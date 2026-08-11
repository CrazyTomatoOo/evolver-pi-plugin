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
	recordOutcome(
		projectDir: string,
		sessionId: string | null,
	): Promise<string | null>;
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

function extractContent(input: Record<string, unknown>): string {
	if (typeof input.content === "string") return input.content;
	if (typeof input.new_string === "string") return input.new_string;
	if (typeof input.file_text === "string") return input.file_text;
	if (typeof input.file_content === "string") return input.file_content;
	if (Array.isArray(input.changes)) {
		return (input.changes as Array<{ content_lines?: unknown }>)
			.map((change) =>
				Array.isArray(change?.content_lines)
					? (change.content_lines as string[]).join("\n")
					: "",
			)
			.join("\n");
	}
	return "";
}

function extractFilePath(input: Record<string, unknown>): string {
	if (typeof input.path === "string") return input.path;
	if (typeof input.file_path === "string") return input.file_path;
	return "";
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
				if (!WRITE_TOOLS.has(input.toolName)) return [];
				const signals = dependencies.detectSignals(extractContent(input.input));
				if (signals.length === 0) return [];
				const where = extractFilePath(input.input) || "edited file";
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
			if (input.reason !== "quit") return [];
			try {
				await dependencies.recordOutcome(input.cwd, input.sessionId);
			} catch {
				// fail open — recording is optional
			}
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
