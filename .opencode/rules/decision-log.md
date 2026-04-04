---
trigger: model_decision
description: Load when questioning an existing architectural choice, proposing a change that may conflict with a recorded decision, or evaluating whether a new ADR is warranted.
---

# DECISION LOG
## Architectural Decision Records (ADR)

Consult this before proposing changes that might revisit recorded decisions.
**Write protocol:** SPBED flags candidates → SPSA evaluates → user approves → SPSA writes entry.

---

## ADR-001: Stateless Core
**Decision:** `Orchestrator` holds no state between `run()` calls.
**Rationale:** Determinism, testability, horizontal scaling, no session cleanup in core.
**Consequence:** Session state lives in `MemoryAdapter` adapters.

## ADR-002: Interface-First, Adapters Are External
**Decision:** All extension points are TypeScript interfaces. Core has zero imports from adapter packages.
**Rationale:** Structural typing enables any conforming object; MockProvider is trivially simple; adapters publish independently.

## ADR-003: Lifecycle State Machine (Not Generic Pipeline)
**Decision:** Execution modeled as a finite state machine with guarded transitions.
**Rationale:** Constrains scope to LLM interaction model; illegal transitions surface immediately; state always inspectable.

## ADR-004: Hooks Serial, Events Fire-and-Forget
**Decision:** Lifecycle hooks execute serially (each awaits previous). Event bus listeners are fire-and-forget.
**Rationale:** Hooks need ordering and can abort; events must never affect pipeline outcome. Different contracts must not be merged.

## ADR-005: OrchestratorProfile Is a Config Snapshot
**Decision:** Multiple execution behaviors via `OrchestratorProfile` objects, not subclasses or multiple instances.
**Rationale:** Single instance = shared event listeners and metrics; profiles are plain objects — serializable and testable.

## ADR-006: Streaming Is a Mode of `run()`, Not a Separate Method
**Decision:** `run({ stream: true })` returns `Promise<AsyncIterable<StreamChunk>>`. No `runStream()` method.
**Rationale:** Single entry point; TypeScript overloads give correct return type; same state machine for both modes.

## ADR-007: Error Taxonomy With `retryable` Classification
**Decision:** All errors extend `OrchestratorError` with `readonly retryable: boolean`. Retry decisions inspect the error type.
**Rationale:** Type-safe retry decisions via `isRetryable()`; self-documenting; extensible without changing retry logic.

## ADR-008: MockProvider Belongs in Core
**Decision:** `MockProvider` lives in `packages/core/src/testing/`.
**Rationale:** Zero-friction testing without API keys; core is self-contained; `testing/` subdirectory signals purpose clearly.

## ADR-009: Zod for Runtime Schema Validation
**Decision:** Tool input schema validation uses Zod.
**Rationale:** TypeScript-first; single validation library for config and tool input; `ToolValidationError` is FATAL — schema failures are programmer errors.

## ADR-010: pnpm Workspaces for Monorepo
**Decision:** pnpm workspaces with simple `extends` (no project references). tsup builds; `tsc` for typecheck only.
**Rationale:** Lean setup covers 95% of needs; project references add complexity without benefit at this scale.

## ADR-011: `OrchestratorProfile.role` Removed
**Decision:** `role` field removed from `OrchestratorProfile` before v1 freeze.
**Rationale:** Undefined semantic — not used in any pipeline step; `systemPrompt` covers all legitimate use cases.

## ADR-012: `MemoryAdapter.save()` Accepts `Message[]`
**Decision:** `save(sessionId, messages: Message[])` — batch, not single-message.
**Rationale:** Atomicity — both user and assistant messages saved in one call; partial saves on failure are prevented.

## ADR-013: Context and Memory Loading Is Sequential
**Decision:** `ContextProvider.provide()` calls are sequential. Memory loading follows context loading.
**Rationale:** Consistent with constrained execution model; each state machine step = one well-defined operation; parallel execution would complicate the retry path.

## ADR-014: Timeout via `AbortSignal` + `Promise.race` Fallback
**Decision:** Kernel attaches `AbortSignal` (from `generateTimeoutMs`) to each `PromptRequest`. `Promise.race` fallback for non-cooperative providers. `totalTimeoutMs` via `Promise.race` at pipeline top level.
**Rationale:** `AbortSignal` enables cooperative cancellation; `Promise.race` is the unconditional hard ceiling for both per-call and total timeouts.

## ADR-015: ContextProvider Partial Failure Is Fail-Fast
**Decision:** First provider failure aborts all context loading → `RETRYING` or `FAILED`. Partial results discarded.
**Rationale:** Explicit failure over silent partial context; `context.failed` event gives full visibility. Best-effort: v2 candidate.

## ADR-016: Tool Round Counter Is Cumulative
**Decision:** Tool round counter in `pipeline.ts` (local variable) does not reset on retry.
**Rationale:** `maxToolRounds` prevents infinite loops; resetting on retry would allow a misbehaving LLM to bypass the limit.

## ADR-017: Streaming and Fallback Are Forbidden Together in v1
**Decision:** `stream: true` + `fallbackProvider` → `ConfigValidationError` at `run()` entry.
**Rationale:** Mid-stream provider failure cannot be transparently recovered — consumer has partial output. v2 candidate with defined contract.

## ADR-018: `Message` Discriminated Union
**Decision:** `Message` is a 4-arm discriminated union. `role: 'tool'` requires `toolCallId: string` and `name: string`. `role: 'assistant'` carries optional `toolCalls?: ToolCall[]`.
**Rationale:** "Impossible states must be unrepresentable" — compile-time enforcement of role-specific required fields.

## ADR-019: `generateStream?` Returns `Promise<AsyncIterable<StreamChunk>>`
**Decision:** `AIProvider.generateStream?` returns `Promise<AsyncIterable<StreamChunk>>` instead of bare `AsyncIterable<StreamChunk>`.
**Rationale:** Connection errors surface before streaming begins (as `Promise` rejection) rather than being deferred to the first chunk read.

## ADR-020: `ToolResult` Discriminated Union
**Decision:** `ToolResult` is a discriminated union — `output` and `error` are mutually exclusive.
**Rationale:** A result is either successful or failed — both fields present simultaneously is an impossible state.

## ADR-021: `StreamChunk` Discriminated Union
**Decision:** `StreamChunk` is a discriminated union — each `type` carries exactly its required fields.
**Rationale:** Compile-time field presence guarantees per chunk type; `delta` on `text` chunks is `string`, not `string | undefined`.

## ADR-022: `OrchestratorErrorCode` Union Type
**Decision:** All kernel error codes defined as a single exported union `OrchestratorErrorCode` in `interfaces.ts`.
**Rationale:** Consumer exhaustive switch/case; single source of truth; adding a code is MINOR (union widening), removing is MAJOR.

## ADR-023: `EventErrorPayload` / `ToolResultError` Semantic Separation
**Decision:** Two structurally identical interfaces kept separate: `EventErrorPayload` (event bus payloads) and `ToolResultError` (`ToolResult.error` DTO).
**Rationale:** Accidental structural convergence — semantics differ; each may diverge independently; merging creates hidden coupling.

## ADR-024: `ContextProviderInput = Omit<RunInput, 'stream' | 'profile'>`
**Decision:** `ContextProvider.provide()` receives `ContextProviderInput`, not the full `RunInput`.
**Rationale:** `stream` and `profile` are pipeline-internal routing fields — exposing them to context providers is a leaky abstraction.

## ADR-025: `OrchestratorConfig.systemPrompt`
**Decision:** `systemPrompt?: string` added to `OrchestratorConfig` as a global system prompt. Profile `systemPrompt` replaces (does not append) the base value.
**Rationale:** Config-driven initialization principle — common use case should not require a `beforeGenerate` hook.

## ADR-026: `totalTimeoutMs` Enforced via `Promise.race` at Pipeline Top Level
**Decision:** `pipeline.ts` wraps the entire execution in `Promise.race([executePipeline(...), timeoutPromise])`.
**Rationale:** `AbortSignal` is cooperative — non-compliant operations ignore it. `Promise.race` is an unconditional hard ceiling regardless of which step is active.

## ADR-027: `afterGenerate` in Streaming Mode Fires After `done` Chunk
**Decision:** In streaming mode, `afterGenerate` hook fires after the `done` chunk is received, with accumulated text and usage in `response`.
**Rationale:** `response` must be complete for validation hooks to work correctly. Firing mid-stream would produce a partial and misleading `PromptResponse`.

## ADR-028: `OrchestratorError.fatal` Removed
**Decision:** `fatal: boolean` field removed from `OrchestratorError` base class.
**Rationale:** Always `fatal === !retryable` — redundant. `retryable: false` already communicates fatal intent. Removing reduces frozen interface surface.

## ADR-029: `transition()` Returns Previous State
**Decision:** `LifecycleStateMachine.transition(to)` returns `LifecycleState` (the previous state) instead of `void`.
**Rationale:** `pipeline.ts` can log `from → to` in a single line without a separate variable. No behavioral change — return value is optional to use.
