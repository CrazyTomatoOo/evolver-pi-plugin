import { describe, expect, test } from "bun:test";
import {
	createCoreCoordinator,
	type CoordinatorDependencies,
} from "../src/core-coordinator";

function createDependencies(
	overrides: Partial<CoordinatorDependencies> = {},
): CoordinatorDependencies {
	return {
		loadRecall: () => ({ eligible: false, workspaceId: null, entries: [] }),
		now: () => Date.parse("2026-08-12T12:00:00.000Z"),
		detectSignals: () => [],
		...overrides,
	};
}

describe("Core Coordinator", () => {
	test("delivers Recall on the first user turn with durable identity details", async () => {
		const coordinator = createCoreCoordinator(
			createDependencies({
				loadRecall: () => ({
					eligible: true,
					workspaceId: "workspace-1",
					entries: [
						{
							timestamp: "2026-08-12T11:00:00.000Z",
							outcome: { status: "success", score: 0.8, note: "reuse this" },
						},
					],
				}),
			}),
		);

		expect(
			await coordinator.sessionStart({ cwd: "/workspace", reason: "startup" }),
		).toEqual([]);
		const effects = await coordinator.beforeAgentStart({
			cwd: "/workspace",
			deliveredRecalls: [],
		});

		expect(effects).toHaveLength(1);
		expect(effects[0]).toMatchObject({
			type: "message",
			customType: "evolver-recall",
			display: true,
			deliverAs: "currentTurn",
			details: {
				workspaceId: "workspace-1",
				recallHash: expect.stringMatching(/^[a-f0-9]{64}$/),
			},
		});
		expect(await coordinator.beforeAgentStart({
			cwd: "/workspace",
			deliveredRecalls: [],
		})).toEqual([]);
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
			await coordinator.beforeAgentStart({
				cwd: "/workspace",
				deliveredRecalls: [],
			}),
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
