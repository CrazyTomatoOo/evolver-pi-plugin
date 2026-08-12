import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");
const sourceDir = join(projectRoot, "src");

function productionSource(): string {
	return readdirSync(sourceDir)
		.filter((file) => file.endsWith(".ts"))
		.sort((left, right) => left.localeCompare(right))
		.map((file) => `// ${file}\n${readFileSync(join(sourceDir, file), "utf8")}`)
		.join("\n");
}

describe("Local-only runtime contract", () => {
	test("production has no obsolete network, identity, claim, or Session-end TTL path", () => {
		const source = productionSource();
		const forbidden: Array<[string, RegExp]> = [
			["Hub", /\bHub\b|EVOMAP_HUB|A2A_HUB/i],
			["Proxy", /\bProxy\b/i],
			["mailbox", /\bmailbox\b/i],
			["OAuth", /\bOAuth\b/i],
			["A2A or node identity", /\bA2A\b|A2A_|EVOMAP_NODE_ID|sender_id/i],
			["HTTP client", /\bfetch\s*\(|AbortController|node:https?|\baxios\b|\bundici\b/i],
			["claim notice", /CLAIM_NOTICE|readPendingClaimUrl|claim_url|evomap\.ai/i],
			[
				"Session-end TTL",
				/SESSION_END_.*TTL|EVOLVER_SESSION_END_DEDUPE_TTL_MS|session-end-state/i,
			],
			[
				"automatic Outcome classification",
				/stable_success_plateau|recordOutcome|hook:session-end/i,
			],
		];

		for (const [name, pattern] of forbidden) {
			expect(source, `${name} runtime path must stay removed`).not.toMatch(pattern);
		}

		const environmentVariables = [
			...source.matchAll(/process\.env\.([A-Z0-9_]+)/g),
		]
			.map((match) => match[1])
			.sort((left, right) => left.localeCompare(right));
		expect([...new Set(environmentVariables)]).toEqual([
			"EVOLVER_SESSION_STATE_DIR",
			"EVOLVER_WORKSPACE_ID",
			"MEMORY_GRAPH_PATH",
		]);
	});

	test("package and lockfile pin the selected Pi line and reproducible commands", () => {
		const packageJson = JSON.parse(
			readFileSync(join(projectRoot, "package.json"), "utf8"),
		) as Record<string, Record<string, string>>;
		const packageLock = JSON.parse(
			readFileSync(join(projectRoot, "package-lock.json"), "utf8"),
		) as {
			lockfileVersion: number;
			packages: Record<string, Record<string, Record<string, string>>>;
		};

		expect(packageJson.dependencies).toEqual({
			"@earendil-works/pi-ai": "0.84.1",
			typebox: "1.3.7",
		});
		expect(packageJson.peerDependencies).toEqual({
			"@earendil-works/pi-coding-agent": "^0.84.1",
		});
		expect(packageJson.devDependencies["@earendil-works/pi-coding-agent"]).toBe(
			"0.84.1",
		);
		expect(packageJson.scripts["self-check"]).toBe("bun scripts/self-check.ts");
		expect(packageJson.scripts.test).toBe("bun test");
		expect(packageJson.scripts.typecheck).toBe("tsc --noEmit");
		expect(packageJson.scripts.build).toBeUndefined();

		const lockedRoot = packageLock.packages[""];
		expect(packageLock.lockfileVersion).toBe(3);
		expect(lockedRoot.dependencies).toEqual(packageJson.dependencies);
		expect(lockedRoot.peerDependencies).toEqual(packageJson.peerDependencies);
		expect(lockedRoot.devDependencies).toEqual(packageJson.devDependencies);
	});

	test("dogfood pins Pi to the selected line", () => {
		const dockerfile = readFileSync(
			join(projectRoot, "dogfood", "Dockerfile"),
			"utf8",
		);
		expect(dockerfile).toContain(
			"@earendil-works/pi-coding-agent@0.84.1",
		);
	});
});
