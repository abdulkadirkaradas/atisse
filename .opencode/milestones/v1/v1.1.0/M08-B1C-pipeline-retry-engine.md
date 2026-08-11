# B1C — RetryEngine (Pipeline Decomposition, Part 3 of 5)

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap (ADR-039)

> **Sequence (ADR-039):** B1A → B1B → B1C → B1D → B1E, then B15. Each sub-milestone is an **atomic commit** — independent review and rollback, **no behavioral change, no test modification**. The build must stay green at every commit.

---

## 1. Task Summary

Extract the **RetryEngine** — retry handling and timeout management — from `packages/core/src/pipeline.ts` into `packages/core/src/pipeline/retry-engine.ts`:

1. Move the retry loop (Step 7 `RETRYING`) — exponential backoff + jitter delay — into `retry-engine.ts`.
2. Move timeout management: `generateTimeoutMs` `AbortSignal` attachment (Step 5) and the `totalTimeoutMs` hard ceiling (`Promise.race` at the pipeline top level).
3. Preserve `retry.attempted` event emission and the retryable/fatal classification transitions (`goto RETRYING` / `goto FAILED`).
4. Wire `non-streaming.ts` and `generation-engine.ts` (B1A) to call the RetryEngine.
5. Public API unchanged — no consumer-visible changes.

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` is 1547 lines — 3.4× larger than the next largest file (`interfaces.ts` at 458 lines). Retry handling and timeout management are among the six distinct orchestration concerns embedded in that single file (Generation, Streaming, Retry, Fallback, Tool, Error — see `chatgpt-technical-analysis.md` §2.1). This violates **Principle 7 (Small Core, Large Ecosystem)**.

Key behavioral facts that must be preserved:

- Retry classification follows `error-taxonomy.md`: retryable `ProviderError` → `RETRYING` with exponential backoff + jitter; fatal `ProviderError` → `FAILED`; `MaxRetriesExceeded` + fallback exists → `FALLBACKING` (the fallback swap action itself is owned by the GenerationEngine — B1A — which handles Step 8).
- `retry.attempted` is emitted before each backoff delay.
- `generateTimeoutMs` attaches an `AbortSignal` to each `PromptRequest`; `totalTimeoutMs` is a hard ceiling enforced via `Promise.race([executePipeline(...), totalTimeoutTimer])` regardless of which step is active.
- Retry policy comes from `policies.ts` (`RetryPolicy`: `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `jitter` — ADR-007).

---

## 3. Issues/Changes

### Issue B1C-1: RetryEngine embedded in a God Module

| Field       | Value                                                                                |
| ----------- | ------------------------------------------------------------------------------------ |
| File        | `packages/core/src/pipeline.ts`                                                      |
| Lines       | 1–1547 (entire file); retry loop spans Step 7, timeouts span Steps 1–10              |
| Severity    | HIGH                                                                                 |
| Description | Retry loop, backoff, and timeout management are embedded in a single 1547-line file. |
| Fix         | Extract into `pipeline/retry-engine.ts`. Pure restructuring — no behavioral change.  |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

- Create `packages/core/src/pipeline/retry-engine.ts` hosting the `RetryEngine` module.
- Move the retry loop (Step 7 `RETRYING`) — exponential backoff + jitter delay — preserving exact behavior.
- Keep timeout enforcement in the engine, preserving semantics:
  - `generateTimeoutMs` → `AbortSignal` attached to each `PromptRequest`; `Promise.race` fallback for non-cooperative providers.
  - `toolTimeoutMs` → wrapped by `ToolExecutor` (B1B) — RetryEngine does not duplicate it.
  - `totalTimeoutMs` → `Promise.race([executePipeline(...), timeoutPromise])` at the pipeline top level; hard ceiling covering all steps including context loading, retries, and tool rounds.
- Event emission preserved: `retry.attempted` before each backoff.
- Transition decisions preserved: retryable → `RETRYING`, fatal → `FAILED`, `MaxRetriesExceeded` + fallback → `FALLBACKING` (fallback action executed by GenerationEngine — B1A).
- Retry policy consumed from `policies.ts` (`RetryPolicy`) — no changes to policy types or merge utilities.
- All state remains local per call (Principle 4 — Stateless Core). No module-level state.
- Follow function body max 40 lines (per `implementation-standards.md`). Decompose further if exceeded.

### 4.2 What NOT to Do

- Do NOT change the public exports of `pipeline.ts` (now `pipeline/index.ts`). `executePipeline()` must remain the single exported function with the same signature.
- Do NOT modify `packages/core/src/interfaces.ts`, `types.ts`, `policies.ts`, or any other contract file.
- Do NOT change retry semantics: backoff algorithm, jitter, `maxAttempts`, retryable/fatal classification.
- Do NOT introduce new runtime dependencies.
- Do NOT change behavioral logic — pure restructuring only.
- Do NOT create `.md` documentation files.
- Do NOT introduce module-level state or singletons in the new files.

---

## 5. Files to Modify

| File                                              | Action | Notes                                                                                      |
| ------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| `packages/core/src/pipeline/retry-engine.ts`      | NEW    | `RetryEngine` module — retry loop, backoff, timeout enforcement                            |
| `packages/core/src/pipeline.ts`                   | MODIFY | Remove retry slice (Step 7) and timeout enforcement                                        |
| `packages/core/src/pipeline/non-streaming.ts`     | MODIFY | Call `RetryEngine` for the Step 7 retry loop                                               |
| `packages/core/src/pipeline/generation-engine.ts` | MODIFY | Use `RetryEngine` for backoff/`retry.attempted`; keep fallback swap (Step 8) in the engine |

---

## 6. Implementation Strategy

### Step 1: Create `retry-engine.ts`

- Create `packages/core/src/pipeline/retry-engine.ts`.
- Move the retry loop and backoff logic (Step 7) into it, preserving exact behavior.
- Move timeout enforcement (AbortSignal construction, total-timeout `Promise.race` wrapping) into it.

### Step 2: Wire Non-Streaming + Generation Paths

- In `non-streaming.ts` / `generation-engine.ts`, replace inline retry logic with calls to the `RetryEngine`.
- Verify `retry.attempted` emission points are preserved exactly.

### Step 3: Update Imports

- Update all import paths to reference the correct `.js` modules.

### Step 4: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`.
- ALL tests must pass WITHOUT modification. This is a pure refactor — no behavioral change.

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

Specific assertions to verify:

- `packages/core/src/pipeline/retry-engine.ts` exists and hosts the retry loop.
- Retry behavior is identical: backoff + jitter, `maxAttempts` enforcement, retryable → `RETRYING` / fatal → `FAILED` (verified with fake timers per test constraints).
- `retry.attempted` emitted before each backoff delay, with identical payload shape.
- `generateTimeoutMs` AbortSignal and `totalTimeoutMs` hard ceiling behave identically.
- `executePipeline()` has the exact same function signature as before; no new public exports.
- All tests pass without modification.

---

## 8. Risk Assessment

| Risk                                                     | Likelihood | Impact | Mitigation                                                                                      |
| -------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------- |
| Backoff/timing regression during extraction              | Medium     | Medium | Fake-timer retry tests pass without modification; algorithm preserved verbatim.                 |
| `totalTimeoutMs` ceiling accidentally scoped to a module | Low        | High   | Keep the `Promise.race` wrapper at the pipeline top level (covers all steps).                   |
| `retry.attempted` emission point moved                   | Low        | Medium | Preserve emit sites; event payload shape unchanged.                                             |
| Fallback handoff (B1A) mis-wired                         | Low        | Medium | RetryEngine reports `MaxRetriesExceeded`; GenerationEngine executes the fallback swap (Step 8). |

---

## 9. References

- `.opencode/skill/architecture/SKILL.md` — Execution flow Step 7 (RETRYING), Timeout Enforcement section
- `.opencode/skill/principles/SKILL.md` — Principle 4 (Stateless Core), Principle 6 (Production-Ready Defaults), Principle 7
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines
- `.opencode/skill/errors/SKILL.md` — Retryable/fatal classification, `isRetryable()`
- `.opencode/skill/architecture/SKILL.md` — RETRYING / FAILED / FALLBACKING transitions
- `DECISION-LOG.md` — ADR-007 (retry policy), ADR-039 (B1C atomic split; B15 closure)
- `.opencode/milestones/v1/analysis-reports/after-assessment-reports/chatgpt-technical-analysis.md` — §2.1 (Retry orchestration concern)
- `packages/core/src/pipeline.ts` — Source file to decompose
- `packages/core/src/policies.ts` — `RetryPolicy`, `DEFAULT_RETRY`, merge utilities
- `M06-B1A-pipeline-generation-engine.md`, `M07-B1B-pipeline-tool-executor.md` — Preceding sub-milestones (B1A, B1B)
