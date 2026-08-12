// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createGraphRecorder } from "../src/graph-recorder";
import {
	createSessionTransitionStore,
	type FinalizationResult,
	type GraphRecorder,
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

function failingRecorder(): GraphRecorder {
	let calls = 0;
	return {
		record: () => {
			calls += 1;
			return { code: calls <= 1 ? "unavailable" : "recorded" };
		},
	};
}

function flakyThenRealRecorder(real: GraphRecorder): GraphRecorder {
	let calls = 0;
	return {
		record: (graphPath, entry) => {
			calls += 1;
			if (calls <= 1) return { code: "unavailable" };
			return real.record(graphPath, entry);
		},
	};
}

function setup(store: ReturnType<typeof createSessionTransitionStore>): string {
	const cwd = repository();
	store.start(cwd, WORKSPACE_ID, "session-1");
	writeFileSync(join(cwd, "tracked.txt"), "changed\n");
	store.submit(
		cwd,
		WORKSPACE_ID,
		"session-1",
		{ action: "set", verdict: "success", lesson: "reuse this" },
		"tool:evolver_outcome",
		new Date(NOW).toISOString(),
	);
	return cwd;
}

function outboxDir(state: string): string {
	return join(state, "outbox", WORKSPACE_ID);
}

describe("Ready Outbox recovery contract", () => {
	test("lock contention or I/O failure queues a Ready item and retains it", () => {
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(failingRecorder());
		const cwd = setup(store);

		const result = store.finalize(cwd, WORKSPACE_ID, "session-1", graph);

		expect(result).toEqual<FinalizationResult>({
			code: "queued",
			receipt: "Outcome queued for retry.",
		});
		expect(readdirSync(outboxDir(state))).not.toHaveLength(0);
		const item = JSON.parse(
			readFileSync(join(outboxDir(state), readdirSync(outboxDir(state))[0]), "utf8"),
		) as Record<string, unknown>;
		expect(item.workspace_id).toBe(WORKSPACE_ID);
		expect(item.diff_hash).not.toBe("");
		const persisted = JSON.parse(
			readFileSync(join(state, "sessions", WORKSPACE_ID, "session-1.json"), "utf8"),
		);
		expect(persisted.pending).toBeUndefined();
		expect(readGraph(graph)).toHaveLength(0);
	});

	test("a later drain retries the Ready item and removes it on success", () => {
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(flakyThenRealRecorder(createGraphRecorder()));
		const cwd = setup(store);
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);

		const results = store.drainOutbox(WORKSPACE_ID, graph);

		expect(results).toHaveLength(1);
		expect(results[0]).toEqual<FinalizationResult>({
			code: "recorded",
			receipt: "Outcome recorded.",
		});
		expect(readdirSync(outboxDir(state))).toHaveLength(0);
		expect(readGraph(graph)).toHaveLength(1);
	});

	test("repeated failure for the same Ready identity is idempotent", () => {
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore({
			record: () => ({ code: "unavailable" }),
		} as GraphRecorder);
		const cwd = setup(store);
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);

		const first = store.drainOutbox(WORKSPACE_ID, graph);
		const second = store.drainOutbox(WORKSPACE_ID, graph);
		expect(first[0]?.code).toBe("queued");
		expect(second[0]?.code).toBe("queued");
		expect(readGraph(graph)).toHaveLength(0);
		expect(readdirSync(outboxDir(state))).toHaveLength(1);
	});

	test("a duplicate Ready item is removed without append or rewrite", () => {
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		const cwd = setup(store);
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);
		const record = JSON.parse(readFileSync(graph, "utf8").split("\n")[0]) as Record<string, unknown>;
		writeFileSync(
			join(outboxDir(state), `${record.diff_hash}.json`),
			`${JSON.stringify(record)}\n`,
			{ mode: 0o600 },
		);

		const results = store.drainOutbox(WORKSPACE_ID, graph);

		expect(results).toEqual<FinalizationResult[]>([
			{ code: "duplicate", receipt: "Outcome already recorded." },
		]);
		expect(readdirSync(outboxDir(state))).toHaveLength(0);
		expect(readGraph(graph)).toHaveLength(1);
	});

	test("a malformed Ready item is skipped without throwing", () => {
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		setup(store);
	mkdirSync(outboxDir(state), { recursive: true });
	writeFileSync(join(outboxDir(state), "malformed.json"), "not json\n", { mode: 0o600 });

		const results = store.drainOutbox(WORKSPACE_ID, graph);

		expect(Array.isArray(results)).toBe(true);
		expect(readdirSync(outboxDir(state))).not.toContain("malformed.json");
	});

	test("a throwing recorder never escapes into the drain", () => {
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore({
			record: () => {
				throw new Error("boom");
			},
		} as GraphRecorder);
		const cwd = setup(store);
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);

		const results = store.drainOutbox(WORKSPACE_ID, graph);

		expect(results[0]).toEqual<FinalizationResult>({
			code: "queued",
			receipt: "Outcome queued for retry.",
		});
		// The Ready item survives a transient throw for a later retry.
		expect(readdirSync(outboxDir(state))).toHaveLength(1);
	});

	test("Ready items are 0600 and guarded against symlinked paths", () => {
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(failingRecorder());
		const cwd = setup(store);
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);

		const dir = outboxDir(state);
		const file = join(dir, readdirSync(dir)[0]);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});

	test("a symlinked Ready item is skipped without following it", () => {
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		const cwd = setup(store);
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);
		const dir = outboxDir(state);
		const target = join(state, "outside-target");
		writeFileSync(target, "do not follow\n", { mode: 0o600 });
		symlinkSync(target, join(dir, "link.json"));

		const results = store.drainOutbox(WORKSPACE_ID, graph);

		expect(Array.isArray(results)).toBe(true);
		expect(readdirSync(dir)).not.toContain("link.json");
	});
});
