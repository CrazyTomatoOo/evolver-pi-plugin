// SPDX-License-Identifier: MIT
// Self-check for the evolver local core. Runs the non-trivial logic against
// temp dirs (never the real ~/.evolver) and asserts the contracts hold.
// Run: bun scripts/self-check.ts   (or: npx tsx scripts/self-check.ts)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { detectSignals } from "../src/signals";
import { createCoreCoordinator } from "../src/core-coordinator";
import type { OutcomeEntry } from "../src/filter";
import { resolveWorkspaceId } from "../src/paths";
import { appendEntry, gatherWorkspaceEntries } from "../src/memory";
import { loadRecall } from "../src/recall";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evolver-selfcheck-"));
// Keep all state in the temp sandbox, away from the real ~/.evolver.
process.env.EVOLVER_SESSION_STATE_DIR = path.join(tmp, "state");

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

async function main() {
	await check("detectSignals finds prose signals, skips code lines", () => {
		const prose = "The deploy failed and there was a timeout under load.";
		const sigs = detectSignals(prose);
		assert.ok(sigs.includes("deployment_issue"), `got ${sigs}`);
		assert.ok(sigs.includes("perf_bottleneck"), `got ${sigs}`);
		// Pure code/comment lines mentioning keywords must NOT fire.
		assert.deepStrictEqual(
			detectSignals("// error: handled\n{ failed: true }"),
			[],
		);
		assert.deepStrictEqual(detectSignals(""), []);
	});

	await check("resolveWorkspaceId forges a stable 32-hex 0600 id", () => {
		const proj = path.join(tmp, "proj-ws");
		fs.mkdirSync(proj, { recursive: true });
		delete process.env.EVOLVER_WORKSPACE_ID;
		const id1 = resolveWorkspaceId(proj);
		assert.ok(id1 && /^[a-f0-9]{32}$/i.test(id1), `id1=${id1}`);
		const id2 = resolveWorkspaceId(proj);
		assert.strictEqual(id1, id2, "id must be stable across calls");
		// Env override wins.
		process.env.EVOLVER_WORKSPACE_ID = "f".repeat(32);
		assert.strictEqual(resolveWorkspaceId(proj), "f".repeat(32));
		delete process.env.EVOLVER_WORKSPACE_ID;
	});

	await check("memory roundtrip delivers first-turn recall", async () => {
		const proj = path.join(tmp, "proj-mem");
		spawnSync("git", ["init", "-q", proj], { stdio: "ignore" });
		const graph = path.join(tmp, "graph.jsonl");
		process.env.MEMORY_GRAPH_PATH = graph;
		const wsId = resolveWorkspaceId(proj);
		const entry: OutcomeEntry = {
			timestamp: new Date().toISOString(),
			gene_id: "ad_hoc",
			signals: ["capability_gap"],
			outcome: { status: "success", score: 0.8, note: "did the thing" },
			cwd: proj,
			workspace_id: wsId,
			session_id: "sess-1",
			diff_hash: "h",
			diff_scope: "working_tree",
			source: "tool:evolver_outcome",
		};
		assert.ok(appendEntry(graph, entry));
		const gathered = gatherWorkspaceEntries(graph, wsId, proj);
		assert.strictEqual(gathered.length, 1);
		const core = createCoreCoordinator({
			loadRecall,
			now: Date.now,
			detectSignals,
		});
		await core.sessionStart({ cwd: proj, reason: "startup" });
		const effects = await core.beforeAgentStart({
			cwd: proj,
			deliveredRecalls: [],
		});
		assert.strictEqual(effects.length, 1);
		assert.ok(effects[0]?.content.includes("did the thing"));
		delete process.env.MEMORY_GRAPH_PATH;
	});


	console.log(`\n${passed} checks passed.`);
}

main()
	.then(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
		process.exit(0);
	})
	.catch((err) => {
		console.error(err);
		fs.rmSync(tmp, { recursive: true, force: true });
		process.exit(1);
	});
