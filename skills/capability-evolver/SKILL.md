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

- **First-turn Recall** injects a short, bounded summary of recent eligible Outcomes for this workspace.
- Successful `write`, `edit`, and `replace` results produce advisory mutation signals.
- Outcomes are **never inferred automatically**. After verifying substantive changed work, submit one explicit verdict and reusable lesson with `evolver_outcome`:
  - `{ action: "set", verdict: "success" | "failed", lesson: "..." }`
  - `{ action: "clear" }`

The lesson should capture one reusable technique or pitfall in at most 500 normalized characters. Do not include secrets. Submission is local, makes no model or network call, and remains pending until it is replaced, cleared, or finalized at a later lifecycle boundary.
Memory is written to a local JSONL graph. With no extra setup it lands in
`~/.evolver/memory/evolution/memory_graph.jsonl`; inside an evolver-managed
project it lands under that project's `memory/evolution/`.

## What you (the agent) should do

For substantive changed work:

1. Reuse relevant injected Recall.
2. Complete and verify the work.
3. Call `evolver_outcome` once with the verified verdict and one concise reusable lesson. If the pending verdict is no longer valid, clear it explicitly.

Trivial or purely conversational turns don't need this — skip it.

## Signals

The recorder classifies work by signal. Knowing the vocabulary helps you
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

## Engine pipeline (optional)

The bundled event handlers record and recall outcomes on their own. The full
`@evomap/evolver` engine (automated log analysis, review-and-solidify) is a
separate CLI you can install if you want that pipeline — the handlers do not
auto-detect or invoke it. The memory the handlers record is what the pipeline
consumes.
