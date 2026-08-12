import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createSessionTransitionStore } from "../src/session-transition";
import {
	captureWorkspaceSnapshot,
	type WorkspaceSnapshot,
} from "../src/workspace-snapshot";

const sandboxes: string[] = [];

afterEach(() => {
	delete process.env.EVOLVER_SESSION_STATE_DIR;
	for (const sandbox of sandboxes.splice(0)) {
		rmSync(sandbox, { recursive: true, force: true });
	}
});

function git(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

function repository(): string {
	const dir = mkdtempSync(join(tmpdir(), "evolver-transition-"));
	sandboxes.push(dir);
	git(dir, "init", "-q");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test User");
	writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
	writeFileSync(join(dir, "tracked.txt"), "base\n");
	git(dir, "add", ".gitignore", "tracked.txt");
	git(dir, "commit", "-qm", "base");
	return dir;
}

function snapshot(dir: string): WorkspaceSnapshot {
	const value = captureWorkspaceSnapshot(dir);
	if (!value) throw new Error("snapshot unavailable");
	return value;
}

describe("Content-level Session transitions", () => {
	test("canonical snapshot includes tracked and non-ignored untracked content but not ignored files", () => {
		const dir = repository();
		writeFileSync(join(dir, "tracked.txt"), "working tree\n");
		writeFileSync(join(dir, "untracked.txt"), "new\n");
		writeFileSync(join(dir, "ignored.txt"), "secret\n");

		const value = snapshot(dir);

		expect(value.manifest.map((entry) => entry.path)).toEqual([
			".gitignore",
			"tracked.txt",
			"untracked.txt",
		]);
		expect(JSON.stringify(value)).not.toContain("working tree");
		expect(JSON.stringify(value)).not.toContain("secret");
	});

	test("repository-relative names beginning with two dots remain in the manifest", () => {
		const dir = repository();
		writeFileSync(join(dir, "..valid"), "valid\n");

		expect(snapshot(dir).manifest.map((entry) => entry.path)).toContain("..valid");
	});

	test("git add and a content-preserving commit do not change the logical snapshot", () => {
		const dir = repository();
		writeFileSync(join(dir, "tracked.txt"), "changed\n");
		writeFileSync(join(dir, "untracked.txt"), "new\n");
		const dirty = snapshot(dir);

		git(dir, "add", "tracked.txt", "untracked.txt");
		const staged = snapshot(dir);
		git(dir, "commit", "-qm", "same content");
		const committed = snapshot(dir);

		expect(staged).toEqual(dirty);
		expect(committed).toEqual(dirty);
	});

	test("content, addition, deletion, rename, executable mode, and symlink target change the snapshot", () => {
		const dir = repository();
		const baseline = snapshot(dir);

		writeFileSync(join(dir, "tracked.txt"), "changed\n");
		expect(snapshot(dir).hash).not.toBe(baseline.hash);
		writeFileSync(join(dir, "tracked.txt"), "base\n");

		writeFileSync(join(dir, "added.txt"), "new\n");
		expect(snapshot(dir).hash).not.toBe(baseline.hash);
		rmSync(join(dir, "added.txt"));

		rmSync(join(dir, "tracked.txt"));
		expect(snapshot(dir).hash).not.toBe(baseline.hash);
		writeFileSync(join(dir, "tracked.txt"), "base\n");

		git(dir, "mv", "tracked.txt", "renamed.txt");
		expect(snapshot(dir).hash).not.toBe(baseline.hash);
		git(dir, "reset", "--hard", "-q", "HEAD");

		chmodSync(join(dir, "tracked.txt"), 0o755);
		expect(snapshot(dir).hash).not.toBe(baseline.hash);
		chmodSync(join(dir, "tracked.txt"), 0o644);

		symlinkSync("tracked.txt", join(dir, "link"));
		const firstLink = snapshot(dir);
		rmSync(join(dir, "link"));
		symlinkSync(".gitignore", join(dir, "link"));
		expect(snapshot(dir).hash).not.toBe(firstLink.hash);
		expect(lstatSync(join(dir, "link")).isSymbolicLink()).toBe(true);
	});

	test("symlink targets are hashed without following target contents", () => {
		const dir = repository();
		writeFileSync(join(dir, "outside-one"), "same\n");
		writeFileSync(join(dir, "outside-two"), "same\n");
		symlinkSync("outside-one", join(dir, "link"));
		const first = snapshot(dir);
		rmSync(join(dir, "link"));
		symlinkSync("outside-two", join(dir, "link"));
		const second = snapshot(dir);

		expect(first.manifest.find((entry) => entry.path === "link")?.hash).not.toBe(
			second.manifest.find((entry) => entry.path === "link")?.hash,
		);
	});

	test("manifest ordering is deterministic code-unit order for non-ASCII paths", () => {
		const dir = repository();
		writeFileSync(join(dir, "z.txt"), "z\n");
		writeFileSync(join(dir, "ä.txt"), "a\n");

		const paths = snapshot(dir).manifest.map((entry) => entry.path);

		expect(paths.indexOf("z.txt")).toBeLessThan(paths.indexOf("ä.txt"));
	});

	test("persists one 0600 baseline across reload and reports equal snapshots as no transition", () => {
		const dir = repository();
		const stateDir = join(mkdtempSync(join(tmpdir(), "evolver-state-")), "state");
		sandboxes.push(join(stateDir, ".."));
		process.env.EVOLVER_SESSION_STATE_DIR = stateDir;
		const store = createSessionTransitionStore();

		const started = store.start(
			dir,
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"session-1",
		);
		store.addSignals(
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"session-1",
			["test_failure"],
		);
		const restored = createSessionTransitionStore().start(
			dir,
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"session-1",
		);
		const transition = store.inspect(
			dir,
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"session-1",
		);

		expect(started?.baseline.hash).toBe(restored?.baseline.hash);
		expect(restored?.signals).toEqual(["test_failure"]);
		expect(transition?.changed).toBe(false);
		const stateFile = join(
			stateDir,
			"sessions",
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			"session-1.json",
		);
		expect(statSync(stateFile).mode & 0o777).toBe(0o600);
	});

	test("missing or unsafe identities disable durable transition state without fallback", () => {
		const dir = repository();
		const stateDir = join(mkdtempSync(join(tmpdir(), "evolver-state-")), "state");
		sandboxes.push(join(stateDir, ".."));
		process.env.EVOLVER_SESSION_STATE_DIR = stateDir;
		const store = createSessionTransitionStore();

		expect(store.start(dir, "", "session-1")).toBeNull();
		expect(
			store.start(dir, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "../unsafe"),
		).toBeNull();
		expect(() => statSync(stateDir)).toThrow();
	});

	test("different Session identities keep independent durable baselines", () => {
		const dir = repository();
		const stateDir = join(mkdtempSync(join(tmpdir(), "evolver-state-")), "state");
		sandboxes.push(join(stateDir, ".."));
		process.env.EVOLVER_SESSION_STATE_DIR = stateDir;
		const store = createSessionTransitionStore();
		const workspaceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

		const first = store.start(dir, workspaceId, "session-1");
		writeFileSync(join(dir, "tracked.txt"), "changed\n");
		const second = store.start(dir, workspaceId, "session-2");

		expect(first?.baseline.hash).not.toBe(second?.baseline.hash);
		expect(store.inspect(dir, workspaceId, "session-1")?.changed).toBe(true);
		expect(store.inspect(dir, workspaceId, "session-2")?.changed).toBe(false);
	});

	test("unsafe pre-existing state paths are rejected without following symlinks", () => {
		const dir = repository();
		const stateRoot = mkdtempSync(join(tmpdir(), "evolver-state-"));
		sandboxes.push(stateRoot);
		process.env.EVOLVER_SESSION_STATE_DIR = join(stateRoot, "state");
		const outside = join(stateRoot, "outside");
		writeFileSync(outside, "do not overwrite\n");
		const sessionDir = join(
			process.env.EVOLVER_SESSION_STATE_DIR,
			"sessions",
			"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);
		mkdirSync(sessionDir, { recursive: true });
		symlinkSync(outside, join(sessionDir, "session-1.json"));

		expect(
			createSessionTransitionStore().start(
				dir,
				"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"session-1",
			),
		).toBeNull();
		expect(readFileSync(outside, "utf8")).toBe("do not overwrite\n");
	});
});
