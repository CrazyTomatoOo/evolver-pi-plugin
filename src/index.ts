// SPDX-License-Identifier: MIT
// Evolver — agent self-evolving engine for pi (local-memory edition).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createCoreCoordinator } from "./core-coordinator";
import { loadRecall } from "./recall";
import { registerPiAdapter } from "./pi-adapter";
import { detectSignals } from "./signals";

export default function (pi: ExtensionAPI): void {
	const coordinator = createCoreCoordinator({
		loadRecall,
		now: Date.now,
		detectSignals,
	});
	registerPiAdapter(pi, coordinator, join(__dirname, "..", "skills"));
}
