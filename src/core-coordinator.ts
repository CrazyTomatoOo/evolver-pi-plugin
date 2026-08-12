// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import type { OutcomeEntry } from "./filter";
import type {
	FinalizationResult,
	OutcomeSource,
	OutcomeSubmission,
	OutcomeSubmissionResult,
} from "./session-transition";
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface RecallDetails {
	workspaceId: string;
	recallHash: string;
}

export interface MessageEffect {
	type: "message";
	customType: "evolver-recall" | "evolver-signal";
	content: string;
	display: true;
	deliverAs: "currentTurn" | "steer";
	details?: RecallDetails;
}

export type CoordinatorEffect = MessageEffect;

export interface RecallContext {
	eligible: boolean;
	workspaceId: string | null;
	entries: OutcomeEntry[];
}

export interface CoordinatorDependencies {
	loadRecall(projectDir: string): RecallContext;
	now(): number;
	detectSignals(text: string): string[];
	resolveWorkspaceId(projectDir: string): string | null;
	startSessionTransition(cwd: string, workspaceId: string, sessionId: string): void;
	addSessionSignals(workspaceId: string, sessionId: string, signals: string[]): void;
	submitSessionOutcome(
		cwd: string,
		workspaceId: string,
		sessionId: string,
		submission: OutcomeSubmission,
		source: OutcomeSource,
		submittedAt: string,
	): OutcomeSubmissionResult;
	finalizeSessionOutcome(
		cwd: string,
		workspaceId: string,
		sessionId: string,
	): FinalizationResult;
}
export interface SessionStartInput {
	cwd: string;
	reason: SessionStartReason;
	sessionId: string | null;
}
export interface DeliveredRecall {
	workspaceId: string;
	recallHash: string;
}

export interface BeforeAgentStartInput {
	cwd: string;
	deliveredRecalls: DeliveredRecall[];
}

export interface MutationResultInput {
	cwd: string;
	sessionId: string | null;
	toolName: string;
	isError: boolean;
	input: Record<string, unknown>;
}

export interface SessionShutdownInput {
	cwd: string;
	reason: SessionShutdownReason;
	sessionId: string | null;
}

export interface OutcomeSubmissionInput {
	cwd: string;
	sessionId: string | null;
	source: OutcomeSource;
	submission: OutcomeSubmission;
}

export interface StatusInspectionInput {
	cwd: string;
}

export interface StatusInspectionResult {
	health: "unavailable";
	reason: string;
}

export interface CoreCoordinator {
	sessionStart(input: SessionStartInput): Promise<CoordinatorEffect[]>;
	beforeAgentStart(input: BeforeAgentStartInput): Promise<CoordinatorEffect[]>;
	mutationResult(input: MutationResultInput): Promise<CoordinatorEffect[]>;
	sessionShutdown(input: SessionShutdownInput): Promise<CoordinatorEffect[]>;
	submitOutcome(input: OutcomeSubmissionInput): Promise<OutcomeSubmissionResult>;
	inspectStatus(input: StatusInspectionInput): Promise<StatusInspectionResult>;
}

const WRITE_TOOLS = new Set(["write", "edit", "replace"]);
const FRAGMENT_SAMPLE_LIMIT = 16_384;
const RESULT_SAMPLE_LIMIT = 65_536;

function extractWriteFragments(input: Record<string, unknown>): string[] | null {
	return typeof input.content === "string" ? [input.content] : null;
}

function extractEditFragments(input: Record<string, unknown>): string[] | null {
	if (!Array.isArray(input.edits)) return null;
	const fragments: string[] = [];
	for (const value of input.edits) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return null;
		}
		const edit = value as Record<string, unknown>;
		if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
			return null;
		}
		fragments.push(edit.newText);
	}
	return fragments;
}

function extractReplaceFragments(input: Record<string, unknown>): string[] | null {
	if (
		typeof input.remove_from !== "string" ||
		input.remove_from.length === 0 ||
		typeof input.remove_to !== "string" ||
		input.remove_to.length === 0 ||
		typeof input.replacement_text !== "string"
	) {
		return null;
	}
	return [input.replacement_text];
}

function extractMutationFragments(
	toolName: string,
	input: Record<string, unknown>,
): string[] | null {
	if (typeof input.path !== "string" || input.path.trim().length === 0) {
		return null;
	}
	if (toolName === "write") return extractWriteFragments(input);
	if (toolName === "edit") return extractEditFragments(input);
	if (toolName === "replace") return extractReplaceFragments(input);
	return null;
}

function sampleMutationFragments(fragments: string[]): string[] {
	const samples: string[] = [];
	let remaining = RESULT_SAMPLE_LIMIT;
	for (const fragment of fragments) {
		if (remaining === 0) break;
		const sampleLength = Math.min(FRAGMENT_SAMPLE_LIMIT, remaining);
		if (fragment.length < sampleLength) {
			if (fragment.length > 0) samples.push(fragment);
			remaining -= fragment.length;
			continue;
		}
		const headLength = Math.ceil(sampleLength / 2);
		const tailLength = Math.floor(sampleLength / 2);
		if (headLength > 0) samples.push(fragment.slice(0, headLength));
		if (tailLength > 0) samples.push(fragment.slice(-tailLength));
		remaining -= sampleLength;
	}
	return samples;
}

const RECALL_MAX_LENGTH = 2_000;
const RECALL_MAX_RESULTS = 3;
const RECALL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const TRUSTED_FAILURE_SOURCES = new Set([
	"tool:evolver_outcome",
	"command:evolver-outcome",
]);

function recallStatus(entry: OutcomeEntry, now: number): "success" | "failed" | null {
	const timestamp =
		typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	if (
		!Number.isFinite(timestamp) ||
		timestamp > now ||
		timestamp < now - RECALL_MAX_AGE_MS
	) {
		return null;
	}
	const outcome = entry.outcome;
	if (
		outcome?.status === "success" &&
		typeof outcome.score === "number" &&
		outcome.score >= 0.5
	) {
		return "success";
	}
	if (
		outcome?.status === "failed" &&
		typeof outcome.note === "string" &&
		outcome.note.trim().length > 0 &&
		typeof entry.source === "string" &&
		TRUSTED_FAILURE_SOURCES.has(entry.source)
	) {
		return "failed";
	}
	return null;
}

function selectRecallEntries(entries: OutcomeEntry[], now: number): OutcomeEntry[] {
	const eligible = entries
		.filter((entry) => recallStatus(entry, now) !== null)
		.sort(
			(left, right) =>
				Date.parse(right.timestamp as string) - Date.parse(left.timestamp as string),
		);
	const selected = eligible.slice(0, RECALL_MAX_RESULTS);
	const statuses = new Set(eligible.map((entry) => recallStatus(entry, now)));
	const selectedStatuses = new Set(selected.map((entry) => recallStatus(entry, now)));
	if (
		statuses.has("success") &&
		statuses.has("failed") &&
		selected.length === RECALL_MAX_RESULTS
	) {
		const missing = selectedStatuses.has("success") ? "failed" : "success";
		if (!selectedStatuses.has(missing)) {
			const replacement = eligible.find(
				(entry) => recallStatus(entry, now) === missing,
			);
			if (replacement) {
				selected.splice(-1, 1, replacement);
				selected.sort(
					(left, right) =>
						Date.parse(right.timestamp as string) -
						Date.parse(left.timestamp as string),
				);
			}
		}
	}
	return selected;
}

function formatRecall(entries: OutcomeEntry[], now: number): string {
	const successes = entries.filter(
		(entry) => recallStatus(entry, now) === "success",
	).length;
	const failures = entries.length - successes;
	const header =
		`[Evolution Memory] Recent ${entries.length} outcomes ` +
		`(${successes} success, ${failures} failed):`;
	const footer = "Use successful approaches. Avoid repeating failed patterns.";
	const rows = entries.map((entry) => {
		const status = recallStatus(entry, now);
		const icon = status === "success" ? "+" : "-";
		const date = (entry.timestamp as string).slice(0, 10);
		const score = typeof entry.outcome?.score === "number" ? entry.outcome.score : "?";
		const signals = Array.isArray(entry.signals)
			? entry.signals.slice(0, 3).join(", ")
			: "";
		return `[${icon}] ${date} score=${score} signals=[${signals}] ${entry.outcome?.note?.trim() ?? ""}`;
	});
	const full = [header, ...rows, "", footer].join("\n");
	if (full.length <= RECALL_MAX_LENGTH) return full;
	const fixedLength = header.length + footer.length + 3;
	const availableRows = RECALL_MAX_LENGTH - fixedLength;
	const marker = "… [truncated]";
	const included: string[] = [];
	let used = 0;
	for (const row of rows) {
		const separator = included.length === 0 ? 0 : 1;
		if (used + separator + row.length <= availableRows) {
			included.push(row);
			used += separator + row.length;
			continue;
		}
		const available = availableRows - used - separator;
		if (available >= marker.length) {
			included.push(`${row.slice(0, available - marker.length)}${marker}`);
		} else if (included.length > 0) {
			const previous = included.at(-1);
			if (previous) {
				included[included.length - 1] = `${previous.slice(0, -marker.length)}${marker}`;
			}
		}
		break;
	}
	return [header, ...included, "", footer].join("\n");
}

function prepareRecall(
	context: RecallContext,
	now: number,
): { content: string; details: RecallDetails } | null {
	if (!context.eligible || !context.workspaceId) return null;
	const selected = selectRecallEntries(context.entries, now);
	if (selected.length === 0) return null;
	const content = formatRecall(selected, now);
	return {
		content,
		details: {
			workspaceId: context.workspaceId,
			recallHash: createHash("sha256").update(content).digest("hex"),
		},
	};
}

export function createCoreCoordinator(
	dependencies: CoordinatorDependencies,
): CoreCoordinator {
	let recallArmed = false;
	return {
		async sessionStart(input) {
			recallArmed = true;
			try {
				if (!input.sessionId) return [];
				const workspaceId = dependencies.resolveWorkspaceId(input.cwd);
				if (!workspaceId) return [];
				dependencies.startSessionTransition(input.cwd, workspaceId, input.sessionId);
			} catch {
				// fail open — transition tracking is optional
			}
			return [];
		},

		async beforeAgentStart(input) {
			if (!recallArmed) return [];
			recallArmed = false;
			try {
				const recall = prepareRecall(
					dependencies.loadRecall(input.cwd),
					dependencies.now(),
				);
				if (!recall) return [];
				if (
					input.deliveredRecalls.some(
						(delivered) =>
							delivered.workspaceId === recall.details.workspaceId &&
							delivered.recallHash === recall.details.recallHash,
					)
				) {
					return [];
				}
				return [
					{
						type: "message",
						customType: "evolver-recall",
						content: recall.content,
						display: true,
						deliverAs: "currentTurn",
						details: recall.details,
					},
				];
			} catch {
				return [];
			}
		},

		async mutationResult(input) {
			try {
				if (!WRITE_TOOLS.has(input.toolName) || input.isError !== false) return [];
				const fragments = extractMutationFragments(input.toolName, input.input);
				if (fragments === null) return [];
				const found = new Set<string>();
				for (const fragment of sampleMutationFragments(fragments)) {
					for (const signal of dependencies.detectSignals(fragment)) {
						found.add(signal);
					}
				}
				const signals = Array.from(found).sort((left, right) =>
					left.localeCompare(right),
				);
				if (signals.length === 0) return [];
				if (input.sessionId) {
					const workspaceId = dependencies.resolveWorkspaceId(input.cwd);
					if (workspaceId) {
						dependencies.addSessionSignals(workspaceId, input.sessionId, signals);
					}
				}
				const where = input.input.path as string;
				return [
					{
						type: "message",
						customType: "evolver-signal",
						content:
							`[Evolution Signal] Detected: [${signals.join(", ")}] in ${where}. ` +
							"Consider recording this outcome.",
						display: true,
						deliverAs: "steer",
					},
				];
			} catch {
				return [];
			}
		},

		async sessionShutdown(input) {
			if (input.reason === "reload") return [];
			try {
				if (!input.sessionId) return [];
				const workspaceId = dependencies.resolveWorkspaceId(input.cwd);
				if (!workspaceId) return [];
				dependencies.finalizeSessionOutcome(input.cwd, workspaceId, input.sessionId);
			} catch {
				// fail open — finalization is optional
			}
			return [];
		},

		async submitOutcome(input) {
			try {
				if (!input.sessionId) {
					return {
						code: "unavailable",
						receipt: "Outcome submission is unavailable.",
					};
				}
				const workspaceId = dependencies.resolveWorkspaceId(input.cwd);
				if (!workspaceId) {
					return {
						code: "unavailable",
						receipt: "Outcome submission is unavailable.",
					};
				}
				return dependencies.submitSessionOutcome(
					input.cwd,
					workspaceId,
					input.sessionId,
					input.submission,
					input.source,
					new Date(dependencies.now()).toISOString(),
				);
			} catch {
				return {
					code: "unavailable",
					receipt: "Outcome submission is unavailable.",
				};
			}
		},

		async inspectStatus(_input) {
			return {
				health: "unavailable",
				reason: "Status inspection is not available yet.",
			};
		},
	};
}
