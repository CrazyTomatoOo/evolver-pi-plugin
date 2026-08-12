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
		resolveWorkspaceId: () => null,
		startSessionTransition: () => {},
		addSessionSignals: () => {},
		submitSessionOutcome: () => ({
			code: "unavailable",
			receipt: "Outcome submission is unavailable.",
		}),
		finalizeSessionOutcome: () => ({
			code: "unavailable",
			receipt: "Outcome finalization is unavailable.",
		}),
		recoverCrashLeftOutcomes: () => [],
		drainReadyOutbox: () => [],
		inspectStatusSnapshot: () => null,
		pendingAnnouncements: () => [],
		now: () => Date.parse("2026-08-12T12:00:00.000Z"),
		detectSignals: () => [],
		...overrides,
	};
}

describe("Core Coordinator", () => {
	test("starts a durable transition and accumulates detected signals for the stable Session identity", async () => {
		const starts: unknown[] = [];
		const signalUpdates: unknown[] = [];
		const coordinator = createCoreCoordinator(
			createDependencies({
				resolveWorkspaceId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				startSessionTransition: (...args) => {
					starts.push(args);
				},
				addSessionSignals: (...args) => {
					signalUpdates.push(args);
				},
				detectSignals: () => ["test_failure"],
			}),
		);

		await coordinator.sessionStart({
			cwd: "/workspace",
			reason: "startup",
			sessionId: "session-1",
		});
		await coordinator.mutationResult({
			cwd: "/workspace",
			sessionId: "session-1",
			toolName: "write",
			isError: false,
			input: { path: "src/example.ts", content: "changed" },
		});

		expect(starts).toEqual([
			["/workspace", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "session-1"],
		]);
		expect(signalUpdates).toEqual([
			[
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"session-1",
				["test_failure"],
			],
		]);
	});
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
			await coordinator.sessionStart({
				cwd: "/workspace",
				reason: "startup",
				sessionId: null,
			}),
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
			cwd: "/workspace",
			sessionId: null,
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

	test("quit, new, resume, and fork finalize the outgoing session; reload never does", async () => {
		const finalizations: unknown[] = [];
		const coordinator = createCoreCoordinator(
			createDependencies({
				resolveWorkspaceId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				finalizeSessionOutcome: (...args) => {
					finalizations.push(args);
					return { code: "recorded", receipt: "Outcome recorded." };
				},
			}),
		);

		for (const reason of ["quit", "new", "resume", "fork"] as const) {
			finalizations.length = 0;
			await coordinator.sessionShutdown({
				cwd: "/workspace",
				reason,
				sessionId: "session-1",
			});
			expect(finalizations).toEqual([
				["/workspace", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "session-1"],
			]);
		}

		finalizations.length = 0;
		await coordinator.sessionShutdown({
			cwd: "/workspace",
			reason: "reload",
			sessionId: "session-1",
		});
		expect(finalizations).toEqual([]);

		// Missing identity disables finalization without throwing.
		await expect(
			coordinator.sessionShutdown({
				cwd: "/workspace",
				reason: "quit",
				sessionId: null,
			}),
		).resolves.toEqual([]);
	});

	test("a non-reload start recovers crash-left pendings and drains the outbox before Recall", async () => {
		const calls: string[] = [];
		let recalled = false;
		const coordinator = createCoreCoordinator(
			createDependencies({
				resolveWorkspaceId: () => "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				recoverCrashLeftOutcomes: () => {
					calls.push("recover");
					return [];
				},
				drainReadyOutbox: () => {
					calls.push("drain");
					return [];
				},
				loadRecall: () => {
					recalled = true;
					return { eligible: false, workspaceId: null, entries: [] };
				},
			}),
		);

		// Reload never recovers crash-left state.
		await coordinator.sessionStart({
			cwd: "/workspace",
			reason: "reload",
			sessionId: "session-1",
		});
		expect(calls).not.toContain("recover");

		// A non-reload start recovers, and the next first-turn Recall drains
		// before selecting entries.
		await coordinator.sessionStart({
			cwd: "/workspace",
			reason: "new",
			sessionId: "session-1",
		});
		expect(calls).toEqual(["recover"]);
		await coordinator.beforeAgentStart({
			cwd: "/workspace",
			deliveredRecalls: [],
		});
		expect(calls).toEqual(["recover", "drain"]);
		expect(recalled).toBe(true);
	});

	test("exposes future lifecycle seams without loading Pi", async () => {
		const coordinator = createCoreCoordinator(createDependencies());

		expect(
			await coordinator.beforeAgentStart({
				cwd: "/workspace",
				deliveredRecalls: [],
			}),
		).toEqual([]);
		expect(
			await coordinator.submitOutcome({
				cwd: "/workspace",
				sessionId: null,
				source: "tool:evolver_outcome",
				submission: { action: "clear" },
			}),
		).toEqual({
			code: "unavailable",
			receipt: "Outcome submission is unavailable.",
		});
		expect(
			await coordinator.inspectStatus({ cwd: "/workspace", sessionId: null }),
		).toEqual({ snapshot: null, reason: "No active session." });
	});
});
