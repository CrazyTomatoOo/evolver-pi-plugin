// SPDX-License-Identifier: MIT

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
	CoordinatorEffect,
	CoreCoordinator,
	DeliveredRecall,
	MessageEffect,
	SessionShutdownReason,
	SessionStartReason,
} from "./core-coordinator";
import { renderStatus } from "./status";

const OutcomeParameters = Type.Object(
	{
		action: StringEnum(["set", "clear"] as const),
		verdict: Type.Optional(StringEnum(["success", "failed"] as const)),
		lesson: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const INVALID_OUTCOME = {
	code: "invalid" as const,
	receipt: "Outcome submission is invalid.",
};

function parseToolSubmission(input: Record<string, unknown>) {
	const keys = Object.keys(input).sort();
	if (
		input.action === "clear" &&
		keys.length === 1
	) {
		return { action: "clear" } as const;
	}
	if (
		input.action === "set" &&
		(input.verdict === "success" || input.verdict === "failed") &&
		typeof input.lesson === "string" &&
		keys.length === 3
	) {
		return { action: "set", verdict: input.verdict, lesson: input.lesson } as const;
	}
	return null;
}

function parseCommandSubmission(args: string) {
	if (args === "clear") return { action: "clear" } as const;
	const match = /^(success|failed) ([\s\S]+)$/.exec(args);
	return match
		? { action: "set" as const, verdict: match[1] as "success" | "failed", lesson: match[2]! }
		: null;
}

function toolResult(result: { code: string; receipt: string }) {
	return {
		content: [],
		details: result,
	};
}
function toPiMessage(effect: MessageEffect) {
	const message = {
		customType: effect.customType,
		content: effect.content,
		display: effect.display,
	};
	return effect.details ? { ...message, details: effect.details } : message;
}

function applyEffects(pi: ExtensionAPI, effects: CoordinatorEffect[]): void {
	for (const effect of effects) {
		if (effect.type !== "message") continue;
		if (effect.deliverAs !== "steer") continue;
		pi.sendMessage(toPiMessage(effect), { deliverAs: "steer" });
	}
}

function deliveredRecalls(branch: unknown[]): DeliveredRecall[] {
	const delivered: DeliveredRecall[] = [];
	for (const value of branch) {
		if (typeof value !== "object" || value === null) continue;
		const entry = value as Record<string, unknown>;
		if (entry.type !== "custom_message" || entry.customType !== "evolver-recall") {
			continue;
		}
		if (typeof entry.details !== "object" || entry.details === null) continue;
		const details = entry.details as Record<string, unknown>;
		if (
			typeof details.workspaceId === "string" &&
			typeof details.recallHash === "string"
		) {
			delivered.push({
				workspaceId: details.workspaceId,
				recallHash: details.recallHash,
			});
		}
	}
	return delivered;
}

export function registerPiAdapter(
	pi: ExtensionAPI,
	coordinator: CoreCoordinator,
	skillPath: string,
): void {
	pi.registerTool({
		name: "evolver_outcome",
		label: "Evolver Outcome",
		description:
			"Set or clear one verified pending Outcome for the current content transition. Lessons must be concise, reusable, and contain no secrets.",
		parameters: OutcomeParameters,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const submission = parseToolSubmission(params as Record<string, unknown>);
				if (!submission) return toolResult(INVALID_OUTCOME);
				const result = await coordinator.submitOutcome({
					cwd: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId?.() ?? null,
					source: "tool:evolver_outcome",
					submission,
				});
				return toolResult(result);
			} catch {
				return toolResult({
					code: "unavailable",
					receipt: "Outcome submission is unavailable.",
				});
			}
		},
	});

	pi.registerCommand("evolver-outcome", {
		description: "Set or clear one verified pending Outcome",
		async handler(args, ctx) {
			try {
				const submission = parseCommandSubmission(args);
				if (!submission) {
					ctx.ui.notify(
						"Usage: /evolver-outcome <success|failed> <lesson> | /evolver-outcome clear",
						"error",
					);
					return;
				}
				const result = await coordinator.submitOutcome({
					cwd: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId?.() ?? null,
					source: "command:evolver-outcome",
					submission,
				});
				ctx.ui.notify(
					result.receipt,
					result.code === "accepted" || result.code === "replaced" ? "info" : "warning",
				);
			} catch {
				try {
					ctx.ui.notify("Outcome submission is unavailable.", "warning");
				} catch {
					// fail open — local receipt rendering is optional
				}
			}
		},
	});
	pi.registerCommand("evolver-status", {
		description: "Show the read-only evolution status snapshot",
		async handler(_args, ctx) {
			try {
				const result = await coordinator.inspectStatus({
					cwd: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId?.() ?? null,
				});
				const lines = result.snapshot
					? renderStatus(result.snapshot)
					: [`Evolver status: unavailable — ${result.reason}`];
				ctx.ui.setWidget("evolver-status", lines, { placement: "belowEditor" });
			} catch {
				try {
					ctx.ui.setWidget("evolver-status", ["Evolver status: unavailable"], {
						placement: "belowEditor",
					});
				} catch {
					// fail open — the widget is best-effort
				}
			}
		},
	});
	pi.on("session_start", async (event, ctx) => {
		try {
			const effects = await coordinator.sessionStart({
				cwd: ctx.cwd,
				reason: event.reason as SessionStartReason,
				sessionId: ctx.sessionManager.getSessionId?.() ?? null,
			});
		for (const effect of effects) {
			if (effect.type === "announcement") {
				try {
					ctx.ui.notify(effect.content, "info");
				} catch {
					// fail open — announcements are best-effort
				}
			}
		}
		} catch (_err) {
			// fail open — evolution memory is optional
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const effects = await coordinator.beforeAgentStart({
				cwd: ctx.cwd,
				deliveredRecalls: deliveredRecalls(ctx.sessionManager.getBranch()),
			});
			applyEffects(pi, effects);
		const recall = effects.find(
			(effect): effect is MessageEffect =>
				effect.type === "message" && effect.deliverAs === "currentTurn",
		);
		return recall ? { message: toPiMessage(recall) } : undefined;
		} catch (_err) {
			// fail open — Recall preparation is optional
		}
	});

	pi.on("tool_result", async (event, _ctx) => {
		try {
			const effects = await coordinator.mutationResult({
				cwd: _ctx.cwd,
				sessionId: _ctx.sessionManager.getSessionId?.() ?? null,
				toolName: event.toolName,
				isError: event.isError,
				input: (event.input ?? {}) as Record<string, unknown>,
			});
			applyEffects(pi, effects);
		} catch (_err) {
			// fail open — signal detection is optional
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		try {
			const effects = await coordinator.sessionShutdown({
				cwd: ctx.cwd,
				reason: event.reason as SessionShutdownReason,
				sessionId: ctx.sessionManager.getSessionId?.() ?? null,
			});
			applyEffects(pi, effects);
		} catch (_err) {
			// fail open — outcome recording is optional
		}
		try {
			ctx.ui.setWidget("evolver-status", undefined, { placement: "belowEditor" });
		} catch {
			// fail open — widget clearing is best-effort
		}
	});

	pi.on("input", async (event, ctx) => {
		// Clear the status widget on the next non-status input.
		if (typeof event.text === "string" && event.text.trim().startsWith("/evolver-status")) {
			return;
		}
		try {
			ctx.ui.setWidget("evolver-status", undefined, { placement: "belowEditor" });
		} catch {
			// fail open — widget clearing is best-effort
		}
	});

	pi.on("resources_discover", async (_event, _ctx) => ({
		skillPaths: [skillPath],
	}));
}
