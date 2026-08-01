// SPDX-License-Identifier: MIT
// Ported from EvoMap/evolver-claude-code-plugin `hooks/_signals.js` (MIT).
// Keyword-based evolution signal detection. Deliberately simple: substring
// matching against a small, hand-curated keyword table, with a heuristic to
// skip code/comment lines.

/** Each signal category maps to a set of lowercase trigger phrases. A category
 * fires if any of its phrases appears as a substring of the (lowercased) text. */
export const SIGNAL_KEYWORDS: Record<string, string[]> = {
  perf_bottleneck: [
    "timeout",
    "slow",
    "latency",
    "bottleneck",
    "oom",
    "out of memory",
    "performance",
  ],
  capability_gap: [
    "not supported",
    "unsupported",
    "not implemented",
    "missing feature",
    "not available",
  ],
  log_error: [
    "error:",
    "exception:",
    "typeerror",
    "referenceerror",
    "syntaxerror",
    "failed",
  ],
  user_feature_request: [
    "add feature",
    "implement",
    "new function",
    "new module",
    "please add",
  ],
  recurring_error: [
    "same error",
    "still failing",
    "not fixed",
    "keeps failing",
    "repeatedly",
  ],
  deployment_issue: [
    "deploy failed",
    "build failed",
    "ci failed",
    "pipeline",
    "rollback",
  ],
  test_failure: [
    "test failed",
    "test failure",
    "assertion",
    "expect(",
    "assert.",
  ],
};

// Prefixes that mark a line as "probably code or a comment" — skipped to cut
// down on false positives from source files that merely mention keywords.
const CODE_LINE_PREFIXES = ["//", "#", "*", "{", "[", "}", "]", "/*"];

function looksLikeCode(trimmedLine: string): boolean {
  for (const prefix of CODE_LINE_PREFIXES) {
    if (trimmedLine.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/** Detect evolution signals within free-form text.
 * @returns sorted, de-duplicated list of signal category names. */
export function detectSignals(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) {
    return [];
  }

  // Build the prose-only corpus: drop lines that look like code/comments.
  const prose = text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return false;
      }
      return !looksLikeCode(trimmed);
    })
    .join("\n")
    .toLowerCase();

  if (!prose) {
    return [];
  }

  const found = new Set<string>();
  for (const [category, phrases] of Object.entries(SIGNAL_KEYWORDS)) {
    for (const phrase of phrases) {
      if (prose.indexOf(phrase) !== -1) {
        found.add(category);
        break;
      }
    }
  }
  return Array.from(found).sort();
}
