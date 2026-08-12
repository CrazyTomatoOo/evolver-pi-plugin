import { describe, expect, test } from "bun:test";
import {
	createCoreCoordinator,
	type CoordinatorDependencies,
} from "../src/core-coordinator";

function createDependencies(
	overrides: Partial<CoordinatorDependencies> = {},
): CoordinatorDependencies {
	return {
		buildRecallText: () => null,
		detectSignals: () => [],
		...overrides,
	};
}

describe("Core Coordinator", () => {
	test("prepares the existing Recall message without loading Pi", async () => {
		const coordinator = createCoreCoordinator(
			createDependencies({
				buildRecallText: (cwd) =>
					cwd === "/workspace" ? "remember this approach" : null,
			}),
		);

		const effects = await coordinator.sessionStart({
			cwd: "/workspace",
			reason: "startup",
		});

		expect(effects).toEqual([
			{
				type: "message",
				customType: "evolver-recall",
				content: "remember this approach",
				display: true,
				deliverAs: "nextTurn",
			},
		]);
	});

	test("turns existing mutation signals into a Pi-neutral effect", async () => {
		const coordinator = createCoreCoordinator(
			createDependencies({
				detectSignals: (text) =>
					text.includes("regression") ? ["regression"] : [],
			}),
		);

		const effects = await coordinator.mutationResult({
			toolName: "write",
			isError: false,
			input: { path: "src/example.ts", content: "fixed a regression" },
		});

		expect(effects).toEqual([
			{
				type: "message",
				customType: "evolver-signal",
				content:
					"[Evolution Signal] Detected: [regression] in src/example.ts. Consider recording this outcome.",
				display: true,
				deliverAs: "steer",
			},
		]);
	});

	test("never classifies or records an Outcome automatically at shutdown", async () => {
		const coordinator = createCoreCoordinator(createDependencies());

		expect(
			await coordinator.sessionShutdown({
				cwd: "/workspace",
				reason: "reload",
				sessionId: "session-1",
			}),
		).toEqual([]);
		expect(
			await coordinator.sessionShutdown({
				cwd: "/workspace",
				reason: "quit",
				sessionId: "session-1",
			}),
		).toEqual([]);
	});

	test("exposes future lifecycle seams without loading Pi", async () => {
		const coordinator = createCoreCoordinator(createDependencies());

		expect(
			await coordinator.beforeAgentStart({ cwd: "/workspace" }),
		).toEqual([]);
		expect(await coordinator.submitOutcome({ cwd: "/workspace" })).toEqual({
			code: "unavailable",
			receipt: "Outcome submission is not available yet.",
		});
		expect(await coordinator.inspectStatus({ cwd: "/workspace" })).toEqual({
			health: "unavailable",
			reason: "Status inspection is not available yet.",
		});
	});
});
