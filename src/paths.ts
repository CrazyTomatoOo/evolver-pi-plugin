// SPDX-License-Identifier: MIT
// Ported from EvoMap/evolver-claude-code-plugin `hooks/_paths.js` (MIT).
// Shared path / workspace helpers. Pure Node.js built-ins, no external
// dependencies. Every exported helper is defensive: it must never throw,
// because the callers are expected to fail open.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

// Pattern an external tool relies on for the workspace identifier: a lowercase
// hex string of at least 32 characters. Keep this in sync with the contract.
const WORKSPACE_ID_PATTERN = /^[a-f0-9]{32,}$/i;

/** True when `candidate` is a string pointing at an existing directory. */
function looksLikeDir(candidate: unknown): candidate is string {
	if (typeof candidate !== "string" || candidate.length === 0) {
		return false;
	}
	try {
		return fs.statSync(candidate).isDirectory();
	} catch (_err) {
		return false;
	}
}

/** Whether `dir` lives inside a git working tree. False on any problem. */
export function isGitWorkspace(dir: string): boolean {
	try {
		const result = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
			cwd: looksLikeDir(dir) ? dir : undefined,
			shell: false,
			timeout: 5000,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.status !== 0 || typeof result.stdout !== "string") {
			return false;
		}
		return result.stdout.trim() === "true";
	} catch (_err) {
		return false;
	}
}

/** Return the path to the evolution memory graph (a JSONL file).
 *
 * Resolution order:
 *   1. MEMORY_GRAPH_PATH override, if set.
 *   2. `<projectDir>/memory/evolution/memory_graph.jsonl` — but only if it
 *      already EXISTS (an evolver-managed project owns this file).
 *   3. The user-level `~/.evolver/memory/evolution/memory_graph.jsonl`, whose
 *      parent directory is best-effort created. */
export function findMemoryGraph(projectDir: string): string {
	const override = process.env.MEMORY_GRAPH_PATH;
	if (typeof override === "string" && override.length > 0) {
		return override;
	}
	if (looksLikeDir(projectDir)) {
		const projectPath = path.join(
			projectDir,
			"memory",
			"evolution",
			"memory_graph.jsonl",
		);
		try {
			if (fs.statSync(projectPath).isFile()) {
				return projectPath;
			}
		} catch (_err) {
			// Not present — fall through to the user-level default.
		}
	}
	const defaultPath = path.join(
		os.homedir(),
		".evolver",
		"memory",
		"evolution",
		"memory_graph.jsonl",
	);
	try {
		fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
	} catch (_err) {
		// Best effort only; callers tolerate a missing directory.
	}
	return defaultPath;
}

/** Walk upward from `start` looking for the directory that directly contains a
 * `.git` entry. Returns the repo root, or null if none is found. */
function findRepoRoot(start: string): string | null {
	let current = path.resolve(start);
	let guard = 0;
	while (guard < 256) {
		guard += 1;
		try {
			if (fs.existsSync(path.join(current, ".git"))) {
				return current;
			}
		} catch (_err) {
			// Ignore and keep climbing.
		}
		const parent = path.dirname(current);
		if (parent === current) {
			break; // reached filesystem root
		}
		current = parent;
	}
	return null;
}

type ReadResult = { ok: true; id: string } | { ok: false; missing: boolean };

/** Read the workspace-id file at `idFile`, applying symlink / regular-file
 * guards. Returns the validated id, or a not-ok result if the file is missing,
 * a symlink, not a regular file, or malformed. */
function readWorkspaceIdFile(
	dotEvolverDir: string,
	idFile: string,
): ReadResult {
	// Refuse to follow a symlinked `.evolver` directory.
	let dirStat: fs.Stats;
	try {
		dirStat = fs.lstatSync(dotEvolverDir);
	} catch (_err) {
		return { ok: false, missing: true };
	}
	if (dirStat.isSymbolicLink()) {
		return { ok: false, missing: false };
	}

	let fileStat: fs.Stats;
	try {
		fileStat = fs.lstatSync(idFile);
	} catch (_err) {
		// ENOENT (or similar) => treat as missing so the caller may create it.
		return { ok: false, missing: true };
	}
	if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
		return { ok: false, missing: false };
	}

	let raw: string;
	try {
		raw = fs.readFileSync(idFile, "utf8");
	} catch (_err) {
		return { ok: false, missing: false };
	}
	const value = raw.trim();
	if (WORKSPACE_ID_PATTERN.test(value)) {
		return { ok: true, id: value };
	}
	return { ok: false, missing: false };
}

/** Compute the workspace root used to anchor the workspace-id file.
 *   - OPENCLAW_WORKSPACE wins if set.
 *   - Otherwise the git repo root above `projectDir`; if that root has a
 *     `workspace/` subdirectory use it, else the root itself.
 *   - If no repo root exists, fall back to `projectDir`. */
function computeWorkspaceRoot(projectDir: string): string {
	const explicit = process.env.OPENCLAW_WORKSPACE;
	if (typeof explicit === "string" && explicit.length > 0) {
		return explicit;
	}
	const repoRoot = findRepoRoot(projectDir);
	if (!repoRoot) {
		return projectDir;
	}
	const nestedWorkspace = path.join(repoRoot, "workspace");
	if (looksLikeDir(nestedWorkspace)) {
		return nestedWorkspace;
	}
	return repoRoot;
}

/** Resolve (or lazily create) the forge-resistant workspace identifier.
 *
 * Contract with external tooling — do not change without coordination:
 *   - file path:  <workspaceRoot>/.evolver/workspace-id
 *   - file mode:  0600
 *   - format:     a single 32+ char hex string
 *
 * Returns the id string, or null when it cannot be safely read or created.
 * Never throws. */
export function resolveWorkspaceId(projectDir: string): string | null {
	try {
		const fromEnv = process.env.EVOLVER_WORKSPACE_ID;
		if (typeof fromEnv === "string" && fromEnv.length > 0) {
			return String(fromEnv);
		}

		const workspaceRoot = computeWorkspaceRoot(projectDir);
		const dotEvolverDir = path.join(workspaceRoot, ".evolver");
		const idFile = path.join(dotEvolverDir, "workspace-id");

		// First attempt: read an existing, trusted file.
		const existing = readWorkspaceIdFile(dotEvolverDir, idFile);
		if (existing.ok) {
			return existing.id;
		}
		if (!existing.missing) {
			// A file (or `.evolver`) is present but failed the guards. Never clobber
			// it — surface "unknown" instead.
			return null;
		}

		// File is genuinely missing: create it. Re-check the `.evolver` symlink
		// guard right before writing.
		try {
			const dirStat = fs.lstatSync(dotEvolverDir);
			if (dirStat.isSymbolicLink()) {
				return null;
			}
		} catch (_err) {
			// Does not exist yet — that is fine, mkdir below.
		}

		try {
			fs.mkdirSync(dotEvolverDir, { recursive: true });
		} catch (_err) {
			return null;
		}

		const fresh = crypto.randomBytes(16).toString("hex"); // 32 hex chars
		let fd: number | undefined;
		try {
			// O_EXCL + O_NOFOLLOW: fail rather than follow a symlink or overwrite a
			// racing writer's file.
			const flags =
				fs.constants.O_WRONLY |
				fs.constants.O_CREAT |
				fs.constants.O_EXCL |
				fs.constants.O_NOFOLLOW;
			fd = fs.openSync(idFile, flags, 0o600);
			fs.writeSync(fd, fresh);
		} catch (err) {
			if (err && (err as NodeJS.ErrnoException).code === "EEXIST") {
				// Someone created it between our check and write — re-read it through
				// the same guards.
				const raced = readWorkspaceIdFile(dotEvolverDir, idFile);
				return raced.ok ? raced.id : null;
			}
			return null;
		} finally {
			if (fd !== undefined) {
				try {
					fs.closeSync(fd);
				} catch (_err) {
					// ignore
				}
			}
		}

		// Tighten permissions in case the umask widened them.
		try {
			fs.chmodSync(idFile, 0o600);
		} catch (_err) {
			// best effort
		}
		return fresh;
	} catch (_err) {
		// EACCES / EIO / anything else: degrade to "unknown workspace".
		return null;
	}
}
