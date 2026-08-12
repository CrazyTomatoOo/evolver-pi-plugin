// SPDX-License-Identifier: MIT

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	CoordinatorEffect,
	CoreCoordinator,
	DeliveredRecall,
	MessageEffect,
	SessionShutdownReason,
	SessionStartReason,
} from "./core-coordinator";

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
	pi.on("session_start", async (event, ctx) => {
		try {
			const effects = await coordinator.sessionStart({
				cwd: ctx.cwd,
				reason: event.reason as SessionStartReason,
				sessionId: ctx.sessionManager.getSessionId?.() ?? null,
			});
			applyEffects(pi, effects);
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
				(effect) => effect.deliverAs === "currentTurn",
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
	});

	pi.on("resources_discover", async (_event, _ctx) => ({
		skillPaths: [skillPath],
	}));
}
