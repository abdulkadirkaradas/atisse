---
name: architecture
description: System design, package structure, the run() execution flow, and lifecycle state machine for @atisse/core. Load when implementing any feature touching execution flow, retry/fallback, streaming, or lifecycle transitions — or reviewing one.
license: MIT
compatibility: opencode
---

# Architecture

`pipeline.ts` is ~1500 lines and is the actual source of truth for execution order — this
skill is the condensed map of it, not a replacement for reading it on a non-trivial change.

## Core package layout

**Current:**

```
packages/core/src/
├── interfaces.ts       FROZEN — see `interfaces` skill
├── errors.ts            error hierarchy + isRetryable() — see `errors` skill
├── orchestrator.ts       L4: new Orchestrator(config), run(), on() — eager validation, delegates to pipeline
├── pipeline.ts           L3: ~1500 lines, owns steps 1-10 below; runId/state/roundCounter are local per call
├── lifecycle.ts          L1: LifecycleStateMachine + VALID_TRANSITIONS
├── prompt-composer.ts    L1: assembles Message[] from all sources
├── tool-controller.ts    L2: tool execution loop, round limiting, validation
├── hooks.ts / events.ts  L2: HookRegistry/runHooks(); EventBus
├── policies.ts           L1: RetryPolicy/TimeoutPolicy/ToolPolicy defaults + merge utils
├── profile.ts            OrchestratorProfile merge logic
└── testing/mock-provider.ts   MockProvider — public test infra, not an adapter
```

`pipeline.ts` is still the actual source of truth for execution order today — the flow
below is the condensed map of it, not a replacement for reading it on a non-trivial change.

**Target, per ADR-039 — not yet implemented.** `pipeline.ts` splits into `pipeline/`
(internal, not exported from `@atisse/core`; L3 in the layer diagram unchanged), landing as
five atomic, independently-reviewable sub-milestones B1A–B1E, no behavioral or public API
change at any step:

```
pipeline/
├── index.ts              barrel — executePipeline() stream/non-stream dispatch     (B1A)
├── shared.ts              buildPromptRequest, resolveProfiles, buildContextInput,
│                          initializePipeline, finalizePipeline                     (B1A-D)
├── non-streaming.ts       non-streaming orchestration — assembles the engines       (B1A-D)
├── streaming.ts           executeStreamingPipeline() async generator                (B1E)
├── generation-engine.ts   generation loop + fallback, Step 5 + Step 8               (B1A)
├── tool-executor.ts       tool round execution, round limiting, Step 6              (B1B)
├── retry-engine.ts        retry/backoff + timeout enforcement, Step 7               (B1C)
├── error-normalizer.ts    handleOrchestratorError() + run.failed                    (B1D)
└── streaming-engine.ts    streaming generator + chunk consumption                   (B1E)
```

Later v1.1.0 additions to `pipeline/`, after B1A-E: `types.ts` (`PipelineRoundContext` +
`RoundMutableState`, internal, B2); `error-mapper.ts` (`ProviderErrorMapper`, public
adapter-facing, B11); `round-loop.ts` — the closure point for the streaming/non-streaming
round-loop duplication, unifying both behind one `RoundExecutionStrategy` interface with
two thin implementations, internal (B15, see `DECISION-LOG.md` ADR-039). Until B15 lands,
treat the streaming and non-streaming round loops as two call sites that must be kept in
sync by hand — that duplication is real and current, not yet resolved by B1A-E alone.

`core` has zero runtime deps on adapter packages (`provider-*`, `memory-*`, `context-*`) —
they depend on `core`'s interfaces, never the reverse. This holds before and after the
pipeline split.

## run() execution flow

Whole pipeline wrapped in `Promise.race([executePipeline(...), totalTimeoutTimer])` — a
hard ceiling regardless of which step is active.

1. **INITIALIZED** — validate config (`ConfigValidationError` on failure); resolve profile
   (profile values replace base, don't merge — except `retry`/`timeout`/`toolPolicy`, which
   deep-merge, and `hooks`, which concatenate, base first); generate `runId`;
   `roundCounter = 0` and `tempMessages = []` are local, not instance state.
2. **CONTEXT_INJECTING** — `ContextProvider`s called sequentially; fail-fast (first failure
   aborts all, no partial results); retryable → `RETRYING`, fatal → `FAILED`.
3. **CONTEXT_INJECTED** — `MemoryAdapter.load(sessionId)` if a session is present.
4. **PROMPT_COMPOSED** — fixed message order: `systemPrompt` → context messages → memory
   messages (token-trimmed, oldest dropped first — context/system are never trimmed) →
   user message (always last, always `role: 'user'`).
5. **GENERATING** (+retry loop) — `beforeGenerate` hooks → `AIProvider.generate()` (or
   `generateStream()` if `stream: true`) → retryable error → `RETRYING`; fatal →
   `FAILED`; retries exhausted + fallback configured → `FALLBACKING`; `tool_calls` in
   response → `TOOL_EXECUTING`; otherwise `afterGenerate` hooks fire and the pipeline moves
   to `COMPLETING`. Streaming pre-flight (throws `ConfigValidationError` if violated):
   `capabilities.streaming === false`, `generateStream === undefined`, or a
   `fallbackProvider` configured are all forbidden with `stream: true`.
6. **TOOL_EXECUTING** — round counter lives in `pipeline.ts`, not `ToolController`;
   increments here, checked against `maxToolRounds`, never resets on retry. Validate
   (`ToolValidationError`, fatal) → execute under `Promise.race(toolTimeoutMs)`
   (`ToolExecutionError`, retryable) → append results → back to `GENERATING`.
7. **RETRYING** — exponential backoff + jitter → back to `GENERATING` or
   `CONTEXT_INJECTING` (context-provider failures only).
8. **FALLBACKING** — swap to `fallbackProvider` → `GENERATING`.
9. **COMPLETING** — `MemoryAdapter.save()` (atomic append of `[userMessage,
assistantMessage]`) → `afterRun` hooks.
10. **COMPLETED** / **FAILED** (terminal) — emit `run.completed`/`run.failed`.

**Streaming** follows the same steps 1-4, then yields `{type:'text'|'tool_call'|
'tool_result'|'done'|'error'}` chunks; tool execution blocks the stream (never streamed
itself); always terminates in exactly one `done` or `error` chunk; `afterGenerate` fires
after `done` with the accumulated response.

## Lifecycle state machine

A fresh `LifecycleStateMachine` per `run()` call — never stored on `Orchestrator`. Illegal
transitions throw `InvalidStateTransitionError` immediately (`assertNotTerminal()` uses
`to: 'any'`). `LifecycleState` is exported from `interfaces.ts`; `VALID_TRANSITIONS` is an
internal constant in `lifecycle.ts` — read it there for the exact table, not reproduced
here since it changes with the flow above.

Rules worth remembering because they aren't obvious from a quick read of `lifecycle.ts`:

- `COMPLETED`/`FAILED` are terminal — zero outbound transitions.
- `FALLBACKING → GENERATING` uses the fallback provider, not the primary.
- `TOOL_EXECUTING → GENERATING` increments the round counter (held in `pipeline.ts`, not
  the state machine or `ToolController`) — cumulative across the whole `run()`, never
  resets on retry.
- `RETRYING → CONTEXT_INJECTING` only happens for a context-provider failure.
- The state machine doesn't know about retry _counts_ — that's the policy engine's job, it
  only enforces which states may follow which.
- `LifecycleStateMachine` holds no `runId` and no `Logger` — `pipeline.ts` owns both and
  writes every transition log itself.

## Profile resolution

`BaseConfig + ProfileOverride = ResolvedConfig`, computed fresh per call.

| Field                            | Merge                                                         |
| -------------------------------- | ------------------------------------------------------------- |
| `provider`, `systemPrompt`       | profile replaces base                                         |
| `retry`, `timeout`, `toolPolicy` | deep merge, profile keys win                                  |
| `tools`, `contextProviders`      | full replace when profile defines either (`[]` also replaces) |
| `hooks`                          | concatenate, base first                                       |

Profile key not found in `config.profiles` → `ConfigValidationError` at `run()` entry.

## Non-negotiables

`core` has zero adapter imports · `interfaces.ts` never breaks during v1 · `run()` stores
nothing on `this` · hooks run serially in registration order · event listeners never throw
(errors are swallowed) · `MockProvider` lives in `core/testing/`, it's public, not an
adapter · all public types export from `interfaces.ts`, never from implementation files.
