# Decision Log

Architectural Decision Records (ADR) — append-only history. **Grep for the relevant ADR
number or keyword rather than reading this whole file**; it will only grow. Write protocol:
SPBED flags a candidate -> SPSA evaluates -> user approves -> SPSA writes the entry (see the
`spsa.md` agent profile). If your task conflicts with a recorded decision, that's a Hard
Stop (`AGENTS.md`) — surface it, don't silently override it.

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

---

## ADR-039: Pipeline Internal Architecture — `RoundExecutionStrategy`

**References:** ADR-006, ADR-030, ADR-034; `claude-technical-analysis.md` Finding 1.3; `chatgpt-technical-analysis.md` §2.1–2.2; `_archive/000-superseded-b1-pipeline-decomposition.md`; `M06-B1A-pipeline-generation-engine.md`–`M10-B1E-pipeline-streaming-engine.md`; `M12-B15-round-execution-strategy.md`

**Decision:** Three-part ruling on pipeline internals (no public API change):

1. **Single `RoundExecutionStrategy` interface, two thin implementations.** Streaming and non-streaming round execution share one loop; the strategies supply only the generate-call and chunk-consumption variation. One internal interface, two implementations (`NonStreamingRoundExecutionStrategy`, `StreamingRoundExecutionStrategy`) — internal to `pipeline/`, not exported from `@atisse/core`; `run()` return contracts unchanged (ADR-006).
2. **B1 is executed as five atomic sub-milestones (B1A–B1E), not one mega-refactor.** B1A GenerationEngine, B1B ToolExecutor, B1C RetryEngine, B1D ErrorMapper, B1E StreamingEngine. Each is an atomic commit — independent review and rollback, no behavioral change, no test modification.
3. **B15 is the terminal closure point for the ~250-line duplication finding (Finding 1.2/1.3).** B1/B2/B11 relocate the duplicated round-execution logic; B15 eliminates it by unifying the round loop behind `RoundExecutionStrategy` (part 1). Sequenced after B1A–B1E; may run in parallel with B11.

**Rationale:**

- ADR-006 consistency: a single round loop with a strategy seam embodies "streaming is a mode of `run()`"; two full copies of the loop contradict it.
- Principle 1 (Explicit Over Magical): one visible loop is more traceable than two near-identical loops that can silently diverge.
- Not an ADR-034 case: the round-loop duplication is a DRY violation with a structural fix, not a layer-boundary artifact.
- B1A–B1E avoids the mega-refactor review/rollback risk flagged in the ChatGPT analysis (§2.1).

**Consequence:**

- `_archive/000-superseded-b1-pipeline-decomposition.md` re-organized into B1A–B1E sub-milestones (`M06-B1A`–`M10-B1E`; content preserved).
- New B15 milestone (`M12-B15-round-execution-strategy.md`) added to the v1.1.0 backlog, sequenced after B1A–B1E.
- No changes to `interfaces-core.md` or `interfaces-runtime.md` — strategy types are internal to `pipeline/`.
- Classification: NOT a user-facing breaking change.

---

## ADR-040: Single esbuild Version Enforced via Workspace Override

**Decision:** Pin `esbuild` to a single version across the monorepo by tightening the workspace override in `pnpm-workspace.yaml` from `esbuild: ^0.28.1` to `esbuild: ^0.28.2`, aligning it with the root devDependency (`esbuild: ^0.28.2` in `package.json`, which requires no change). Keep `allowBuilds: esbuild: true` as-is.

**Rationale:** Three factors converge toward this decision:

1. **Security advisories (CVE motivation):** The esbuild dependency graph is exposed to two advisories patched in `0.28.1`:

   - `GHSA-g7r4-m6w7-qqqr` — Windows dev-server path traversal: arbitrary file read when serving from `servedir` via backslash-based traversal. Affected `>=0.27.3 <0.28.1`, patched in `0.28.1`. This is the primary motivation and remains active.
   - `GHSA-gv7w-rqvm-qjhr` — Deno binary integrity: the Deno module downloads its native binary without SHA-256 verification, enabling remote code execution via a compromised `NPM_CONFIG_REGISTRY`. Affected `<=0.28.0`, patched in `0.28.1`. (Advisory subsequently withdrawn upstream on 2026-06-17 because the affected package was misidentified — recorded here for completeness; the decision does not depend on it.)

2. **Single-version enforcement:** `tsup@8.5.1` declares `esbuild: ^0.27.0`, which does NOT intersect the 0.28.x range. Without the override, pnpm hoists `0.28.2` at the root and additionally installs a nested vulnerable `0.27.7` under `tsup` — two esbuild versions, one of them still affected. `vite@8.2.1` declares peer `^0.27.0 || ^0.28.0` and `bundle-require@5.1.0` declares peer `>=0.18`, so both accept the overridden single version. The override forces every consumer onto the patched `0.28.x` line.

3. **`allowBuilds` is required, not optional:** pnpm 11 blocks dependency build scripts by default. esbuild ships `postinstall: node install.js` to fetch and verify its platform-specific native binary; without `allowBuilds: esbuild: true` the binary is never installed and esbuild fails at runtime.

**Consequence:**

- `pnpm-workspace.yaml` — `overrides.esbuild` tightened from `^0.28.1` to `^0.28.2` (single line).
- `package.json` — unchanged (`esbuild: ^0.28.2` already declared).
- `pnpm-lock.yaml` — regenerated via `pnpm install --lockfile-only`; lockfile now records `overrides.esbuild: ^0.28.2` and propagates the specifier to the peer-dependency metadata of `bundle-require@5.1.0` and `vite@8.2.1`; exactly one `esbuild@0.28.2` resolution (packages entry + snapshot), no version churn.
- Verification: `pnpm why esbuild` reports exactly one version (`0.28.2`); `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass.
- Classification: NOT a breaking change (config-only; dependency resolution tightened to a single patched version).

---

## ADR-041: Redis MEMORY adapter WATCH/MULTI/EXEC isolation via RedisClientPool (`node-redis` v6)

**Status:** Proposed (SPSA draft — awaiting user review)

**Decision:** Replace the read-modify-write pattern in `RedisMemoryAdapter.save()` with `WATCH`/`MULTI`/`EXEC` optimistic locking using `RedisClientPool.execute()` (not the v4-era `client.executeIsolated()`), and handle `Exec` failure by catching `WatchError` (not checking `result === null`), classifying a retry signal as `false` / non-retryable and any other transaction error as `MemorySaveError`.

**Context:**

The `P01-A1A2-redis-atomic-writes.md` plan (§4.1, §6) and its remediation in `claude-technical-analysis.md` §1.1 both prescribe `client.executeIsolated(async (isolatedClient) => { ... })` as the mechanism for isolating the `WATCH`/`MULTI`/`EXEC` sequence on a dedicated connection. Neither document accounts for the installed version. The installed packages are `redis@6.2.1` and `@redis/client@6.2.1`:

| v4 API (plan assumes)                                 | v6 reality (verified)                                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RedisClientType.executeIsolated(fn)`                 | **Does not exist.** Zero references in `@redis/client@6.2.1` dist (grep: 0 matches).                                                                                      |
| `client.multi().exec()` returns `null` on WATCH abort | `_executeMulti` (`@redis/client@6.2.1` `lib/client/index.js:1318–1320`) throws `new errors_1.WatchError()` when `execResult === null`. Returns non-null array on success. |
| `import { WatchError } from 'redis'` (v4 path)        | Same import works — `redis@6.2.1` does `export * from '@redis/client'`; `WatchError` is defined in `@redis/client/dist/lib/errors.js:10` and re-exported.                 |

The `node-redis` v4→v5 migration guide states: _"In v4, RedisClient had the ability to create a pool of connections using an 'Isolation Pool'... In v5 we've extracted this pool logic into its own class—RedisClientPool."_ The v6 README repeats this. In v6, the equivalent of v4's `executeIsolated()` is:

```typescript
import { createClientPool } from 'redis'; // or '@redis/client'

const pool = createClientPool({ url: config.url });
await pool.execute(async (isolatedClient) => {
  // WATCH + MULTI/EXEC on a dedicated connection from the pool
});
```

`RedisClientPool.execute(fn)` (`@redis/client@6.2.1` `lib/client/pool.js:265`) acquires a dedicated `RedisClientType` from the pool, runs `fn` on it, and returns it via `#returnClient()` (`pool.js:313`) — guaranteeing that no other `save()` call can interleave commands on the same underlying connection.

`RedisClientPool.MULTI()` (`pool.js:349`) creates a `Multi` command bound to `this.execute(client => client._executeMulti(...))` — meaning `multi().exec()` on a pool-acquired client correctly routes through the pool, maintaining isolation for the entire transaction.

**A2 relationship:** Phase 2 of P01-A1A2 (error type fix — `ContextLoadError` → `MemorySaveError` in `save()`/`clear()`) is an independent concern touching the same `save()` method. The new transaction pattern rewrites the catch block entirely, so the `MemorySaveError` import and throw naturally land in the same diff. `load()` remains unchanged on `ContextLoadError`.

**Consequence:**

- **`packages/memory-redis/src/index.ts`**: Replace `createClient()` with `createClientPool()` in the URL-config constructor branch. The `save()` method wraps the WATCH/MULTI/EXEC sequence in `pool.execute(async (isolatedClient) => { ... })`. The retry loop (max 3 attempts, no delay) stays at the `save()` level. On success, `exec()` resolves without throwing. On WATCH-abort, `_executeMulti` throws `WatchError` — the `pool.execute` callback catches it, returns `false` (retry signal), and the outer loop retries. Any non-`WatchError` exception propagates to `save()`'s catch, which throws `MemorySaveError`.
- **Error classification**: `WatchError` → `false` (retry signal, not an error to propagate). Non-WatchError exceptions → `MemorySaveError` (`retryable = false`, code `MEMORY_SAVE_FAILED`, per `packages/core/src/errors.ts:173` and ADR-007). This correctly classifies a failed save as non-retryable, aligning with ADR-007's taxonomy. The revised plan (§4.1) no longer uses a `result !== null` check — it catches `WatchError` inside the `pool.execute()` callback and translates it to a retry signal, since `_executeMulti` throws `WatchError` rather than returning `null` under v6.
- **Test mocks**: `MockProvider` doesn't cover `MemoryAdapter` — tests for `memory-redis` need a Redis mock that stubs `createClientPool`, `RedisClientPool.prototype.execute`, and inside the callback `isolatedClient.watch`, `isolatedClient.get`, `isolatedClient.multi().setEx().exec()`. The `WatchError` throw path and the `unwatch().catch(() => {})` defensive path both need explicit test coverage.
- **Cross-package consistency**: Any future `memory-redis` or `memory-*` adapter implementing WATCH/MULTI/EXEC must use the same `RedisClientPool.execute()` pattern. This is an implicit adapter-level convention (not an `interfaces.ts` change — the `MemoryAdapter` interface is unchanged).
- **ADR compatibility**: Complies with ADR-007 (retryable classification — WatchError retry is a signal, not an `OrchestratorError`; actual save failures throw `MemorySaveError` with `retryable = false`). Complies with ADR-012 (`save()` still accepts `Message[]`). Complies with ADR-004 (no dependency on hooks/events ordering — transaction logic is entirely within the adapter).
- **No ADR needed for MemoryAdapter interface**: The `MemoryAdapter.save(sessionId, messages: Message[]): Promise<void>` signature is unchanged. This is an internal implementation improvement.

**Alternatives considered:**

- **A) `WATCH`/`MULTI`/`EXEC` on the shared `RedisClientType`** (i.e., `this.client.watch(key)` directly, without a pool) — **Rejected: the server-side optimistic lock is silently defeated.**

  Redis tracks `WATCH` state **per-connection** (server-side). A shared `RedisClientType` multiplexes all commands over a single TCP socket. When Call A and Call B both call `watch(key)` on the same connection, the server's watch state is shared. The critical defect is not in client-side private fields — it is in the **server-side WATCH reset semantics**:

  Per Redis docs, a successful `EXEC` (or `DISCARD`) on a connection **resets all WATCH state** on that connection. The interleaving is:

  1. Call A: `WATCH key` → server starts watching on connection C.
  2. Call A: `GET key` → reads `[m1]` (outside MULTI). Call A yields (async/await).
  3. Call B: `WATCH key` on connection C → server re-watches (no-op, already watching).
  4. Call B: `GET key` → reads `[m1]`.
  5. Call B: `MULTI SETEX [m1, mb] EXEC` → server executes, key is now `[m1, mb]`. Server **resets WATCH state on connection C** (successful EXEC clears watch).
  6. Call A resumes: `MULTI SETEX [m1, ma] EXEC` → server checks: is the watched key modified? But WATCH was **already reset** by Call B's EXEC in step 5. Server sees no active watch → EXEC succeeds → writes `[m1, ma]`, **silently overwriting Call B's `[m1, mb]`**.

  The data-loss race the transaction was meant to prevent is **reproduced**. `RedisClientPool.execute()` eliminates this by giving each `save()` a **dedicated connection** from the pool, so Call A's EXEC cannot be corrupted by Call B's EXEC on a different connection.

  Client-side state (`#watchEpoch`, `#dirtyWatch` — `index.js:263–264`) provides secondary protection (detecting reconnection/dirty events within a single connection), but cannot prevent the server-side WATCH-reset that is the primary failure mode.

- **B) Lua script via `EVALSHA`/`SCRIPT LOAD`** — Rejected. P01 §4.3 explicitly states "Do NOT introduce a Lua script." Additionally, a Lua script encoding the read-modify-write-append logic in Redis would be more efficient but introduces operational complexity: script deployment, SHA management, version tracking — none of which justify the marginal performance gain for append-only conversation history at typical `@atisse/core` throughput.

- **C) Redis distributed lock (`SET key lock NX EX 10` + unlock via Lua)** — Rejected. node-redis v6 provides native `WATCH`/`MULTI`/`EXEC` optimistic locking, which is lighter-weight (no lock acquisition TTL to tune, no lock-release edge cases) and semantically precise (the lock only covers the exact key being modified). Redlock/`SETNX` lock patterns add contention overhead and failure modes (lock expiry mid-transaction, unlock race conditions) that are unnecessary when Redis transactions suffice.

**References:**

- `DECISION-LOG.md` — ADR-004 (hooks serial / events fire-and-forget; concurrent-safety referenced in P01 §1.1), ADR-007 (error taxonomy with `retryable` classification), ADR-012 (`MemoryAdapter.save()` accepts `Message[]`)
- `packages/core/src/errors.ts:173` — `MemorySaveError` (`retryable = false`, code `MEMORY_SAVE_FAILED`)
- `packages/core/src/errors.ts:138` — `ContextLoadError` (`retryable = true`, code `CONTEXT_LOAD_FAILED`)
- `packages/core/src/interfaces.ts:164–168` — `MemoryAdapter` interface (unchanged by this ADR)
- `packages/memory-redis/src/index.ts` — `save()` (lines 45–55), `clear()` (lines 57–65), `load()` (lines 33–43)
- `packages/memory-redis/package.json` — peer dep: `"redis": "^6.0.0"` (compatible)
- `.opencode/milestones/v1/v1.0.2/P01-A1A2-redis-atomic-writes.md` §4.1 (proposed `executeIsolated` usage — v4 API, not available in v6), §6 (step references), §8 (risk table — risk (A1) line 337 confirms pool need)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/claude-technical-analysis.md` §1.1 (remediation prescribes `executeIsolated` — v4 API; references issues #2613, #559)
- `@redis/client@6.2.1` `lib/client/index.js:1287–1332` — `_executeMulti` implementation; line 1318–1319 confirms `execResult === null` → `throw new WatchError()`
- `@redis/client@6.2.1` `lib/client/index.js:263–264` — `#dirtyWatch`, `#watchEpoch` private fields
- `@redis/client@6.2.1` `lib/client/index.js:1198–1212` — `WATCH` sets `#watchEpoch`, `UNWATCH` clears it
- `@redis/client@6.2.1` `lib/client/index.js:358–378` — `socketEpoch`, `isWatching`, `isDirtyWatch`, `setDirtyWatch`
- `@redis/client@6.2.1` `lib/client/pool.js:265–312` — `RedisClientPool.execute(fn)` acquires/releases dedicated client
- `@redis/client@6.2.1` `lib/client/pool.js:349–352` — `RedisClientPool.MULTI()` routes through `execute`
- `@redis/client@6.2.1` `lib/client/pool.d.ts:138` — `execute<T>(fn: PoolTask<...>): Promise<Awaited<T>>`
- `@redis/client@6.2.1` `lib/errors.js:10–15` — `WatchError` class definition
- `@redis/client@6.2.1` `dist/index.d.ts:11–13` — `RedisClientPool`, `createClientPool` exports
- `node_modules/.pnpm/redis@6.2.1/.../redis/dist/index.d.ts` — re-exports via `export * from '@redis/client'`
