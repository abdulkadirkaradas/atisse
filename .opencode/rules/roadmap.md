---
trigger: model_decision
description: Load when scoping work against milestones, checking v1 exit criteria, or evaluating whether a feature belongs in the current development phase.
---

# ROADMAP

## Development Milestones — @atisse/core

This roadmap is milestone-driven, not calendar-driven. Each milestone has explicit
entry conditions, deliverables, and exit criteria. A milestone is complete when its
exit criteria are fully satisfied — not before.

> **Architecture baseline is complete.** All interface contracts, ADRs, constraints,
> security boundaries, and design principles are finalized and documented.

---

## Milestone Overview

| Milestone | Focus                             | Blocker      |
| --------- | --------------------------------- | ------------ |
| M1        | Interface freeze + infrastructure | None         |
| M2        | Core kernel — `run()` end-to-end  | M1           |
| M3        | Streaming + OrchestratorProfile   | M2           |
| M4        | Official adapter set              | M2           |
| M5        | Quality gate                      | M2 + M3 + M4 |
| M6        | First release                     | M5           |

---

## M1 — Interface & Infrastructure Foundation

**Goal:** Every interface is written in code and frozen. The test infrastructure is
operational. No feature code exists yet — only the contracts that all feature code
will be written against.

**Deliverables:**

`interfaces.ts` — All public contracts written and marked FROZEN: `AIProvider`,
`MemoryAdapter`, `ContextProvider`, `Tool`, `ToolDefinition`, `ToolCall`, `ToolResult`,
`ToolResultError`, `RunInput`, `RunOutput`, `OrchestratorConfig`, `OrchestratorProfile`,
`HookRegistry`, `StreamChunk`, `RetryPolicy`, `TimeoutPolicy`, `ToolPolicy`, `Logger`,
`EventBus`, `OrchestratorEvent`, `Orchestrator` class public API.

`errors.ts` — Full error hierarchy under `OrchestratorError`. Every error class carries
`readonly retryable: boolean` and `readonly code: string`. `isRetryable()` type guard
exported.

`lifecycle.ts` — `LifecycleStateMachine` + `VALID_TRANSITIONS` map.
`InvalidStateTransitionError` on illegal transition.

`testing/mock-provider.ts` — `MockProvider` with response queue, call history, and
configurable error injection. Test infrastructure — not an adapter.

Monorepo toolchain: pnpm workspaces, `tsconfig.base.json`, ESLint, Prettier, Vitest,
tsup. GitHub Actions: lint + typecheck + test on every PR.

**Exit criteria:**

- `interfaces.ts` frozen — no required fields added or removed in v1
- `MockProvider` passes its unit test suite without a working kernel
- `isRetryable()` correctly classifies every error subtype
- CI pipeline green on a clean checkout

---

## M2 — Core Kernel

**Goal:** `orchestrator.run()` executes the full 10-step lifecycle end-to-end.
Every core module is implemented, tested, and wired together.

**Blocker:** M1.

**Deliverables:**

`policies.ts` — `RetryPolicy`, `TimeoutPolicy`, `ToolPolicy` with production defaults.
`executeWithRetry()`: exponential backoff + jitter + `retryAfterMs`.
`executeWithFallback()`: triggers fallback on `MaxRetriesExceededError`.

`prompt-composer.ts` — Deterministic message assembly: systemPrompt → contextMessages
→ memoryMessages (trimmed, oldest dropped first) → userMessage.

`tool-controller.ts` — Tool execution loop with cumulative round counter (never resets
on retry — ADR-016). Zod schema validation: mismatch throws `ToolValidationError`
(FATAL). Caught `ToolError` subclasses are mapped to `ToolResultError` and stored in
`ToolResult.error`. Each `Tool.execute()` wrapped in `Promise.race` against
`toolTimeoutMs`. Serial execution only — `allowParallelTools: false` is the v1
constraint.

`hooks.ts` — `HookRegistry` + `runHooks()` serial executor. Hooks run in registration
order. A hook that throws aborts the pipeline.

`events.ts` — `EventBus` + full `OrchestratorEvent` union. `tool.failed` carries
`ToolResultError` payload. Listeners are fire-and-forget. Listener errors are swallowed
and logged — never affect pipeline outcome.

`pipeline.ts` — Owns all 10 execution steps. All state (`LifecycleStateMachine`,
`runId`, `tempMessages`) is local per call — never stored on `this`. Receives
`EventBus` instance by injection from `orchestrator.ts`.

`orchestrator.ts` — Public surface: `new Orchestrator(config)`, `run()`, `on()`.
Config validated eagerly in constructor. Constructs and owns the `EventBus` instance.
`on(type, listener)` delegates registration to the internal `EventBus` and returns
the unsubscribe function — callers MUST hold and invoke it when the listener is no
longer needed. Delegates all execution to `pipeline.ts`.

`memory-inmemory` — `InMemoryAdapter`: reference `MemoryAdapter` implementation.
No dependencies. Used as baseline in all integration tests.

**Exit criteria:**

- `orchestrator.run()` passes full integration test suite with `MockProvider`
  and `InMemoryAdapter`
- Retry + fallback: FATAL vs RETRYABLE classification, backoff, fallback trigger tested
- Tool round limit enforced cumulatively across retry paths
- `ToolResultError` correctly populated from `ToolExecutionError` and
  `ToolValidationError` — `code`, `message`, `retryable` fields verified
- Hook serial order and event listener isolation verified
- `orchestrator.on()` returns an unsubscribe function; after it is called, the
  listener no longer fires
- Registering a listener inside a loop without unsubscribing causes listener
  accumulation — verified via listener count assertion
- `ConfigValidationError` thrown on `stream: true` + `fallbackProvider` combination
- CI green

---

## M3 — Streaming & OrchestratorProfile

**Goal:** Streaming mode is a first-class execution path. Profile resolution is
fully operational. Both are integrated into the state machine.

**Blocker:** M2.

**Deliverables:**

Streaming — `run({ stream: true })` returns `Promise<AsyncIterable<StreamChunk>>`.
Tool execution in streaming mode: stream pauses on `tool_calls`, tool executes,
`tool_result` chunk yielded, stream resumes. Pre-condition guards enforced at `run()`
entry (ADR-017).

`profile.ts` — `OrchestratorProfile` merge logic per `ARCHITECTURE.md`: `provider` /
`systemPrompt` replace; policies deep merge; `tools` / `contextProviders` full replace;
`hooks` concatenate. Key/name invariant validated at construction time.

`provider-openai` — `OpenAIProvider`: `generate()` + `generateStream()`. Full error
mapping to `OrchestratorError` subtypes. `AbortSignal` forwarded to SDK.

**Exit criteria:**

- Streaming text, streaming + tool calls, streaming error termination tested
- Profile override, hook merging, provider override tested
- `profile.resolved` event emitted with correct override field list
- `OpenAIProvider` passes unit tests (error mapping) and integration tests
  (retry, hook, state machine behavior)
- CI green

---

## M4 — Official Adapter Set

**Goal:** A production-representative adapter set, each fully tested at unit
and integration level.

**Blocker:** M2.

**Adapters:**

`@atisse/provider-anthropic` — `AnthropicProvider`. Full error mapping.
`generateStream()` implemented.

`@atisse/memory-redis` — `RedisMemoryAdapter`. TTL support. Append-only save
semantics (ADR-012). Connection errors mapped to `ContextLoadError` (retryable).

`@atisse/context-rag` — `RAGContextProvider` scaffold. `input.prompt` never
elevated to `role: 'system'` (SECURITY.md S-2).

**Tool patterns:** Tools are passed directly to `OrchestratorConfig.tools` or
`OrchestratorProfile.tools` — no packaging required for application-specific use.
General-purpose tools intended for independent publishing follow the
`@atisse/tool-{name}` convention documented in `ADAPTER_PATTERN.md`.

**Test requirement per adapter:**

- Unit: error mapping, schema enforcement, interface contract compliance
- Integration: adapter wired into `Orchestrator` — retry, hooks, state transitions,
  `RunOutput` shape verified

**Exit criteria:**

- All three adapters pass unit and integration test suites
- `memory-redis` append semantics verified under concurrent `run()` calls
- `RAGContextProvider` fail-fast path tested (ADR-015)
- CI green

---

## M5 — Quality Gate

**Goal:** The kernel meets the reliability, performance, and security bar for v1.

**Blocker:** M2 + M3 + M4.

**Criteria:**

Coverage — unit coverage ≥ 70% on `@atisse/core`. Report generated in CI.

Performance — p50 and p95 latency overhead of `orchestrator.run()` vs raw SDK call
< 5ms on `MockProvider`. Benchmark script committed to repo.

Stress — 100 concurrent `run()` calls: no state leaks, no cross-run interference,
no memory growth.

Security checklist:

- No secrets in logs or error messages
- `role: 'system'` never assigned to `input.prompt` in any code path
- All tool `inputSchema` non-empty, `additionalProperties: false`
- HTTP-calling tools implement URL allowlist
- Profile factory functions accept no user-controlled string arguments

TypeDoc annotations complete on all exported symbols. API naming and config fields
reviewed for consistency.

**Exit criteria:**

- Coverage ≥ 70%, benchmark within threshold, stress test passes
- Security checklist signed off
- TypeDoc generates without errors

---

## M6 — First Release

**Goal:** The project is publicly accessible and usable from day one.

**Blocker:** M5.

**Deliverables:**

`README.md` — positioning, problem/solution, comparison table (LangChain / Vercel AI
SDK / this project), quick-start example.

`examples/` — minimum 5 working examples:

1. Basic run with OpenAI provider
2. Retry and fallback
3. Tool execution with schema validation
4. OrchestratorProfile usage
5. Streaming with tool calls

`docs/getting-started.md` — installation, first `run()`, configuration reference.
`docs/writing-adapters.md` — provider, memory, context, and tool adapters. References
`ADAPTER_PATTERN.md` and `@atisse/tool-{name}` packaging convention.

Version: `1.0.0` via Changesets. Published: `@atisse/core` + all official adapters.
GitHub Discussions enabled.

**Exit criteria:**

- `npm install @atisse/core` + any example works on a clean machine
- All examples run without errors
- TypeDoc site live
- Packages published to npm

---

## v2+ Boundary

| Feature                              | Reason                                                     |
| ------------------------------------ | ---------------------------------------------------------- |
| Parallel tool execution              | v1 is serial-only                                          |
| Typed tool generics                  | v2 candidate — `execute()` input/output is `unknown` in v1 |
| Agent planning loop                  | Turns kernel into a framework                              |
| Multi-agent communication            | Different product                                          |
| Workflow DAG / step chaining         | Pipeline engine scope                                      |
| Streaming + fallback combination     | ADR-017 — deferred                                         |
| Configurable partial context failure | ADR-015 — deferred                                         |
| WASM / Rust core                     | Performance optimization track                             |

---

## Known Limitations (v1)

**`Tool.execute()` input/output typing is `unknown`.** Zod enforces the schema at
runtime but TypeScript cannot infer the narrowed type from a JSON Schema object.
Use Zod `safeParse` inside `execute()` for type-safe access — see `ADAPTER_PATTERN.md`
for the recommended pattern. Typed generics are a v2 candidate.

**Streaming and fallback cannot be combined.** A provider failure mid-stream cannot
be transparently recovered — the consumer has already received partial output. Deferred
to v2 (ADR-017).

**ContextProvider partial failure is fail-fast.** Configurable best-effort behavior
(skip failed providers, continue) is a v2 option (ADR-015).
