// SPDX-License-Identifier: MIT
// Evolver — agent self-evolving engine for pi.
//
// A faithful pi port of EvoMap/evolver-claude-code-plugin. Three automatic
// behaviors (no invocation needed):
//   - session_start  → inject recent successful outcomes for this workspace.
//   - tool_result    → scan write/edit output for improvement signals.
//   - session_shutdown(reason:"quit") → classify the session's git diff and
//                                       append the outcome to the memory graph.
// Memory is workspace-scoped and byte-compatible with the @evomap/evolver
// engine and the sibling Claude/Cursor plugins. Everything fails open.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { detectSignals } from "./signals";
import { buildRecallText } from "./recall";
import { recordOutcome } from "./record";

// pi file-mutation tools whose output we scan for evolution signals.
const WRITE_TOOLS = new Set(["write", "edit", "replace"]);

/** Pull the edited content out of pi's tool input shapes. */
function extractContent(input: Record<string, unknown>): string {
  if (typeof input.content === "string") return input.content;
  if (typeof input.new_string === "string") return input.new_string;
  if (typeof input.file_text === "string") return input.file_text;
  if (typeof input.file_content === "string") return input.file_content;
  // pi's `replace` tool carries an array of { content_lines } edits.
  if (Array.isArray(input.changes)) {
    return (input.changes as Array<{ content_lines?: unknown }>)
      .map((c) =>
        Array.isArray(c?.content_lines)
          ? (c.content_lines as string[]).join("\n")
          : "",
      )
      .join("\n");
  }
  return "";
}

/** Pull the edited file path out of pi's tool input shapes. */
function extractFilePath(input: Record<string, unknown>): string {
  if (typeof input.path === "string") return input.path;
  if (typeof input.file_path === "string") return input.file_path;
  return "";
}

export default function (pi: ExtensionAPI) {
  // Recall: inject recent successful outcomes once per session.
  pi.on("session_start", async (_event, ctx) => {
    try {
      const text = buildRecallText(ctx.cwd);
      if (text) {
        pi.sendMessage(
          { customType: "evolver-recall", content: text, display: true },
          { deliverAs: "nextTurn" },
        );
      }
    } catch (_err) {
      // fail open — recall is optional
    }
  });

  // Signal detection: scan edits for improvement signals and nudge the agent.
  pi.on("tool_result", async (event, _ctx) => {
    try {
      if (!WRITE_TOOLS.has(event.toolName)) return;
      const input = (event.input ?? {}) as Record<string, unknown>;
      const signals = detectSignals(extractContent(input));
      if (signals.length === 0) return;
      const where = extractFilePath(input) || "edited file";
      const msg =
        `[Evolution Signal] Detected: [${signals.join(", ")}] in ${where}. ` +
        "Consider recording this outcome.";
      pi.sendMessage(
        { customType: "evolver-signal", content: msg, display: true },
        { deliverAs: "steer" },
      );
    } catch (_err) {
      // fail open — detection is optional
    }
  });

  // Record: classify the session's git diff once, on true exit.
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason !== "quit") return;
    try {
      const sessionId = ctx.sessionManager.getSessionId?.() ?? null;
      await recordOutcome(ctx.cwd, sessionId);
    } catch (_err) {
      // fail open — recording is optional
    }
  });

  // Ship the capability-evolver skill.
  pi.on("resources_discover", async (_event, _ctx) => ({
    skillPaths: [join(__dirname, "..", "skills")],
  }));
}
