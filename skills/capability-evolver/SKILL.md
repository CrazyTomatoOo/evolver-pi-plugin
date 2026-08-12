---
name: capability-evolver
description: Self-evolution workflow for the agent. Before a substantive task, recall what worked on similar past tasks from evolution memory; after it, record the outcome so future sessions learn from it. Use when the user starts non-trivial work (a feature, a fix, a refactor) or asks the agent to "evolve", "learn from this", or "remember how this went".
---

# Capability Evolver

This plugin gives the agent a **persistent, auditable evolution memory** built on the
Genome Evolution Protocol (GEP). The goal is simple: stop re-solving the same
problem from scratch. Past outcomes — what worked, what failed — are carried
forward into future sessions.

## How it works

- **First-turn Recall** injects a short, bounded summary of recent eligible Outcomes for this workspace (success/failed, ≤ 7 days, score ≥ 0.5, balanced newest 3, ≤ 2 000 chars). It is delivered once on the next user turn and is idempotent across reload/resume/fork.
- Successful `write`, `edit`, and `replace` results produce advisory mutation signals.
- Outcomes are **never inferred automatically**. After verifying substantive changed work, submit one explicit verdict and reusable lesson with `evolver_outcome`:
  - `{ action: "set", verdict: "success" | "failed", lesson: "..." }`
  - `{ action: "clear" }`

The lesson should capture one reusable technique or pitfall in at most 500 normalized characters. Do not include secrets. Submission is local, makes no model or network call, and remains pending until it is replaced, cleared, or finalized at a later lifecycle boundary (quit/new/resume/fork; reload never finalizes).

The pending verdict is bound to the workspace snapshot at submission time. If the content changes after submission, finalize marks it stale — clear and re-submit after the new change.

## What you (the agent) should do

For substantive changed work:

1. Reuse relevant injected Recall.
2. Complete and **verify** the work (tests pass, typecheck clean, behavior confirmed).
3. Call `evolver_outcome` once with the verified verdict and one concise reusable lesson. If the pending verdict is no longer valid (the work changed after submission), clear it explicitly and re-submit.

Trivial or purely conversational turns don't need this — skip it.

## What is NOT captured

- The final assistant prose is **not** captured or recorded — only the explicit verdict and lesson you submit via `evolver_outcome`.
- Mutation signals are advisory topic labels only; they never determine the verdict or score.
- Diff contents, source code, and stack traces are never stored in the Graph.

## Signals

The recorder indexes work by signal. Knowing the vocabulary helps you
describe outcomes in terms the memory graph indexes well:

| Signal | Fires on |
| --- | --- |
| `log_error` | errors, exceptions, failures in the diff |
| `perf_bottleneck` | timeout / slow / latency / OOM |
| `capability_gap` | "not supported" / "not implemented" |
| `user_feature_request` | adding a feature / new module |
| `test_failure` | failing tests / assertions |
| `deployment_issue` | build / CI / pipeline / rollback |
| `recurring_error` | same error / still failing / not fixed |

## Status inspection

Use `/evolver-status` to see a read-only snapshot of the evolution pipeline:
workspace health, Graph health, current session transition, pending Outcome,
Recall selection, and the latest finalization attempt. It is strictly
observational — it never creates identity, acquires locks, drains the
outbox, or writes any file.

## Engine pipeline (optional)

The bundled event handlers record and recall outcomes on their own. The full
`@evomap/evolver` engine (automated log analysis, review-and-solidify) is a
separate CLI you can install if you want that pipeline — the handlers do not
auto-detect or invoke it. The memory the handlers record is what the pipeline
consumes.
