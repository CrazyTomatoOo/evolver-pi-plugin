// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
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

function repository(content = "base\n"): string {
	const dir = mkdtempSync(join(tmpdir(), "evolver-repo-"));
	sandboxes.push(dir);
	writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(dir, "tracked.txt"), content);
	execSync("git init -q && git config user.email t@t.t && git config user.name t && git add -A && git commit -qm init", { cwd: dir });
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

function seedCrashLeft(cwd: string, state: string, endContent: string): void {
	// Simulate a process that started a session, submitted a verdict, then died
	// before the shutdown boundary could finalize it.
	const store = createSessionTransitionStore(createGraphRecorder());
	store.start(cwd, WORKSPACE_ID, "crash-1");
	writeFileSync(join(cwd, "tracked.txt"), "changed\n");
	store.submit(
		cwd,
		WORKSPACE_ID,
		"crash-1",
		{ action: "set", verdict: "success", lesson: "crash-left lesson" },
		"tool:evolver_outcome",
		new Date(NOW).toISOString(),
	);
	// Restore the submitted content so the recovery snapshot matches (or differs).
	writeFileSync(join(cwd, "tracked.txt"), endContent);
	void state;
}

function readGraph(graphPath: string): number {
	let content: string;
	try {
		content = readFileSync(graphPath, "utf8");
	} catch {
		return 0;
	}
	return content.split("\n").filter((line) => line.trim()).length;
}

describe("Crash-left recovery contract", () => {
	test("a crash-left Pending is finalized when the submitted snapshot still matches", () => {
		const state = stateDir();
		const graph = graphPath();
		const cwd = repository();
		seedCrashLeft(cwd, state, "changed\n");

		const results = createSessionTransitionStore(createGraphRecorder()).recoverCrashLeft(
			cwd,
			WORKSPACE_ID,
			graph,
		);

		expect(results).toEqual<FinalizationResult[]>([
			{ code: "recorded", receipt: "Outcome recorded." },
		]);
		expect(readGraph(graph)).toBe(1);
		// The crash-left pending is settled.
		const persisted = JSON.parse(
			readFileSync(join(state, "sessions", WORKSPACE_ID, "crash-1.json"), "utf8"),
		);
		expect(persisted.pending).toBeUndefined();
	});

	test("a crash-left Pending is stale when the submitted snapshot no longer matches", () => {
		const state = stateDir();
		const graph = graphPath();
		const cwd = repository();
		seedCrashLeft(cwd, state, "changed again\n");

		const results = createSessionTransitionStore(createGraphRecorder()).recoverCrashLeft(
			cwd,
			WORKSPACE_ID,
			graph,
		);

		expect(results).toEqual<FinalizationResult[]>([
			{ code: "stale", receipt: "Pending Outcome is stale." },
		]);
		expect(readGraph(graph)).toBe(0);
		const persisted = JSON.parse(
			readFileSync(join(state, "sessions", WORKSPACE_ID, "crash-1.json"), "utf8"),
		);
		expect(persisted.pending).toBeUndefined();
	});

	test("another workspace's crash-left Pending is untouched until that workspace is active", () => {
		const state = stateDir();
		const graph = graphPath();
		const other = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const cwdOther = repository();
		// Seed a crash-left pending for a DIFFERENT workspace under the same state root.
		const storeOther = createSessionTransitionStore(createGraphRecorder());
		storeOther.start(cwdOther, other, "crash-other");
		writeFileSync(join(cwdOther, "tracked.txt"), "changed\n");
		storeOther.submit(
			cwdOther,
			other,
			"crash-other",
			{ action: "set", verdict: "success", lesson: "other workspace" },
			"tool:evolver_outcome",
			new Date(NOW).toISOString(),
		);

		// Recover for OUR workspace — the other workspace's pending must remain.
		const cwd = repository();
		const results = createSessionTransitionStore(createGraphRecorder()).recoverCrashLeft(
			cwd,
			WORKSPACE_ID,
			graph,
		);

		expect(results).toEqual([]);
		const otherPersisted = JSON.parse(
			readFileSync(join(state, "sessions", other, "crash-other.json"), "utf8"),
		);
		expect(otherPersisted.pending).toBeDefined();
		void state;
	});

	test("a second recovery of the same crash-left pending is a no-op", () => {
		const state = stateDir();
		const graph = graphPath();
		const cwd = repository();
		seedCrashLeft(cwd, state, "changed\n");
		const store = createSessionTransitionStore(createGraphRecorder());
		expect(store.recoverCrashLeft(cwd, WORKSPACE_ID, graph)[0]?.code).toBe("recorded");

		const second = store.recoverCrashLeft(cwd, WORKSPACE_ID, graph);

		expect(second).toEqual([]);
		expect(readGraph(graph)).toBe(1);
	});

	test("a malformed crash-left state file is skipped without throwing", () => {
		const state = stateDir();
		const graph = graphPath();
		const cwd = repository();
		const sessionDir = join(state, "sessions", WORKSPACE_ID);
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "garbage.json"), "not json\n", { mode: 0o600 });

		const results = createSessionTransitionStore(createGraphRecorder()).recoverCrashLeft(
			cwd,
			WORKSPACE_ID,
			graph,
		);

		expect(results).toEqual([]);
	});
});
