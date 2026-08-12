// SPDX-License-Identifier: MIT
// Evolver — agent self-evolving engine for pi (local-memory edition).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createCoreCoordinator } from "./core-coordinator";
import { createGraphRecorder } from "./graph-recorder";
import { loadRecall } from "./recall";
import { findMemoryGraph } from "./paths";
import { prefix } from "./status";
import { registerPiAdapter } from "./pi-adapter";
import { resolveWorkspaceId } from "./paths";
import { createSessionTransitionStore } from "./session-transition";
import { detectSignals } from "./signals";

export default function (pi: ExtensionAPI): void {
	const transitions = createSessionTransitionStore(createGraphRecorder());
	const coordinator = createCoreCoordinator({
		loadRecall,
		now: Date.now,
		detectSignals,
		resolveWorkspaceId,
		startSessionTransition: (cwd, workspaceId, sessionId) => {
			transitions.start(cwd, workspaceId, sessionId);
		},
		addSessionSignals: (workspaceId, sessionId, signals) => {
			transitions.addSignals(workspaceId, sessionId, signals);
		},
		submitSessionOutcome: (cwd, workspaceId, sessionId, submission, source, submittedAt) =>
			transitions.submit(cwd, workspaceId, sessionId, submission, source, submittedAt),
		finalizeSessionOutcome: (cwd, workspaceId, sessionId) =>
			transitions.finalize(cwd, workspaceId, sessionId, findMemoryGraph(cwd)),
		recoverCrashLeftOutcomes: (cwd, workspaceId) =>
			transitions.recoverCrashLeft(cwd, workspaceId, findMemoryGraph(cwd)),
		drainReadyOutbox: (cwd, workspaceId) =>
			transitions.drainOutbox(workspaceId, findMemoryGraph(cwd)),
		inspectStatusSnapshot: (cwd, workspaceId, sessionId) =>
			transitions.inspectStatus(cwd, workspaceId, sessionId, findMemoryGraph(cwd)),
		pendingAnnouncements: (workspaceId) =>
			transitions.pendingAnnouncements(workspaceId).map(
				(r) => `${r.code} — ${r.identity?.source ?? "evolver"} (${r.identity ? prefix(r.identity.diffHash) : "—"})`,
			),
	});
	registerPiAdapter(pi, coordinator, join(__dirname, "..", "skills"));
}
