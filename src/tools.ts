// SPDX-License-Identifier: MIT
// The seven EvoMap Proxy mailbox tools, exposed as native pi tools (pi has no
// built-in MCP). Schemas and endpoints ported from EvoMap/evolver-claude-code-
// plugin `mcp/evolver-proxy.mjs` (MIT). Every tool degrades gracefully when the
// Proxy is down — it returns a structured error result and never throws.

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { proxyFetch, type ProxyResult } from "./proxy";

/** Render a ProxyResult as a pi tool result. */
function asResult(res: ProxyResult): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError: boolean;
} {
  const text = res.ok
    ? JSON.stringify(res.data, null, 2)
    : (res.error ?? "unknown error");
  return { content: [{ type: "text", text }], details: {}, isError: !res.ok };
}

const SIGNALS = Type.Optional(
  Type.Array(Type.String(), {
    description:
      'Signal keywords, e.g. ["log_error","perf_bottleneck","test_failure"].',
  }),
);

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "evolver_status",
    label: "Evolver status",
    description:
      "Get the EvoMap Proxy status: running state, node_id, pending inbound/outbound message counts, and last Hub sync time. Use this first to confirm the Proxy is up.",
    parameters: Type.Object({}),
    async execute() {
      return asResult(await proxyFetch("GET", "/proxy/status"));
    },
  });

  pi.registerTool({
    name: "evolver_search_assets",
    label: "Evolver search assets",
    description:
      "Search the EvoMap network for reusable evolution assets (Genes and Capsules). Pass `query` to describe your current task/situation in natural language (semantic search — recommended when you are unsure which signal keywords apply) and/or `signals` to match on known signal keywords; provide at least one. Call this BEFORE starting substantive work to reuse proven approaches instead of reinventing them.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            'Free-text description of the current task/situation, e.g. "restore quoted reply text in a feishu bot". Provide query and/or signals.',
        }),
      ),
      signals: SIGNALS,
      mode: Type.Optional(
        Type.Union([Type.Literal("semantic"), Type.Literal("exact")], {
          description: "Search mode. Defaults to semantic.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 25, description: "Defaults to 5." }),
      ),
    }),
    async execute(_id, params) {
      return asResult(
        await proxyFetch("POST", "/asset/search", {
          query: params.query,
          signals: params.signals,
          mode: params.mode || "semantic",
          limit: params.limit || 5,
        }),
      );
    },
  });

  pi.registerTool({
    name: "evolver_fetch_asset",
    label: "Evolver fetch asset",
    description:
      'Fetch the full content of one or more evolution assets by their IDs (e.g. "sha256:abc..."), as returned by evolver_search_assets. After you actually reuse any of these in your work, call evolver_report_reuse with their IDs so the original author gets credit.',
    parameters: Type.Object({
      asset_ids: Type.Array(Type.String(), { minItems: 1 }),
    }),
    async execute(_id, params) {
      const res = await proxyFetch("POST", "/asset/fetch", {
        asset_ids: params.asset_ids,
      });
      // Close the reuse-reward loop: nudge the agent, in-context, to report
      // what it reuses. Additive top-level field — does not alter results.
      if (res.ok && res.data && typeof res.data === "object" && !Array.isArray(res.data)) {
        res.data = {
          ...(res.data as Record<string, unknown>),
          _reuse_hint:
            "If you build on any of these assets, call evolver_report_reuse with the asset_ids you reused so the author gets credit.",
        };
      }
      return asResult(res);
    },
  });

  pi.registerTool({
    name: "evolver_report_reuse",
    label: "Evolver report reuse",
    description:
      "Report that you actually REUSED one or more fetched Gene/Capsule assets in your work (not just viewed them). This credits the original authors and feeds the reuse-reward network. Call it after you build on an asset fetched via evolver_fetch_asset; pass the asset_ids you genuinely reused.",
    parameters: Type.Object({
      asset_ids: Type.Array(Type.String(), {
        minItems: 1,
        description: "The asset IDs you reused (as returned by evolver_fetch_asset).",
      }),
      outcome: Type.Optional(
        Type.Union([Type.Literal("success"), Type.Literal("failed")], {
          description: "Whether reusing them worked out. Defaults to success.",
        }),
      ),
      signals: SIGNALS,
    }),
    async execute(_id, params) {
      return asResult(
        await proxyFetch("POST", "/asset/report-reuse", {
          used_asset_ids: params.asset_ids,
          status: params.outcome || "success",
          signals: params.signals,
        }),
      );
    },
  });

  pi.registerTool({
    name: "evolver_publish_asset",
    label: "Evolver publish asset",
    description:
      "Publish one or more evolution assets (Genes/Capsules) to the EvoMap Hub for review. Queued locally and synced by the Proxy in the background; poll asset_submit_result with evolver_poll to see the Hub decision.",
    parameters: Type.Object({
      assets: Type.Array(
        Type.Object({
          type: Type.Union([Type.Literal("Gene"), Type.Literal("Capsule")]),
          content: Type.String(),
          summary: Type.Optional(Type.String()),
          signals: Type.Optional(Type.Array(Type.String())),
        }),
        { minItems: 1 },
      ),
    }),
    async execute(_id, params) {
      return asResult(
        await proxyFetch("POST", "/asset/submit", { assets: params.assets }),
      );
    },
  });

  pi.registerTool({
    name: "evolver_distill_conversation",
    label: "Evolver distill conversation",
    description:
      "Distill a reusable Gene/Capsule from the current conversation. Provide a concrete summary, strategy/evidence, artifacts, and validation; the Proxy gates quality, stores locally, and queues Hub publishing.",
    parameters: Type.Object({
      summary: Type.String({
        description: "Concrete reusable lesson or capability distilled from the conversation.",
      }),
      title: Type.Optional(Type.String()),
      platform: Type.Optional(Type.String({ description: "Defaults to pi." })),
      thread_id: Type.Optional(Type.String()),
      user_prompt: Type.Optional(Type.String()),
      assistant_summary: Type.Optional(Type.String()),
      transcript: Type.Optional(Type.String()),
      signals: Type.Optional(Type.Array(Type.String())),
      strategy: Type.Optional(Type.Array(Type.String())),
      artifacts: Type.Optional(Type.Array(Type.String())),
      validation: Type.Optional(Type.Array(Type.String())),
      persist: Type.Optional(Type.Boolean({ description: "Defaults to true." })),
      publish: Type.Optional(Type.Boolean({ description: "Defaults to true." })),
      min_score: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 10, description: "Defaults to 5." }),
      ),
    }),
    async execute(_id, params) {
      return asResult(
        await proxyFetch("POST", "/conversation/distill", {
          ...params,
          platform: params.platform || "pi",
        }),
      );
    },
  });

  pi.registerTool({
    name: "evolver_poll",
    label: "Evolver poll",
    description:
      'Poll the local mailbox for inbound messages by type, e.g. "asset_submit_result" (Hub review decisions), "hub_event", or "task_available". Returns and does not auto-acknowledge.',
    parameters: Type.Object({
      type: Type.Optional(
        Type.String({ description: 'Message type filter, e.g. "asset_submit_result".' }),
      ),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 50, description: "Defaults to 10." }),
      ),
    }),
    async execute(_id, params) {
      return asResult(
        await proxyFetch("POST", "/mailbox/poll", {
          type: params.type,
          limit: params.limit || 10,
        }),
      );
    },
  });
}
