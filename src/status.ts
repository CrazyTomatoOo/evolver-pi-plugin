// SPDX-License-Identifier: MIT
// Read-only evolution status snapshot and renderer. Strictly observational:
// building or rendering a snapshot never mutates identity, state, locks,
// outbox, receipts, or Graph bytes. Redaction rules: full repository/Graph
// paths; 12-character ID/hash prefixes; at most 160 characters of the pending
// lesson with its original length; no diff contents, history, raw JSON, or
// stack traces are ever shown.

export type StatusHealth = "ready" | "degraded" | "disabled";

export interface StatusWorkspaceSection {
	root: string | null;
	gitHealth: "ok" | "unavailable";
	workspaceIdPrefix: string | null;
	sessionIdPrefix: string | null;
	recordingReady: boolean;
	disabledReason: string | null;
}

export type GraphHealth =
	| "ok"
	| "missing"
	| "readonly"
	| "malformed"
	| "unavailable";

export type LockState = "free" | "busy" | "stale" | "unavailable";

export interface StatusGraphSection {
	path: string | null;
	health: GraphHealth;
	totalCount: number;
	workspaceCount: number;
	malformedCount: number;
	lockState: LockState;
}

export interface StatusSessionSection {
	baselinePrefix: string | null;
	currentPrefix: string | null;
	changed: boolean;
	transitionHashPrefix: string | null;
	graphContainsIdentity: boolean;
	signals: string[];
	readyOutboxCount: number;
}

export interface StatusPendingSection {
	verdict: "success" | "failed";
	source: string;
	submittedAt: string;
	snapshotMatches: boolean;
	lessonPreview: string;
	lessonOriginalLength: number;
}

export interface StatusRecallSection {
	eligibleSuccess: number;
	eligibleFailed: number;
	selectedSuccess: number;
	selectedFailed: number;
	formattedCharCount: number;
	recallHashPrefix: string | null;
	deliveryState: "armed" | "delivered" | "not-delivered";
}

export interface StatusResultSlot {
	code: string;
	timestamp: string;
	identityPrefix: string | null;
	source: string | null;
}

export interface StatusSnapshot {
	workspace: StatusWorkspaceSection;
	graph: StatusGraphSection;
	session: StatusSessionSection | null;
	pending: StatusPendingSection | null;
	recall: StatusRecallSection | null;
	lastAttempt: StatusResultSlot | null;
	lastRecorded: StatusResultSlot | null;
	overallHealth: StatusHealth;
}

const PREFIX = 12;
const LESSON_PREVIEW_LIMIT = 160;

/** Truncate an identifier to a 12-character prefix, or null when absent. */
export function prefix(value: string | null | undefined): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	return value.slice(0, PREFIX);
}

/** Bound a lesson preview to 160 characters, preserving the original length. */
export function previewLesson(lesson: string): { preview: string; originalLength: number } {
	const originalLength = lesson.length;
	if (originalLength <= LESSON_PREVIEW_LIMIT) {
		return { preview: lesson, originalLength };
	}
	return { preview: `${lesson.slice(0, LESSON_PREVIEW_LIMIT)}…`, originalLength };
}

/** Derive the display-only overall health from the snapshot sections. */
export function deriveHealth(snapshot: Omit<StatusSnapshot, "overallHealth">): StatusHealth {
	const { workspace, graph, session, pending } = snapshot;
	if (!workspace.recordingReady || workspace.gitHealth !== "ok") return "disabled";
	const degraded =
		graph.health === "malformed" ||
		graph.health === "readonly" ||
		graph.health === "unavailable" ||
		graph.lockState === "stale" ||
		graph.lockState === "busy" ||
		(session !== null && session.readyOutboxCount > 0) ||
		(pending !== null && !pending.snapshotMatches);
	return degraded ? "degraded" : "ready";
}

/** Render a status snapshot as compact, redacted lines for the below-editor widget. */
export function renderStatus(snapshot: StatusSnapshot): string[] {
	const lines: string[] = [];
	lines.push(`Evolver status: ${snapshot.overallHealth}`);
	lines.push("");
	lines.push("Workspace:");
	lines.push(`  root: ${snapshot.workspace.root ?? "unavailable"}`);
	lines.push(`  git: ${snapshot.workspace.gitHealth}`);
	lines.push(
		`  workspace: ${snapshot.workspace.workspaceIdPrefix ?? "—"}  session: ${snapshot.workspace.sessionIdPrefix ?? "—"}`,
	);
	lines.push(
		snapshot.workspace.recordingReady
			? `  recording: ready`
			: `  recording: disabled — ${snapshot.workspace.disabledReason ?? "unavailable"}`,
	);
	lines.push("");
	lines.push("Graph:");
	lines.push(`  path: ${snapshot.graph.path ?? "unavailable"}`);
	lines.push(
		`  health: ${snapshot.graph.health}  lock: ${snapshot.graph.lockState}`,
	);
	lines.push(
		`  entries: ${snapshot.graph.totalCount} total, ${snapshot.graph.workspaceCount} workspace, ${snapshot.graph.malformedCount} malformed`,
	);
	lines.push("");
	if (snapshot.session) {
		const s = snapshot.session;
		lines.push("Session:");
		lines.push(`  baseline: ${s.baselinePrefix ?? "—"}  current: ${s.currentPrefix ?? "—"}`);
		lines.push(`  changed: ${s.changed}  transition: ${s.transitionHashPrefix ?? "—"}`);
		lines.push(
			`  graph: ${s.graphContainsIdentity ? "contains" : "absent"}  ready: ${s.readyOutboxCount}  signals: [${s.signals.join(", ")}]`,
		);
		lines.push("");
	}
	if (snapshot.pending) {
		const p = snapshot.pending;
		lines.push("Pending:");
		lines.push(
			`  verdict: ${p.verdict}  source: ${p.source}  submitted: ${p.submittedAt}`,
		);
		lines.push(`  snapshot: ${p.snapshotMatches ? "matches" : "stale"}  lesson: ${p.lessonPreview} (${p.lessonOriginalLength})`);
		lines.push("");
	}
	lines.push("Recall:");
	if (snapshot.recall) {
		const r = snapshot.recall;
		lines.push(
			`  eligible: ${r.eligibleSuccess} success, ${r.eligibleFailed} failed`,
		);
		lines.push(
			`  selected: ${r.selectedSuccess} success, ${r.selectedFailed} failed  chars: ${r.formattedCharCount}`,
		);
		lines.push(`  hash: ${r.recallHashPrefix ?? "—"}  delivery: ${r.deliveryState}`);
	} else {
		lines.push("  unavailable");
	}
	lines.push("");
	lines.push("Last result:");
	const slot = (label: string, s: StatusResultSlot | null) =>
		s
			? `  ${label}: ${s.code} at ${s.timestamp}  identity: ${s.identityPrefix ?? "—"}  source: ${s.source ?? "—"}`
			: `  ${label}: none`;
	lines.push(slot("attempt", snapshot.lastAttempt));
	lines.push(slot("recorded", snapshot.lastRecorded));
	return lines;
}
