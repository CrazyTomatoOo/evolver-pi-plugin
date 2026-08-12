// SPDX-License-Identifier: MIT

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	CoordinatorEffect,
	CoreCoordinator,
	SessionShutdownReason,
	SessionStartReason,
} from "./core-coordinator";

function applyEffects(pi: ExtensionAPI, effects: CoordinatorEffect[]): void {
	for (const effect of effects) {
		pi.sendMessage(
			{
				customType: effect.customType,
				content: effect.content,
				display: effect.display,
			},
			{ deliverAs: effect.deliverAs },
		);
	}
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
			});
			applyEffects(pi, effects);
		} catch (_err) {
			// fail open — evolution memory is optional
		}
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		try {
			const effects = await coordinator.beforeAgentStart({ cwd: ctx.cwd });
			applyEffects(pi, effects);
		} catch (_err) {
			// fail open — Recall preparation is optional
		}
	});

	pi.on("tool_result", async (event, _ctx) => {
		try {
			const effects = await coordinator.mutationResult({
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
