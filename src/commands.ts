// SPDX-License-Identifier: MIT
// The /evolver:* slash commands. The reference plugin ships these as LLM
// prompt files (commands/*.md) that tell the model what to do. pi commands are
// code handlers, so we split each command in two: the handler does the
// mechanical part (read-only git, run the engine CLI, call the Proxy), then
// injects the orchestration instruction via pi.sendUserMessage(deliverAs:
// "steer") so the agent summarizes / asks / infers — the part the reference
// prompt used to do. `evolve`, `search`, and `status` work with just the local
// memory + Proxy bridge; `run`, `solidify`, `review`, `sync`, and `distill`
// shell out to the optional @evomap/evolver engine CLI (resolved at call time,
// with an npx fallback). Ported from EvoMap/evolver-claude-code-plugin
// `commands/*.md` (MIT).

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
const RO_TIMEOUT_MS = 5000;
const OUT_TAIL_MAX = 4000;

function splitArgs(args: string): string[] {
	return args.split(/\s+/).filter(Boolean);
}

/** Whether a CLI is on PATH. Never throws. */
function commandExists(name: string): boolean {
	try {
		const result = spawnSync("sh", ["-c", `command -v ${name}`], {
			stdio: ["ignore", "pipe", "pipe"],
			encoding: "utf8",
			timeout: RO_TIMEOUT_MS,
		});
		return result.status === 0;
	} catch (_err) {
		return false;
	}
}

/** Read-only git subcommand output; "" on any failure. Never throws. */
function gitOut(args: string[], cwd: string): string {
	try {
		const r = spawnSync("git", args, {
			cwd,
			shell: false,
			timeout: RO_TIMEOUT_MS,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return r.status === 0 ? (r.stdout ?? "").trim() : "";
	} catch (_err) {
		return "";
	}
}

/** First line of `<cmd> --version`, or "". Never throws. */
function cliVersion(cmd: string): string {
	try {
		const r = spawnSync(cmd, ["--version"], {
			shell: false,
			timeout: RO_TIMEOUT_MS,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (r.status === 0 && typeof r.stdout === "string") {
			const line = r.stdout.trim().split("\n")[0];
			return line ?? "";
		}
	} catch (_err) {
		// ignore
	}
	return "";
}

/** Run the @evomap/evolver CLI subcommand (npx fallback). Never throws. */
function runEngine(
	sub: string,
	args: string,
	cwd: string,
): { status: number | null; tail: string } {
	const extra = splitArgs(args);
	const hasEvolver = commandExists("evolver");
	const cmd = hasEvolver ? "evolver" : "npx";
	const cmdArgs = hasEvolver
		? [sub, ...extra]
		: ["-y", "@evomap/evolver", sub, ...extra];
	try {
		const r = spawnSync(cmd, cmdArgs, {
			cwd,
			encoding: "utf8",
			timeout: ENGINE_TIMEOUT_MS,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
		const tail = out.length > OUT_TAIL_MAX ? out.slice(-OUT_TAIL_MAX) : out;
		return {
			status: typeof r.status === "number" ? r.status : null,
			tail,
		};
	} catch (err) {
		return {
			status: null,
			tail: `evolver ${sub} failed: ${(err as Error).message}`,
		};
	}
}

/** Inject an orchestration instruction as a user message (triggers a turn).
 * Fails open — orchestration is optional. */
function steer(pi: ExtensionAPI, text: string): void {
	try {
		pi.sendUserMessage(text, { deliverAs: "steer" });
	} catch (_err) {
		// fail open
	}
}

/** /evolver:status — a short health checklist (report only, no agent turn). */
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
			`• Proxy: unavailable — ${status.error ?? "unknown error"}\n` +
				"  Start it with `evolver proxy` in a separate terminal. Local memory works regardless.",
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

	// 3. Workspace id — anchored at the repo root, not ctx.cwd (matches the
	// forge-resistant id file that paths.ts writes under <repoRoot>/.evolver).
	const repoRoot = gitOut(["rev-parse", "--show-toplevel"], ctx.cwd);
	if (repoRoot) {
		const present = fs.existsSync(
			path.join(repoRoot, ".evolver", "workspace-id"),
		);
		lines.push(
			`• Workspace id: ${present ? "present" : "not yet created"} (repo root: ${repoRoot})`,
		);
	} else {
		lines.push("• Workspace id: not a git repo — memory inactive here");
	}

	// 4. Full engine.
	if (commandExists("evolver")) {
		const v = cliVersion("evolver");
		lines.push(`• Engine: @evomap/evolver installed${v ? ` (${v})` : ""}`);
	} else {
		lines.push(
			"• Engine: not installed — `npm i -g @evomap/evolver` unlocks /evolver:run etc.",
		);
	}

	ctx.ui.notify(lines.join("\n"), "info");
}

/** /evolver:search <signal ...> — search the network for reusable assets. */
async function searchCommand(
	pi: ExtensionAPI,
	args: string,
	_ctx: ExtensionCommandContext,
): Promise<void> {
	const signals = splitArgs(args);
	if (signals.length === 0) {
		// No signals: defer to the agent to infer from the current task, then
		// re-invoke with explicit signals (mirrors the reference prompt).
		steer(
			pi,
			"Search EvoMap for reusable genes/capsules before doing work from scratch. " +
				"Infer 2–4 signal keywords from the current task/conversation " +
				"(valid signals: log_error, perf_bottleneck, test_failure, capability_gap, " +
				"user_feature_request, deployment_issue, recurring_error), then run " +
				"`/evolver:search <signals>` (e.g. `/evolver:search log_error perf_bottleneck`).",
		);
		return;
	}
	const res = await proxyFetch("POST", "/asset/search", {
		signals,
		mode: "semantic",
		limit: 5,
	});
	if (!res.ok) {
		steer(
			pi,
			`EvoMap search for [${signals.join(", ")}] failed: ${res.error}\n` +
				"Run /evolver:status to check the Proxy.",
		);
		return;
	}
	steer(
		pi,
		`EvoMap assets for [${signals.join(", ")}]:\n${JSON.stringify(res.data, null, 2)}\n\n` +
			"Summarize each hit: id, type (Gene/Capsule), a one-line description, and relevance. " +
			"If a hit looks directly applicable, offer to fetch its full content with the " +
			"evolver_fetch_asset tool and apply the approach to the current task.",
	);
}

/** /evolver:evolve — a deliberate recall → reflect → record checkpoint. */
async function evolveCommand(
	pi: ExtensionAPI,
	_args: string,
	_ctx: ExtensionCommandContext,
): Promise<void> {
	steer(
		pi,
		"Evolution checkpoint.\n" +
			"1) Recall: look at the evolution memory injected at session start (or read the tail " +
			"of the memory graph at ~/.evolver/memory/evolution/memory_graph.jsonl, or the " +
			"project's memory/evolution/memory_graph.jsonl if present). Summarize any recent " +
			"outcome — success or failure — relevant to the current task.\n" +
			"2) Reflect: given the current diff / task state, state in one or two lines what " +
			"worked, what didn't, and the durable lesson.\n" +
			"3) Record: the session_shutdown handler records the outcome automatically. If the " +
			"user wants a full engine cycle now and `evolver` is on PATH, run `/evolver:run` " +
			"(or `evolver run`).\n" +
			"Keep it lightweight — an explicit checkpoint, not a ceremony on every turn.",
	);
}

/** /evolver:run — one Evolver self-evolution cycle (engine). */
async function runCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!isGitWorkspace(ctx.cwd)) {
		steer(pi, "Evolver requires a git repository.");
		return;
	}
	const { status, tail } = runEngine("run", args, ctx.cwd);
	steer(
		pi,
		`Ran \`evolver run${args ? ` ${args}` : ""}\` (exit ${status ?? "?"}). Output (tail):\n\n${tail || "(no output)"}\n\n` +
			"Summarize: which signals were collected, which gene was selected/mutated, and " +
			"whether any changes are now pending solidify. If changes are pending, remind the " +
			"user they can inspect with `/evolver:review` (or roll back with " +
			"`/evolver:review --reject`). Do NOT auto-approve pending changes.",
	);
}

/** /evolver:solidify — solidify working changes into a durable gene (engine). */
async function solidifyCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!isGitWorkspace(ctx.cwd)) {
		steer(pi, "Evolver requires a git repository.");
		return;
	}
	const a = splitArgs(args);
	const hasSummary = a.some((x) => x.startsWith("--summary="));
	// --dry-run is safe to run without a summary.
	if (hasSummary || a.includes("--dry-run")) {
		const { status, tail } = runEngine("solidify", args, ctx.cwd);
		steer(
			pi,
			`Ran \`evolver solidify${args ? ` ${args}` : ""}\` (exit ${status ?? "?"}). Output (tail):\n\n${tail || "(no output)"}\n\n` +
				"Report the gene/capsule that was created or updated, and whether a rollback " +
				"point was recorded.",
		);
		return;
	}
	// No --summary: defer to the agent to infer one from the diff, then re-invoke.
	const diffStat = gitOut(["diff", "--stat"], ctx.cwd);
	steer(
		pi,
		`Current working-tree changes:\n\n git diff --stat:\n${diffStat || "(no diff)"}\n\n` +
			"Infer a concise one-line summary of this change from the diff, then run " +
			'`/evolver:solidify --summary="<inferred>"` (tip: pass --dry-run first to preview ' +
			"without writing).",
	);
}

/** /evolver:review — review pending changes, then approve or reject (engine). */
async function reviewCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	if (!isGitWorkspace(ctx.cwd)) {
		steer(pi, "Evolver requires a git repository.");
		return;
	}
	const a = splitArgs(args);
	const hasFlag = a.some((x) => x === "--approve" || x === "--reject");
	if (hasFlag) {
		const { status, tail } = runEngine("review", args, ctx.cwd);
		steer(
			pi,
			`Ran \`evolver review ${args}\` (exit ${status ?? "?"}). Output (tail):\n\n${tail || "(no output)"}\n\n` +
				"Report the final state (solidified or rolled back) and the resulting git status " +
				"(run `git status --short` to show it).",
		);
		return;
	}
	// No flag: show the pending diff and ask the user before running anything.
	const statusShort = gitOut(["status", "--short"], ctx.cwd);
	const unstaged = gitOut(["diff", "--stat"], ctx.cwd);
	const staged = gitOut(["diff", "--cached", "--stat"], ctx.cwd);
	steer(
		pi,
		`Review the changes Evolver currently has pending solidify in this repo.\n\n` +
			` git status --short:\n${statusShort || "(clean)"}\n\n` +
			` git diff --stat:\n${unstaged || "(none)"}\n` +
			(staged ? `(staged) ${staged}` : "") +
			"\n\nDo NOT run anything yet. Show the user the pending diff above and ask whether " +
			"to approve (solidify) or reject (roll back). Once they decide, run " +
			"`/evolver:review --approve` or `/evolver:review --reject`.",
	);
}

/** /evolver:sync — sync assets with the EvoMap Hub (engine). */
async function syncCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const { status, tail } = runEngine("sync", args, ctx.cwd);
	steer(
		pi,
		`Ran \`evolver sync${args ? ` ${args}` : ""}\` (exit ${status ?? "?"}). Output (tail):\n\n${tail || "(no output)"}\n\n` +
			"Summarize: how many assets were pulled/updated, any local-only (unpublished) " +
			"assets listed, and — if --export was given — where the .gepx archive was written. " +
			"If it reports node identity or Hub credentials are missing, point the user to " +
			"`/evolver:status`.",
	);
}

/** /evolver:distill — distill a reusable gene from run history (engine). */
async function distillCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const a = splitArgs(args);
	if (a.length === 0) {
		// No args: prefer the conversation-distill tool when the lesson came from
		// this conversation (mirrors the reference prompt's preference).
		steer(
			pi,
			"Distill a reusable skill/gene from recent run history. If the reusable lesson came " +
				"from THIS conversation, prefer calling the `evolver_distill_conversation` tool " +
				"with a concrete summary, signals, strategy steps, artifact paths/links, and " +
				"validation evidence — it lets the local Proxy quality-gate, persist, and queue " +
				"Hub publishing. Otherwise run `/evolver:distill --response-file=<path>` (or plain " +
				"`/evolver:distill`).",
		);
		return;
	}
	const { status, tail } = runEngine("distill", args, ctx.cwd);
	steer(
		pi,
		`Ran \`evolver distill ${args}\` (exit ${status ?? "?"}). Output (tail):\n\n${tail || "(no output)"}\n\n` +
			"Explain what was distilled: the candidate skill/gene and the signals it generalizes. " +
			"Remind the user that only assets produced through genuine Evolver self-evolution " +
			"are eligible to be published to the EvoMap skill store via `/evolver:sync`.",
	);
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("evolver:status", {
		description:
			"Evolver health — Proxy, evolution memory, workspace id, engine.",
		handler: (args, ctx) => statusCommand(args, ctx),
	});
	pi.registerCommand("evolver:search", {
		description:
			"Search the EvoMap network for reusable genes/capsules by signal.",
		handler: (args, ctx) => searchCommand(pi, args, ctx),
	});
	pi.registerCommand("evolver:evolve", {
		description: "Run an evolution checkpoint — recall, reflect, record.",
		handler: (args, ctx) => evolveCommand(pi, args, ctx),
	});
	pi.registerCommand("evolver:run", {
		description:
			"Run one Evolver self-evolution cycle on the current repo (engine).",
		handler: (args, ctx) => runCommand(pi, args, ctx),
	});
	pi.registerCommand("evolver:solidify", {
		description: "Solidify pending evolution changes (engine).",
		handler: (args, ctx) => solidifyCommand(pi, args, ctx),
	});
	pi.registerCommand("evolver:review", {
		description:
			"Review pending evolution changes; --reject to roll back (engine).",
		handler: (args, ctx) => reviewCommand(pi, args, ctx),
	});
	pi.registerCommand("evolver:sync", {
		description: "Sync evolution assets with the EvoMap Hub (engine).",
		handler: (args, ctx) => syncCommand(pi, args, ctx),
	});
	pi.registerCommand("evolver:distill", {
		description: "Distill a reusable gene from run history (engine).",
		handler: (args, ctx) => distillCommand(pi, args, ctx),
	});
}
