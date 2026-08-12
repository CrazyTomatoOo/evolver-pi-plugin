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
	const tools: any[] = [];
	const commands = new Map<string, any>();
	const notifications: Array<[string, string | undefined]> = [];
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		registerTool(definition: unknown) {
			tools.push(definition);
		},
		registerCommand(name: string, definition: unknown) {
			commands.set(name, definition);
		},
		sendMessage(message: unknown, options: unknown) {
			messages.push([message, options]);
		},
	} as unknown as ExtensionAPI;
	return { commands, handlers, messages, notifications, pi, tools };
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

	test("publishes a flat Google-compatible Outcome schema and maps strict tool and command inputs", async () => {
		const harness = createPiHarness();
		const submissions: unknown[] = [];
		const coordinator = createCoordinator({
			submitOutcome: async (input) => {
				submissions.push(input);
				return { code: "accepted", receipt: "Pending Outcome accepted." };
			},
		});
		registerPiAdapter(harness.pi, coordinator, "/skills");
		const tool = harness.tools[0];
		const command = harness.commands.get("evolver-outcome");
		const context = {
			cwd: "/workspace",
			sessionManager: { getSessionId: () => "session-1" },
			ui: {
				notify(message: string, level?: string) {
					harness.notifications.push([message, level]);
				},
			},
		};

		expect(tool.name).toBe("evolver_outcome");
		expect(tool.parameters.anyOf).toBeUndefined();
		expect(tool.parameters.properties.action.enum).toEqual(["set", "clear"]);
		expect(tool.parameters.properties.verdict.enum).toEqual(["success", "failed"]);
		expect(tool.parameters.additionalProperties).toBe(false);
		expect(
			await tool.execute(
				"call-1",
				{ action: "set", verdict: "success", lesson: "reuse this" },
				undefined,
				undefined,
				context,
			),
		).toMatchObject({
			content: [],
			details: { code: "accepted", receipt: "Pending Outcome accepted." },
		});
		await command.handler("failed avoid this pitfall", context);
		expect(submissions).toEqual([
			{
				cwd: "/workspace",
				sessionId: "session-1",
				source: "tool:evolver_outcome",
				submission: { action: "set", verdict: "success", lesson: "reuse this" },
			},
			{
				cwd: "/workspace",
				sessionId: "session-1",
				source: "command:evolver-outcome",
				submission: { action: "set", verdict: "failed", lesson: "avoid this pitfall" },
			},
		]);
		expect(harness.messages).toEqual([]);
	});

	test("rejects non-exact tool combinations and command syntax before the Coordinator", async () => {
		const harness = createPiHarness();
		const submissions: unknown[] = [];
		const coordinator = createCoordinator({
			submitOutcome: async (input) => {
				submissions.push(input);
				return { code: "accepted", receipt: "Pending Outcome accepted." };
			},
		});
		registerPiAdapter(harness.pi, coordinator, "/skills");
		const tool = harness.tools[0];
		const command = harness.commands.get("evolver-outcome");
		const context = {
			cwd: "/workspace",
			sessionManager: { getSessionId: () => "session-1" },
			ui: { notify: () => {} },
		};

		for (const params of [
			{ action: "set", verdict: "success" },
			{ action: "set", lesson: "missing verdict" },
			{ action: "set", verdict: "success", lesson: "valid", extra: true },
			{ action: "clear", verdict: "success" },
		]) {
			expect(
				await tool.execute("call-invalid", params, undefined, undefined, context),
			).toMatchObject({ content: [], details: { code: "invalid" } });
		}
		for (const args of ["", "Success alias", "succeeded alias", "invalid lesson", "clear trailing"]) {
			await command.handler(args, context);
		}
		expect(submissions).toEqual([]);
	});

	test("clear entrypoints map exact sources and handler failures stay fail-open", async () => {
		const harness = createPiHarness();
		const submissions: unknown[] = [];
		const coordinator = createCoordinator({
			submitOutcome: async (input) => {
				submissions.push(input);
				if (submissions.length > 2) throw new Error("state unavailable");
				return { code: "cleared", receipt: "Pending Outcome cleared." };
			},
		});
		registerPiAdapter(harness.pi, coordinator, "/skills");
		const tool = harness.tools[0];
		const command = harness.commands.get("evolver-outcome");
		const context = {
			cwd: "/workspace",
			sessionManager: { getSessionId: () => "session-1" },
			ui: { notify: () => {} },
		};

		expect(
			await tool.execute("clear", { action: "clear" }, undefined, undefined, context),
		).toMatchObject({ content: [], details: { code: "cleared" } });
		await command.handler("clear", context);
		expect(submissions.slice(0, 2)).toEqual([
			{
				cwd: "/workspace",
				sessionId: "session-1",
				source: "tool:evolver_outcome",
				submission: { action: "clear" },
			},
			{
				cwd: "/workspace",
				sessionId: "session-1",
				source: "command:evolver-outcome",
				submission: { action: "clear" },
			},
		]);
		expect(
			await tool.execute("failure", { action: "clear" }, undefined, undefined, context),
		).toMatchObject({ content: [], details: { code: "unavailable" } });
		expect(command.handler("clear", context)).resolves.toBeUndefined();
	});
});
