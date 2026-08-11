---
name: constraints
description: v1 scope hard limits and forbidden code patterns for @atisse/core. Load before implementing anything, and always before proposing a new feature or dependency.
license: MIT
compatibility: opencode
---

# Constraints

Protected: changes here require SPSA evaluation + explicit user approval.

## v1 scope — forbidden, don't implement or scaffold "for later"

| Forbidden                                                          | Why                                                   |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| Agent planning loop, autonomous decision-making, multi-agent comms | turns this into an agent framework — see `principles` |
| Workflow DAG / step chaining / graph execution                     | pipeline-engine scope, not kernel scope               |
| Parallel tool execution                                            | v2 — v1 is serial only                                |
| Visual editor, SaaS dashboard, cost-analytics dashboard            | not a UI/SaaS project                                 |
| Prompt template DSL                                                | not a template engine                                 |
| Distributed orchestration                                          | not this project's concern                            |
| Built-in RAG pipeline                                              | RAG is a `ContextProvider` adapter, not core          |

If a task requires one of these, stop and clarify with the user rather than implementing a
partial version.

## Forbidden code patterns

- **No state on `Orchestrator` during `run()`** — all execution state (`stateMachine`,
  `runId`, `roundCounter`) is local to the call. See `code-standards` stateless contract.
- **No adapter imports in `core`** — `import { OpenAIProvider } from '@atisse/provider-openai'`
  inside core is forbidden; depend on `interfaces.ts` types only.
- **No breaking changes to `interfaces.ts`** — no removed fields, no narrowed types; only
  additive optional fields are allowed. See `api-design` for the full breaking-change test.
- **No `any`** — `unknown` + narrowing, or generics.
- **No secrets in logs or errors** — see `security` S-1.
- **No sync blocking in async functions** (`fs.readFileSync` inside an `async function` —
  use the promise API).
- **No event listeners that throw** — wrap in try/catch that silently discards.
- **No circular dependencies** — follow the layer rules in `architecture`; `import type`
  within Layer 0 is fine, runtime circular imports are not.
- **No user input as `role: 'system'`** — see `security` S-2.
- **No user-controlled values in profile factory arguments** — see `security` S-2a.
- **No mismatched `profiles` key / `name` field** — constructor throws
  `ConfigValidationError` on mismatch.
- **No duplicate tool names** — constructor throws `ConfigValidationError`.
- **No `allowParallelTools: true` in v1** — `ConfigValidationError`.
- **No `maxToolRounds < 1`** — `ConfigValidationError`.
- **No `stream: true` + `fallbackProvider`** — `ConfigValidationError` at `run()` entry.
- **No plain `Error` throws** in adapters or kernel — see `errors`.
- **`TokenLimitExceededError` is user-land only** — the kernel never throws it internally;
  prompt overflow is handled by trimming `memoryMessages`. It exists for `beforeRun` hooks
  that enforce custom token budgets.

## Interface modification quick-check

| Question                                 | If yes                   |
| ---------------------------------------- | ------------------------ |
| Removing a field breaks an adapter?      | don't remove it          |
| Changing a type breaks existing code?    | don't change it          |
| Is the new field required?               | make it optional instead |
| Does this change `run()`'s return shape? | MAJOR — escalate to SPSA |

## Test constraints

No real API calls (`MockProvider` only) · no network access in unit tests · no filesystem
writes (use in-memory alternatives) · no `setTimeout` with real durations
(`vi.useFakeTimers()` per-test, never globally) · test files never import from other test
files.
