import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	createCoreCoordinator,
	type CoordinatorDependencies,
} from "../src/core-coordinator";
import { createSessionTransitionStore } from "../src/session-transition";
import { findMemoryGraph } from "../src/paths";
import type { GraphRecorder } from "../src/graph-recorder";

const stubRecorder: GraphRecorder = { record: () => ({ code: "error" }) };

const WORKSPACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const sandboxes: string[] = [];

afterEach(() => {
	delete process.env.EVOLVER_SESSION_STATE_DIR;
	for (const sandbox of sandboxes.splice(0)) {
		rmSync(sandbox, { recursive: true, force: true });
	}
});

function git(cwd: string, ...args: string[]): void {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
}

function repository(): string {
	const dir = mkdtempSync(join(tmpdir(), "evolver-outcome-"));
	sandboxes.push(dir);
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
	writeFileSync(join(dir, "tracked.txt"), "base\n");
	git(dir, "add", ".");
	git(dir, "commit", "-qm", "base");
	return dir;
}

function coordinator() {
	const store = createSessionTransitionStore(stubRecorder);
	const dependencies: CoordinatorDependencies = {
		loadRecall: () => ({ eligible: false, workspaceId: null, entries: [] }),
		now: () => NOW,
		detectSignals: () => [],
		resolveWorkspaceId: () => WORKSPACE_ID,
		startSessionTransition: (cwd, workspaceId, sessionId) => {
			store.start(cwd, workspaceId, sessionId);
		},
		addSessionSignals: (workspaceId, sessionId, signals) => {
			store.addSignals(workspaceId, sessionId, signals);
		},
		submitSessionOutcome: (cwd, workspaceId, sessionId, submission, source, submittedAt) =>
			store.submit(cwd, workspaceId, sessionId, submission, source, submittedAt),
		finalizeSessionOutcome: (cwd, workspaceId, sessionId) => {
			const graph = findMemoryGraph(cwd);
			return store.finalize(cwd, workspaceId, sessionId, graph);
		},
		recoverCrashLeftOutcomes: (cwd, workspaceId) =>
			store.recoverCrashLeft(cwd, workspaceId, findMemoryGraph(cwd)),
		drainReadyOutbox: (cwd, workspaceId) =>
			store.drainOutbox(workspaceId, findMemoryGraph(cwd)),
	};
	return createCoreCoordinator(dependencies);
}

function statePath(stateDir: string): string {
	return join(stateDir, "sessions", WORKSPACE_ID, "session-1.json");
}

describe("Pending Outcome contract", () => {
	test("accepts one explicit changed-workspace verdict and normalizes its lesson atomically", async () => {
		const cwd = repository();
		const stateDir = join(mkdtempSync(join(tmpdir(), "evolver-state-")), "state");
		sandboxes.push(join(stateDir, ".."));
		process.env.EVOLVER_SESSION_STATE_DIR = stateDir;
		const core = coordinator();
		await core.sessionStart({ cwd, reason: "startup", sessionId: "session-1" });
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");

		const result = await core.submitOutcome({
			cwd,
			sessionId: "session-1",
			source: "tool:evolver_outcome",
			submission: {
				action: "set",
				verdict: "success",
				lesson: "  Reuse\n the   verified approach.  ",
			},
		});
		const state = JSON.parse(readFileSync(statePath(stateDir), "utf8"));

		expect(result).toEqual({
			code: "accepted",
			receipt: "Pending Outcome accepted.",
		});
		expect(state.pending).toMatchObject({
			verdict: "success",
			lesson: "Reuse the verified approach.",
			source: "tool:evolver_outcome",
			submittedAt: "2026-08-12T12:00:00.000Z",
		});
		expect(state.pending.endSnapshot.hash).not.toBe(state.baseline.hash);
	});

	test("last valid set wins while invalid attempts preserve the prior pending Outcome", async () => {
		const cwd = repository();
		const stateDir = join(mkdtempSync(join(tmpdir(), "evolver-state-")), "state");
		sandboxes.push(join(stateDir, ".."));
		process.env.EVOLVER_SESSION_STATE_DIR = stateDir;
		const core = coordinator();
		await core.sessionStart({ cwd, reason: "startup", sessionId: "session-1" });
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");

		expect(
			await core.submitOutcome({
				cwd,
				sessionId: "session-1",
				source: "tool:evolver_outcome",
				submission: { action: "set", verdict: "success", lesson: "first lesson" },
			}),
		).toMatchObject({ code: "accepted" });
		expect(
			await core.submitOutcome({
				cwd,
				sessionId: "session-1",
				source: "command:evolver-outcome",
				submission: { action: "set", verdict: "failed", lesson: "corrected lesson" },
			}),
		).toMatchObject({ code: "replaced" });
		expect(
			await core.submitOutcome({
				cwd,
				sessionId: "session-1",
				source: "tool:evolver_outcome",
				submission: { action: "set", verdict: "success", lesson: "x".repeat(501) },
			}),
		).toMatchObject({ code: "invalid" });

		const state = JSON.parse(readFileSync(statePath(stateDir), "utf8"));
		expect(state.pending).toMatchObject({
			verdict: "failed",
			lesson: "corrected lesson",
			source: "command:evolver-outcome",
		});
	});

	test("clear is idempotent and preserves the baseline and accumulated signals", async () => {
		const cwd = repository();
		const stateDir = join(mkdtempSync(join(tmpdir(), "evolver-state-")), "state");
		sandboxes.push(join(stateDir, ".."));
		process.env.EVOLVER_SESSION_STATE_DIR = stateDir;
		const store = createSessionTransitionStore(stubRecorder);
		store.start(cwd, WORKSPACE_ID, "session-1");
		store.addSignals(WORKSPACE_ID, "session-1", ["test_failure"]);
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");
		store.submit(
			cwd,
			WORKSPACE_ID,
			"session-1",
			{ action: "set", verdict: "success", lesson: "verified" },
			"tool:evolver_outcome",
			"2026-08-12T12:00:00.000Z",
		);

		expect(
			store.submit(
				cwd,
				WORKSPACE_ID,
				"session-1",
				{ action: "clear" },
				"command:evolver-outcome",
				"2026-08-12T12:01:00.000Z",
			),
		).toMatchObject({ code: "cleared" });
		expect(
			store.submit(
				cwd,
				WORKSPACE_ID,
				"session-1",
				{ action: "clear" },
				"command:evolver-outcome",
				"2026-08-12T12:02:00.000Z",
			),
		).toMatchObject({ code: "no_op" });
		const state = JSON.parse(readFileSync(statePath(stateDir), "utf8"));
		expect(state.pending).toBeUndefined();
		expect(state.signals).toEqual(["test_failure"]);
		expect(state.baseline).toBeDefined();
	});

	test("set prerequisites reject unavailable or unchanged workspaces without mutating pending state", async () => {
		const cwd = repository();
		const stateDir = join(mkdtempSync(join(tmpdir(), "evolver-state-")), "state");
		sandboxes.push(join(stateDir, ".."));
		process.env.EVOLVER_SESSION_STATE_DIR = stateDir;
		const core = coordinator();

		expect(
			await core.submitOutcome({
				cwd,
				sessionId: "session-1",
				source: "tool:evolver_outcome",
				submission: { action: "set", verdict: "success", lesson: "lesson" },
			}),
		).toMatchObject({ code: "unavailable" });
		await core.sessionStart({ cwd, reason: "startup", sessionId: "session-1" });
		expect(
			await core.submitOutcome({
				cwd,
				sessionId: "session-1",
				source: "tool:evolver_outcome",
				submission: { action: "set", verdict: "success", lesson: "lesson" },
			}),
		).toMatchObject({ code: "no_changes" });
	});

	test("raw and normalized lesson limits reject without truncation", async () => {
		const cwd = repository();
		const stateDir = join(mkdtempSync(join(tmpdir(), "evolver-state-")), "state");
		sandboxes.push(join(stateDir, ".."));
		process.env.EVOLVER_SESSION_STATE_DIR = stateDir;
		const core = coordinator();
		await core.sessionStart({ cwd, reason: "startup", sessionId: "session-1" });
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");

		for (const lesson of ["x".repeat(2_001), "x".repeat(501), " \n\t "]) {
			expect(
				await core.submitOutcome({
					cwd,
					sessionId: "session-1",
					source: "tool:evolver_outcome",
					submission: { action: "set", verdict: "success", lesson },
				}),
			).toMatchObject({ code: "invalid" });
		}
		expect(
			createSessionTransitionStore(stubRecorder).submit(
				cwd,
				WORKSPACE_ID,
				"session-1",
				{ action: "clear" },
				"other" as never,
				"2026-08-12T12:00:00.000Z",
			),
		).toEqual({ code: "invalid", receipt: "Outcome submission is invalid." });
		expect(
			await core.submitOutcome({
				cwd,
				sessionId: "session-1",
				source: "tool:evolver_outcome",
				submission: {
					action: "set",
					verdict: "success",
					lesson: "valid",
					extra: true,
				} as never,
			}),
		).toMatchObject({ code: "invalid" });
		expect(JSON.parse(readFileSync(statePath(stateDir), "utf8")).pending).toBeUndefined();
	});

	test("accepts exact raw and normalized lesson boundaries unchanged", async () => {
		const cwd = repository();
		const stateDir = join(mkdtempSync(join(tmpdir(), "evolver-state-")), "state");
		sandboxes.push(join(stateDir, ".."));
		process.env.EVOLVER_SESSION_STATE_DIR = stateDir;
		const store = createSessionTransitionStore(stubRecorder);
		store.start(cwd, WORKSPACE_ID, "session-1");
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");
		const raw2000Normalized500 = `${"x".repeat(500)}${" ".repeat(1_500)}`;

		expect(
			store.submit(
				cwd,
				WORKSPACE_ID,
				"session-1",
				{ action: "set", verdict: "success", lesson: raw2000Normalized500 },
				"tool:evolver_outcome",
				"2026-08-12T12:00:00.000Z",
			),
		).toEqual({ code: "accepted", receipt: "Pending Outcome accepted." });
		expect(JSON.parse(readFileSync(statePath(stateDir), "utf8")).pending.lesson).toHaveLength(500);
		expect(
			store.submit(
				cwd,
				WORKSPACE_ID,
				"session-1",
				{ action: "set", verdict: "failed", lesson: "x" },
				"command:evolver-outcome",
				"2026-08-12T12:01:00.000Z",
			),
		).toEqual({ code: "replaced", receipt: "Pending Outcome replaced." });
		expect(JSON.parse(readFileSync(statePath(stateDir), "utf8")).pending.lesson).toBe("x");
	});

	test("unsafe, missing Session, and non-Git submissions return exact unavailable receipts", async () => {
		const cwd = repository();
		const stateDir = join(mkdtempSync(join(tmpdir(), "evolver-state-")), "state");
		sandboxes.push(join(stateDir, ".."));
		process.env.EVOLVER_SESSION_STATE_DIR = stateDir;
		const unavailable = {
			code: "unavailable",
			receipt: "Outcome submission is unavailable.",
		} as const;
		const noIdentity = createCoreCoordinator({
			loadRecall: () => ({ eligible: false, workspaceId: null, entries: [] }),
			now: () => NOW,
			detectSignals: () => [],
			resolveWorkspaceId: () => null,
			startSessionTransition: () => {},
			addSessionSignals: () => {},
			submitSessionOutcome: () => unavailable,
		finalizeSessionOutcome: () => unavailable,
			recoverCrashLeftOutcomes: () => [],
			drainReadyOutbox: () => [],
		});

		expect(
			await noIdentity.submitOutcome({
				cwd,
				sessionId: "session-1",
				source: "tool:evolver_outcome",
				submission: { action: "clear" },
			}),
		).toEqual(unavailable);
		expect(
			await coordinator().submitOutcome({
				cwd,
				sessionId: null,
				source: "tool:evolver_outcome",
				submission: { action: "clear" },
			}),
		).toEqual(unavailable);
		const nonGit = mkdtempSync(join(tmpdir(), "evolver-nongit-"));
		sandboxes.push(nonGit);
		expect(
			createSessionTransitionStore(stubRecorder).submit(
				nonGit,
				WORKSPACE_ID,
				"session-1",
				{ action: "set", verdict: "success", lesson: "lesson" },
				"tool:evolver_outcome",
				"2026-08-12T12:00:00.000Z",
			),
		).toEqual(unavailable);
	});
});
