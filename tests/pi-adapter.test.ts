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
	test("delegates Session start and translates the returned message effect", async () => {
		const harness = createPiHarness();
		const starts: unknown[] = [];
		const coordinator = createCoordinator({
			sessionStart: async (input) => {
				starts.push(input);
				return [
					{
						type: "message",
						customType: "evolver-recall",
						content: "remember this",
						display: true,
						deliverAs: "nextTurn",
					},
				];
			},
		});
		registerPiAdapter(harness.pi, coordinator, "/skills");

		await harness.handlers.get("session_start")?.(
			{ reason: "startup" },
			{ cwd: "/workspace" },
		);

		expect(starts).toEqual([{ cwd: "/workspace", reason: "startup" }]);
		expect(harness.messages).toEqual([
			[
				{
					customType: "evolver-recall",
					content: "remember this",
					display: true,
				},
				{ deliverAs: "nextTurn" },
			],
		]);
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
			{ cwd: "/workspace" },
		);
		await harness.handlers.get("tool_result")?.(
			{
				toolName: "write",
				input: { path: "README.md", content: "text" },
				isError: false,
			},
			{ cwd: "/workspace" },
		);
		await harness.handlers.get("tool_result")?.(
			{
				toolName: "edit",
				input: { path: "README.md", edits: [] },
				isError: true,
			},
			{ cwd: "/workspace" },
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

		expect(beforeAgentStarts).toEqual([{ cwd: "/workspace" }]);
		expect(mutations).toEqual([
			{
				toolName: "write",
				input: { path: "README.md", content: "text" },
				isError: false,
			},
			{
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
