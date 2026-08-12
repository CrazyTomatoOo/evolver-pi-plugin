// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync, spawnSync } from "node:child_process";
import { createGraphRecorder } from "../src/graph-recorder";
import {
	createSessionTransitionStore,
	type FinalizationResult,
} from "../src/session-transition";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");
const WORKSPACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const sandboxes: string[] = [];
afterEach(() => {
	delete process.env.EVOLVER_SESSION_STATE_DIR;
	delete process.env.MEMORY_GRAPH_PATH;
	for (const sandbox of sandboxes.splice(0)) {
		rmSync(sandbox, { recursive: true, force: true });
	}
});

function repository(): string {
	const dir = mkdtempSync(join(tmpdir(), "evolver-repo-"));
	sandboxes.push(dir);
	writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(dir, "tracked.txt"), "base\n");
	execSync("git init -q", { cwd: dir });
	execSync('git config user.email t@t.t && git config user.name t', { cwd: dir });
	execSync("git add -A && git commit -qm init", { cwd: dir });
	return dir;
}

function stateDir(): string {
	const dir = join(mkdtempSync(join(tmpdir(), "evolver-state-")), "state");
	sandboxes.push(join(dir, ".."));
	process.env.EVOLVER_SESSION_STATE_DIR = dir;
	return dir;
}

function graphPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "evolver-graph-"));
	sandboxes.push(dir);
	const path = join(dir, "memory_graph.jsonl");
	process.env.MEMORY_GRAPH_PATH = path;
	return path;
}

function readGraph(graphPath: string): unknown[] {
	let content: string;
	try {
		content = readFileSync(graphPath, "utf8");
	} catch {
		return [];
	}
	const out: unknown[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed));
		} catch {
			// skip malformed
		}
	}
	return out;
}

function submit(
	cwd: string,
	store: ReturnType<typeof createSessionTransitionStore>,
	verdict: "success" | "failed",
	lesson: string,
	sessionId = "session-1",
) {
	return store.submit(
		cwd,
		WORKSPACE_ID,
		sessionId,
		{ action: "set", verdict, lesson },
		"tool:evolver_outcome",
		new Date(NOW).toISOString(),
	);
}

function finalize(
	cwd: string,
	store: ReturnType<typeof createSessionTransitionStore>,
	graphPath: string,
	sessionId = "session-1",
) {
	return store.finalize(cwd, WORKSPACE_ID, sessionId, graphPath);
}

describe("Finalization contract", () => {
	test("quit records one immutable Outcome and clears pending", () => {
		const cwd = repository();
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		store.start(cwd, WORKSPACE_ID, "session-1");
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");
		expect(submit(cwd, store, "success", "reuse this").code).toBe("accepted");

		const result = finalize(cwd, store, graph);

		expect(result).toEqual<FinalizationResult>({
			code: "recorded",
			receipt: "Outcome recorded.",
		});
		const lines = readGraph(graph);
		expect(lines).toHaveLength(1);
		const record = lines[0] as Record<string, unknown>;
		expect(record).toMatchObject({
			gene_id: "ad_hoc",
			signals: [],
			cwd,
			workspace_id: WORKSPACE_ID,
			session_id: "session-1",
			diff_scope: "working_tree",
			source: "tool:evolver_outcome",
			outcome: { status: "success", score: 0.8, note: "reuse this" },
		});
		expect(typeof record.timestamp).toBe("string");
		expect(typeof record.diff_hash).toBe("string");
		expect(record.diff_hash).not.toBe("");

		// Pending is cleared after settlement.
		const persisted = JSON.parse(
			readFileSync(join(state, "sessions", WORKSPACE_ID, "session-1.json"), "utf8"),
		);
		expect(persisted.pending).toBeUndefined();
	});

	test("a second finalize for the same transition returns duplicate without append or rewrite", () => {
		const cwd = repository();
		stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		store.start(cwd, WORKSPACE_ID, "session-1");
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");
		submit(cwd, store, "success", "first lesson");

		expect(finalize(cwd, store, graph).code).toBe("recorded");
		// The first finalization settled the transition. A re-submission of the
		// same content transition finds the identity already in the Graph.
		submit(cwd, store, "success", "first lesson");
		const result = finalize(cwd, store, graph);

		expect(result).toEqual<FinalizationResult>({
			code: "duplicate",
			receipt: "Outcome already recorded.",
		});
		const lines = readGraph(graph);
		expect(lines).toHaveLength(1);
		expect((lines[0] as Record<string, unknown>).outcome).toMatchObject({
			note: "first lesson",
		});
	});

	test("no pending verdict returns skipped_no_verdict and changes nothing", () => {
		const cwd = repository();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		store.start(cwd, WORKSPACE_ID, "session-1");
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");

		const result = finalize(cwd, store, graph);

		expect(result).toEqual<FinalizationResult>({
			code: "skipped_no_verdict",
			receipt: "No pending Outcome to finalize.",
		});
		expect(readGraph(graph)).toHaveLength(0);
	});

	test("baseline-equal snapshots return skipped_no_changes", () => {
		const cwd = repository();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		store.start(cwd, WORKSPACE_ID, "session-1");
		// No content change, but a pending verdict was somehow accepted.
		store.submit(
			cwd,
			WORKSPACE_ID,
			"session-1",
			{ action: "set", verdict: "success", lesson: "no real change" },
			"command:evolver-outcome",
			new Date(NOW).toISOString(),
		);

		const result = finalize(cwd, store, graph);

		// submit() rejects no_changes before a pending is stored, so finalize
		// reaches the no-pending branch and reports skipped_no_changes.
		expect(result).toEqual<FinalizationResult>({
			code: "skipped_no_changes",
			receipt: "Workspace has no content changes.",
		});
		expect(readGraph(graph)).toHaveLength(0);
	});

	test("a later content change after submission returns stale", () => {
		const cwd = repository();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		store.start(cwd, WORKSPACE_ID, "session-1");
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");
		submit(cwd, store, "success", "verified");
		writeFileSync(join(cwd, "tracked.txt"), "changed again\n");

		const result = finalize(cwd, store, graph);

		expect(result).toEqual<FinalizationResult>({
			code: "stale",
			receipt: "Pending Outcome is stale.",
		});
		expect(readGraph(graph)).toHaveLength(0);
	});

	test("missing state returns unavailable", () => {
		const cwd = repository();
		stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());

		const result = finalize(cwd, store, graph);

		expect(result).toEqual<FinalizationResult>({
			code: "unavailable",
			receipt: "Outcome finalization is unavailable.",
		});
		expect(readGraph(graph)).toHaveLength(0);
	});

	test("failed verdict records score 0.3 and accumulated signals", () => {
		const cwd = repository();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		store.start(cwd, WORKSPACE_ID, "session-1");
		writeFileSync(join(cwd, "tracked.txt"), "broken\n");
		store.addSignals(WORKSPACE_ID, "session-1", ["regression", "test_failure"]);
		submit(cwd, store, "failed", "avoid this");

		const result = finalize(cwd, store, graph);

		expect(result.code).toBe("recorded");
		const record = readGraph(graph)[0] as Record<string, unknown>;
		expect(record.outcome).toMatchObject({
			status: "failed",
			score: 0.3,
			note: "avoid this",
		});
		expect(record.signals).toEqual(["regression", "test_failure"]);
	});

	test("transition identity is workspace plus versioned snapshot pair, never session id", () => {
		const cwd = repository();
		stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		store.start(cwd, WORKSPACE_ID, "session-1");
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");
		submit(cwd, store, "success", "one");
		expect(finalize(cwd, store, graph).code).toBe("recorded");
		const firstHash = (readGraph(graph)[0] as Record<string, unknown>)
			.diff_hash as string;

		// A different session id with the same content transition must dedup.
		writeFileSync(join(cwd, "tracked.txt"), "base\n");
		store.start(cwd, WORKSPACE_ID, "session-2");
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");
		store.submit(
			cwd,
			WORKSPACE_ID,
			"session-2",
			{ action: "set", verdict: "success", lesson: "two" },
			"tool:evolver_outcome",
			new Date(NOW).toISOString(),
		);
		const result = finalize(cwd, store, graph, "session-2");

		expect(result.code).toBe("duplicate");
		const lines = readGraph(graph);
		expect(lines).toHaveLength(1);
		expect((lines[0] as Record<string, unknown>).diff_hash).toBe(firstHash);
	});

	test("a different baseline-to-end transition produces a new identity", () => {
		const cwd = repository();
		stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		store.start(cwd, WORKSPACE_ID, "session-1");
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");
		submit(cwd, store, "success", "one", "session-1");
		expect(finalize(cwd, store, graph).code).toBe("recorded");

		// New session, new baseline, a different end.
		store.start(cwd, WORKSPACE_ID, "session-2");
		writeFileSync(join(cwd, "tracked.txt"), "changed differently\n");
		submit(cwd, store, "success", "two", "session-2");
		const result = finalize(cwd, store, graph, "session-2");

		expect(result.code).toBe("recorded");
		const lines = readGraph(graph);
		expect(lines).toHaveLength(2);
		const hashes = lines.map(
			(line) => (line as Record<string, unknown>).diff_hash,
		);
		expect(hashes[0]).not.toBe(hashes[1]);
	});

	test("a newly recorded Outcome is eligible for the subsequent first-turn Recall", () => {
		const cwd = repository();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		store.start(cwd, WORKSPACE_ID, "session-1");
		writeFileSync(join(cwd, "tracked.txt"), "changed\n");
		submit(cwd, store, "success", "reuse the verified approach");
		finalize(cwd, store, graph);

		// Re-load the graph through the production recall path.
		const { gatherWorkspaceEntries } = require("../src/memory");
		const entries = gatherWorkspaceEntries(graph, WORKSPACE_ID, cwd);
		expect(entries).toHaveLength(1);
		expect(entries[0].outcome?.note).toBe("reuse the verified approach");
		expect(entries[0].outcome?.status).toBe("success");
	});
});
