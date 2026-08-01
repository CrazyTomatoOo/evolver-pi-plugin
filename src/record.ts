// SPDX-License-Identifier: MIT
// Ported from EvoMap/evolver-claude-code-plugin `hooks/session-end.js` (MIT).
// Records the outcome of a session by inspecting the git diff of the project
// directory, writing a memory-graph entry (and optionally posting to a Hub),
// and leaving a breadcrumb in the evolution log. Fails open.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { findMemoryGraph, resolveWorkspaceId } from "./paths";
import { detectSignals } from "./signals";
import { appendEntry } from "./memory";
import type { OutcomeEntry } from "./filter";

const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 10 * 1024 * 1024; // 10 MB
const HUB_TIMEOUT_MS = 8000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value || "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const SESSION_END_DEDUPE_TTL_MS = parsePositiveInt(
	process.env.EVOLVER_SESSION_END_DEDUPE_TTL_MS,
	6 * 60 * 60 * 1000,
);
const SESSION_END_PRUNE_MS = Math.max(
	SESSION_END_DEDUPE_TTL_MS,
	24 * 60 * 60 * 1000,
);

/** Append a timestamped line to the evolution log. Best effort; never throws. */
function appendEvolutionLog(line: string): void {
	try {
		const dir =
			process.env.EVOLVER_HOOK_LOG_DIR ||
			path.join(os.homedir(), ".evolver", "logs");
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "evolution.log");
		fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
	} catch (_err) {
		// best effort
	}
}

interface GitResult {
	status: number;
	stdout: string;
}

/** Run a git subcommand in `cwd`, returning { status, stdout }. Never throws. */
function git(args: string[], cwd: string): GitResult {
	try {
		const result = spawnSync("git", args, {
			cwd,
			shell: false,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: GIT_MAX_BUFFER,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return {
			status: typeof result.status === "number" ? result.status : 1,
			stdout: typeof result.stdout === "string" ? result.stdout : "",
		};
	} catch (_err) {
		return { status: 1, stdout: "" };
	}
}

interface Diff {
	isRepo: boolean;
	statText: string;
	body: string;
}

/** Collect the git diff for the session (working tree + staged). */
function collectDiff(projectDir: string): Diff {
	const insideTree = git(["rev-parse", "--is-inside-work-tree"], projectDir);
	const isRepo = insideTree.status === 0 && insideTree.stdout.trim() === "true";
	if (!isRepo) {
		return { isRepo, statText: "", body: "" };
	}

	const statParts: string[] = [];
	const unstagedStat = git(["diff", "--stat", "--"], projectDir);
	if (unstagedStat.status === 0 && unstagedStat.stdout.trim().length > 0) {
		statParts.push(unstagedStat.stdout);
	}
	const stagedStat = git(["diff", "--cached", "--stat", "--"], projectDir);
	if (stagedStat.status === 0 && stagedStat.stdout.trim().length > 0) {
		statParts.push(stagedStat.stdout);
	}

	const bodyParts: string[] = [];
	const unstagedBody = git(["diff", "--no-color", "--"], projectDir);
	if (unstagedBody.status === 0 && unstagedBody.stdout.trim().length > 0) {
		bodyParts.push(unstagedBody.stdout);
	}
	const stagedBody = git(["diff", "--cached", "--no-color", "--"], projectDir);
	if (stagedBody.status === 0 && stagedBody.stdout.trim().length > 0) {
		bodyParts.push(stagedBody.stdout);
	}

	return {
		isRepo,
		statText: statParts.join("\n"),
		body: bodyParts.join("\n"),
	};
}

/** Parse "N files changed, A insertions(+), D deletions(-)" from a --stat tail. */
function parseStat(statText: string): {
	files: number;
	insertions: number;
	deletions: number;
} {
	function sum(regex: RegExp): number {
		let total = 0;
		for (const match of statText.matchAll(regex)) {
			total += parseInt(match[1], 10);
		}
		return total;
	}
	return {
		files: sum(/(\d+)\s+files?\s+changed/g),
		insertions: sum(/(\d+)\s+insertions?\(\+\)/g),
		deletions: sum(/(\d+)\s+deletions?\(-\)/g),
	};
}

function hashText(text: string): string {
	return crypto
		.createHash("sha256")
		.update(String(text || ""))
		.digest("hex");
}

/** Once-per-session dedupe guard backed by a small state file. Returns whether
 * this (session/diff) may record now. Fails open (true) on error. */
function claimSessionRecord(args: {
	projectDir: string;
	workspaceId: string | null;
	sessionId: string | null;
	diffHash: string;
}): { claimed: boolean; key: string | null } {
	const { projectDir, workspaceId, sessionId, diffHash } = args;
	try {
		const base =
			process.env.EVOLVER_SESSION_STATE_DIR ||
			path.join(os.homedir(), ".evolver");
		const stateFile = path.join(base, "session-end-state.json");

		let state: Record<string, unknown> = {};
		try {
			const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				state = parsed as Record<string, unknown>;
			}
		} catch (_err) {
			state = {};
		}

		const now = Date.now();
		const key = sessionId
			? `session:${sessionId}`
			: `workspace:${workspaceId || projectDir}:diff:${diffHash}`;
		const previous = state[key];
		const previousTs =
			typeof previous === "number"
				? previous
				: previous && typeof (previous as { ts?: number }).ts === "number"
					? (previous as { ts: number }).ts
					: 0;
		if (previousTs > 0 && now - previousTs < SESSION_END_DEDUPE_TTL_MS) {
			return { claimed: false, key };
		}

		state[key] = { ts: now, diff_hash: diffHash };
		for (const existingKey of Object.keys(state)) {
			const value = state[existingKey];
			const ts =
				typeof value === "number"
					? value
					: value && typeof (value as { ts?: number }).ts === "number"
						? (value as { ts: number }).ts
						: 0;
			if (ts <= 0 || now - ts > SESSION_END_PRUNE_MS) {
				delete state[existingKey];
			}
		}

		fs.mkdirSync(base, { recursive: true });
		const tmp = `${stateFile}.${process.pid}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
		fs.renameSync(tmp, stateFile);
		return { claimed: true, key };
	} catch (_err) {
		return { claimed: true, key: null };
	}
}

/** Attempt to POST the outcome to a configured Hub. Never throws. */
async function recordToHub(payload: Record<string, unknown>): Promise<boolean> {
	try {
		const hubUrl = process.env.EVOMAP_HUB_URL || process.env.A2A_HUB_URL;
		const apiKey = process.env.EVOMAP_API_KEY || process.env.A2A_NODE_SECRET;
		if (!hubUrl || !apiKey || typeof fetch !== "function") {
			return false;
		}
		const url = new URL(
			"/a2a/evolution/record",
			`${hubUrl.replace(/\/+$/, "")}/`,
		);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), HUB_TIMEOUT_MS);
		if (typeof timer.unref === "function") {
			timer.unref();
		}
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			return response.ok;
		} finally {
			clearTimeout(timer);
		}
	} catch (_err) {
		return false;
	}
}

/** Classify the session's git diff and record the outcome. Returns a receipt
 * string describing where the outcome landed, or null when nothing was
 * recorded (no changes / deduped). Never throws. */
export async function recordOutcome(
	projectDir: string,
	sessionId: string | null,
): Promise<string | null> {
	try {
		const diff = collectDiff(projectDir);
		const stats = parseStat(diff.statText);
		const hasChanges =
			diff.statText.trim().length > 0 || diff.body.trim().length > 0;

		// No changes: just leave a breadcrumb, never a memory-graph entry.
		if (!hasChanges) {
			const reason = diff.isRepo
				? "no changes detected this session"
				: "not a git workspace";
			appendEvolutionLog(
				`[Evolution] Session end: nothing recorded (${reason}).`,
			);
			return null;
		}

		const workspaceId = resolveWorkspaceId(projectDir);
		const diffHash = hashText(diff.body || diff.statText);
		const claim = claimSessionRecord({
			projectDir,
			workspaceId,
			sessionId,
			diffHash,
		});
		if (!claim.claimed) {
			appendEvolutionLog(
				`[Evolution] Session end: duplicate outcome suppressed (${claim.key}).`,
			);
			return null;
		}

		// Changes present: derive signals / status / score.
		let signals = detectSignals(diff.body);
		if (signals.length === 0) {
			signals = ["stable_success_plateau"];
		}
		const failed =
			signals.includes("log_error") || signals.includes("test_failure");
		const status = failed ? "failed" : "success";
		const score = failed ? 0.3 : 0.8;

		const summary =
			`Session end: ${stats.files} files changed, ` +
			`+${stats.insertions}/-${stats.deletions}. Signals: [${signals.join(", ")}]`;

		// Try the Hub first (if configured).
		const hubOk = await recordToHub({
			gene_id: "ad_hoc",
			signals,
			status,
			score,
			summary,
			session_id: sessionId,
			workspace_id: workspaceId,
			diff_hash: diffHash,
			sender_id: process.env.EVOMAP_NODE_ID || process.env.A2A_NODE_ID,
		});

		// Always also attempt a local record.
		const entry: OutcomeEntry = {
			timestamp: new Date().toISOString(),
			gene_id: "ad_hoc",
			signals,
			outcome: { status, score, note: summary },
			cwd: projectDir,
			workspace_id: workspaceId,
			session_id: sessionId,
			diff_hash: diffHash,
			diff_scope: "working_tree",
			source: "hook:session-end",
		};
		const localOk = appendEntry(findMemoryGraph(projectDir), entry);

		let destination: string;
		if (hubOk) {
			destination = "Hub";
		} else if (localOk) {
			destination = "local memory";
		} else {
			destination = "nowhere (no Hub or local path)";
		}
		const receipt = `[Evolution] Session outcome recorded to ${destination}: ${summary}`;
		appendEvolutionLog(receipt);
		return receipt;
	} catch (_err) {
		return null;
	}
}
