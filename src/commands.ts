// SPDX-License-Identifier: MIT
// The /evolver:* slash commands. `evolve`, `search`, and `status` work with
// just the local memory + Proxy bridge; `run`, `solidify`, `review`, `sync`,
// and `distill` shell out to the optional @evomap/evolver engine CLI (resolved
// at call time, with an npx fallback). Ported from EvoMap/evolver-claude-code-
// plugin `commands/*.md` (MIT).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { proxyFetch } from "./proxy";
import { isGitWorkspace, findMemoryGraph } from "./paths";
import { readEntries } from "./memory";

const ENGINE_TIMEOUT_MS = 120000;

function splitArgs(args: string): string[] {
	return args.split(/\s+/).filter(Boolean);
}

/** Whether a CLI is on PATH. Never throws. */
function commandExists(name: string): boolean {
	try {
		const result = spawnSync("sh", ["-c", `command -v ${name}`], {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			timeout: 5000,
		});
		return result.status === 0;
	} catch (_err) {
		return false;
	}
}

/** /evolver:status — a short health checklist. */
async function statusCommand(
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const lines: string[] = ["Evolver health"];

	// 1. Proxy / network.
	const status = await proxyFetch("GET", "/proxy/status");
	if (status.ok) {
		const d = status.data as Record<string, unknown>;
		lines.push(
			`• Proxy: up (node ${String(d.node_id ?? "?")}, ` +
				`in ${String(d.inbound_pending ?? 0)} / out ${String(d.outbound_pending ?? 0)}, ` +
				`last sync ${String(d.last_sync_at ?? "?")})`,
		);
	} else {
		lines.push(
			"• Proxy: down — starts when you run `evolver` once in a git repo. Local memory works regardless.",
		);
	}
	try {
		const claimFile = path.join(os.homedir(), ".evomap", "claim_url");
		const claimUrl = fs.readFileSync(claimFile, "utf8").trim();
		if (/^https?:\/\//.test(claimUrl)) {
			lines.push(
				`• Node not yet claimed — sign in to evomap.ai and open: ${claimUrl}`,
			);
		}
	} catch (_err) {
		// no pending claim — fine
	}

	// 2. Evolution memory.
	try {
		const graph = findMemoryGraph(ctx.cwd);
		if (fs.existsSync(graph)) {
			lines.push(`• Memory: ${graph} (${readEntries(graph).length} outcomes)`);
		} else {
			lines.push(
				"• Memory: none yet (appears after a session ends with changes in a git repo)",
			);
		}
	} catch (_err) {
		lines.push("• Memory: unknown");
	}

	// 3. Workspace id.
	if (isGitWorkspace(ctx.cwd)) {
		const present = fs.existsSync(
			path.join(ctx.cwd, ".evolver", "workspace-id"),
		);
		lines.push(`• Workspace id: ${present ? "present" : "not yet created"}`);
	} else {
		lines.push("• Workspace id: not a git repo — memory inactive here");
	}

	// 4. Full engine.
	if (commandExists("evolver")) {
		lines.push("• Engine: @evomap/evolver installed");
	} else {
		lines.push(
			"• Engine: not installed — `npm i -g @evomap/evolver` unlocks /evolver:run etc.",
		);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

/** /evolver:search <signal ...> — search the network for reusable assets. */
async function searchCommand(
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const signals = splitArgs(args);
	if (signals.length === 0) {
		ctx.ui.notify(
			"Usage: /evolver:search <signal> [signal ...]  e.g. log_error perf_bottleneck test_failure",
			"info",
		);
		return;
	}
	const res = await proxyFetch("POST", "/asset/search", {
		signals,
		mode: "semantic",
		limit: 5,
	});
	if (!res.ok) {
		ctx.ui.notify(
			`${res.error}\nRun /evolver:status to check the Proxy.`,
			"error",
		);
		return;
	}
	ctx.ui.notify(
		`EvoMap assets for [${signals.join(", ")}]:\n${JSON.stringify(res.data, null, 2)}`,
		"info",
	);
}

/** /evolver:evolve — a deliberate recall → reflect → record checkpoint. */
async function evolveCommand(
	_args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	ctx.ui.notify(
		"Evolution checkpoint: recall relevant past outcomes from the injected evolution memory " +
			"(or the tail of memory_graph.jsonl), reflect in one or two lines on what worked / didn't / " +
			"the durable lesson, then continue — the session-end recorder captures the outcome automatically. " +
			"Run /evolver:run for a full engine cycle.",
		"info",
	);
}

/** Build a handler that shells out to the @evomap/evolver engine CLI. */
function engineCommand(sub: string) {
	return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
		if (!isGitWorkspace(ctx.cwd)) {
			ctx.ui.notify("Evolver requires a git repository.", "error");
			return;
		}
		const extra = splitArgs(args);
		const hasEvolver = commandExists("evolver");
		const cmd = hasEvolver ? "evolver" : "npx";
		const cmdArgs = hasEvolver
			? [sub, ...extra]
			: ["-y", "@evomap/evolver", sub, ...extra];
		ctx.ui.notify(`Running evolver ${sub}…`, "info");
		try {
			const result = spawnSync(cmd, cmdArgs, {
				cwd: ctx.cwd,
				encoding: "utf8",
				timeout: ENGINE_TIMEOUT_MS,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const out = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
			const tail = out.length > 4000 ? out.slice(-4000) : out;
			ctx.ui.notify(
				`evolver ${sub} exited ${result.status ?? "?"}\n${tail || "(no output)"}`,
				result.status === 0 ? "info" : "error",
			);
		} catch (err) {
			ctx.ui.notify(
				`evolver ${sub} failed: ${(err as Error).message}`,
				"error",
			);
		}
	};
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("evolver:status", {
		description:
			"Evolver health — Proxy, evolution memory, workspace id, engine.",
		handler: statusCommand,
	});
	pi.registerCommand("evolver:search", {
		description:
			"Search the EvoMap network for reusable genes/capsules by signal.",
		handler: searchCommand,
	});
	pi.registerCommand("evolver:evolve", {
		description: "Run an evolution checkpoint — recall, reflect, record.",
		handler: evolveCommand,
	});
	pi.registerCommand("evolver:run", {
		description:
			"Run one Evolver self-evolution cycle on the current repo (engine).",
		handler: engineCommand("run"),
	});
	pi.registerCommand("evolver:solidify", {
		description: "Solidify pending evolution changes (engine).",
		handler: engineCommand("solidify"),
	});
	pi.registerCommand("evolver:review", {
		description:
			"Review pending evolution changes; --reject to roll back (engine).",
		handler: engineCommand("review"),
	});
	pi.registerCommand("evolver:sync", {
		description: "Sync evolution assets with the EvoMap Hub (engine).",
		handler: engineCommand("sync"),
	});
	pi.registerCommand("evolver:distill", {
		description: "Distill a reusable gene from run history (engine).",
		handler: engineCommand("distill"),
	});
}
