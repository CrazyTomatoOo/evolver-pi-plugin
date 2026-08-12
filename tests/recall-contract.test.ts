import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
	createCoreCoordinator,
	type CoordinatorDependencies,
	type DeliveredRecall,
	type SessionStartReason,
} from "../src/core-coordinator";
import type { OutcomeEntry } from "../src/filter";
import { loadRecall } from "../src/recall";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const START_REASONS: SessionStartReason[] = [
	"startup",
	"reload",
	"new",
	"resume",
	"fork",
];

const sandboxes: string[] = [];
afterEach(() => {
	delete process.env.MEMORY_GRAPH_PATH;
	delete process.env.EVOLVER_WORKSPACE_ID;
	for (const sandbox of sandboxes.splice(0)) {
		rmSync(sandbox, { recursive: true, force: true });
	}
});

function success(
	hoursAgo: number,
	note: string,
	score = 0.8,
): OutcomeEntry {
	return {
		timestamp: new Date(NOW - hoursAgo * 60 * 60 * 1_000).toISOString(),
		outcome: { status: "success", score, note },
	};
}

function failure(
	hoursAgo: number,
	note: string,
	source = "tool:evolver_outcome",
): OutcomeEntry {
	return {
		timestamp: new Date(NOW - hoursAgo * 60 * 60 * 1_000).toISOString(),
		outcome: { status: "failed", score: 0.2, note },
		source,
	};
}

function coordinator(
	entries: OutcomeEntry[],
	workspaceId: string | null = "workspace-1",
	eligible = true,
) {
	const dependencies: CoordinatorDependencies = {
		loadRecall: () => ({ eligible, workspaceId, entries }),
		now: () => NOW,
		detectSignals: () => [],
		resolveWorkspaceId: () => null,
		startSessionTransition: () => {},
		addSessionSignals: () => {},
		submitSessionOutcome: () => ({
			code: "unavailable",
			receipt: "Outcome submission is unavailable.",
		}),
		finalizeSessionOutcome: () => ({ code: "unavailable" as const, receipt: "Outcome finalization is unavailable." }),
		recoverCrashLeftOutcomes: () => [],
		drainReadyOutbox: () => [],
	};
	return createCoreCoordinator(dependencies);
}

async function recall(
	entries: OutcomeEntry[],
	reason: SessionStartReason = "startup",
	deliveredRecalls: DeliveredRecall[] = [],
) {
	const core = coordinator(entries);
	await core.sessionStart({ cwd: "/workspace", reason, sessionId: null });
	return core.beforeAgentStart({ cwd: "/workspace", deliveredRecalls });
}

describe("First-turn Recall contract", () => {
	for (const reason of START_REASONS) {
		test(`${reason} arms one Recall evaluation for the next user turn`, async () => {
			const core = coordinator([success(1, "reuse this")]);

			expect(
				await core.sessionStart({ cwd: "/workspace", reason, sessionId: null }),
			).toEqual([]);
			expect(
				await core.beforeAgentStart({ cwd: "/workspace", deliveredRecalls: [] }),
			).toHaveLength(1);
			expect(
				await core.beforeAgentStart({ cwd: "/workspace", deliveredRecalls: [] }),
			).toEqual([]);
		});
	}

	test("an identical workspace and Recall hash on the active branch suppresses delivery", async () => {
		const first = await recall([success(1, "reuse this")]);
		const details = first[0]?.details;
		expect(details).toBeDefined();

		for (const reason of ["reload", "resume", "startup", "fork"] as const) {
			expect(
				await recall([success(1, "reuse this")], reason, [details!]),
			).toEqual([]);
		}
	});

	test("changed Recall content is delivered once after a later start", async () => {
		const first = await recall([success(2, "old lesson")]);
		const delivered = first[0]?.details;
		const second = await recall([success(1, "new lesson")], "reload", [delivered!]);

		expect(second).toHaveLength(1);
		expect(second[0]?.details?.recallHash).not.toBe(delivered?.recallHash);
	});

	test("filters age, success score, and untrusted or lessonless failures", async () => {
		const effects = await recall([
			success(1, "eligible success", 0.5),
			success(2, "low score", 0.49),
			{
				...success(8 * 24, "too old"),
			},
			failure(3, "trusted failure", "command:evolver-outcome"),
			failure(4, "untrusted failure", "legacy:heuristic"),
			failure(5, "   "),
		]);
		const content = effects[0]?.content ?? "";

		expect(content).toContain("eligible success");
		expect(content).toContain("trusted failure");
		expect(content).not.toContain("low score");
		expect(content).not.toContain("too old");
		expect(content).not.toContain("untrusted failure");
	});

	test("selects newest-first, at most three, while preserving success and failure", async () => {
		const effects = await recall([
			failure(4, "older failure"),
			success(3, "success three"),
			success(2, "success two"),
			success(1, "success one"),
		]);
		const content = effects[0]?.content ?? "";

		expect(content).toContain("Recent 3 outcomes (2 success, 1 failed)");
		expect(content.indexOf("success one")).toBeLessThan(
			content.indexOf("success two"),
		);
		expect(content).toContain("older failure");
		expect(content).not.toContain("success three");
	});

	test("production Graph loading can balance a trusted failure beyond the fifth newest record", async () => {
		const sandbox = mkdtempSync(join(tmpdir(), "evolver-recall-"));
		sandboxes.push(sandbox);
		const project = join(sandbox, "project");
		spawnSync("git", ["init", "-q", project]);
		const graphPath = join(sandbox, "memory_graph.jsonl");
		process.env.MEMORY_GRAPH_PATH = graphPath;
		process.env.EVOLVER_WORKSPACE_ID = "workspace-1";
		const entries = [
			failure(7, "older trusted failure"),
			...Array.from({ length: 6 }, (_, index) =>
				success(6 - index, `success ${index + 1}`),
			),
		].map((entry) => ({
			...entry,
			cwd: project,
			workspace_id: "workspace-1",
		}));
		writeFileSync(
			graphPath,
			`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		);
		const core = createCoreCoordinator({
			loadRecall,
			now: () => NOW,
			detectSignals: () => [],
			resolveWorkspaceId: () => null,
			startSessionTransition: () => {},
			addSessionSignals: () => {},
			submitSessionOutcome: () => ({
				code: "unavailable",
				receipt: "Outcome submission is unavailable.",
			}),
finalizeSessionOutcome: () => ({
				code: "unavailable",
				receipt: "Outcome finalization is unavailable.",
			}),
				recoverCrashLeftOutcomes: () => [],
				drainReadyOutbox: () => [],
		});

		await core.sessionStart({ cwd: project, reason: "startup", sessionId: null });
		const effects = await core.beforeAgentStart({
			cwd: project,
			deliveredRecalls: [],
		});

		expect(effects[0]?.content).toContain("older trusted failure");
	});

	test("caps formatted Recall at 2,000 characters and visibly truncates only the final included entry", async () => {
		const firstNote = "a".repeat(900);
		const secondNote = "b".repeat(1_500);
		const effects = await recall([
			success(2, secondNote),
			success(1, firstNote),
		]);
		const content = effects[0]?.content ?? "";

		expect(content.length).toBe(2_000);
		expect(content).toContain(firstNote);
		expect(content).toContain("… [truncated]");
		expect(content).not.toContain(secondNote);
	});

	test("keeps visible truncation when the next entry has less room than the marker", async () => {
		const effects = await recall([
			success(2, "b".repeat(100)),
			success(1, "a".repeat(1_831)),
		]);
		const content = effects[0]?.content ?? "";

		expect(content.length).toBeLessThanOrEqual(2_000);
		expect(content).toContain("… [truncated]");
		expect(content).not.toContain("b".repeat(100));
	});

	test("different workspaces do not suppress an identical Recall hash", async () => {
		const first = await recall([success(1, "same lesson")]);
		const delivered = first[0]?.details;
		const core = coordinator([success(1, "same lesson")], "workspace-2");
		await core.sessionStart({ cwd: "/workspace", reason: "fork", sessionId: null });

		expect(
			await core.beforeAgentStart({
				cwd: "/workspace",
				deliveredRecalls: [delivered!],
			}),
		).toHaveLength(1);
	});

	test("empty, ineligible, and non-Git Recall inputs stay silent", async () => {
		expect(await recall([])).toEqual([]);

		const sandbox = mkdtempSync(join(tmpdir(), "evolver-nongit-"));
		sandboxes.push(sandbox);
		const nonGitCore = createCoreCoordinator({
			loadRecall,
			now: () => NOW,
			detectSignals: () => [],
			resolveWorkspaceId: () => null,
			startSessionTransition: () => {},
			addSessionSignals: () => {},
			submitSessionOutcome: () => ({
				code: "unavailable",
				receipt: "Outcome submission is unavailable.",
			}),
finalizeSessionOutcome: () => ({
				code: "unavailable",
				receipt: "Outcome finalization is unavailable.",
			}),
				recoverCrashLeftOutcomes: () => [],
				drainReadyOutbox: () => [],
		});
		await nonGitCore.sessionStart({ cwd: sandbox, reason: "startup", sessionId: null });
		expect(
			await nonGitCore.beforeAgentStart({
				cwd: sandbox,
				deliveredRecalls: [],
			}),
		).toEqual([]);

		for (const core of [coordinator([success(1, "lesson")], null), coordinator([success(1, "lesson")], null, false)]) {
			await core.sessionStart({ cwd: "/workspace", reason: "startup", sessionId: null });
			expect(
				await core.beforeAgentStart({ cwd: "/workspace", deliveredRecalls: [] }),
			).toEqual([]);
		}
	});
});
