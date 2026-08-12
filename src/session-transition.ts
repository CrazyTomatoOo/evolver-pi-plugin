// SPDX-License-Identifier: MIT

import {
	chmodSync,
	closeSync,
	constants,
	mkdirSync,
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
import { captureWorkspaceSnapshot, type WorkspaceSnapshot } from "./workspace-snapshot";

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

function writeState(path: string, state: SessionTransitionState): boolean {
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

export function createSessionTransitionStore(): SessionTransitionStore {
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
	};
}
