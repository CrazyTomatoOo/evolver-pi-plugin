import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CoreCoordinator } from "../src/core-coordinator";
import { registerPiAdapter } from "../src/pi-adapter";

type Handler = (event: any, context: any) => unknown;

function createCoordinator(
	overrides: Partial<CoreCoordinator> = {},
): CoreCoordinator {
	return {
		sessionStart: async () => [],
		beforeAgentStart: async () => [],
		mutationResult: async () => [],
		sessionShutdown: async () => [],
		submitOutcome: async () => ({
			code: "unavailable",
			receipt: "not available",
		}),
		inspectStatus: async () => ({
			health: "unavailable",
			reason: "not available",
		}),
		...overrides,
	};
}

function createPiHarness() {
	const handlers = new Map<string, Handler>();
	const messages: Array<[unknown, unknown]> = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		sendMessage(message: unknown, options: unknown) {
			messages.push([message, options]);
		},
	} as unknown as ExtensionAPI;
	return { handlers, messages, pi };
}

describe("Pi Adapter", () => {
	test("returns first-turn Recall and reads durable delivery details from the active branch", async () => {
		const harness = createPiHarness();
		const starts: unknown[] = [];
		const beforeAgentStarts: unknown[] = [];
		const coordinator = createCoordinator({
			sessionStart: async (input) => {
				starts.push(input);
				return [];
			},
			beforeAgentStart: async (input) => {
				beforeAgentStarts.push(input);
				return [
					{
						type: "message",
						customType: "evolver-recall",
						content: "remember this",
						display: true,
						deliverAs: "currentTurn",
						details: { workspaceId: "workspace-1", recallHash: "hash-1" },
					},
				];
			},
		});
		registerPiAdapter(harness.pi, coordinator, "/skills");
		const sessionManager = {
			getSessionId: () => "session-1",
			getBranch: () => [
				{
					type: "custom_message",
					customType: "evolver-recall",
					details: { workspaceId: "workspace-1", recallHash: "old-hash" },
				},
			],
		};

		await harness.handlers.get("session_start")?.(
			{ reason: "startup" },
			{ cwd: "/workspace", sessionManager },
		);
		const result = await harness.handlers.get("before_agent_start")?.(
			{},
			{ cwd: "/workspace", sessionManager },
		);

		expect(starts).toEqual([
			{ cwd: "/workspace", reason: "startup", sessionId: "session-1" },
		]);
		expect(beforeAgentStarts).toEqual([
			{
				cwd: "/workspace",
				deliveredRecalls: [
					{ workspaceId: "workspace-1", recallHash: "old-hash" },
				],
			},
		]);
		expect(result).toEqual({
			message: {
				customType: "evolver-recall",
				content: "remember this",
				display: true,
				details: { workspaceId: "workspace-1", recallHash: "hash-1" },
			},
		});
		expect(harness.messages).toEqual([]);
	});

	test("delegates mutation, shutdown, and skill discovery without domain logic", async () => {
		const harness = createPiHarness();
		const beforeAgentStarts: unknown[] = [];
		const mutations: unknown[] = [];
		const shutdowns: unknown[] = [];
		const coordinator = createCoordinator({
			beforeAgentStart: async (input) => {
				beforeAgentStarts.push(input);
				return [];
			},
			mutationResult: async (input) => {
				mutations.push(input);
				return [];
			},
			sessionShutdown: async (input) => {
				shutdowns.push(input);
				return [];
			},
		});
		registerPiAdapter(harness.pi, coordinator, "/skills");

		await harness.handlers.get("before_agent_start")?.(
			{},
			{
				cwd: "/workspace",
				sessionManager: { getBranch: () => [] },
			},
		);
		await harness.handlers.get("tool_result")?.(
			{
				toolName: "write",
				input: { path: "README.md", content: "text" },
				isError: false,
			},
			{
				cwd: "/workspace",
				sessionManager: { getSessionId: () => "session-1" },
			},
		);
		await harness.handlers.get("tool_result")?.(
			{
				toolName: "edit",
				input: { path: "README.md", edits: [] },
				isError: true,
			},
			{
				cwd: "/workspace",
				sessionManager: { getSessionId: () => "session-1" },
			},
		);
		await harness.handlers.get("session_shutdown")?.(
			{ reason: "quit" },
			{
				cwd: "/workspace",
				sessionManager: { getSessionId: () => "session-1" },
			},
		);
		const resources = await harness.handlers.get("resources_discover")?.(
			{},
			{ cwd: "/workspace" },
		);

		expect(beforeAgentStarts).toEqual([
			{ cwd: "/workspace", deliveredRecalls: [] },
		]);
		expect(mutations).toEqual([
			{
				cwd: "/workspace",
				sessionId: "session-1",
				toolName: "write",
				input: { path: "README.md", content: "text" },
				isError: false,
			},
			{
				cwd: "/workspace",
				sessionId: "session-1",
				toolName: "edit",
				input: { path: "README.md", edits: [] },
				isError: true,
			},
		]);
		expect(shutdowns).toEqual([
			{ cwd: "/workspace", reason: "quit", sessionId: "session-1" },
		]);
		expect(resources).toEqual({ skillPaths: ["/skills"] });
	});
});
