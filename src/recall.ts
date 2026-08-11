// SPDX-License-Identifier: MIT
// Ported from EvoMap/evolver-claude-code-plugin `hooks/session-start.js` (MIT).
// Builds the session-start recall text: recent workspace-scoped evolution
// memory plus an optional non-git notice. Fails open (null).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isGitWorkspace, findMemoryGraph, resolveWorkspaceId } from "./paths";
import { filterRelevant, type OutcomeEntry } from "./filter";
import { gatherWorkspaceEntries } from "./memory";

const LINE_MAX = 200; // per-outcome line truncation
const NONGIT_TTL_MS = 30 * 60 * 1000; // throttle the non-git notice
const THROTTLE_PRUNE_MS = 24 * 60 * 60 * 1000;

const NONGIT_NOTICE =
	"[Evolver] This folder is not a git repository, so evolution memory is " +
	"inactive (outcomes are derived from git diffs). Run `git init` here, or " +
	"open a git project, to enable recall and recording.";

/** Lightweight throttle backed by a small JSON map of key -> last-fired epoch.
 * Returns true when `key` fired within `ttlMs` (caller should suppress).
 * Otherwise records "now" and returns false. Fails open (false) on error. */
function throttled(key: string, ttlMs: number): boolean {
	try {
		const base =
			process.env.EVOLVER_SESSION_STATE_DIR ||
			path.join(os.homedir(), ".evolver");
		const stateFile = path.join(base, "session-start-state.json");

		let state: Record<string, number> = {};
		try {
			const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
			if (parsed && typeof parsed === "object") {
				state = parsed as Record<string, number>;
			}
		} catch (_err) {
			state = {};
		}

		const now = Date.now();
		const last = state[key];
		if (typeof last === "number" && now - last < ttlMs) {
			return true; // recently fired -> suppress
		}

		state[key] = now;
		for (const k of Object.keys(state)) {
			if (typeof state[k] !== "number" || now - state[k] > THROTTLE_PRUNE_MS) {
				delete state[k];
			}
		}

		try {
			fs.mkdirSync(base, { recursive: true });
			fs.writeFileSync(stateFile, JSON.stringify(state));
		} catch (_err) {
			// best effort
		}
		return false;
	} catch (_err) {
		return false; // fail open
	}
}

/** Format the human-readable outcome summary block from filtered entries. */
function formatSummary(outcomes: OutcomeEntry[]): string {
	const successes = outcomes.filter(
		(o) => o.outcome && o.outcome.status === "success",
	).length;
	const failures = outcomes.filter(
		(o) => o.outcome && o.outcome.status === "failed",
	).length;

	const header =
		`[Evolution Memory] Recent ${outcomes.length} outcomes ` +
		`(${successes} success, ${failures} failed):`;

	const rows = outcomes.map((entry) => {
		const outcome = entry.outcome || {};
		let icon = "?";
		if (outcome.status === "success") {
			icon = "+";
		} else if (outcome.status === "failed") {
			icon = "-";
		}
		const date =
			typeof entry.timestamp === "string"
				? entry.timestamp.slice(0, 10)
				: "??????????";
		const score = typeof outcome.score === "number" ? outcome.score : "?";
		const signals = Array.isArray(entry.signals)
			? entry.signals.slice(0, 3).join(", ")
			: "";
		const note = typeof outcome.note === "string" ? outcome.note : "";
		const line = `[${icon}] ${date} score=${score} signals=[${signals}] ${note}`;
		return line.length > LINE_MAX ? line.slice(0, LINE_MAX) : line;
	});

	return (
		[header, ...rows].join("\n") +
		"\n\nUse successful approaches. Avoid repeating failed patterns."
	);
}

/** Build the recall text for `projectDir`, or null when there is nothing worth
 * injecting. Never throws. */
export function buildRecallText(projectDir: string): string | null {
	const parts: string[] = [];
	const currentDir = projectDir;

	// 1. Non-git notice (throttled per directory).
	try {
		if (!isGitWorkspace(currentDir)) {
			if (!throttled(`nongit:${currentDir}`, NONGIT_TTL_MS)) {
				parts.push(NONGIT_NOTICE);
			}
		}
	} catch (_err) {
		// ignore — notice is optional
	}

	// 2. Workspace-scoped evolution memory.
	try {
		const graphPath = findMemoryGraph(currentDir);
		const currentId = resolveWorkspaceId(currentDir);
		const candidates = gatherWorkspaceEntries(graphPath, currentId, currentDir);
		const relevant = filterRelevant(candidates);
		if (relevant.length > 0) {
			parts.push(formatSummary(relevant));
		}
	} catch (_err) {
		// ignore — memory injection is optional
	}

	if (parts.length === 0) {
		return null;
	}
	return parts.join("\n\n");
}
