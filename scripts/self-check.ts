// SPDX-License-Identifier: MIT
// Composed self-check for the evolver local core. Exercises the complete
// Coordinator flow in disposable Git/state/Graph sandboxes without touching
// real user state, and restores every mutated environment variable. Run:
//   bun scripts/self-check.ts   (or: npx tsx scripts/self-check.ts)
// Exits nonzero with a precise failed assertion on any contract breach.

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { detectSignals } from "../src/signals";
import { createCoreCoordinator, type MessageEffect } from "../src/core-coordinator";
import type { OutcomeEntry } from "../src/filter";
import { resolveWorkspaceId, findMemoryGraph } from "../src/paths";
import { gatherWorkspaceEntries } from "../src/memory";
import { loadRecall } from "../src/recall";
import { createGraphRecorder } from "../src/graph-recorder";
import { createSessionTransitionStore } from "../src/session-transition";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evolver-selfcheck-"));

// Save every environment variable this flow may mutate so it can be restored.
const envSnapshot: Record<string, string | undefined> = {
	EVOLVER_SESSION_STATE_DIR: process.env.EVOLVER_SESSION_STATE_DIR,
	EVOLVER_WORKSPACE_ID: process.env.EVOLVER_WORKSPACE_ID,
	MEMORY_GRAPH_PATH: process.env.MEMORY_GRAPH_PATH,
};

function restoreEnv(): void {
	for (const [key, value] of Object.entries(envSnapshot)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

const WORKSPACE_ID = "a".repeat(32);

function repository(name: string, files: Record<string, string>): string {
	const proj = path.join(tmp, name);
	fs.mkdirSync(proj, { recursive: true });
	fs.writeFileSync(path.join(proj, ".gitignore"), "ignored.txt\n");
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(proj, name), content);
	}
	spawnSync("git", ["init", "-q"], { cwd: proj, stdio: "ignore" });
	spawnSync("git", ["-C", proj, "config", "user.email", "t@t.t"]);
	spawnSync("git", ["-C", proj, "config", "user.name", "t"]);
	spawnSync("git", ["-C", proj, "add", "-A"]);
	spawnSync("git", ["-C", proj, "commit", "-qm", "init"]);
	return proj;
}

function coordinator(transitions: ReturnType<typeof createSessionTransitionStore>) {
	return createCoreCoordinator({
		loadRecall,
		now: Date.now,
		detectSignals,
		resolveWorkspaceId,
		startSessionTransition: (cwd, ws, sid) => transitions.start(cwd, ws, sid),
		addSessionSignals: (ws, sid, sigs) => transitions.addSignals(ws, sid, sigs),
		submitSessionOutcome: (cwd, ws, sid, sub, src, at) =>
			transitions.submit(cwd, ws, sid, sub, src, at),
		finalizeSessionOutcome: (cwd, ws, sid) =>
			transitions.finalize(cwd, ws, sid, findMemoryGraph(cwd)),
		recoverCrashLeftOutcomes: (cwd, ws) =>
			transitions.recoverCrashLeft(cwd, ws, findMemoryGraph(cwd)),
		drainReadyOutbox: (cwd, ws) => transitions.drainOutbox(ws, findMemoryGraph(cwd)),
		inspectStatusSnapshot: (cwd, ws, sid) =>
			transitions.inspectStatus(cwd, ws, sid, findMemoryGraph(cwd)),
		pendingAnnouncements: (ws) => transitions.pendingAnnouncements(ws).map((r) => r.code),
	});
}

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
	return Promise.resolve(fn())
		.then(() => {
			passed += 1;
			console.log(`  ok  ${name}`);
		})
		.catch((err) => {
			console.error(`FAIL  ${name}`);
			throw err;
		});
}

function recallContent(effects: unknown[]): string {
	const msg = effects.find(
		(e): e is MessageEffect => (e as MessageEffect).type === "message" && (e as MessageEffect).customType === "evolver-recall",
	);
	return msg?.content ?? "";
}

async function main() {
	// Keep all state in the temp sandbox, away from the real ~/.evolver.
	process.env.EVOLVER_SESSION_STATE_DIR = path.join(tmp, "state");
	process.env.EVOLVER_WORKSPACE_ID = WORKSPACE_ID;
	const graph = path.join(tmp, "memory_graph.jsonl");
	process.env.MEMORY_GRAPH_PATH = graph;

	// ── Scenario 1: committed + dirty + untracked transition survives reload
	//    and records an explicit successful agent submission. ──────────────
	await check("committed+dirty+untracked transition survives reload and records success", async () => {
		const proj = repository("scenario-1", { "committed.txt": "base\n" });
		const transitions = createSessionTransitionStore(createGraphRecorder());
		const core = coordinator(transitions);
		// Start, then reload: the baseline must survive across reload.
		await core.sessionStart({ cwd: proj, reason: "startup", sessionId: "sess-1" });
		await core.sessionStart({ cwd: proj, reason: "reload", sessionId: "sess-1" });
		// Dirty a tracked file and add an untracked one AFTER the baseline.
		fs.writeFileSync(path.join(proj, "committed.txt"), "changed\n");
		fs.writeFileSync(path.join(proj, "untracked.txt"), "new\n");
		const submit = await core.submitOutcome({
			cwd: proj,
			sessionId: "sess-1",
			source: "tool:evolver_outcome",
			submission: { action: "set", verdict: "success", lesson: "reuse the verified approach" },
		});
		assert.strictEqual(submit.code, "accepted");
		const finalize = await core.sessionShutdown({
			cwd: proj,
			reason: "quit",
			sessionId: "sess-1",
		});
		assert.strictEqual(finalize.length, 0);
		const entries = gatherWorkspaceEntries(graph, WORKSPACE_ID, proj);
		assert.strictEqual(entries.length, 1, `expected 1 recorded outcome, got ${entries.length}`);
		assert.strictEqual(entries[0].outcome?.status, "success");
		assert.strictEqual(entries[0].outcome?.note, "reuse the verified approach");
	});

	// ── Scenario 2: a later command-sourced failed lesson is trusted and
	//    produces balanced Recall with the prior success. ─────────────────
	await check("command-sourced failed lesson is trusted and balances Recall", async () => {
		const proj = repository("scenario-2", { "file.txt": "base\n" });
		const transitions = createSessionTransitionStore(createGraphRecorder());
		const core = coordinator(transitions);
		await core.sessionStart({ cwd: proj, reason: "startup", sessionId: "sess-2" });
		fs.writeFileSync(path.join(proj, "file.txt"), "broken\n");
		const failed = await core.submitOutcome({
			cwd: proj,
			sessionId: "sess-2",
			source: "command:evolver-outcome",
			submission: { action: "set", verdict: "failed", lesson: "avoid this regression" },
		});
		assert.strictEqual(failed.code, "accepted");
		await core.sessionShutdown({ cwd: proj, reason: "quit", sessionId: "sess-2" });
		// The prior success + this trusted failure must both be Recall candidates.
		const entries = gatherWorkspaceEntries(graph, WORKSPACE_ID, proj);
		const statuses = entries.map((e) => e.outcome?.status).sort();
		assert.deepStrictEqual(statuses, ["failed", "success"], `expected balanced recall, got ${statuses}`);
		// A new session arms Recall; the first turn must surface both kinds.
		await core.sessionStart({ cwd: proj, reason: "new", sessionId: "sess-2b" });
		const recall = await core.beforeAgentStart({
			cwd: proj,
			deliveredRecalls: [],
		});
		const content = recallContent(recall);
		assert.ok(content.includes("reuse the verified approach"), `recall missing success: ${content}`);
		assert.ok(content.includes("avoid this regression"), `recall missing trusted failure: ${content}`);
	});

	// ── Scenario 3: the same transition under another Session ID is
	//    deduplicated. ─────────────────────────────────────────────────────
	await check("the same transition under another Session ID is deduplicated", async () => {
		const proj = repository("scenario-3", { "file.txt": "base\n" });
		const transitions = createSessionTransitionStore(createGraphRecorder());
		const core = coordinator(transitions);
		const before = gatherWorkspaceEntries(graph, WORKSPACE_ID, proj).length;
		await core.sessionStart({ cwd: proj, reason: "startup", sessionId: "sess-3a" });
		fs.writeFileSync(path.join(proj, "file.txt"), "changed\n");
		await core.submitOutcome({
			cwd: proj,
			sessionId: "sess-3a",
			source: "tool:evolver_outcome",
			submission: { action: "set", verdict: "success", lesson: "same transition" },
		});
		await core.sessionShutdown({ cwd: proj, reason: "new", sessionId: "sess-3a" });
		// A second session, same content transition, different session id.
		fs.writeFileSync(path.join(proj, "file.txt"), "base\n");
		await core.sessionStart({ cwd: proj, reason: "new", sessionId: "sess-3b" });
		fs.writeFileSync(path.join(proj, "file.txt"), "changed\n");
		await core.submitOutcome({
			cwd: proj,
			sessionId: "sess-3b",
			source: "tool:evolver_outcome",
			submission: { action: "set", verdict: "success", lesson: "same transition" },
		});
		const result = await core.sessionShutdown({
			cwd: proj,
			reason: "quit",
			sessionId: "sess-3b",
		});
		void result;
		const after = gatherWorkspaceEntries(graph, WORKSPACE_ID, proj).length;
		assert.strictEqual(after, before + 1, `expected dedup (+1), got ${before} -> ${after}`);
	});

	// ── Scenario 4: a forced Ready append failure recovers. ───────────────
	await check("a forced Ready append failure recovers on a later drain", async () => {
		const proj = repository("scenario-4", { "file.txt": "base\n" });
		const graph4 = path.join(tmp, "scenario-4-graph.jsonl");
		process.env.MEMORY_GRAPH_PATH = graph4;
		const real = createGraphRecorder();
		let attempts = 0;
		const flaky = {
			record: (gp: string, entry: OutcomeEntry) => {
				attempts += 1;
				if (attempts <= 1) return { code: "unavailable" as const };
				return real.record(gp, entry);
			},
		};
		const transitions = createSessionTransitionStore(flaky);
		const core = coordinator(transitions);
		await core.sessionStart({ cwd: proj, reason: "startup", sessionId: "sess-4" });
		fs.writeFileSync(path.join(proj, "file.txt"), "changed\n");
		await core.submitOutcome({
			cwd: proj,
			sessionId: "sess-4",
			source: "tool:evolver_outcome",
			submission: { action: "set", verdict: "success", lesson: "recovered lesson" },
		});
		const shutdown = await core.sessionShutdown({
			cwd: proj,
			reason: "quit",
			sessionId: "sess-4",
		});
		void shutdown;
		// The shutdown finalize queued the Ready item; a later drain recovers it.
		const drained = transitions.drainOutbox(WORKSPACE_ID, graph4);
		assert.strictEqual(drained[0]?.code, "recorded");
		const entries = gatherWorkspaceEntries(graph4, WORKSPACE_ID, proj);
		assert.strictEqual(entries.length, 1);
		assert.strictEqual(entries[0].outcome?.note, "recovered lesson");
		process.env.MEMORY_GRAPH_PATH = graph;
	});

	// ── Scenario 5: read-only status leaves all inspected bytes unchanged. ─
	await check("read-only status inspection leaves all inspected bytes unchanged", async () => {
		const proj = repository("scenario-5", { "file.txt": "base\n" });
		const transitions = createSessionTransitionStore(createGraphRecorder());
		const core = coordinator(transitions);
		await core.sessionStart({ cwd: proj, reason: "startup", sessionId: "sess-5" });
		fs.writeFileSync(path.join(proj, "file.txt"), "changed\n");
		await core.submitOutcome({
			cwd: proj,
			sessionId: "sess-5",
			source: "tool:evolver_outcome",
			submission: { action: "set", verdict: "success", lesson: "status lesson" },
		});
		await core.sessionShutdown({ cwd: proj, reason: "quit", sessionId: "sess-5" });
		const stateRoot = process.env.EVOLVER_SESSION_STATE_DIR!;
		const bytesBefore = new Map<string, string>();
		const walk = (dir: string) => {
			for (const name of fs.readdirSync(dir)) {
				const p = path.join(dir, name);
				const st = fs.statSync(p);
				if (st.isDirectory()) walk(p);
				else bytesBefore.set(p, fs.readFileSync(p, "utf8"));
			}
		};
		walk(stateRoot);
		bytesBefore.set(graph, fs.readFileSync(graph, "utf8"));

		const status = await core.inspectStatus({ cwd: proj, sessionId: "sess-5" });
		assert.ok(status.snapshot, "status snapshot must be available");
		assert.strictEqual(status.snapshot.graph.lockState, "free");
		// No durable bytes changed, and no lock was acquired.
		for (const [p, content] of bytesBefore) {
			assert.strictEqual(fs.readFileSync(p, "utf8"), content, `status mutated ${p}`);
		}
		assert.throws(() => fs.statSync(`${graph}.lock`), "status must not create a lock");
	});

	console.log(`\n${passed} checks passed.`);
}

main()
	.then(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		restoreEnv();
		process.exit(0);
	})
	.catch((err) => {
		console.error(err);
		fs.rmSync(tmp, { recursive: true, force: true });
		restoreEnv();
		process.exit(1);
	});
