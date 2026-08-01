// SPDX-License-Identifier: MIT
// Evolution memory graph I/O. The graph is a JSONL file whose record shape is a
// hard external contract (consumed by the @evomap/evolver engine and the
// sibling Claude/Cursor plugins) — keep the field names exact.

import fs from "node:fs";
import path from "node:path";
import type { OutcomeEntry } from "./filter";

// How many workspace-matched entries to gather for recall scanning.
const MAX_SCAN_ENTRIES = 5;

/** Read a JSONL graph into entries in file order (oldest first). Malformed
 * lines are skipped. Never throws. */
export function readEntries(graphPath: string): OutcomeEntry[] {
	let content: string;
	try {
		content = fs.readFileSync(graphPath, "utf8");
	} catch (_err) {
		return [];
	}
	const out: OutcomeEntry[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}
		try {
			out.push(JSON.parse(trimmed) as OutcomeEntry);
		} catch (_err) {
			// skip malformed lines
		}
	}
	return out;
}

/** Append one JSON entry as a new line to the memory graph. Returns true on
 * success. Never throws. */
export function appendEntry(graphPath: string, entry: OutcomeEntry): boolean {
	try {
		fs.mkdirSync(path.dirname(graphPath), { recursive: true });
		fs.appendFileSync(graphPath, `${JSON.stringify(entry)}\n`);
		return true;
	} catch (_err) {
		return false;
	}
}

/** Decide whether a memory entry belongs to the current workspace.
 *   - tagged with workspace_id, our id known: match iff equal.
 *   - tagged with workspace_id, our id UNKNOWN: do not blanket-include (that
 *     would leak other workspaces' entries from a shared graph). Fall back to
 *     cwd matching.
 *   - else tagged with cwd: match iff equal (lenient only when currentDir is
 *     unknown).
 *   - untagged (no workspace_id and no cwd): always include (legacy). */
export function belongsToWorkspace(
	entry: OutcomeEntry,
	currentId: string | null,
	currentDir: string,
): boolean {
	if (entry && typeof entry.workspace_id === "string" && entry.workspace_id) {
		if (currentId === null || currentId === undefined) {
			if (typeof entry.cwd === "string" && entry.cwd) {
				return currentDir ? entry.cwd === currentDir : false;
			}
			return !currentDir;
		}
		return entry.workspace_id === currentId;
	}
	if (entry && typeof entry.cwd === "string" && entry.cwd) {
		if (!currentDir) {
			return true;
		}
		return entry.cwd === currentDir;
	}
	return true;
}

/** Read the graph and gather up to MAX_SCAN_ENTRIES entries belonging to this
 * workspace, scanning from newest (end) to oldest. Returns them in
 * chronological order. Never throws. */
export function gatherWorkspaceEntries(
	graphPath: string,
	currentId: string | null,
	currentDir: string,
): OutcomeEntry[] {
	let content: string;
	try {
		content = fs.readFileSync(graphPath, "utf8");
	} catch (_err) {
		return [];
	}

	const lines = content.split("\n");
	const collected: OutcomeEntry[] = [];
	for (let i = lines.length - 1; i >= 0; i -= 1) {
		const line = lines[i].trim();
		if (!line) {
			continue;
		}
		let entry: OutcomeEntry;
		try {
			entry = JSON.parse(line) as OutcomeEntry;
		} catch (_err) {
			continue; // skip malformed lines
		}
		if (belongsToWorkspace(entry, currentId, currentDir)) {
			collected.push(entry);
			if (collected.length >= MAX_SCAN_ENTRIES) {
				break;
			}
		}
	}

	collected.reverse(); // newest-first -> chronological
	return collected;
}
