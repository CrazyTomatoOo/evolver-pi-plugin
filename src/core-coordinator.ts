// SPDX-License-Identifier: MIT

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";
export type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

export interface MessageEffect {
	type: "message";
	customType: "evolver-recall" | "evolver-signal";
	content: string;
	display: true;
	deliverAs: "nextTurn" | "steer";
}

export type CoordinatorEffect = MessageEffect;

export interface CoordinatorDependencies {
	buildRecallText(projectDir: string): string | null;
	detectSignals(text: string): string[];
}

export interface SessionStartInput {
	cwd: string;
	reason: SessionStartReason;
}

export interface BeforeAgentStartInput {
	cwd: string;
}

export interface MutationResultInput {
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
}

export interface OutcomeSubmissionResult {
	code: "unavailable";
	receipt: string;
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

export function createCoreCoordinator(
	dependencies: CoordinatorDependencies,
): CoreCoordinator {
	return {
		async sessionStart(input) {
			try {
				const text = dependencies.buildRecallText(input.cwd);
				if (!text) return [];
				return [
					{
						type: "message",
						customType: "evolver-recall",
						content: text,
						display: true,
						deliverAs: "nextTurn",
					},
				];
			} catch {
				return [];
			}
		},

		async beforeAgentStart(_input) {
			return [];
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

		async sessionShutdown(_input) {
			return [];
		},

		async submitOutcome(_input) {
			return {
				code: "unavailable",
				receipt: "Outcome submission is not available yet.",
			};
		},

		async inspectStatus(_input) {
			return {
				health: "unavailable",
				reason: "Status inspection is not available yet.",
			};
		},
	};
}
