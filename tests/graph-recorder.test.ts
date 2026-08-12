// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
	createGraphRecorder,
	type GraphRecordResult,
} from "../src/graph-recorder";
import type { OutcomeEntry } from "../src/filter";

const sandboxes: string[] = [];
afterEach(() => {
	for (const sandbox of sandboxes.splice(0)) {
		rmSync(sandbox, { recursive: true, force: true });
	}
});

function entry(workspaceId: string, diffHash: string): OutcomeEntry {
	return {
		timestamp: "2026-08-12T12:00:00.000Z",
		gene_id: "ad_hoc",
		signals: ["test_failure"],
		outcome: { status: "success", score: 0.8, note: "reuse this" },
		cwd: "/workspace",
		workspace_id: workspaceId,
		session_id: "session-1",
		diff_hash: diffHash,
		diff_scope: "working_tree",
		source: "tool:evolver_outcome",
	};
}

describe("Graph recorder", () => {
	test("records one line for a new identity and reports duplicate without append or rewrite", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolver-graph-"));
		sandboxes.push(dir);
		const graphPath = join(dir, "memory_graph.jsonl");
		const recorder = createGraphRecorder();
		const record = entry("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "deadbeef");

		const first = recorder.record(graphPath, record);
		const second = recorder.record(graphPath, {
			...record,
			outcome: { status: "failed", score: 0.3, note: "corrected lesson" },
		});

		expect(first).toEqual<GraphRecordResult>({ code: "recorded" });
		expect(second).toEqual<GraphRecordResult>({ code: "duplicate" });
		const lines = readLines(graphPath);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toEqual(record);
	});

	test("a malformed Graph line is skipped without throwing", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolver-graph-"));
		sandboxes.push(dir);
		const graphPath = join(dir, "memory_graph.jsonl");
		writeFileSync(graphPath, "not json\n\n");
		const recorder = createGraphRecorder();
		const record = entry("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "deadbeef");

		const result = recorder.record(graphPath, record);

		expect(result).toEqual<GraphRecordResult>({ code: "recorded" });
		const lines = readLines(graphPath);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toEqual(record);
	});

	test("entries from other workspaces never match an identity", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolver-graph-"));
		sandboxes.push(dir);
		const graphPath = join(dir, "memory_graph.jsonl");
		const recorder = createGraphRecorder();
		const other = entry("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "deadbeef");
		recorder.record(graphPath, other);
		const record = entry("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "deadbeef");

		const result = recorder.record(graphPath, record);

		expect(result).toEqual<GraphRecordResult>({ code: "recorded" });
		expect(readLines(graphPath)).toHaveLength(2);
	});

	test("two concurrent processes cannot both append the same identity", () => {
		const dir = mkdtempSync(join(tmpdir(), "evolver-graph-"));
		sandboxes.push(dir);
		const graphPath = join(dir, "memory_graph.jsonl");
		const script = join(__dirname, "..", "scripts", "concurrent-recorder.ts");
		const env = `EVOLVER_CONCURRENT_GRAPH=${JSON.stringify(graphPath)}`;

		const result = spawnSync(
			"bash",
			[
				"-c",
				`${env} EVOLVER_CONCURRENT_PID=1 bun ${JSON.stringify(script)} >${JSON.stringify(join(dir, "a.txt"))} 2>&1 & ${env} EVOLVER_CONCURRENT_PID=2 bun ${JSON.stringify(script)} >${JSON.stringify(join(dir, "b.txt"))} 2>&1 & wait`,
			],
			{ encoding: "utf8", timeout: 30_000 },
		);

		expect(result.status).toBe(0);
		const a = readFileSync(join(dir, "a.txt"), "utf8").trim();
		const b = readFileSync(join(dir, "b.txt"), "utf8").trim();
		expect([a, b].sort()).toEqual(["duplicate", "recorded"]);
		expect(readLines(graphPath)).toHaveLength(1);
	});
});

function readLines(graphPath: string): OutcomeEntry[] {
	const out: OutcomeEntry[] = [];
	for (const line of readFileSync(graphPath, "utf8").split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			out.push(JSON.parse(trimmed) as OutcomeEntry);
		} catch {
			// skip malformed lines (mirrors the recorder)
		}
	}
	return out;
}
