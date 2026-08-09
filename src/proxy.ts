// SPDX-License-Identifier: MIT
// Ported from EvoMap/evolver-claude-code-plugin `mcp/evolver-proxy.mjs` (MIT).
// Client for the local EvoMap Proxy mailbox. The Proxy is a separate local
// process started by the @evomap/evolver CLI; this client never spawns it. When
// it is down, every call degrades to a helpful { ok:false, error } — it never
// throws.

import { readFileSync } from "node:fs";
import { connect as connectNet } from "node:net";
import { connect as connectTls } from "node:tls";
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

function proxySettingsPath(): string {
	return (
		process.env.EVOLVER_PROXY_SETTINGS_FILE ??
		join(homedir(), ".evolver", "settings.json")
	);
}

/** Resolve the live Proxy connection. The configured settings file (or
 * `~/.evolver/settings.json`) is authoritative: the running Proxy writes both
 * its url and a per-instance auth token there. Recent Proxy builds reject
 * unauthenticated local requests with 401, so we send `Authorization: Bearer
 * <token>`. Re-read every call — the token rotates whenever the Proxy restarts.
 * Never log or echo the token. */
export function readProxySettings(): ProxySettings {
	let url: string | null = null;
	let token: string | null = null;
	try {
		const s = JSON.parse(
			readFileSync(proxySettingsPath(), "utf8"),
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

/** Make a direct request to the loopback Proxy.
 *
 * Pi can install a process-wide HTTP dispatcher from `http_proxy`. A raw local
 * socket is deliberately used instead of `fetch` or `node:http`, so a stopped
 * Proxy reports its actual connection error rather than the dispatcher's 502. */
function decodeChunkedBody(body: string): string {
	let offset = 0;
	let decoded = "";
	while (true) {
		const lineEnd = body.indexOf("\r\n", offset);
		if (lineEnd < 0) throw new Error("Malformed chunked Proxy response");
		const size = Number.parseInt(body.slice(offset, lineEnd).split(";", 1)[0], 16);
		if (!Number.isFinite(size)) throw new Error("Malformed chunked Proxy response");
		offset = lineEnd + 2;
		if (size === 0) return decoded;
		if (offset + size > body.length) {
			throw new Error("Truncated chunked Proxy response");
		}
		decoded += body.slice(offset, offset + size);
		offset += size;
		if (body.slice(offset, offset + 2) !== "\r\n") {
			throw new Error("Malformed chunked Proxy response");
		}
		offset += 2;
	}
}

function requestLocalProxy(
	base: string,
	path: string,
	method: string,
	headers: Record<string, string>,
	body?: string,
): Promise<{ status: number; text: string }> {
	const target = new URL(path, base);
	const host = target.hostname.replace(/^\[|\]$/g, "");
	const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
	const headerLines = Object.entries(headers).map(([name, value]) => {
		if (/\r|\n/.test(name) || /\r|\n/.test(value)) {
			throw new Error("Invalid Proxy request header");
		}
		return `${name}: ${value}`;
	});
	const request = [
		`${method} ${target.pathname || "/"}${target.search} HTTP/1.1`,
		`Host: ${target.host}`,
		"Connection: close",
		...headerLines,
		"",
		"",
	].join("\r\n") + (body ?? "");

	return new Promise((resolve, reject) => {
		const socket =
			target.protocol === "https:"
				? connectTls({ host, port, servername: host })
				: connectNet({ host, port });
		const chunks: Buffer[] = [];
		let settled = false;
		const fail = (error: Error): void => {
			if (settled) return;
			settled = true;
			reject(error);
		};
		socket.once(target.protocol === "https:" ? "secureConnect" : "connect", () => {
			socket.write(request);
		});
		socket.on("data", (chunk: Buffer) => chunks.push(chunk));
		socket.once("end", () => {
			if (settled) return;
			try {
				const response = Buffer.concat(chunks).toString("utf8");
				const split = response.indexOf("\r\n\r\n");
				if (split < 0) throw new Error("Malformed Proxy response");
				const responseHeaders = response.slice(0, split);
				const match = /^HTTP\/\d\.\d\s+(\d{3})\b/.exec(responseHeaders);
				if (!match) throw new Error("Malformed Proxy response status");
				const responseBody = response.slice(split + 4);
				const text = /\btransfer-encoding:\s*[^\r\n]*\bchunked\b/i.test(
					responseHeaders,
				)
					? decodeChunkedBody(responseBody)
					: responseBody;
				settled = true;
				resolve({ status: Number(match[1]), text });
			} catch (error) {
				fail(error as Error);
			}
		});
		socket.once("error", (error) => fail(error));
		socket.setTimeout(REQUEST_TIMEOUT_MS, () =>
			socket.destroy(new Error("Proxy request timed out")),
		);
	});
}

/** Call a Proxy endpoint. Always resolves to a ProxyResult; never throws. */
export async function proxyFetch(
	method: string,
	path: string,
	body?: unknown,
): Promise<ProxyResult> {
	const { url: base, token } = readProxySettings();
	const payload = body ? JSON.stringify(body) : undefined;
	try {
		const headers: Record<string, string> = {};
		if (payload) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = String(Buffer.byteLength(payload));
		}
		if (token) headers.Authorization = `Bearer ${token}`;
		const res = await requestLocalProxy(base, path, method, headers, payload);
		let data: unknown;
		try {
			data = res.text ? JSON.parse(res.text) : {};
		} catch {
			data = { raw: res.text };
		}
		if (res.status < 200 || res.status >= 300) {
			// Make auth/connection failures actionable. Never echo the token.
			let hint = "";
			if ([401, 403].includes(res.status)) {
				hint = token
					? " The Proxy token in ~/.evolver/settings.json looks stale (the Proxy mints a fresh token on restart). Restart the pi session so the bridge re-reads it, or run /evolver:status."
					: ` No Proxy token found in ~/.evolver/settings.json and the request was rejected — another process may be using ${base}. Start the Proxy with \`evolver proxy\`, then run /evolver:status.`;
			} else if (res.status === 404) {
				hint = ` Endpoint not found at ${base} — it may not be the Evolver Proxy. Confirm with /evolver:status.`;
			} else if (res.status === 402) {
				hint = " Network features require EvoMap credits — buy or subscribe at https://evomap.ai/pricing. Local evolution memory keeps working as usual.";
			} else if (res.status >= 500) {
				hint = " The local Proxy is unhealthy. Restart it with `evolver proxy`, then run /evolver:status. Local evolution memory keeps working as usual.";
			}
			return {
				ok: false,
				error: `Proxy at ${base} returned HTTP ${res.status}: ${
					typeof data === "object" ? JSON.stringify(data) : res.text
				}.${hint}`,
			};
		}
		return { ok: true, data };
	} catch (e) {
		const err = e as Error;
		const hint = `Evolver Proxy not reachable at ${base}. Start it with \`evolver proxy\` in a separate terminal, then run /evolver:status. Set EVOMAP_PROXY_PORT if you use a non-default port.`;
		return {
			ok: false,
			error: `${
				err.message === "Proxy request timed out"
					? "Proxy request timed out"
					: "Proxy connection failed: " + err.message
			}. ${hint}`,
		};
	}
}
