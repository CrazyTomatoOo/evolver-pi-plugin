// SPDX-License-Identifier: MIT
// Self-check for the evolver local core. Runs the non-trivial logic against
// temp dirs (never the real ~/.evolver) and asserts the contracts hold.
// Run: bun scripts/self-check.ts   (or: npx tsx scripts/self-check.ts)

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { detectSignals } from "../src/signals";
import { filterRelevant, type OutcomeEntry } from "../src/filter";
import { resolveWorkspaceId } from "../src/paths";
import { appendEntry, gatherWorkspaceEntries } from "../src/memory";
import { buildRecallText } from "../src/recall";
import { recordOutcome } from "../src/record";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evolver-selfcheck-"));
// Keep all state in the temp sandbox, away from the real ~/.evolver.
process.env.EVOLVER_SESSION_STATE_DIR = path.join(tmp, "state");
process.env.EVOLVER_HOOK_LOG_DIR = path.join(tmp, "logs");

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

	await check(
		"filterRelevant keeps recent high-score successes, caps at 3",
		() => {
			const now = Date.now();
			const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
			const mk = (
				score: number,
				status: string,
				msAgo: number,
			): OutcomeEntry => ({
				timestamp: iso(msAgo),
				outcome: { status, score, note: "x" },
			});
			const entries = [
				mk(0.9, "success", 30 * 86400000), // drop: too old (oldest)
				mk(0.95, "success", 4 * 86400000), // recent success, oldest of the four -> dropped by cap
				mk(0.6, "success", 3 * 86400000), // keep
				mk(0.7, "success", 2 * 86400000), // keep
				mk(0.4, "success", 1 * 86400000), // drop: score < 0.5
				mk(0.3, "failed", 1 * 86400000), // drop: failed
				mk(0.8, "success", 1 * 86400000), // keep (newest)
			];
			const relevant = filterRelevant(entries);
			assert.strictEqual(relevant.length, 3, `got ${relevant.length}`);
			assert.ok(relevant.every((e) => e.outcome?.status === "success"));
			// Tail (latest) kept: the 0.95/4d is oldest of the four successes -> dropped.
			assert.ok(!relevant.some((e) => e.outcome?.score === 0.95));
		},
	);

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

	await check("memory roundtrip: append -> gather -> recall text", () => {
		const proj = path.join(tmp, "proj-mem");
		fs.mkdirSync(proj, { recursive: true });
		const graph = path.join(tmp, "graph.jsonl");
		process.env.MEMORY_GRAPH_PATH = graph;
		const wsId = resolveWorkspaceId(proj);
		const entry: OutcomeEntry = {
			timestamp: new Date().toISOString(),
			gene_id: "ad_hoc",
			signals: ["stable_success_plateau"],
			outcome: { status: "success", score: 0.8, note: "did the thing" },
			cwd: proj,
			workspace_id: wsId,
			session_id: "sess-1",
			diff_hash: "h",
			diff_scope: "working_tree",
			source: "hook:session-end",
		};
		assert.ok(appendEntry(graph, entry));
		const gathered = gatherWorkspaceEntries(graph, wsId, proj);
		assert.strictEqual(gathered.length, 1);
		const text = buildRecallText(proj);
		assert.ok(text && text.includes("[Evolution Memory]"), `text=${text}`);
		assert.ok(text!.includes("did the thing"));
		delete process.env.MEMORY_GRAPH_PATH;
	});

	await check(
		"recordOutcome classifies a real git diff into the graph",
		async () => {
			const repo = path.join(tmp, "repo");
			fs.mkdirSync(repo, { recursive: true });
			const sh = (cmd: string): void => {
				try {
					execSync(cmd, { cwd: repo, stdio: "ignore" });
				} catch (err) {
					throw new Error(`git step failed: ${cmd}: ${(err as Error).message}`);
				}
			};
			sh("git init -q");
			sh("git config user.email t@t.t");
			sh("git config user.name t");
			fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
			sh("git add -A");
			sh("git commit -qm init");
			// Introduce a working-tree change that mentions an error signal.
			fs.writeFileSync(path.join(repo, "a.txt"), "hello\nerror: it failed\n");

			const graph = path.join(tmp, "repo-graph.jsonl");
			process.env.MEMORY_GRAPH_PATH = graph;
			const receipt = await recordOutcome(repo, "sess-repo");
			assert.ok(receipt, "expected a receipt");
			const lines = fs.readFileSync(graph, "utf8").trim().split("\n");
			let rec: OutcomeEntry;
			try {
				rec = JSON.parse(lines[lines.length - 1]) as OutcomeEntry;
			} catch (err) {
				throw new Error(`bad graph json: ${(err as Error).message}`);
			}
			assert.strictEqual(rec.outcome?.status, "failed"); // log_error present
			assert.strictEqual(rec.outcome?.score, 0.3);
			assert.ok(rec.signals?.includes("log_error"));
			assert.strictEqual(rec.source, "hook:session-end");
			assert.strictEqual(rec.diff_scope, "working_tree");
			assert.ok(rec.workspace_id && /^[a-f0-9]{32}$/i.test(rec.workspace_id));
			// Dedupe: a second immediate call with the same session records nothing new.
			const before = lines.length;
			await recordOutcome(repo, "sess-repo");
			const after = fs.readFileSync(graph, "utf8").trim().split("\n").length;
			assert.strictEqual(
				after,
				before,
				"dedupe must suppress the second record",
			);
			delete process.env.MEMORY_GRAPH_PATH;
		},
	);

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
