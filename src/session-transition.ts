// SPDX-License-Identifier: MIT

import {
	chmodSync,
	closeSync,
	constants,
	mkdirSync,
	readdirSync,
	openSync,
	readFileSync,
	renameSync,
	lstatSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { captureWorkspaceSnapshot, type WorkspaceSnapshot } from "./workspace-snapshot";
import type { OutcomeEntry } from "./filter";
import type { GraphRecorder } from "./graph-recorder";
export type { GraphRecordResult, GraphRecordCode } from "./graph-recorder";
export type { GraphRecorder };

export type OutcomeVerdict = "success" | "failed";
export type OutcomeSource = "tool:evolver_outcome" | "command:evolver-outcome";

export interface PendingOutcome {
	verdict: OutcomeVerdict;
	lesson: string;
	source: OutcomeSource;
	submittedAt: string;
	endSnapshot: WorkspaceSnapshot;
}

export type OutcomeSubmission =
	| { action: "set"; verdict: OutcomeVerdict; lesson: string }
	| { action: "clear" };

export type OutcomeSubmissionCode =
	| "accepted"
	| "replaced"
	| "cleared"
	| "no_op"
	| "invalid"
	| "unavailable"
	| "no_changes";

export interface OutcomeSubmissionResult {
	code: OutcomeSubmissionCode;
	receipt: string;
}

export interface SessionTransitionState {
	version: 1;
	workspaceId: string;
	sessionId: string;
	baseline: WorkspaceSnapshot;
	signals: string[];
	pending?: PendingOutcome;
}

export interface SessionTransitionInspection extends SessionTransitionState {
	current: WorkspaceSnapshot;
	changed: boolean;
}

export type FinalizationCode =
	| "recorded"
	| "duplicate"
	| "skipped_no_verdict"
	| "skipped_no_changes"
	| "stale"
	| "queued"
	| "unavailable"
	| "error";

export interface FinalizationResult {
	code: FinalizationCode;
	receipt: string;
}

export interface SessionTransitionStore {
	start(cwd: string, workspaceId: string, sessionId: string): SessionTransitionState | null;
	addSignals(
		workspaceId: string,
		sessionId: string,
		signals: string[],
	): SessionTransitionState | null;
	submit(
		cwd: string,
		workspaceId: string,
		sessionId: string,
		submission: OutcomeSubmission,
		source: OutcomeSource,
		submittedAt: string,
	): OutcomeSubmissionResult;
	inspect(
		cwd: string,
		workspaceId: string,
		sessionId: string,
	): SessionTransitionInspection | null;
	finalize(
		cwd: string,
		workspaceId: string,
		sessionId: string,
		graphPath: string,
	): FinalizationResult;
	drainOutbox(workspaceId: string, graphPath: string): FinalizationResult[];
	recoverCrashLeft(cwd: string, workspaceId: string, graphPath: string): FinalizationResult[];
}

const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const WORKSPACE_PATTERN = /^[a-f0-9]{32,}$/;

const RECEIPTS: Record<OutcomeSubmissionCode, string> = {
	accepted: "Pending Outcome accepted.",
	replaced: "Pending Outcome replaced.",
	cleared: "Pending Outcome cleared.",
	no_op: "No pending Outcome to clear.",
	invalid: "Outcome submission is invalid.",
	unavailable: "Outcome submission is unavailable.",
	no_changes: "Workspace has no content changes.",
};

const FINALIZE_RECEIPTS: Record<FinalizationCode, string> = {
	recorded: "Outcome recorded.",
	duplicate: "Outcome already recorded.",
	skipped_no_verdict: "No pending Outcome to finalize.",
	skipped_no_changes: "Workspace has no content changes.",
	stale: "Pending Outcome is stale.",
	queued: "Outcome queued for retry.",
	unavailable: "Outcome finalization is unavailable.",
	error: "Outcome finalization failed.",
};

function finalizeResult(code: FinalizationCode): FinalizationResult {
	return { code, receipt: FINALIZE_RECEIPTS[code] };
}

function transitionHash(start: WorkspaceSnapshot, end: WorkspaceSnapshot): string {
	return createHash("sha256")
		.update(`evolver-transition-v1\n${start.hash}\n${end.hash}`)
		.digest("hex");
}

function buildRecord(
	cwd: string,
	workspaceId: string,
	sessionId: string,
	state: SessionTransitionState,
	pending: PendingOutcome,
): OutcomeEntry {
	return {
		timestamp: pending.submittedAt,
		gene_id: "ad_hoc",
		signals: state.signals,
		outcome: {
			status: pending.verdict,
			score: pending.verdict === "success" ? 0.8 : 0.3,
			note: pending.lesson,
		},
		cwd,
		workspace_id: workspaceId,
		session_id: sessionId,
		diff_hash: transitionHash(state.baseline, pending.endSnapshot),
		diff_scope: "working_tree",
		source: pending.source,
	};
}

function result(code: OutcomeSubmissionCode): OutcomeSubmissionResult {
	return { code, receipt: RECEIPTS[code] };
}

function normalizeSubmission(submission: OutcomeSubmission): OutcomeSubmission | null {
	if (typeof submission !== "object" || submission === null) return null;
	const value = submission as Record<string, unknown>;
	const keys = Object.keys(value).sort();
	if (value.action === "clear" && keys.length === 1) return { action: "clear" };
	if (
		value.action !== "set" ||
		(value.verdict !== "success" && value.verdict !== "failed") ||
		typeof value.lesson !== "string" ||
		keys.length !== 3
	) {
		return null;
	}
	if (value.lesson.length > 2_000) return null;
	const lesson = value.lesson.trim().replace(/\s+/g, " ");
	if (lesson.length < 1 || lesson.length > 500) return null;
	return { action: "set", verdict: value.verdict, lesson };
}
function stateRoot(): string {
	return process.env.EVOLVER_SESSION_STATE_DIR || join(homedir(), ".evolver");
}

function statePath(workspaceId: string, sessionId: string): string | null {
	if (!WORKSPACE_PATTERN.test(workspaceId) || !ID_PATTERN.test(sessionId)) return null;
	return join(stateRoot(), "sessions", workspaceId, `${sessionId}.json`);
}

function readState(path: string): SessionTransitionState | null {
	try {
		if (lstatSync(path).isSymbolicLink()) return null;
		const stat = statSync(path);
		if (!stat.isFile() || stat.mode & 0o077) return null;
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<SessionTransitionState>;
		if (
			value.version !== 1 ||
			typeof value.workspaceId !== "string" ||
			typeof value.sessionId !== "string" ||
			!value.baseline ||
			!Array.isArray(value.baseline.manifest) ||
			typeof value.baseline.hash !== "string" ||
			!Array.isArray(value.signals)
		) {
			return null;
		}
		return value as SessionTransitionState;
	} catch {
		return null;
	}
}

function writeState(path: string, state: unknown): boolean {
	let fd: number | undefined;
	const temp = `${path}.tmp-${process.pid}`;
	try {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		fd = openSync(
			temp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		writeFileSync(fd, `${JSON.stringify(state)}\n`);
		closeSync(fd);
		fd = undefined;
		chmodSync(temp, 0o600);
		renameSync(temp, path);
		chmodSync(path, 0o600);
		return true;
	} catch {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// ignore
			}
		}
		try {
			unlinkSync(temp);
		} catch {
			// ignore
		}
		return false;
	}
}

function matchingState(
	path: string,
	workspaceId: string,
	sessionId: string,
): SessionTransitionState | null {
	const state = readState(path);
	return state?.workspaceId === workspaceId && state.sessionId === sessionId ? state : null;
}

function outboxDir(workspaceId: string): string | null {
	if (!WORKSPACE_PATTERN.test(workspaceId)) return null;
	return join(stateRoot(), "outbox", workspaceId);
}

function outboxPath(workspaceId: string, diffHash: string): string | null {
	if (!/^[a-f0-9]+$/.test(diffHash)) return null;
	const dir = outboxDir(workspaceId);
	if (!dir) return null;
	return join(dir, `${diffHash}.json`);
}

function listReadyRecords(workspaceId: string): { path: string; record: OutcomeEntry }[] {
	const dir = outboxDir(workspaceId);
	if (!dir) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: { path: string; record: OutcomeEntry }[] = [];
	for (const name of entries.sort()) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		try {
			if (lstatSync(path).isSymbolicLink()) {
				try {
					unlinkSync(path);
				} catch {
					// ignore
				}
				continue;
			}
			const stat = statSync(path);
			if (!stat.isFile() || stat.mode & 0o077) {
				// Drop unreadable/unsafe items rather than retrying them forever.
				try {
					unlinkSync(path);
				} catch {
					// ignore
				}
				continue;
			}
			const record = JSON.parse(readFileSync(path, "utf8")) as OutcomeEntry;
			if (
				record.workspace_id === workspaceId &&
				typeof record.diff_hash === "string" &&
				record.diff_hash.length > 0
			) {
				out.push({ path, record });
			} else {
				try {
					unlinkSync(path);
				} catch {
					// ignore
				}
			}
		} catch {
			// malformed or unreadable item — drop it
			try {
				unlinkSync(path);
			} catch {
				// ignore
			}
		}
	}
	return out;
}
function writeReadyRecord(path: string, record: OutcomeEntry): boolean {
	return writeState(path, record);
}

function removeReadyRecord(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// ignore
	}
}

function listCrashLeftSessions(workspaceId: string): { path: string; state: SessionTransitionState }[] {
	const dir = join(stateRoot(), "sessions", workspaceId);
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: { path: string; state: SessionTransitionState }[] = [];
	for (const name of entries.sort()) {
		if (!name.endsWith(".json")) continue;
		const path = join(dir, name);
		const state = readState(path);
		if (state?.workspaceId === workspaceId && state.pending) {
			out.push({ path, state });
		}
	}
	return out;
}

export function createSessionTransitionStore(
	recorder: GraphRecorder,
): SessionTransitionStore {
	return {
		start(cwd, workspaceId, sessionId) {
			const path = statePath(workspaceId, sessionId);
			if (!path) return null;
			const existing = matchingState(path, workspaceId, sessionId);
			if (existing) return existing;
			try {
				lstatSync(path);
				return null;
			} catch {
				// create only when the state path is genuinely absent
			}
			const baseline = captureWorkspaceSnapshot(cwd);
			if (!baseline) return null;
			const state: SessionTransitionState = {
				version: 1,
				workspaceId,
				sessionId,
				baseline,
				signals: [],
			};
			return writeState(path, state) ? state : null;
		},

		addSignals(workspaceId, sessionId, signals) {
			const path = statePath(workspaceId, sessionId);
			if (!path) return null;
			const state = matchingState(path, workspaceId, sessionId);
			if (!state) return null;
			state.signals = Array.from(new Set([...state.signals, ...signals])).sort((left, right) =>
				left.localeCompare(right),
			);
			return writeState(path, state) ? state : null;
		},

		submit(cwd, workspaceId, sessionId, submission, source, submittedAt) {
			if (source !== "tool:evolver_outcome" && source !== "command:evolver-outcome") {
				return result("invalid");
			}
			const normalized = normalizeSubmission(submission);
			if (!normalized) return result("invalid");
			const path = statePath(workspaceId, sessionId);
			if (!path) return result("unavailable");
			const state = matchingState(path, workspaceId, sessionId);
			if (!state) return result("unavailable");
			if (normalized.action === "clear") {
				if (!state.pending) return result("no_op");
				delete state.pending;
				return writeState(path, state) ? result("cleared") : result("unavailable");
			}
			const current = captureWorkspaceSnapshot(cwd);
			if (!current) return result("unavailable");
			if (current.hash === state.baseline.hash) return result("no_changes");
			const code = state.pending ? "replaced" : "accepted";
			state.pending = {
				verdict: normalized.verdict,
				lesson: normalized.lesson,
				source,
				submittedAt,
				endSnapshot: current,
			};
			return writeState(path, state) ? result(code) : result("unavailable");
		},

		inspect(cwd, workspaceId, sessionId) {
			const path = statePath(workspaceId, sessionId);
			if (!path) return null;
			const state = matchingState(path, workspaceId, sessionId);
			const current = captureWorkspaceSnapshot(cwd);
			if (!state || !current) return null;
			return { ...state, current, changed: state.baseline.hash !== current.hash };
		},

		finalize(cwd, workspaceId, sessionId, graphPath) {
			const path = statePath(workspaceId, sessionId);
			if (!path) return finalizeResult("unavailable");
			const state = matchingState(path, workspaceId, sessionId);
			if (!state) return finalizeResult("unavailable");
			const pending = state.pending;
			if (!pending) {
				const current = captureWorkspaceSnapshot(cwd);
				if (current && current.hash === state.baseline.hash) {
					return finalizeResult("skipped_no_changes");
				}
				return finalizeResult("skipped_no_verdict");
			}
			const current = captureWorkspaceSnapshot(cwd);
			if (!current) return finalizeResult("unavailable");
			if (current.hash !== pending.endSnapshot.hash) {
				return finalizeResult("stale");
			}
			if (current.hash === state.baseline.hash) {
				return finalizeResult("skipped_no_changes");
			}
		const record = buildRecord(cwd, workspaceId, sessionId, state, pending);
		const readyPath = outboxPath(workspaceId, record.diff_hash as string);
		if (readyPath && !writeReadyRecord(readyPath, record)) {
			return finalizeResult("error");
		}
		// Pending is settled once the Ready item is durable.
		delete state.pending;
		if (!writeState(path, state)) return finalizeResult("error");
		let recorded;
		try {
			recorded = recorder.record(graphPath, record);
		} catch {
			// A transient throw leaves the Ready item in place for a later retry.
			return finalizeResult("queued");
		}
		if (recorded.code === "recorded" || recorded.code === "duplicate") {
			if (readyPath) removeReadyRecord(readyPath);
			return finalizeResult(recorded.code);
		}
		// Lock contention or I/O failure: keep the Ready item for later retry.
		return finalizeResult("queued");
		},

		drainOutbox(workspaceId, graphPath) {
			const results: FinalizationResult[] = [];
			for (const { path, record } of listReadyRecords(workspaceId)) {
				try {
					const recorded = recorder.record(graphPath, record);
					if (recorded.code === "recorded" || recorded.code === "duplicate") {
						removeReadyRecord(path);
						results.push(finalizeResult(recorded.code));
					} else {
						results.push(finalizeResult("queued"));
					}
				} catch {
				results.push(finalizeResult("queued"));
				}
			}
			return results;
		},

		recoverCrashLeft(cwd, workspaceId, graphPath) {
			const results: FinalizationResult[] = [];
			for (const { path, state } of listCrashLeftSessions(workspaceId)) {
				const pending = state.pending;
				if (!pending) continue;
				const current = captureWorkspaceSnapshot(cwd);
				if (!current || current.hash !== pending.endSnapshot.hash) {
					// The submitted snapshot no longer matches reality — mark stale and settle.
					delete state.pending;
					writeState(path, state);
					results.push(finalizeResult("stale"));
					continue;
				}
				if (current.hash === state.baseline.hash) {
					delete state.pending;
					writeState(path, state);
					results.push(finalizeResult("skipped_no_changes"));
					continue;
				}
				const record = buildRecord(cwd, workspaceId, state.sessionId, state, pending);
			const readyPath = outboxPath(workspaceId, record.diff_hash as string);
			if (readyPath && !writeReadyRecord(readyPath, record)) {
				results.push(finalizeResult("error"));
				continue;
			}
				delete state.pending;
				if (!writeState(path, state)) {
					results.push(finalizeResult("error"));
					continue;
				}
				try {
					const recorded = recorder.record(graphPath, record);
					if (recorded.code === "recorded" || recorded.code === "duplicate") {
						if (readyPath) removeReadyRecord(readyPath);
						results.push(finalizeResult(recorded.code));
					} else {
						results.push(finalizeResult("queued"));
					}
				} catch {
					results.push(finalizeResult("error"));
				}
			}
			return results;
		},
	};
}
