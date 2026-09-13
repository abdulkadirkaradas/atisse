# B1C — RetryEngine (Pipeline Decomposition, Part 3 of 5)

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap (ADR-039)

> **Sequence (ADR-039):** B1A → B1B → B1C → B1D → B1E, then B15. Each sub-milestone is an **atomic commit** — independent review and rollback, **no behavioral change, no test modification**. The build must stay green at every commit.

---

## 1. Task Summary

> **Precondition: M06-B1A + M07-B1B merged, pipeline/{index.ts,shared.ts,generation-engine.ts,non-streaming.ts,tool-executor.ts} exists, pnpm typecheck && pnpm build green. All pipeline.ts:XXX refs are post-B1A/B1B — re-verify after B1B hash 491b1fd. B1C extracts from pipeline/non-streaming.ts + pipeline/streaming.ts (future) not from monolithic pipeline.ts:1547.**
> Note that repo currently has no pipeline/ directory (only doc commits), so plan must not assume monolith. Pre-B1A monolith was 1547 lines — post-B1A/B1B the source is the pipeline/ directory shell.

Extract the **RetryEngine** — retry handling and backoff — from `packages/core/src/pipeline/non-streaming.ts` (post-B1B shell) + future `pipeline/streaming.ts` (streaming retry at `pipeline.ts:1134-1180` pre-B1A, now deferred to streaming.ts) into `packages/core/src/pipeline/retry-engine.ts`:

1. Move the retry loop (Step 7 `RETRYING`) — exponential backoff + jitter delay — into `retry-engine.ts`, covering **both loops**: (a) non-streaming `executeWithRetry:826-851` `onRetry` path and (b) streaming manual `while` `1134-1180` (`isRetryable` + `calculateDelay:1174` + `retry.attempted`).
2. Timeout management stays outside RetryEngine: generateTimeoutMs AbortSignal remains in shared.ts:buildPromptRequest:67-85; totalTimeoutMs hard ceiling remains as withTimeout(Promise.race) at pipeline/index.ts:executePipeline:1536-1539 per ADR-014/026. RetryEngine only handles backoff delay (calculateDelay + abortableSleep) and RETRYING transitions.
3. Preserve `retry.attempted` event emission and the retryable/fatal classification transitions (`goto RETRYING` / `goto FAILED`) via `RetryEngine.handleGenerationError` handoff (see §4.1 C4).
4. Wire `non-streaming.ts` and `generation-engine.ts` (B1A) plus future `streaming.ts` (B1E) to call the RetryEngine helpers (`executeWithRetry` wrapper + `shouldRetry(err)` + `getBackoffDelay(attempt, policy, err)`).
5. Public API unchanged — no consumer-visible changes. Classification: internal refactor, no `interfaces.ts` change → `changeset: patch` or `none` (see §5b).

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` was 1547 lines pre-B1A — 3.4× larger than the next largest file (`interfaces.ts` at 458 lines). Post-B1A/B1B the monolith is split into `pipeline/` (`index.ts`, `shared.ts`, `generation-engine.ts`, `non-streaming.ts`, `tool-executor.ts`). Retry handling and backoff are among the six distinct orchestration concerns embedded in that single file (Generation, Streaming, Retry, Fallback, Tool, Error — see `chatgpt-technical-analysis.md` §2.1). This violates **Principle 7 (Small Core, Large Ecosystem)**.

Key behavioral facts that must be preserved:

- Retry classification follows `error-taxonomy.md`: retryable `ProviderError` → `RETRYING` with exponential backoff + jitter; fatal `ProviderError` → `FAILED`; `MaxRetriesExceeded` + fallback exists → `FALLBACKING` (the fallback swap action itself is owned by the GenerationEngine — B1A — which handles Step 8; RetryEngine only signals the decision).
- `retry.attempted` is emitted before each backoff delay (non-streaming `:835`, streaming `:1175`).
- `generateTimeoutMs` attaches an `AbortSignal` to each `PromptRequest` via `shared.ts:buildPromptRequest:67-85`; `totalTimeoutMs` is a hard ceiling enforced via `withTimeout(Promise.race([executePipeline(...), totalTimeoutTimer]))` at `pipeline/index.ts:executePipeline:1536-1539` regardless of which step is active (ADR-014/026) — **not owned by RetryEngine**.
- Retry policy comes from `policies.ts` (`RetryPolicy`: `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `jitter`, `jitterFactor` — ADR-007 + M02-B8). `jitterFactor` defaults to `0.3` via `DEFAULT_RETRY:7-12` and `calculateDelay:85-86` uses `policy.jitterFactor ?? 0.3`.
- Two retry call-sites exist and must stay in sync until B15 closure: non-streaming `executeWithRetry:826-851` and streaming manual `while 1134-1180`.

---

## 3. Issues/Changes

### Issue B1C-1: RetryEngine embedded in a God Module

| Field       | Value                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline/non-streaming.ts` (post-B1B shell; pre-B1A `packages/core/src/pipeline.ts` 1–1547 monolith, retry Step 7 + streaming 1134-1180)     |
| Lines       | retry 656-705,826-851,1134-1180, timeout 67-85 + 1536-1539 (pre-B1A refs; re-verify post-B1A/B1B in pipeline/non-streaming.ts and future pipeline/streaming.ts) |
| Severity    | HIGH                                                                                                                                                            |
| Description | Retry loop, backoff, jitter, and retryable/fatal classification are embedded in non-streaming shell and streaming path; timeout scoping was ambiguous.          |
| Fix         | Extract into `pipeline/retry-engine.ts`. Pure restructuring — no behavioral change. Timeout stays outside (shared.ts + index.ts).                               |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

- **Precondition: M06-B1A + M07-B1B merged, pipeline/{index.ts,shared.ts,generation-engine.ts,non-streaming.ts,tool-executor.ts} exists, pnpm typecheck && pnpm build green. All pipeline.ts:XXX refs are post-B1A/B1B — re-verify after B1B hash 491b1fd. B1C extracts from pipeline/non-streaming.ts + pipeline/streaming.ts (future) not from monolithic pipeline.ts:1547.** Repo currently has no pipeline/ directory (only doc commits) — do not assume monolith file exists at implementation time; verify skeleton first.

- Create `packages/core/src/pipeline/retry-engine.ts` hosting the `RetryEngine` module (pure functions + optional class wrapper; no module-level state per Principle 4).

- **Dual retry loops (C3):** Expand to cover both loops:
  - (a) **Non-streaming** `executeWithRetry:826-851` `onRetry` path — delegates `calculateDelay` at `:831` and `isRetryable` classification; emits `retry.attempted` before `abortableSleep`.
  - (b) **Streaming** manual `while 1134-1180` — `isRetryable` check + `calculateDelay:1174` + `retry.attempted` emit + `retry.attempted` counter `retry.attempted` at streaming path.
  - Expose helpers from RetryEngine: `executeWithRetry` wrapper (non-streaming) + `shouldRetry(err)` (thin alias over `errors.ts:isRetryable`) + `getBackoffDelay(attempt, policy, err)` (delegates to `policies.ts:85-86 calculateDelay` with `policy.jitterFactor ?? 0.3`). Streaming loop calls `shouldRetry` + `getBackoffDelay`; non-streaming loop may call the wrapper. Until B15 both call-sites must be kept manually in sync — document sync obligation in PR description.

- **Timeout ownership (C2):** Timeout management stays outside RetryEngine: generateTimeoutMs AbortSignal remains in shared.ts:buildPromptRequest:67-85; totalTimeoutMs hard ceiling remains as withTimeout(Promise.race) at pipeline/index.ts:executePipeline:1536-1539 per ADR-014/026. RetryEngine only handles backoff delay (calculateDelay + abortableSleep) and RETRYING transitions. Do NOT move totalTimeoutMs Promise.race or buildPromptRequest AbortSignal into retry-engine.ts (ADR-014/026).

- **Fallback handoff contract (C4):** Define handoff: `RetryEngine.handleGenerationError(err, attempt) → discriminated union {action:'retry', delayMs} | {action:'fallback', error: MaxRetriesExceededError} | {action:'fail', error}`. Caller (non-streaming shell) routes to GenerationEngine for FALLBACKING swap. Explicitly state: "RetryEngine never imports or calls generation-engine.ts — no L3↔L3 circular; fallback swap stays in GenerationEngine." The `MaxRetriesExceededError:187` → `FALLBACKING` vs `FAILED` distinction is executed by GenerationEngine, not RetryEngine.

- **jitterFactor stale (C5):** RetryEngine delegates to policies.ts:85-86 calculateDelay with `policy.jitterFactor ?? 0.3` (M02-B8), DEFAULT_RETRY:7-12 includes jitterFactor:0.3, use ?? not || and respect isFinite guard. Replace hardcoded "baseDelayMs * 2^attempt + 0.3*capped" with the delegated call. Do NOT duplicate calculateDelay/isRetryable — import from policies.ts/errors.ts, respect jitterFactor via ?? .

- **Counter ownership (M1):** Three counters: providerAttempt:819 (non-streaming executeWithRetry inside calculateDelay:831), toolAttempt:955/771 (tool retry backoff:768,1310), roundCounter:954,980,1427 (ADR-016 cumulative, owned by ToolExecutor per M07-B1B). B1B took roundCounter, B1C owns providerAttempt + toolAttempt. RetryEngine owns `providerAttempt` (generate retry) + `toolAttempt` (ToolExecutionError retry) backoff increments; ToolExecutor owns `roundCounter` cumulative check vs `maxToolRounds`. No overlap — verify at review.

- **AbortSignal dual enforcement clarification (M3):** generateTimeoutMs uses AbortSignal.timeout:72-78 in shared.ts + streaming asyncIteratorWithIdleTimeout:108-144 per-chunk TimeoutExceededError; RetryEngine only wraps abortableSleep, does not create signals. Promise.race fallback for non-cooperative providers is not in RetryEngine — it remains at pipeline/index.ts totalTimeoutMs and generation-engine shared.ts signal layer.

- Event emission preserved: `retry.attempted` before each backoff (non-streaming `:835`, streaming `:1175`) with payload `{attempt, reason, delayMs}` per `interfaces.ts:441` and `observability` skill (`logger.warn('Retrying', {attempt, reason, delayMs}) at pipeline.ts:835,1175 S-1 compliant` — no secrets).

- Transition decisions preserved: retryable → `RETRYING`, fatal → `FAILED`, `MaxRetriesExceeded` + fallback → `FALLBACKING` (fallback action executed by GenerationEngine — B1A; RetryEngine returns `fallback` action).

- Retry policy consumed from `policies.ts` (`RetryPolicy`) — no changes to policy types or merge utilities. Respect `jitterFactor` via `??` and `isFinite` guard (M02-B8).

- All state remains local per call (Principle 4 — Stateless Core). No module-level state.

- Follow function body max 40 lines (per `code-standards/SKILL.md` / `implementation-standards.md`). Note `executeWithRetry` in `policies.ts:184-229` is 45 lines over the 40-line limit — wrapper in `retry-engine.ts` will need splitting into helpers (e.g., `computeDelay`, `sleepWithAbort`, `emitRetryAttempted`) to meet limit. Decompose further if exceeded.

- Layering: `retry-engine.ts` imports only L0–L1 (`interfaces`, `errors`, `types`, `lifecycle`, `policies`, `observability/logger`); never imports `generation-engine.ts` or `tool-executor.ts` (L3↔L3 circular forbidden per ADR-030). Verify via `madge --circular`.

### 4.2 What NOT to Do

- Do NOT change the public exports of `pipeline.ts` (now `pipeline/index.ts`). `executePipeline()` must remain the single exported function with the same signature.
- Do NOT modify `packages/core/src/interfaces.ts`, `types.ts`, `policies.ts`, or any other contract file.
- Do NOT move totalTimeoutMs Promise.race or buildPromptRequest AbortSignal into retry-engine.ts (ADR-014/026).
- Do NOT duplicate calculateDelay/isRetryable — import from policies.ts/errors.ts, respect jitterFactor via ?? .
- Do NOT change retry semantics: backoff algorithm, jitter, `maxAttempts`, retryable/fatal classification — delegate to existing helpers; `jitterFactor:0/0.5/1 + jitter:false` ignore paths (M02-B8) must remain via `calculateDelay`.
- Do NOT introduce new runtime dependencies.
- Do NOT change behavioral logic — pure restructuring only.
- Do NOT create `.md` documentation files.
- Do NOT introduce module-level state or singletons in the new files.
- RetryEngine never imports or calls generation-engine.ts — no L3↔L3 circular; fallback swap stays in GenerationEngine.
- Do NOT hardcode `0.3` jitter — use `policy.jitterFactor ?? 0.3` with `isFinite` guard.
- Do NOT move `roundCounter` — owned by ToolExecutor per M07-B1B (ADR-016 cumulative).

---

## 5. Files to Modify

| File                                              | Action    | Notes                                                                                                                                                                                                                                                                             |
| ------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline/retry-engine.ts`      | NEW       | `RetryEngine` module — retry loop helpers: `executeWithRetry` wrapper + `shouldRetry` + `getBackoffDelay` + `handleGenerationError` handoff; delegates to `policies.ts:85-86 calculateDelay` (`jitterFactor ?? 0.3`) + `errors.ts:isRetryable`; `abortableSleep` only, no signals |
| `packages/core/src/pipeline/non-streaming.ts`     | MODIFY    | Replace `executeWithRetry:826-851` inline + `providerAttempt:819` / `toolAttempt:955,771` with `RetryEngine` calls; route `handleGenerationError` fallback action to `GenerationEngine`; keep until B15 streaming `1134-1180` sync manually                                       |
| `packages/core/src/pipeline/generation-engine.ts` | MODIFY    | Use `RetryEngine` for backoff/`retry.attempted` where generation path retries; keep fallback swap (Step 8) in the engine — `RetryEngine` never imports generation-engine.ts                                                                                                       |
| `packages/core/src/pipeline/shared.ts`            | NO CHANGE | `buildPromptRequest:67-85` AbortSignal stays here — not moved to retry-engine.ts (ADR-014/026)                                                                                                                                                                                    |
| `packages/core/src/pipeline/index.ts`             | NO CHANGE | `totalTimeoutMs` `withTimeout(Promise.race)` at `1536-1539` stays here — not moved to retry-engine.ts (ADR-014/026)                                                                                                                                                               |
| `packages/core/src/pipeline.ts`                   | —         | Legacy monolith reference — post-B1A/B1B paths are `pipeline/non-streaming.ts` + future `pipeline/streaming.ts` (not stale `pipeline.ts:1547`)                                                                                                                                    |

### 5b. Changeset / Versioning Classification

Classification: internal refactor, no interfaces.ts change → changeset: patch or none per api-design, api-extractor diff empty, ADR-039 NOT breaking, changeset patch|none. No public type or runtime export changes. Verify with `pnpm changeset` (no changeset required if `none`, or `patch` if repo policy requires one for internal refactors) and `pnpm build && api-extractor` diff empty (no public API change).

---

## 6. Implementation Strategy

### Step 1: Create `retry-engine.ts` — Precondition: M06-B1A + M07-B1B merged, pipeline/{index.ts,shared.ts,generation-engine.ts,non-streaming.ts,tool-executor.ts} exists, pnpm typecheck && pnpm build green. All pipeline.ts:XXX refs are post-B1A/B1B — re-verify after B1B hash 491b1fd. B1C extracts from pipeline/non-streaming.ts + pipeline/streaming.ts (future) not from monolithic pipeline.ts:1547.

- Create `packages/core/src/pipeline/retry-engine.ts`.
- Move retry helpers for **both loops** (non-streaming `executeWithRetry:826-851` `onRetry` at `:831` + streaming manual `while 1134-1180` `isRetryable` + `calculateDelay:1174` + `retry.attempted`) into it, preserving exact behavior. Expose `executeWithRetry` wrapper + `shouldRetry(err)` + `getBackoffDelay(attempt, policy, err)` for streaming loop. Until B15 both call-sites must be kept manually in sync.
- Delegate jitter/backoff to `policies.ts:85-86 calculateDelay` with `policy.jitterFactor ?? 0.3` (M02-B8), `DEFAULT_RETRY:7-12` includes `jitterFactor:0.3`, use `??` not `||` and respect `isFinite` guard — do not duplicate `calculateDelay`/`isRetryable`.
- **Do NOT move** `generateTimeoutMs` `AbortSignal` (`shared.ts:buildPromptRequest:67-85`) or `totalTimeoutMs` `withTimeout(Promise.race)` at `pipeline/index.ts:executePipeline:1536-1539` (ADR-014/026). RetryEngine only wraps `abortableSleep` for backoff delay.
- Own `providerAttempt:819` (non-streaming executeWithRetry inside calculateDelay:831) + `toolAttempt:955/771` (tool retry backoff:768,1310); `roundCounter:954,980,1427` (ADR-016 cumulative) stays in ToolExecutor per M07-B1B — no overlap.
- Keep `AbortSignal` dual enforcement outside: `generateTimeoutMs` via `AbortSignal.timeout:72-78` + streaming `asyncIteratorWithIdleTimeout:108-144`; `Promise.race` fallback for non-cooperative providers is not in RetryEngine.
- Note `policies.ts:184-229` `executeWithRetry` is 45 lines — wrapper in `retry-engine.ts` must be split into sub-helpers (`computeDelay`, `sleepWithAbort`, `emitRetryAttempted`) to meet 40-line `code-standards` limit.

### Step 2: Wire Non-Streaming + Generation Paths (Dual Loops + Fallback Handoff)

- In `non-streaming.ts` / `generation-engine.ts` (and future `streaming.ts` at B1E), replace inline retry logic with calls to the `RetryEngine` (`executeWithRetry` wrapper for non-streaming; `shouldRetry` + `getBackoffDelay` for streaming `1134-1180`).
- Define handoff: `RetryEngine.handleGenerationError(err, attempt) → discriminated union {action:'retry', delayMs} | {action:'fallback', error: MaxRetriesExceededError} | {action:'fail', error}`. Caller (non-streaming shell) routes `fallback` to GenerationEngine for `FALLBACKING` swap; `fail` → `FAILED`. Explicitly: "RetryEngine never imports or calls generation-engine.ts — no L3↔L3 circular; fallback swap stays in GenerationEngine."
- Verify `retry.attempted` emission points are preserved exactly (`:835` non-streaming, `:1175` streaming) with payload shape per `interfaces.ts:441` (`{attempt, reason, delayMs}`) and `logger.warn('Retrying', {attempt, reason, delayMs})` observability S-1 compliant.
- Until B15 both loops must be kept manually in sync — document in PR description.

### Step 3: Update Imports

- Update all import paths to reference the correct `.js` modules (ESM NodeNext). `retry-engine.ts` imports `policies.ts` (`calculateDelay`, `withTimeout` re-export reference but not `totalTimeoutMs` race) + `errors.ts` (`isRetryable`, `MaxRetriesExceededError:187`) + `interfaces.ts` event types.
- Do NOT create `retry-engine.ts → generation-engine.ts` import; fallback stays in GenerationEngine (circular check via `madge`).

### Step 4: Verify (No Test Modification)

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage && pnpm build`.
- ALL tests must pass WITHOUT modification. This is a pure refactor — no behavioral change.
- Expanded checks: `madge --circular packages/core/src/pipeline/retry-engine.ts` no circular (as B1B had); `pnpm build && api-extractor` diff empty; changeset `patch|none`.

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
madge --circular packages/core/src/pipeline/retry-engine.ts
pnpm changeset
api-extractor diff
```

Specific assertions to verify (expanded per M4):

- `packages/core/src/pipeline/retry-engine.ts` exists and hosts the retry helpers (`executeWithRetry` wrapper + `shouldRetry` + `getBackoffDelay` + `handleGenerationError`); both loops covered — non-streaming `executeWithRetry:826-851` onRetry path and streaming manual `while 1134-1180` (`isRetryable` + `calculateDelay:1174` + `retry.attempted`).
- Retry behavior identical: backoff + jitter via `policies.ts:85-86 calculateDelay` with `policy.jitterFactor ?? 0.3` (M02-B8), `maxAttempts` enforcement, retryable → `RETRYING` / fatal → `FAILED` (verified with fake timers per `testing` skill).
  - **MockProvider rate-limit → retry → success:** `MockProvider` enqueue `{error: ProviderRateLimitError}` → `{error: RateLimit}` → `{text:'ok'}` with `vi.useFakeTimers()` + `await vi.runAllTimersAsync()` → `wasCalledTimes(3)`, `retry.attempted` payload `{attempt, reason, delayMs}` shape per `interfaces.ts:441`.
  - **ProviderAuthError (non-retryable) → `wasCalledTimes(1)`, no `RETRYING`.
  - `jitterFactor:0/0.5/1 + jitter:false` ignore paths (M02-B8) — verify `calculateDelay` delegation respects `??` and `isFinite` guard.
  - `MaxRetriesExceededError:187` → `FALLBACKING` vs `FAILED` distinction via GenerationEngine (RetryEngine returns discriminated union; GenerationEngine executes swap).
- `retry.attempted` emitted before each backoff delay, with identical payload shape (`interfaces.ts:441`); `logger.warn('Retrying', {attempt, reason, delayMs}) at pipeline.ts:835,1175 S-1 compliant`.
- `generateTimeoutMs` AbortSignal (`shared.ts:67-85`) and `totalTimeoutMs` hard ceiling (`withTimeout(Promise.race)` at `pipeline/index.ts:1536-1539` per ADR-014/026 + `policies.ts:withTimeout`) behave identically — **not owned by RetryEngine**, no move.
- `executePipeline()` has the exact same function signature as before; no new public exports; `api-extractor` diff empty.
- `madge --circular packages/core/src/pipeline/retry-engine.ts` — no circular in `pipeline/` (RetryEngine never imports generation-engine.ts; fallback stays in GenerationEngine).
- `pnpm build && pnpm changeset` — changeset `patch|none` (internal refactor, no `interfaces.ts` change; ADR-039 NOT breaking).
- Three counters verified: `providerAttempt:819` + `toolAttempt:955/771` owned by RetryEngine; `roundCounter:954,980,1427` (ADR-016 cumulative) owned by ToolExecutor per M07-B1B — no overlap.
- `code-standards` 40-line limit met: split wrapper (`computeDelay`, `sleepWithAbort`, `emitRetryAttempted`) — `policies.ts:184-229` (45 lines) over limit noted.
- All tests pass without modification.

---

## 8. Risk Assessment

| Risk                                                     | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backoff/timing regression during extraction              | Medium     | Medium | Fake-timer retry tests pass without modification; algorithm preserved via delegation to `policies.ts:85-86 calculateDelay` with `jitterFactor ?? 0.3` (M02-B8); `isFinite` guard respected.                                                                                                                 |
| `totalTimeoutMs` ceiling accidentally scoped to a module | Low        | High   | Timeout management stays outside RetryEngine: `generateTimeoutMs` AbortSignal remains in `shared.ts:67-85`; `totalTimeoutMs` hard ceiling remains as `withTimeout(Promise.race)` at `pipeline/index.ts:1536-1539` per ADR-014/026; RetryEngine only handles `abortableSleep` — no `Promise.race` move (C2). |
| `retry.attempted` emission point moved                   | Low        | Medium | Preserve emit sites at `:835` + `:1175`; event payload shape per `interfaces.ts:441` unchanged; `logger.warn` observability check.                                                                                                                                                                          |
| Fallback handoff (B1A) mis-wired                         | Low        | Medium | RetryEngine reports `MaxRetriesExceededError:187` via `handleGenerationError` discriminated union `{retry                                                                                                                                                                                                   | fallback | fail}`; GenerationEngine executes the fallback swap (Step 8); no L3↔L3 import. |
| Dual-loop sync until B15                                 | Medium     | Medium | Both `non-streaming.ts` `826-851` and `streaming.ts` `1134-1180` call-sites must be kept manually in sync until B15 closure; PR description documents sync obligation.                                                                                                                                      |
| `jitterFactor` regression (hardcoded 0.3)                | Low        | Medium | Delegate to `policies.ts:85-86 calculateDelay` with `policy.jitterFactor ?? 0.3` (not `                                                                                                                                                                                                                     |          | `), `DEFAULT_RETRY:7-12`includes`jitterFactor:0.3`, `isFinite` guard.          |
| 40-line violation in wrapper                             | Medium     | Low    | `policies.ts:184-229` (45 lines) over limit — split `retry-engine.ts` wrapper into `computeDelay`/`sleepWithAbort`/`emitRetryAttempted` helpers per `code-standards` 40-line.                                                                                                                               |
| Circular generation↔retry                                | Low        | High   | RetryEngine never imports generation-engine; fallback stays in GenerationEngine; verify via madge.                                                                                                                                                                                                          |

---

## 9. References

- `.opencode/skill/architecture/SKILL.md` — Execution flow Step 7 (RETRYING), Timeout Enforcement section (ADR-014/026), Layer Architecture (ADR-030 L3 may import L0–L3 but no L3↔L3 circular)
- `.opencode/skill/principles/SKILL.md` — Principle 4 (Stateless Core), Principle 6 (Production-Ready Defaults), Principle 7
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines, complexity 7, nesting 3
- `.opencode/skill/errors/SKILL.md` — Retryable/fatal classification, `isRetryable()`, `MaxRetriesExceededError:187`
- `.opencode/skill/observability/SKILL.md` — `logger.warn('Retrying', {attempt, reason, delayMs}) at pipeline.ts:835,1175 S-1 compliant`
- `.opencode/skill/architecture/SKILL.md` — RETRYING / FAILED / FALLBACKING transitions, `state-machine.md` authoritative
- `DECISION-LOG.md` — ADR-007 (retry policy), ADR-014/026 (timeout `generateTimeoutMs` + `totalTimeoutMs` `withTimeout(Promise.race)`), ADR-016 (cumulative `roundCounter`), ADR-030 (L3 may import L0–L3), ADR-035 (mirror), ADR-039 (B1C atomic split; B15 closure)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/chatgpt-technical-analysis.md` — §2.1 (Retry orchestration concern)
- `packages/core/src/pipeline.ts` — Source file to decompose (retry `656-705,826-851,1134-1180`, timeout `67-85 + 1536-1539` — pre-B1A refs; post-B1A/B1B verify in `pipeline/non-streaming.ts` + `pipeline/streaming.ts`)
- `packages/core/src/policies.ts` — `RetryPolicy`, `DEFAULT_RETRY:7-12` (`jitterFactor:0.3`), `calculateDelay:85-86` (`policy.jitterFactor ?? 0.3`), `withTimeout`, `executeWithRetry:184-229` (45 lines over limit)
- `packages/core/src/errors.ts` — `isRetryable`, `MaxRetriesExceededError:187`
- `M06-B1A-pipeline-generation-engine.md`, `M07-B1B-pipeline-tool-executor.md` — Preceding sub-milestones (B1A, B1B) — precondition: `pipeline/` skeleton exists; `orchestrator.ts:22` already `→ ./pipeline/index.js`; B1B hash `491b1fd`
- `M02-B8-retry-jitter-factor.md` — `jitterFactor` semantics (`?? 0.3`, `isFinite`, `jitter:false` ignore)
