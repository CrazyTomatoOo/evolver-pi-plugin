// SPDX-License-Identifier: MIT
// Concurrency helper for the graph recorder test. Each invocation acquires the
// lock against a shared graph, records the same identity, and prints the code.

import { createGraphRecorder } from "../src/graph-recorder";
import type { OutcomeEntry } from "../src/filter";

const graphPath = process.env.EVOLVER_CONCURRENT_GRAPH;
if (!graphPath) {
	console.error("EVOLVER_CONCURRENT_GRAPH unset");
	process.exit(2);
}

const entry: OutcomeEntry = {
	timestamp: "2026-08-12T12:00:00.000Z",
	gene_id: "ad_hoc",
	signals: ["test_failure"],
	outcome: { status: "success", score: 0.8, note: "reuse this" },
	cwd: "/workspace",
	workspace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	session_id: process.env.EVOLVER_CONCURRENT_PID ?? "p",
	diff_hash: "deadbeef",
	diff_scope: "working_tree",
	source: "tool:evolver_outcome",
};

const result = createGraphRecorder().record(graphPath, entry);
console.log(result.code);
