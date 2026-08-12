// SPDX-License-Identifier: MIT
// Graph access and locking seam. The memory graph is a JSONL file whose record
// shape is a hard external contract (see ./memory.ts). This recorder serializes
// the check-and-append transaction under a short-lived local exclusive lock so
// concurrent writers cannot both win. Never throws into Pi.

import { closeSync, constants, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { OutcomeEntry } from "./filter";

export type GraphRecordCode = "recorded" | "duplicate" | "unavailable" | "error";

export interface GraphRecordResult {
	code: GraphRecordCode;
}

export interface GraphRecorder {
	record(graphPath: string, entry: OutcomeEntry): GraphRecordResult;
}

const LOCK_DEADLINE_MS = 2_000;

function identityMatches(entry: OutcomeEntry, candidate: OutcomeEntry): boolean {
	return (
		candidate.workspace_id === entry.workspace_id &&
		candidate.diff_hash === entry.diff_hash
	);
}

function existingIdentity(graphPath: string, entry: OutcomeEntry): boolean {
	let content: string;
	try {
		content = readFileSync(graphPath, "utf8");
	} catch {
		return false;
	}
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const candidate = JSON.parse(trimmed) as OutcomeEntry;
			if (identityMatches(entry, candidate)) return true;
		} catch {
			// skip malformed lines
		}
	}
	return false;
}

function acquireLock(lockPath: string): number | null {
	const deadline = Date.now() + LOCK_DEADLINE_MS;
	while (Date.now() < deadline) {
		try {
			return openSync(
				lockPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") return null;
		}
		// Stall detection: a lock older than the deadline is considered abandoned
		// (e.g. a crashed writer) and is removed so a later writer may proceed.
		try {
			if (Date.now() - statSync(lockPath).mtimeMs > LOCK_DEADLINE_MS) {
				unlinkSync(lockPath);
			}
		} catch {
			// ignore
		}
	}
	return null;
}

function releaseLock(lockPath: string, fd: number | null): void {
	if (fd !== null) {
		try {
			closeSync(fd);
		} catch {
			// ignore
		}
	}
	try {
		unlinkSync(lockPath);
	} catch {
		// ignore
	}
}

export function createGraphRecorder(): GraphRecorder {
	return {
		record(graphPath, entry) {
			const lockPath = `${graphPath}.lock`;
			let fd: number | null = null;
			try {
				fd = acquireLock(lockPath);
				if (fd === null) return { code: "unavailable" };
				if (existingIdentity(graphPath, entry)) return { code: "duplicate" };
				try {
					mkdirSync(dirname(graphPath), { recursive: true });
					writeFileSync(graphPath, `${JSON.stringify(entry)}\n`, { flag: "a" });
					return { code: "recorded" };
				} catch {
					return { code: "error" };
				}
			} catch {
				return { code: "error" };
			} finally {
				releaseLock(lockPath, fd);
			}
		},
	};
}
