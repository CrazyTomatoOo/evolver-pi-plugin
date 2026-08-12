import { describe, expect, test } from "bun:test";
import {
	createCoreCoordinator,
	type CoordinatorDependencies,
	type MutationResultInput,
} from "../src/core-coordinator";

function createDependencies(
	detectSignals: CoordinatorDependencies["detectSignals"],
): CoordinatorDependencies {
	return {
		loadRecall: () => ({ eligible: false, workspaceId: null, entries: [] }),
		now: Date.now,
		detectSignals,
	};
}

describe("Mutation signals", () => {
	test("a successful write scans only current content and emits sorted unique labels once", async () => {
		const scanned: string[] = [];
		const coordinator = createCoreCoordinator(
			createDependencies((text) => {
				scanned.push(text);
				return text === "new text"
					? ["test_failure", "capability_gap", "test_failure"]
					: ["log_error"];
			}),
		);

		const effects = await coordinator.mutationResult({
			toolName: "write",
			isError: false,
			input: {
				path: "src/example.ts",
				content: "new text",
				oldText: "old log error",
				new_string: "obsolete timeout alias",
			},
		});

		expect(scanned).toEqual(["new text"]);
		expect(effects).toEqual([
			{
				type: "message",
				customType: "evolver-signal",
				content:
					"[Evolution Signal] Detected: [capability_gap, test_failure] in src/example.ts. Consider recording this outcome.",
				display: true,
				deliverAs: "steer",
			},
		]);
	});

	test("edit scans each ordered newText independently and never scans oldText or extras", async () => {
		const scanned: string[] = [];
		const coordinator = createCoreCoordinator(
			createDependencies((text) => {
				scanned.push(text);
				if (text === "first new fragment") return ["test_failure"];
				if (text === "second new fragment") return ["capability_gap"];
				return ["log_error"];
			}),
		);

		const effects = await coordinator.mutationResult({
			toolName: "edit",
			isError: false,
			input: {
				path: "src/example.ts",
				edits: [
					{ oldText: "old timeout", newText: "first new fragment" },
					{ oldText: "old deploy failed", newText: "second new fragment" },
				],
				content: "extra test error",
				diff: "unified diff test failure",
			},
		});

		expect(scanned).toEqual(["first new fragment", "second new fragment"]);
		expect(effects).toHaveLength(1);
		expect(effects[0]?.content).toContain(
			"[capability_gap, test_failure] in src/example.ts",
		);
	});

	test("replace scans only replacement_text and requires current anchors", async () => {
		const scanned: string[] = [];
		const coordinator = createCoreCoordinator(
			createDependencies((text) => {
				scanned.push(text);
				return text === "replacement capability gap" ? ["capability_gap"] : [];
			}),
		);

		const effects = await coordinator.mutationResult({
			toolName: "replace",
			isError: false,
			input: {
				path: "src/example.ts",
				remove_from: "timeout",
				remove_to: "test failure",
				replacement_text: "replacement capability gap",
				content: "extra log error",
			},
		});

		expect(scanned).toEqual(["replacement capability gap"]);
		expect(effects).toHaveLength(1);
	});

	test("samples ordered fragments at independent 8,192-character heads and tails within 65,536 total", async () => {
		const scanned: string[] = [];
		const coordinator = createCoreCoordinator(
			createDependencies((text) => {
				scanned.push(text);
				return [];
			}),
		);
		const fragments = [
			"A".repeat(10_000) + "a".repeat(10_000),
			"B".repeat(10_000) + "b".repeat(10_000),
			"C".repeat(10_000) + "c".repeat(10_000),
			"D".repeat(10_000) + "d".repeat(10_000),
			"E".repeat(10_000) + "e".repeat(10_000),
		];

		const effects = await coordinator.mutationResult({
			toolName: "edit",
			isError: false,
			input: {
				path: "large.ts",
				edits: fragments.map((newText) => ({ oldText: "old", newText })),
			},
		});

		expect(scanned.map((sample) => `${sample[0]}:${sample.length}`)).toEqual([
			"A:8192",
			"a:8192",
			"B:8192",
			"b:8192",
			"C:8192",
			"c:8192",
			"D:8192",
			"d:8192",
		]);
		expect(effects).toEqual([]);
	});

	test("keeps head and tail independent even at the exact 16,384-character boundary", async () => {
		const scanned: string[] = [];
		const coordinator = createCoreCoordinator(
			createDependencies((text) => {
				scanned.push(text);
				return text.includes("not supported") ? ["capability_gap"] : [];
			}),
		);
		const boundaryFragment = "x".repeat(8_188) + "not " + "supported" + "y".repeat(8_183);

		const effects = await coordinator.mutationResult({
			toolName: "write",
			isError: false,
			input: { path: "boundary.ts", content: boundaryFragment },
		});

		expect(scanned).toHaveLength(2);
		expect(effects).toEqual([]);
	});

	test("never forms signal phrases across fragments or head and tail samples", async () => {
		const scanned: string[] = [];
		const coordinator = createCoreCoordinator(
			createDependencies((text) => {
				scanned.push(text);
				return text.includes("not supported") ? ["capability_gap"] : [];
			}),
		);
		const oversized =
			"x".repeat(8_188) +
			"not " +
			"middle".repeat(2_000) +
			"supported" +
			"y".repeat(8_183);

		const effects = await coordinator.mutationResult({
			toolName: "edit",
			isError: false,
			input: {
				path: "separate.ts",
				edits: [
					{ oldText: "old", newText: oversized },
					{ oldText: "old", newText: "not " },
					{ oldText: "old", newText: "supported" },
				],
			},
		});

		expect(scanned).toHaveLength(4);
		expect(effects).toEqual([]);
	});

	const rejectedEvents: Array<{ name: string; event: unknown }> = [
		{
			name: "failed write",
			event: {
				toolName: "write",
				isError: true,
				input: { path: "a.ts", content: "capability gap" },
			},
		},
		{
			name: "write file_path alias",
			event: {
				toolName: "write",
				isError: false,
				input: { file_path: "a.ts", content: "capability gap" },
			},
		},
		{
			name: "write file_text alias",
			event: {
				toolName: "write",
				isError: false,
				input: { path: "a.ts", file_text: "capability gap" },
			},
		},
		{
			name: "write file_content alias",
			event: {
				toolName: "write",
				isError: false,
				input: { path: "a.ts", file_content: "capability gap" },
			},
		},
		{
			name: "edit new_string alias",
			event: {
				toolName: "edit",
				isError: false,
				input: { path: "a.ts", new_string: "capability gap" },
			},
		},
		{
			name: "edit changes content_lines alias",
			event: {
				toolName: "edit",
				isError: false,
				input: { path: "a.ts", changes: [{ content_lines: ["capability gap"] }] },
			},
		},
		{
			name: "historical top-level edit shape",
			event: {
				toolName: "edit",
				isError: false,
				input: { path: "a.ts", oldText: "old", newText: "capability gap" },
			},
		},
		{
			name: "write with blank path",
			event: {
				toolName: "write",
				isError: false,
				input: { path: "   ", content: "capability gap" },
			},
		},
		{
			name: "edit missing one required oldText",
			event: {
				toolName: "edit",
				isError: false,
				input: { path: "a.ts", edits: [{ newText: "capability gap" }] },
			},
		},
		{
			name: "edit missing one required newText",
			event: {
				toolName: "edit",
				isError: false,
				input: { path: "a.ts", edits: [{ oldText: "old" }] },
			},
		},
		{
			name: "replace missing remove_from",
			event: {
				toolName: "replace",
				isError: false,
				input: { path: "a.ts", remove_to: "bbb", replacement_text: "capability gap" },
			},
		},
		{
			name: "replace missing remove_to",
			event: {
				toolName: "replace",
				isError: false,
				input: { path: "a.ts", remove_from: "aaa", replacement_text: "capability gap" },
			},
		},
		{
			name: "replace missing replacement_text",
			event: {
				toolName: "replace",
				isError: false,
				input: { path: "a.ts", remove_from: "aaa", remove_to: "bbb" },
			},
		},
	];

	for (const { name, event } of rejectedEvents) {
		test(`rejects ${name} without scanning fallbacks`, async () => {
			const scanned: string[] = [];
			const coordinator = createCoreCoordinator(
				createDependencies((text) => {
					scanned.push(text);
					return ["capability_gap"];
				}),
			);

			const effects = await coordinator.mutationResult(
				event as MutationResultInput,
			);

			expect(scanned).toEqual([]);
			expect(effects).toEqual([]);
		});
	}
});
