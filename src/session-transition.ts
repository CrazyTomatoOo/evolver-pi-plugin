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

export interface SessionTransitionState {
	version: 1;
	workspaceId: string;
	sessionId: string;
	baseline: WorkspaceSnapshot;
	signals: string[];
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
	inspect(
		cwd: string,
		workspaceId: string,
		sessionId: string,
	): SessionTransitionInspection | null;
}

const ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const WORKSPACE_PATTERN = /^[a-f0-9]{32,}$/;

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
