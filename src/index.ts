// SPDX-License-Identifier: MIT
// Evolver — agent self-evolving engine for pi (local-memory edition).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { createCoreCoordinator } from "./core-coordinator";
import { buildRecallText } from "./recall";
import { recordOutcome } from "./record";
import { registerPiAdapter } from "./pi-adapter";
import { detectSignals } from "./signals";

export default function (pi: ExtensionAPI): void {
	const coordinator = createCoreCoordinator({
		buildRecallText,
		detectSignals,
		recordOutcome,
	});
	registerPiAdapter(pi, coordinator, join(__dirname, "..", "skills"));
}
