// SPDX-License-Identifier: MIT
// Ported from EvoMap/evolver-claude-code-plugin `mcp/evolver-proxy.mjs` (MIT).
// Client for the local EvoMap Proxy mailbox. The Proxy is a separate local
// process started by the @evomap/evolver CLI; this client never spawns it. When
// it is down, every call degrades to a helpful { ok:false, error } — it never
// throws.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REQUEST_TIMEOUT_MS = 8000;

export interface ProxyResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ProxySettings {
  url: string;
  token: string | null;
}

function defaultProxyUrl(): string {
  return `http://127.0.0.1:${process.env.EVOMAP_PROXY_PORT || "19820"}`;
}

function isLoopbackHost(hostname: string): boolean {
  const value = String(hostname || "").toLowerCase();
  return (
    value === "localhost" ||
    value === "127.0.0.1" ||
    value === "::1" ||
    value.endsWith(".localhost")
  );
}

function normalizeLocalProxyUrl(raw: unknown): string | null {
  try {
    const parsed = new URL(String(raw));
    if (!["http:", "https:"].includes(parsed.protocol)) return null;
    if (!isLoopbackHost(parsed.hostname)) return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Resolve the live Proxy connection. `~/.evolver/settings.json` is
 * authoritative: the running Proxy writes both its url and a per-instance auth
 * token there. Recent Proxy builds reject unauthenticated local requests with
 * 401, so we send `Authorization: Bearer <token>`. Re-read every call — the
 * token rotates whenever the Proxy restarts. Never log or echo the token. */
export function readProxySettings(): ProxySettings {
  let url: string | null = null;
  let token: string | null = null;
  try {
    const s = JSON.parse(
      readFileSync(join(homedir(), ".evolver", "settings.json"), "utf8"),
    ) as { proxy?: { url?: unknown; token?: unknown } };
    if (s?.proxy?.url) url = normalizeLocalProxyUrl(s.proxy.url);
    if (s?.proxy?.token) token = String(s.proxy.token);
  } catch {
    // not running / unreadable — fall through
  }
  if (!url) {
    url = defaultProxyUrl();
    token = null;
  }
  return { url, token };
}

/** Call a Proxy endpoint. Always resolves to a ProxyResult; never throws. */
export async function proxyFetch(
  method: string,
  path: string,
  body?: unknown,
): Promise<ProxyResult> {
  const { url: base, token } = readProxySettings();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetch(base + path, {
      method,
      headers: Object.keys(headers).length ? headers : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      // Make auth/connection failures actionable. Never echo the token.
      let hint = "";
      if ([401, 403].includes(res.status)) {
        hint = token
          ? " The Proxy token in ~/.evolver/settings.json looks stale (the Proxy mints a fresh token on restart). Restart the pi session so the bridge re-reads it, or run /evolver:status."
          : ` No Proxy token found in ~/.evolver/settings.json and the request was rejected — another process may be using ${base}. Start the Proxy (run \`evolver\` once in a git repo) or set EVOMAP_PROXY_PORT, then run /evolver:status.`;
      } else if (res.status === 404) {
        hint = ` Endpoint not found at ${base} — it may not be the Evolver Proxy. Confirm with /evolver:status.`;
      }
      return {
        ok: false,
        error: `Proxy at ${base} returned HTTP ${res.status}: ${
          typeof data === "object" ? JSON.stringify(data) : text
        }.${hint}`,
      };
    }
    return { ok: true, data };
  } catch (e) {
    const err = e as Error;
    const hint = `Evolver Proxy not reachable at ${base}. Start it by running \`evolver\` once inside a git repo (the CLI launches the Proxy), or run /evolver:status. Set EVOMAP_PROXY_PORT if you use a non-default port.`;
    return {
      ok: false,
      error: `${
        err.name === "AbortError"
          ? "Proxy request timed out"
          : "Proxy connection failed: " + err.message
      }. ${hint}`,
    };
  } finally {
    clearTimeout(timer);
  }
}
