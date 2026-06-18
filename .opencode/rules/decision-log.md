# DECISION LOG

## Architectural Decision Records (ADR)

Consult this before proposing changes that might revisit recorded decisions.
**Write protocol:** SPBED flags candidates → SPSA evaluates → user approves → SPSA writes entry.

---

## ADR-001: Stateless Core

**Decision:** `Orchestrator` holds no state between `run()` calls.
**Rationale:** Determinism, testability, horizontal scaling, no session cleanup in core.
**Consequence:** Session state lives in `MemoryAdapter` adapters.

---

## ADR-002: Interface-First, Adapters Are External

**Decision:** All extension points are TypeScript interfaces. Core has zero imports from adapter packages.
**Rationale:** Structural typing enables any conforming object; MockProvider is trivially simple; adapters publish independently.

---

## ADR-003: Lifecycle State Machine (Not Generic Pipeline)

**Decision:** Execution modeled as a finite state machine with guarded transitions.
**Rationale:** Constrains scope to LLM interaction model; illegal transitions surface immediately; state always inspectable.

---

## ADR-004: Hooks Serial, Events Fire-and-Forget

**Decision:** Lifecycle hooks execute serially (each awaits previous). Event bus listeners are fire-and-forget.
**Rationale:** Hooks need ordering and can abort; events must never affect pipeline outcome. Different contracts must not be merged.

---

## ADR-005: OrchestratorProfile Is a Config Snapshot

**Decision:** Multiple execution behaviors via `OrchestratorProfile` objects, not subclasses or multiple instances.
**Rationale:** Single instance = shared event listeners and metrics; profiles are plain objects — serializable and testable.

---

## ADR-006: Streaming Is a Mode of `run()`, Not a Separate Method

**Decision:** `run({ stream: true })` returns `Promise<AsyncIterable<StreamChunk>>`. No `runStream()` method.
**Rationale:** Single entry point; TypeScript overloads give correct return type; same state machine for both modes.

---

## ADR-007: Error Taxonomy With `retryable` Classification

**Decision:** All errors extend `OrchestratorError` with `readonly retryable: boolean`. Retry decisions inspect the error type.
**Rationale:** Type-safe retry decisions via `isRetryable()`; self-documenting; extensible without changing retry logic.

---

## ADR-008: MockProvider Belongs in Core

**Decision:** `MockProvider` lives in `packages/core/src/testing/`.
**Rationale:** Zero-friction testing without API keys; core is self-contained; `testing/` subdirectory signals purpose clearly.

---

## ADR-009: Zod for Runtime Schema Validation

**Decision:** Tool input schema validation uses Zod.
**Rationale:** TypeScript-first; single validation library for config and tool input; `ToolValidationError` is FATAL — schema failures are programmer errors.

---

## ADR-010: pnpm Workspaces for Monorepo

**Decision:** pnpm workspaces with simple `extends` (no project references). tsup builds; `tsc` for typecheck only.
**Rationale:** Lean setup covers 95% of needs; project references add complexity without benefit at this scale.

---

## ADR-011: `OrchestratorProfile.role` Removed

**Decision:** `role` field removed from `OrchestratorProfile` before v1 freeze.
**Rationale:** Undefined semantic — not used in any pipeline step; `systemPrompt` covers all legitimate use cases.

---

## ADR-012: `MemoryAdapter.save()` Accepts `Message[]`

**Decision:** `save(sessionId, messages: Message[])` — batch, not single-message.
**Rationale:** Atomicity — both user and assistant messages saved in one call; partial saves on failure are prevented.

---

## ADR-013: Context and Memory Loading Is Sequential

**Decision:** `ContextProvider.provide()` calls are sequential. Memory loading follows context loading.
**Rationale:** Consistent with constrained execution model; each state machine step = one well-defined operation; parallel execution would complicate the retry path.

---

## ADR-014: Timeout via `AbortSignal` + `Promise.race` Fallback

**Decision:** Kernel attaches `AbortSignal` (from `generateTimeoutMs`) to each `PromptRequest`. `Promise.race` fallback for non-cooperative providers. `totalTimeoutMs` via `Promise.race` at pipeline top level.
**Rationale:** `AbortSignal` enables cooperative cancellation; `Promise.race` is the unconditional hard ceiling for both per-call and total timeouts.

---

## ADR-015: ContextProvider Partial Failure Is Fail-Fast

**Decision:** First provider failure aborts all context loading → `RETRYING` or `FAILED`. Partial results discarded.
**Rationale:** Explicit failure over silent partial context; `context.failed` event gives full visibility. Best-effort: v1.x.x candidate.

---

## ADR-016: Tool Round Counter Is Cumulative

**Decision:** Tool round counter in `pipeline.ts` (local variable) does not reset on retry.
**Rationale:** `maxToolRounds` prevents infinite loops; resetting on retry would allow a misbehaving LLM to bypass the limit.

---

## ADR-017: Streaming and Fallback Are Forbidden Together in v1

**Decision:** `stream: true` + `fallbackProvider` → `ConfigValidationError` at `run()` entry.
**Rationale:** Mid-stream provider failure cannot be transparently recovered — consumer has partial output. v1.x.x candidate with defined contract.

---

## ADR-018: `Message` Discriminated Union

**Decision:** `Message` is a 4-arm discriminated union. `role: 'tool'` requires `toolCallId: string` and `name: string`. `role: 'assistant'` carries optional `toolCalls?: ToolCall[]`.
**Rationale:** "Impossible states must be unrepresentable" — compile-time enforcement of role-specific required fields.

---

## ADR-019: `generateStream?` Returns `Promise<AsyncIterable<StreamChunk>>`

**Decision:** `AIProvider.generateStream?` returns `Promise<AsyncIterable<StreamChunk>>` instead of bare `AsyncIterable<StreamChunk>`.
**Rationale:** Connection errors surface before streaming begins (as `Promise` rejection) rather than being deferred to the first chunk read.

---

## ADR-020: `ToolResult` Discriminated Union

**Decision:** `ToolResult` is a discriminated union — `output` and `error` are mutually exclusive.
**Rationale:** A result is either successful or failed — both fields present simultaneously is an impossible state.

---

## ADR-021: `StreamChunk` Discriminated Union

**Decision:** `StreamChunk` is a discriminated union — each `type` carries exactly its required fields.
**Rationale:** Compile-time field presence guarantees per chunk type; `delta` on `text` chunks is `string`, not `string | undefined`.

---

## ADR-022: `OrchestratorErrorCode` Union Type

**Decision:** All kernel error codes defined as a single exported union `OrchestratorErrorCode` in `interfaces.ts`.
**Rationale:** Consumer exhaustive switch/case; single source of truth; adding a code is MINOR (union widening), removing is MAJOR.

---

## ADR-023: `EventErrorPayload` / `ToolResultError` Semantic Separation

**Decision:** Two structurally identical interfaces kept separate: `EventErrorPayload` (event bus payloads) and `ToolResultError` (`ToolResult.error` DTO).
**Rationale:** Accidental structural convergence — semantics differ; each may diverge independently; merging creates hidden coupling.

---

## ADR-024: `ContextProviderInput = Omit<RunInput, 'stream' | 'profile'>`

**Decision:** `ContextProvider.provide()` receives `ContextProviderInput`, not the full `RunInput`.
**Rationale:** `stream` and `profile` are pipeline-internal routing fields — exposing them to context providers is a leaky abstraction.

---

## ADR-025: `OrchestratorConfig.systemPrompt`

**Decision:** `systemPrompt?: string` added to `OrchestratorConfig` as a global system prompt. Profile `systemPrompt` replaces (does not append) the base value.
**Rationale:** Config-driven initialization principle — common use case should not require a `beforeGenerate` hook.

---

## ADR-026: `totalTimeoutMs` Enforced via `Promise.race` at Pipeline Top Level

**Decision:** `pipeline.ts` wraps the entire execution in `Promise.race([executePipeline(...), timeoutPromise])`.
**Rationale:** `AbortSignal` is cooperative — non-compliant operations ignore it. `Promise.race` is an unconditional hard ceiling regardless of which step is active.

---

## ADR-027: `afterGenerate` in Streaming Mode Fires After `done` Chunk

**Decision:** In streaming mode, `afterGenerate` hook fires after the `done` chunk is received, with accumulated text and usage in `response`.
**Rationale:** `response` must be complete for validation hooks to work correctly. Firing mid-stream would produce a partial and misleading `PromptResponse`.

---

## ADR-028: `OrchestratorError.fatal` Removed

**Decision:** `fatal: boolean` field removed from `OrchestratorError` base class.
**Rationale:** Always `fatal === !retryable` — redundant. `retryable: false` already communicates fatal intent. Removing reduces frozen interface surface.

---

## ADR-029: `transition()` Returns Previous State

**Decision:** `LifecycleStateMachine.transition(to)` returns `LifecycleState` (the previous state) instead of `void`.
**Rationale:** `pipeline.ts` can log `from → to` in a single line without a separate variable. No behavioral change — return value is optional to use.

---

## ADR-030: Internal Layer Architecture

**Decision:** Core package internally structured into 5 layers with strict import direction rules.
**Rationale:** Explicit dependencies prevent circular imports; layer boundaries enable focused code review; L1 primitives are stable building blocks for L2-L4.

| Layer | Files                                               | May Import From                      |
| ----- | --------------------------------------------------- | ------------------------------------ |
| L0    | `interfaces.ts`, `errors.ts`, `types.ts`            | any (contracts define nothing below) |
| L1    | `lifecycle.ts`, `policies.ts`, `prompt-composer.ts` | L0, L1                               |
| L2    | `tool-controller.ts`, `hooks.ts`, `events.ts`       | L0, L1, L2                           |
| L3    | `pipeline.ts`                                       | L0, L1, L2, L3                       |
| L4    | `orchestrator.ts`                                   | L0, L1, L2, L3, L4                   |

**Consequence:** L1 imports from L2 are forbidden. `profile.ts` (L1) may not import from `hooks.ts` (L2).

---

## ADR-031: Spec-Is-Authoritative for State Machine Transitions

**Decision:** `state-machine.md` is the authoritative specification for `VALID_TRANSITIONS`. Implementation must match the spec.
**Rationale:** `PHILOSOPHY.md` Principle 1 — Explicit Over Magical. Specification is the source of truth; implementation drift is a bug.

**Consequence:** When `lifecycle.ts` differs from `state-machine.md`, the implementation is corrected — not the spec.

---

## ADR-032: VALID_TRANSITIONS Self-Loop Excluded

**Decision:** State machine does NOT use self-loops for retry logic.
**Rationale:** Retry continues via `continue` statement in the `GENERATING` loop, returning to `GENERATING` state — not by holding in `RETRYING` and transitioning to itself.

---

## ADR-033: VALID_TRANSITIONS Direct-to-COMPLETING Excluded

**Decision:** The state machine reaches `COMPLETING` only from `GENERATING` after the loop completes (no more work).
**Rationale:** `TOOL_EXECUTING` returns control to `GENERATING` for the next round. `RETRYING` continues back to `GENERATING`. Direct transitions to `COMPLETING` from intermediate states are not used.

---

## ADR-034: Duplicate Normalization Function Allowed

**Decision:** It is NOT a violation for `profile.ts` to define the same normalization logic as `hooks.ts`.
**Rationale:** Duplicate function definitions avoid upward import violations. The cost (minor duplication) is acceptable to preserve layer boundaries. Consolidation to a shared utility requires moving to L0 or L1 — a separate ADR.

---

## ADR-035: `ToolPolicy.toolTimeoutMs` Is a Mirror of `TimeoutPolicy.toolTimeoutMs`

**Decision:** Accept `toolTimeoutMs` as an intentional duplicate across `TimeoutPolicy` and `ToolPolicy`. `TimeoutPolicy.toolTimeoutMs` is the authoritative user-facing configuration input. `ToolPolicy.toolTimeoutMs` is a convenience mirror synchronized by `profile.ts:resolveConfig()` at `run()` entry — it exists so `ToolController` (L2) can read the timeout from its own policy object without importing `TimeoutPolicy`.

**Rationale:** Three factors converge toward this decision:

1. **Frozen contract constraints** (CONSTRAINTS.md lines 65–84): Removing `toolTimeoutMs` from `ToolPolicy` (Option A) is a MAJOR breaking change — forbidden during v1. The field is required, not optional, so removal breaks all existing consumers.

2. **Layer Architecture** (ADR-030): `ToolController` is a Layer 2 module. Reading timeout from its own `ToolPolicy` parameter keeps it self-contained. Making it import `TimeoutPolicy` would cross policy-domain boundaries unnecessarily. The duplication is architecturally justified — analogous to ADR-034 (duplicate normalization functions preserve layer boundaries).

3. **Data integrity**: A synchronization bug in `profile.ts:resolveConfig()` allowed `timeout.toolTimeoutMs` and `toolPolicy.toolTimeoutMs` to diverge when a user overrode only one path. The fix (synchronizing `toolPolicy.toolTimeoutMs = timeout.toolTimeoutMs` after merge) ensures convergence. `TimeoutPolicy` is designated authoritative to align with orchestrator validation (orchestrator.ts lines 90–92) and Principle 1 (Explicit Over Magical).

**Consequence:**
- `interfaces-runtime.md` updated: `toolTimeoutMs` added to `ToolPolicy` declaration with cross-reference comment.
- `interfaces.ts` unchanged structurally; `ToolPolicy.toolTimeoutMs` TSDoc updated to reference `TimeoutPolicy` (no breaking change).
- `profile.ts` changed: one-line synchronization added after toolPolicy merge step.
- No test changes required — existing tests set both fields consistently; the synchronization line only corrects divergent values.
- Classification: NOT a breaking change (patch-level; additive doc change + bug fix).

---

## ADR-036: Empty Tool inputSchema Enforced at Construction Time

**Decision:** Empty `inputSchema: {}` on a `Tool` is rejected at `Orchestrator` construction time with `ConfigValidationError`, not deferred to runtime. The `z.never()` fallback in `ToolController.jsonSchemaToZod()` remains as defense-in-depth.

**Rationale:** Three factors converge toward this decision:

1. **Frozen contract enforcement** (interfaces-core.md line 157): The contract already states `empty {} is FORBIDDEN — see CONSTRAINTS.md`. The implementation was out of alignment — silently accepting `{}` at construction and only catching it at runtime via `z.never()` → `ToolValidationError`. This fix closes the enforcement gap.

2. **Consistency**: All other tool configuration invariants (duplicate names at orchestrator.ts:102–111, `maxToolRounds < 1` at orchestrator.ts:79, `allowParallelTools: true` at orchestrator.ts:74) produce `ConfigValidationError` at construction time. Empty `inputSchema` was the only gap.

3. **Fail-fast security posture**: A tool with an empty schema should be rejected immediately at configuration time, not silently accepted and only surfaced when the tool is first invoked.

**Consequence:**
- `orchestrator.ts` constructor gains ~13 lines: iterate `config.tools`, reject any where `Object.keys(tool.inputSchema).length === 0` with `ConfigValidationError` (inserted after duplicate-names check at lines 102–111, before the throw at lines 113–116).
- `orchestrator.test.ts` gains one test: `'empty tool inputSchema throws ConfigValidationError'` following the pattern at lines 476–491.
- `tool-controller.ts` unchanged — `z.never()` stays as defense-in-depth.
- `testing-standards.md` updated: REQUIRED construction-time ConfigValidationError test + RECOMMENDED runtime z.never() defense-in-depth test added to What MUST Be Tested section.
- Classification: NOT a breaking change (patch-level; closes a documented contract enforcement gap).

---

## ADR-037: `ProviderMalformedResponse` Renamed to `ProviderMalformedResponseError`

**Decision:** Rename `ProviderMalformedResponse` class to `ProviderMalformedResponseError` for consistency with the `PascalCase ending in Error` convention defined in `api-design.md` §Naming Conventions.

**Rationale:** Every other error class in the codebase ends in `Error` (`ProviderRateLimitError`, `ToolExecutionError`, `ConfigValidationError`, etc.). `ProviderMalformedResponse` was the sole exception, breaking the naming contract for error classes. Adapter authors catching errors by type must be able to rely on the convention.

**Consequence:**
- Breaking change — any consumer catching `ProviderMalformedResponse` by type must update to `ProviderMalformedResponseError`.
- All references updated across `packages/core/`, `packages/provider-openai/`, and `packages/provider-anthropic/` (38 locations).
- The 12-char suffix addition is mechanical; no behavioral change.
- Changeset: MAJOR bump for `@atisse/core` (breaking class rename).

---

## ADR-038: `retry.attempted` Event Renamed to `retry.attempted`

**Decision:** Rename the `retry.attempted` event type string to `retry.attempteded` for consistency with the `noun.verb` past tense convention defined in `api-design.md` §Naming Conventions.

**Rationale:** All other event types use past-tense verbs (`run.completed`, `tool.failed`, `fallback.triggered`, `context.loaded`, `profile.resolved`). `retry.attempted` used the bare noun form of the verb. The past tense `attempted` matches the established pattern and is grammatically consistent.

**Consequence:**
- Non-breaking string change — event consumers listening for `retry.attempted` must update their listener registration to `retry.attempteded`.
- Updated in 6 locations: type definition (`interfaces.ts`), emit site (`pipeline.ts` 2×), and test listeners (2 test files).
- No change to the shape of the event payload.
- Changeset: MINOR bump for `@atisse/core` (string literal change, no interface change).
