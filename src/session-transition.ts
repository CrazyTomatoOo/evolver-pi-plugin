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
import { prefix, previewLesson, deriveHealth, type StatusSnapshot } from "./status";

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
	recordResult(
		workspaceId: string,
		result: FinalizationResult,
		identity: { diffHash: string; source: string } | null,
		timestamp: string,
	): void;
	readResults(workspaceId: string): ResultSlots;
	pendingAnnouncements(workspaceId: string): FinalizationRecord[];
	inspectStatus(cwd: string, workspaceId: string, sessionId: string, graphPath: string): StatusSnapshot | null;
}

export interface FinalizationRecord {
	code: FinalizationCode;
	timestamp: string;
	identity: { diffHash: string; source: string } | null;
	announced: boolean;
}

export interface ResultSlots {
	lastAttempt: FinalizationRecord | null;
	lastRecorded: FinalizationRecord | null;
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

function resultsPath(workspaceId: string): string | null {
	if (!WORKSPACE_PATTERN.test(workspaceId)) return null;
	return join(stateRoot(), "results", `${workspaceId}.json`);
}

function readResultSlots(path: string): ResultSlots {
	const empty: ResultSlots = { lastAttempt: null, lastRecorded: null };
	try {
		if (lstatSync(path).isSymbolicLink()) return empty;
		const stat = statSync(path);
		if (!stat.isFile() || stat.mode & 0o077) return empty;
		const value = JSON.parse(readFileSync(path, "utf8")) as Partial<ResultSlots>;
		return {
			lastAttempt: value.lastAttempt ?? null,
			lastRecorded: value.lastRecorded ?? null,
		};
	} catch {
		return empty;
	}
}

function writeResultSlots(path: string, slots: ResultSlots): void {
	writeState(path, slots);
}

/** Read-only Graph inspection: counts entries without acquiring the lock. */
function inspectGraph(graphPath: string, workspaceId: string): {
	path: string;
	health: "ok" | "missing" | "readonly" | "malformed" | "unavailable";
	totalCount: number;
	workspaceCount: number;
	malformedCount: number;
	lockState: "free" | "busy" | "stale" | "unavailable";
} {
	let content: string;
	try {
		content = readFileSync(graphPath, "utf8");
	} catch {
		// Missing Graph whose parent is writable is a normal "missing" state.
		return { path: graphPath, health: "missing", totalCount: 0, workspaceCount: 0, malformedCount: 0, lockState: lockStateOf(`${graphPath}.lock`) };
	}
	let total = 0;
	let workspace = 0;
	let malformed = 0;
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as OutcomeEntry;
			total += 1;
			if (entry.workspace_id === workspaceId) {
				workspace += 1;
			}
		} catch {
			malformed += 1;
		}
	}
	const lockState = lockStateOf(`${graphPath}.lock`);
	return { path: graphPath, health: malformed > 0 ? "malformed" : "ok", totalCount: total, workspaceCount: workspace, malformedCount: malformed, lockState };
}

function lockStateOf(lockPath: string): "free" | "busy" | "stale" | "unavailable" {
	try {
		const stat = statSync(lockPath);
		// A lock older than the deadline is considered abandoned (stale).
		if (Date.now() - stat.mtimeMs > 5_000) return "stale";
		return "busy";
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return "free";
		return "unavailable";
	}
}

function persistResult(
	workspaceId: string,
	result: FinalizationResult,
	identity: { diffHash: string; source: string } | null,
	timestamp: string,
): void {
	const path = resultsPath(workspaceId);
	if (!path) return;
	const slots = readResultSlots(path);
	const prev = slots.lastAttempt;
	// A repeated retry for the same ready identity and same result code must not
	// re-announce or erase the announced flag.
	const sameState =
		prev &&
		prev.code === result.code &&
		prev.identity?.diffHash === identity?.diffHash;
	const announced = sameState ? prev.announced : false;
	const record: FinalizationRecord = {
		code: result.code,
		timestamp,
		identity,
		announced,
	};
	slots.lastAttempt = record;
	// A duplicate or skip never erases the last actually-appended record.
	if (result.code === "recorded" || result.code === "duplicate") {
		slots.lastRecorded = { ...record };
	}
	writeResultSlots(path, slots);
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
			const now = () => new Date().toISOString();
			const finish = (
				code: FinalizationCode,
				identity: { diffHash: string; source: string } | null,
			): FinalizationResult => {
				persistResult(workspaceId, finalizeResult(code), identity, now());
				return finalizeResult(code);
			};
			if (!path) return finish("unavailable", null);
			const state = matchingState(path, workspaceId, sessionId);
			if (!state) return finish("unavailable", null);
			const pending = state.pending;
			if (!pending) {
				const current = captureWorkspaceSnapshot(cwd);
				if (current && current.hash === state.baseline.hash) {
					return finish("skipped_no_changes", null);
				}
				return finish("skipped_no_verdict", null);
			}
			const current = captureWorkspaceSnapshot(cwd);
			if (!current) return finish("unavailable", null);
			const identity = {
				diffHash: transitionHash(state.baseline, pending.endSnapshot),
				source: pending.source,
			};
			if (current.hash !== pending.endSnapshot.hash) {
				return finish("stale", identity);
			}
			if (current.hash === state.baseline.hash) {
				return finish("skipped_no_changes", identity);
			}
			const record = buildRecord(cwd, workspaceId, sessionId, state, pending);
			const readyPath = outboxPath(workspaceId, record.diff_hash as string);
			if (readyPath && !writeReadyRecord(readyPath, record)) {
				return finish("error", identity);
			}
			delete state.pending;
			if (!writeState(path, state)) return finish("error", identity);
			let recorded;
			try {
				recorded = recorder.record(graphPath, record);
			} catch {
				return finish("queued", identity);
			}
			if (recorded.code === "recorded" || recorded.code === "duplicate") {
				if (readyPath) removeReadyRecord(readyPath);
				return finish(recorded.code, identity);
			}
			return finish("queued", identity);
		},

		drainOutbox(workspaceId, graphPath) {
			const results: FinalizationResult[] = [];
			const now = () => new Date().toISOString();
			for (const { path, record } of listReadyRecords(workspaceId)) {
				const identity = {
					diffHash: record.diff_hash as string,
					source: (record.source as string) ?? "tool:evolver_outcome",
				};
				try {
					const recorded = recorder.record(graphPath, record);
					if (recorded.code === "recorded" || recorded.code === "duplicate") {
						removeReadyRecord(path);
						persistResult(workspaceId, finalizeResult(recorded.code), identity, now());
						results.push(finalizeResult(recorded.code));
					} else {
						persistResult(workspaceId, finalizeResult("queued"), identity, now());
						results.push(finalizeResult("queued"));
					}
				} catch {
					persistResult(workspaceId, finalizeResult("queued"), identity, now());
					results.push(finalizeResult("queued"));
				}
			}
			return results;
		},

		recoverCrashLeft(cwd, workspaceId, graphPath) {
			const results: FinalizationResult[] = [];
			const now = () => new Date().toISOString();
			for (const { path, state } of listCrashLeftSessions(workspaceId)) {
				const pending = state.pending;
				if (!pending) continue;
				const current = captureWorkspaceSnapshot(cwd);
				const identity = {
					diffHash: transitionHash(state.baseline, pending.endSnapshot),
					source: pending.source,
				};
				if (!current || current.hash !== pending.endSnapshot.hash) {
					delete state.pending;
					writeState(path, state);
					persistResult(workspaceId, finalizeResult("stale"), identity, now());
					results.push(finalizeResult("stale"));
					continue;
				}
				if (current.hash === state.baseline.hash) {
					delete state.pending;
					writeState(path, state);
					persistResult(workspaceId, finalizeResult("skipped_no_changes"), identity, now());
					results.push(finalizeResult("skipped_no_changes"));
					continue;
				}
				const record = buildRecord(cwd, workspaceId, state.sessionId, state, pending);
				const readyPath = outboxPath(workspaceId, record.diff_hash as string);
				if (readyPath && !writeReadyRecord(readyPath, record)) {
					persistResult(workspaceId, finalizeResult("error"), identity, now());
					results.push(finalizeResult("error"));
					continue;
				}
				delete state.pending;
				if (!writeState(path, state)) {
					persistResult(workspaceId, finalizeResult("error"), identity, now());
					results.push(finalizeResult("error"));
					continue;
				}
				try {
					const recorded = recorder.record(graphPath, record);
					if (recorded.code === "recorded" || recorded.code === "duplicate") {
						if (readyPath) removeReadyRecord(readyPath);
						persistResult(workspaceId, finalizeResult(recorded.code), identity, now());
						results.push(finalizeResult(recorded.code));
					} else {
						persistResult(workspaceId, finalizeResult("queued"), identity, now());
						results.push(finalizeResult("queued"));
					}
				} catch {
					persistResult(workspaceId, finalizeResult("queued"), identity, now());
					results.push(finalizeResult("queued"));
				}
			}
			return results;
		},
		recordResult(workspaceId, result, identity, timestamp) {
			persistResult(workspaceId, result, identity, timestamp);
		},

		readResults(workspaceId) {
			const path = resultsPath(workspaceId);
			if (!path) return { lastAttempt: null, lastRecorded: null };
			return readResultSlots(path);
		},

		pendingAnnouncements(workspaceId) {
			const path = resultsPath(workspaceId);
			if (!path) return [];
			const slots = readResultSlots(path);
			const announcements: FinalizationRecord[] = [];
			const silent = new Set(["skipped_no_verdict", "skipped_no_changes"]);
			if (slots.lastAttempt && !silent.has(slots.lastAttempt.code) && !slots.lastAttempt.announced) {
				announcements.push(slots.lastAttempt);
				slots.lastAttempt.announced = true;
				writeResultSlots(path, slots);
			}
			return announcements;
		},

		inspectStatus(cwd, workspaceId, sessionId, graphPath) {
			const sessionStatePath = statePath(workspaceId, sessionId);
			const state = sessionStatePath ? matchingState(sessionStatePath, workspaceId, sessionId) : null;
			const graph = inspectGraph(graphPath, workspaceId);
			const results = readResultSlots(resultsPath(workspaceId) ?? "");
		const current = state ? captureWorkspaceSnapshot(cwd) : null;
		const pendingPreview = state?.pending ? previewLesson(state.pending.lesson) : null;
			const transitionHashPrefix = state?.pending
				? prefix(transitionHash(state.baseline, state.pending.endSnapshot))
				: state
					? prefix(state.baseline.hash)
					: null;
			const pendingSection = state?.pending
				? {
						verdict: state.pending.verdict,
						source: state.pending.source,
						submittedAt: state.pending.submittedAt,
					snapshotMatches: current ? current.hash === state.pending.endSnapshot.hash : false,
					lessonPreview: pendingPreview?.preview ?? "",
					lessonOriginalLength: pendingPreview?.originalLength ?? 0,
					}
				: null;
			const snapshot: Omit<StatusSnapshot, "overallHealth"> = {
				workspace: {
					root: null,
					gitHealth: state ? "ok" : "unavailable",
					workspaceIdPrefix: prefix(workspaceId),
					sessionIdPrefix: prefix(sessionId),
					recordingReady: state !== null,
					disabledReason: state ? null : "no session transition",
				},
				graph,
				session: state
					? {
							baselinePrefix: prefix(state.baseline.hash),
							currentPrefix: current ? prefix(current.hash) : null,
							changed: current ? state.baseline.hash !== current.hash : false,
							transitionHashPrefix,
							graphContainsIdentity: graph.workspaceCount > 0,
							signals: state.signals,
							readyOutboxCount: listReadyRecords(workspaceId).length,
						}
					: null,
				pending: pendingSection,
				recall: null,
				lastAttempt: results.lastAttempt
					? {
							code: results.lastAttempt.code,
							timestamp: results.lastAttempt.timestamp,
							identityPrefix: results.lastAttempt.identity
								? prefix(results.lastAttempt.identity.diffHash)
								: null,
							source: results.lastAttempt.identity?.source ?? null,
						}
					: null,
				lastRecorded: results.lastRecorded
					? {
							code: results.lastRecorded.code,
							timestamp: results.lastRecorded.timestamp,
							identityPrefix: results.lastRecorded.identity
								? prefix(results.lastRecorded.identity.diffHash)
								: null,
							source: results.lastRecorded.identity?.source ?? null,
						}
					: null,
			};
			return { ...snapshot, overallHealth: deriveHealth(snapshot) };
		},
	};
}
