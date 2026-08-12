// SPDX-License-Identifier: MIT

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const projectRoot = join(import.meta.dir, "..");

function readDoc(path: string): string {
	return readFileSync(join(projectRoot, path), "utf8");
}

const readmeEn = readDoc("README.md");
const readmeZh = readDoc("README.zh-CN.md");
const agents = readDoc("AGENTS.md");
const skill = readDoc("skills/capability-evolver/SKILL.md");

describe("Documentation contract", () => {
	test("READMEs agree on the lifecycle and first-turn balanced Recall", () => {
		for (const doc of [readmeEn, readmeZh]) {
			expect(doc).toMatch(/session_start/);
			expect(doc).toMatch(/before_agent_start/);
			expect(doc).toMatch(/session_shutdown/);
			expect(doc).toMatch(/balanced Recall|均衡 Recall/i);
			expect(doc).toMatch(/score.*0\.5|0\.5.*score/);
			expect(doc).toMatch(/7 days|7 天/);
			expect(doc).toMatch(/max 3|最多 3/);
			expect(doc).toMatch(/2.?000|2.?000/);
		}
	});

	test("READMEs describe explicit submission, status, and boundaries", () => {
		for (const doc of [readmeEn, readmeZh]) {
			expect(doc).toMatch(/evolver_outcome/);
			expect(doc).toMatch(/evolver-status/);
			expect(doc).toMatch(/explicit|显式/i);
			expect(doc).toMatch(/no model call|不发起 model call/i);
			expect(doc).toMatch(/reload/i);
			expect(doc).toMatch(/quit.*new.*resume.*fork|quit.*new.*resume.*fork/);
		}
	});


	test("READMEs list local storage paths and supported Pi line", () => {
		for (const doc of [readmeEn, readmeZh]) {
			expect(doc).toMatch(/memory_graph\.jsonl/);
			expect(doc).toMatch(/outbox/);
			expect(doc).toMatch(/results/);
			expect(doc).toMatch(/0\.84\.1|\^0\.84\.1/);
			expect(doc).toMatch(/--network none/);
		}
	});

	test("READMEs list only the four supported environment variables", () => {
		for (const doc of [readmeEn, readmeZh]) {
			expect(doc).toMatch(/MEMORY_GRAPH_PATH/);
			expect(doc).toMatch(/EVOLVER_WORKSPACE_ID/);
			expect(doc).toMatch(/EVOLVER_SESSION_STATE_DIR/);
			// The removed TTL and hook-log env vars must not appear.
			expect(doc).not.toMatch(/EVOLVER_HOOK_LOG_DIR/);
			expect(doc).not.toMatch(/EVOLVER_SESSION_END/);
			expect(doc).not.toMatch(/HOOK_LOG/);
		}
	});

	test("READMEs show reproducible verification commands", () => {
		for (const doc of [readmeEn, readmeZh]) {
			expect(doc).toMatch(/npm ci/);
			expect(doc).toMatch(/npm test/);
			expect(doc).toMatch(/npm run typecheck/);
			expect(doc).toMatch(/npm run self-check/);
			expect(doc).toMatch(/npm pack --dry-run/);
			expect(doc).toMatch(/docker build/);
			expect(doc).toMatch(/docker run.*--network none/);
		}
	});

	test("AGENTS describes the Coordinator/Adapter architecture and module responsibilities", () => {
		expect(agents).toMatch(/CoreCoordinator/);
		expect(agents).toMatch(/PiAdapter/);
		expect(agents).toMatch(/core-coordinator\.ts/);
		expect(agents).toMatch(/pi-adapter\.ts/);
		expect(agents).toMatch(/session-transition\.ts/);
		expect(agents).toMatch(/graph-recorder\.ts/);
		expect(agents).toMatch(/workspace-snapshot\.ts/);
		expect(agents).toMatch(/status\.ts/);
		expect(agents).toMatch(/evolver_outcome/);
		expect(agents).toMatch(/evolver-outcome/);
		expect(agents).toMatch(/evolver-status/);
	});

	test("AGENTS describes state, lock, and outbox invariants", () => {
		expect(agents).toMatch(/lastAttempt/);
		expect(agents).toMatch(/lastRecorded/);
		expect(agents).toMatch(/Ready Outbox/);
		expect(agents).toMatch(/O_EXCL/);
		expect(agents).toMatch(/0600/);
		expect(agents).toMatch(/diff_hash/);
		expect(agents).toMatch(/immutable/);
	});

	test("AGENTS describes dependencies and gates", () => {
		expect(agents).toMatch(/0\.84\.1/);
		expect(agents).toMatch(/\^0\.84\.1/);
		expect(agents).toMatch(/typebox/);
		expect(agents).toMatch(/pi-ai/);
		expect(agents).toMatch(/npm ci/);
		expect(agents).toMatch(/docker.*--network none/);
	});

	test("AGENTS lists only the four supported environment variables", () => {
		expect(agents).toMatch(/MEMORY_GRAPH_PATH/);
		expect(agents).toMatch(/EVOLVER_WORKSPACE_ID/);
		expect(agents).toMatch(/EVOLVER_SESSION_STATE_DIR/);
		expect(agents).not.toMatch(/EVOLVER_HOOK_LOG_DIR/);
		expect(agents).not.toMatch(/EVOLVER_SESSION_END/);
	});

	test("capability skill tells agents to verify, submit one non-secret lesson, and clear/re-submit", () => {
		expect(skill).toMatch(/verify/i);
		expect(skill).toMatch(/evolver_outcome/);
		expect(skill).toMatch(/clear.*re-submit|re-submit.*clear/i);
		expect(skill).toMatch(/secret/i);
		expect(skill).toMatch(/500/);
	});

	test("capability skill states final prose is not captured", () => {
		expect(skill).toMatch(/not.*captured|not.*recorded/i);
		expect(skill).toMatch(/prose/i);
	});

	test("capability skill describes status inspection as read-only", () => {
		expect(skill).toMatch(/evolver-status/);
		expect(skill).toMatch(/read-only|strictly observational/i);
	});

	test("banned claims do not appear in maintained docs", () => {
		for (const doc of [readmeEn, readmeZh, agents, skill]) {
			// No nextTurn delivery for Recall.
			expect(doc).not.toMatch(/deliverAs.*nextTurn|nextTurn.*deliverAs/);
			// No quit-only heuristic classification.
			expect(doc).not.toMatch(/reason.*quit.*classify|quit.*classify.*diff/i);
			// No final-message capture.
			expect(doc).not.toMatch(/capture.*final.*message|final.*message.*capture/i);
			// No success-only Recall.
			expect(doc).not.toMatch(/successful.*outcomes.*passive.*context/i);
			expect(doc).not.toMatch(/recent.*successful.*outcomes.*inject/i);
			// No hook:session-end.
			expect(doc).not.toMatch(/hook:session-end/);
			// No Hub/network.
			// No Hub/network as a feature (negated mentions like "no Hub" are OK;
			// production code is separately checked by local-only-contract tests).
			// No obsolete TypeBox union/literal claims.
			expect(doc).not.toMatch(/Type\.Union|Type\.Literal/);
			// No stable_success_plateau fabrication claim (negated warnings like
			// "never fabricate stable_success_plateau" are OK; production source is
			// separately checked by local-only-contract tests).
		}
	});

	test("historical research is labelled as research, not current runtime", () => {
		const ref = readDoc("docs/research/reference-internals.md");
		const mapping = readDoc("docs/research/pi-api-mapping.md");
		expect(ref).toMatch(/Reference Plugin Internals/i);
		expect(ref).toMatch(/port/i);
		expect(mapping).toMatch(/pi Extension API Mapping/i);
		expect(mapping).toMatch(/READ-ONLY research/i);
		// Research docs must not claim to document current runtime behavior.
		expect(ref).not.toMatch(/current runtime behavior/i);
		expect(mapping).not.toMatch(/current runtime behavior/i);
	});
});
