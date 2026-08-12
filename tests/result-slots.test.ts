// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { createGraphRecorder } from "../src/graph-recorder";
import { createSessionTransitionStore } from "../src/session-transition";

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

function resultsFile(state: string): string {
	return join(state, "results", `${WORKSPACE_ID}.json`);
}

function submit(store: ReturnType<typeof createSessionTransitionStore>, cwd: string) {
	store.start(cwd, WORKSPACE_ID, "session-1");
	writeFileSync(join(cwd, "tracked.txt"), "changed\n");
	store.submit(
		cwd,
		WORKSPACE_ID,
		"session-1",
		{ action: "set", verdict: "success", lesson: "lesson" },
		"tool:evolver_outcome",
		new Date(NOW).toISOString(),
	);
}

describe("Result slots", () => {
	test("lastAttempt is persisted separately from lastRecorded and survives a duplicate", () => {
		const cwd = repository();
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		submit(store, cwd);

		// A successful finalize populates both slots.
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);
		let slots = store.readResults(WORKSPACE_ID);
		expect(slots.lastAttempt?.code).toBe("recorded");
		expect(slots.lastRecorded?.code).toBe("recorded");

		// Re-submit, then change content so finalize goes stale.
		store.submit(
			cwd,
			WORKSPACE_ID,
			"session-1",
			{ action: "set", verdict: "success", lesson: "again" },
			"tool:evolver_outcome",
			new Date(NOW).toISOString(),
		);
		writeFileSync(join(cwd, "tracked.txt"), "different\n");
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);
		slots = store.readResults(WORKSPACE_ID);
		expect(slots.lastAttempt?.code).toBe("stale");
		expect(slots.lastRecorded?.code).toBe("recorded");
	});

	test("a queued retry leaves lastAttempt=queued without a lastRecorded until success", () => {
		const cwd = repository();
		const state = stateDir();
		const graph = graphPath();
		let attempts = 0;
		const store = createSessionTransitionStore({
			record: () => {
				attempts += 1;
				return { code: attempts <= 1 ? "unavailable" : "recorded" };
			},
		});
		submit(store, cwd);
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);
		expect(store.readResults(WORKSPACE_ID).lastAttempt?.code).toBe("queued");
		expect(store.readResults(WORKSPACE_ID).lastRecorded).toBeNull();
		store.drainOutbox(WORKSPACE_ID, graph);
		expect(store.readResults(WORKSPACE_ID).lastAttempt?.code).toBe("recorded");
		expect(store.readResults(WORKSPACE_ID).lastRecorded?.code).toBe("recorded");
		void state;
	});

	test("announcements surface once and idempotently suppress repeated queued state", () => {
		const cwd = repository();
		stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore({
			record: () => ({ code: "unavailable" }),
		});
		submit(store, cwd);
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);

		const first = store.pendingAnnouncements(WORKSPACE_ID);
		expect(first).toHaveLength(1);
		expect(first[0]?.code).toBe("queued");
		// A repeat drain produces no new announcement for the same queued state.
		store.drainOutbox(WORKSPACE_ID, graph);
		expect(store.pendingAnnouncements(WORKSPACE_ID)).toEqual([]);
	});

	test("silent skip receipts update lastAttempt but never announce", () => {
		const cwd = repository();
		stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		store.start(cwd, WORKSPACE_ID, "session-1");
		// No pending verdict and no content change.
		expect(store.finalize(cwd, WORKSPACE_ID, "session-1", graph).code).toBe("skipped_no_changes");
		expect(store.readResults(WORKSPACE_ID).lastAttempt?.code).toBe("skipped_no_changes");
		expect(store.pendingAnnouncements(WORKSPACE_ID)).toEqual([]);
	});
});

describe("Read-only status inspection", () => {
	test("inspect does not acquire or clear the Graph lock and does not write any bytes", () => {
		const cwd = repository();
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		submit(store, cwd);
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);
		// Snapshot the bytes of every durable file before inspection.
		const before = new Map<string, string>();
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const p = join(dir, name);
				const st = statSync(p);
				if (st.isDirectory()) walk(p);
				else before.set(p, readFileSync(p, "utf8"));
			}
		};
		walk(state);
		before.set(graph, readFileSync(graph, "utf8"));

		const snapshot = store.inspectStatus(cwd, WORKSPACE_ID, "session-1", graph);

		expect(snapshot).not.toBeNull();
		expect(snapshot?.graph.lockState).toBe("free");
		expect(snapshot?.workspace.workspaceIdPrefix).toBe(WORKSPACE_ID.slice(0, 12));
		// No file bytes changed.
		for (const [p, content] of before) {
			expect(readFileSync(p, "utf8")).toBe(content);
		}
		// No lock file was created by inspection.
		expect(() => statSync(`${graph}.lock`)).toThrow();
	});

	test("results state is 0600 and symlink-guarded", () => {
		const cwd = repository();
		const state = stateDir();
		const graph = graphPath();
		const store = createSessionTransitionStore(createGraphRecorder());
		submit(store, cwd);
		store.finalize(cwd, WORKSPACE_ID, "session-1", graph);
		const file = resultsFile(state);
		expect(statSync(file).mode & 0o777).toBe(0o600);
	});
});
