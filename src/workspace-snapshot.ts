// SPDX-License-Identifier: MIT

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export interface WorkspaceManifestEntry {
	path: string;
	mode: "100644" | "100755" | "120000";
	hash: string;
}

export interface WorkspaceSnapshot {
	manifest: WorkspaceManifestEntry[];
	hash: string;
}

function git(root: string, args: string[]): string | null {
	const result = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 16 * 1024 * 1024,
	});
	return result.status === 0 ? result.stdout : null;
}

function repositoryRoot(projectDir: string): string | null {
	const output = git(projectDir, ["rev-parse", "--show-toplevel"]);
	if (output === null) return null;
	try {
		return realpathSync(output.trim());
	} catch {
		return null;
	}
}

function nulPaths(output: string): string[] {
	return output.split("\0").filter((path) => path.length > 0);
}

function manifestEntry(root: string, path: string): WorkspaceManifestEntry | null {
	const absolute = resolve(root, path);
	const relativePath = relative(root, absolute);
	if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return null;
	try {
		const stat = lstatSync(absolute);
		if (stat.isSymbolicLink()) {
			return {
				path,
				mode: "120000",
				hash: createHash("sha256").update(readlinkSync(absolute)).digest("hex"),
			};
		}
		if (!stat.isFile()) return null;
		return {
			path,
			mode: stat.mode & 0o111 ? "100755" : "100644",
			hash: createHash("sha256").update(readFileSync(absolute)).digest("hex"),
		};
	} catch {
		return null;
	}
}

export function captureWorkspaceSnapshot(projectDir: string): WorkspaceSnapshot | null {
	try {
		const root = repositoryRoot(projectDir);
		if (!root) return null;
		const tracked = git(root, ["ls-files", "-z"]);
		const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]);
		if (tracked === null || untracked === null) return null;
		const paths = Array.from(new Set([...nulPaths(tracked), ...nulPaths(untracked)])).sort();
		const manifest = paths
			.map((path) => manifestEntry(root, path))
			.filter((entry): entry is WorkspaceManifestEntry => entry !== null);
		const hash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
		return { manifest, hash };
	} catch {
		return null;
	}
}
