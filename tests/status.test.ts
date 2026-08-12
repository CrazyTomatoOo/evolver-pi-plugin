// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import {
	deriveHealth,
	prefix,
	previewLesson,
	renderStatus,
	type StatusSnapshot,
} from "../src/status";

function base(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
	const snapshot: StatusSnapshot = {
		workspace: {
			root: "/repo",
			gitHealth: "ok",
			workspaceIdPrefix: "abcd1234abcd",
			sessionIdPrefix: "000011112222",
			recordingReady: true,
			disabledReason: null,
		},
		graph: {
			path: "/repo/memory_graph.jsonl",
			health: "ok",
			totalCount: 3,
			workspaceCount: 2,
			malformedCount: 0,
			lockState: "free",
		},
		session: {
			baselinePrefix: "ba5e1".padEnd(12, "0"),
			currentPrefix: "cu111".padEnd(12, "1"),
			changed: true,
			transitionHashPrefix: "deadbeefdead",
			graphContainsIdentity: false,
			signals: ["regression"],
			readyOutboxCount: 0,
		},
		pending: {
			verdict: "success",
			source: "tool:evolver_outcome",
			submittedAt: "2026-08-12T12:00:00.000Z",
			snapshotMatches: true,
			lessonPreview: "reuse this",
			lessonOriginalLength: 10,
		},
		recall: {
			eligibleSuccess: 2,
			eligibleFailed: 1,
			selectedSuccess: 2,
			selectedFailed: 1,
			formattedCharCount: 480,
			recallHashPrefix: "feedfacefeed",
			deliveryState: "delivered",
		},
		lastAttempt: {
			code: "recorded",
			timestamp: "2026-08-12T12:00:01.000Z",
			identityPrefix: "deadbeefdead",
			source: "tool:evolver_outcome",
		},
		lastRecorded: null,
		overallHealth: "ready",
	};
	return { ...snapshot, ...overrides, workspace: { ...snapshot.workspace, ...overrides.workspace }, graph: { ...snapshot.graph, ...overrides.graph }, session: overrides.session === undefined ? snapshot.session : overrides.session, pending: overrides.pending === undefined ? snapshot.pending : overrides.pending, recall: overrides.recall === undefined ? snapshot.recall : overrides.recall };
}

describe("Status rendering and redaction", () => {
	test("identifiers are 12-character prefixes and paths are full", () => {
		const lines = renderStatus(base());
		expect(lines.some((l) => l.includes("/repo/memory_graph.jsonl"))).toBe(true);
		expect(lines.some((l) => l.includes("workspace: abcd1234abcd"))).toBe(true);
		expect(lines.some((l) => l.includes("hash: feedfacefeed"))).toBe(true);
		// No full hash appears anywhere.
		expect(lines.some((l) => l.includes("feedfacefeedface"))).toBe(false);
	});

	test("a long pending lesson is bounded to 160 characters with its original length", () => {
		const long = "x".repeat(2_000);
		const { preview, originalLength } = previewLesson(long);
		expect(preview.length).toBeLessThanOrEqual(161);
		expect(originalLength).toBe(2_000);
		const lines = renderStatus(base({ pending: { verdict: "success", source: "tool:evolver_outcome", submittedAt: "2026-08-12T12:00:00.000Z", snapshotMatches: true, lessonPreview: preview, lessonOriginalLength: originalLength } }));
		expect(lines.some((l) => l.includes("(2000)"))).toBe(true);
		// The full lesson is never rendered.
		expect(lines.some((l) => l.includes("x".repeat(200)))).toBe(false);
	});

	test("no diff contents, raw JSON, history, or stack traces appear", () => {
		const lines = renderStatus(base());
		const blob = lines.join("\n");
		expect(blob).not.toContain("diff --git");
		expect(blob).not.toContain("new_text");
		expect(blob).not.toContain("{");
		expect(blob).not.toContain("at /");
	});
});

describe("Status health derivation", () => {
	test("disabled when recording is not ready or Git is unavailable", () => {
		expect(deriveHealth(base({ workspace: { root: "/repo", gitHealth: "ok", workspaceIdPrefix: null, sessionIdPrefix: null, recordingReady: false, disabledReason: "no workspace id" } }))).toBe("disabled");
		expect(deriveHealth(base({ workspace: { root: "/repo", gitHealth: "unavailable", workspaceIdPrefix: null, sessionIdPrefix: null, recordingReady: true, disabledReason: null } }))).toBe("disabled");
	});

	test("degraded for malformed Graph, busy/stale lock, ready outbox, or stale pending", () => {
		expect(deriveHealth(base({ graph: { path: "/g", health: "malformed", totalCount: 0, workspaceCount: 0, malformedCount: 1, lockState: "free" } }))).toBe("degraded");
		expect(deriveHealth(base({ graph: { path: "/g", health: "ok", totalCount: 0, workspaceCount: 0, malformedCount: 0, lockState: "busy" } }))).toBe("degraded");
		expect(deriveHealth(base({ session: { baselinePrefix: "b", currentPrefix: "c", changed: true, transitionHashPrefix: "t", graphContainsIdentity: false, signals: [], readyOutboxCount: 1 } }))).toBe("degraded");
		expect(deriveHealth(base({ pending: { verdict: "success", source: "tool:evolver_outcome", submittedAt: "2026-08-12T12:00:00.000Z", snapshotMatches: false, lessonPreview: "p", lessonOriginalLength: 1 } }))).toBe("degraded");
	});

	test("ready otherwise, including empty normal states", () => {
		expect(deriveHealth(base({ session: { baselinePrefix: "b", currentPrefix: "b", changed: false, transitionHashPrefix: "t", graphContainsIdentity: false, signals: [], readyOutboxCount: 0 } }))).toBe("ready");
		expect(deriveHealth(base({ pending: null }))).toBe("ready");
		expect(deriveHealth(base({ recall: null }))).toBe("ready");
	});
});

describe("prefix helper", () => {
	test("returns null for absent values and 12 chars otherwise", () => {
		expect(prefix(null)).toBeNull();
		expect(prefix("")).toBeNull();
		expect(prefix("short")).toBe("short");
		expect(prefix("abcdefghijklmnopqrstuvwxyz")).toBe("abcdefghijkl");
	});
});
