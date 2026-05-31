# M003 — Reliability: Fix Shared `attempt` Counter and Memory Save Error Type

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA pipeline enterprise analysis — Reliability (Strong)

---

## 1. Task Summary

Fix two reliability bugs in `packages/core/src/pipeline.ts`:

1. **Split shared `attempt` counter** — The non-streaming path declares a single `let attempt = 0` variable (line 422) that is mutated by BOTH the provider retry callback (line 477: `attempt = retryAttempt`) AND read by the tool retry catch block (line 618: `calculateDelay(attempt, ...)`). This means tool retries inherit the provider retry's attempt count, causing incorrect delay calculations (potentially capped at `maxDelayMs` after provider retries have already inflated the counter).

2. **Fix memory save failure error type** — `finalizePipeline()` throws `ContextLoadError` (retryable: true, code: `CONTEXT_LOAD_FAILED`) when `memoryAdapter.save()` fails. This is semantically wrong: (a) the error occurs during COMPLETING, not context loading, so the error code is misleading; (b) the `retryable: true` flag suggests the pipeline should retry, but the design explicitly transitions to FAILED (comment: "Memory save failure -> FAILED (no retry check)"). The error type must be non-retryable and semantically correct.

---

## 2. Context (Why This Exists)

### Bug 1: Shared `attempt` Counter

The non-streaming pipeline (lines 422–677) manages retry attempts via a single `let attempt = 0` variable declared at the top of `_execute()`. This variable serves two distinct purposes that are incorrectly conflated:

- **Provider retry tracking:** `executeWithRetry()` manages its own internal `attempt` counter (in `policies.ts`, line 132), but the `onRetry` callback on line 477 updates the outer `attempt = retryAttempt`. This is only meaningful for its side effect — making `attempt` visible to other code in the same scope.
- **Tool retry delay calculation:** Lines 618 and 990 call `calculateDelay(attempt, config.retry, err)` using this same `attempt` variable.

**The bug:** When provider generation fails multiple times before succeeding (e.g., 2 retries, so `attempt = 2`), and then a subsequent tool execution fails, the tool retry delay is calculated using `attempt = 2`. `calculateDelay(2, ...)` yields `baseDelayMs * 2^2 + jitter`, which is ~4× the first-retry delay. After several provider retries, tool retries immediately hit `maxDelayMs`.

**Non-streaming path:** Lines 422, 477, 536, 618
**Streaming path:** Lines 754 (local `attempt`), 784, 787, 805, 990

In the streaming path, `attempt` is local to the stream-setup retry loop (line 754) and is used at line 990 for tool retry delay. The streaming tool retry reuses the stream-setup `attempt`, which has the same bug.

### Bug 2: Memory Save Error Type

In `finalizePipeline()` (lines 337–343):

```typescript
if (input.sessionId && memoryAdapter) {
  try {
    await memoryAdapter.save(input.sessionId, [tempMessages[0], tempMessages[1]]);
  } catch (error: unknown) {
    // D-M2-1/A: Memory save failure -> FAILED (no retry check)
    throw new ContextLoadError('memory', error);
  }
}
```

Problems:

- `ContextLoadError` has `retryable: true` — but this failure is design-fatal (no retry loop wraps it)
- Error code `CONTEXT_LOAD_FAILED` implies a context provider load issue, not a memory save issue
- The `providerId` string `'memory'` is a hardcoded label that misrepresents the failing subsystem

The existing test at `packages/core/tests/integration/streaming.test.ts` line 565 (`'memory save failure yields error chunk during streaming finalize'`) expects `ContextLoadError`, so the test MUST be updated.

---

## 3. Issues/Changes

### Issue 1: Shared `attempt` Counter (Non-Streaming)

| Field       | Value                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                                                                        |
| Lines       | 422, 477, 536, 618 (non-streaming), 754, 784, 787, 805, 990 (streaming)                                                                                                |
| Severity    | MEDIUM                                                                                                                                                                 |
| Description | Single `attempt` variable shared between provider retry and tool retry paths causes incorrect delay calculation for tool retries after provider retries have occurred. |
| Fix         | Split into `providerAttempt` and `toolAttempt` counters; read the correct one in each context.                                                                         |

### Issue 2: Memory Save Error Type

| Field       | Value                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------ |
| File        | `packages/core/src/pipeline.ts`, `packages/core/src/errors.ts`                             |
| Lines       | 341–342 (pipeline), new error class in errors.ts                                           |
| Severity    | MEDIUM                                                                                     |
| Description | `ContextLoadError` used for memory save failure — wrong semantics (retryable, wrong code). |
| Fix         | Create `MemorySaveError` in errors.ts; use it in `finalizePipeline()`.                     |

---

## 4. Architectural Directives

### 4.1 New Error Class: `MemorySaveError`

Add to `packages/core/src/errors.ts` in the Context Errors section (after `ContextProviderError`):

```typescript
/**
 * Memory save failure during COMPLETING — infrastructure error, not retryable.
 * The generation has already succeeded; a memory save failure does not invalidate
 * the generation, but the run transitions to FAILED because the session state
 * is not persisted.
 */
export class MemorySaveError extends OrchestratorError {
  readonly code = 'MEMORY_SAVE_FAILED' as const;
  readonly retryable = false;

  constructor(cause?: unknown) {
    super('Memory save failed during finalization', cause);
  }
}
```

### 4.2 New Error Code in the Union

Add `'MEMORY_SAVE_FAILED'` to the `OrchestratorErrorCode` union in `packages/core/src/interfaces.ts`:

```typescript
export type OrchestratorErrorCode =
  | ...
  | 'HOOK_EXECUTION_FAILED'
  | 'MEMORY_SAVE_FAILED';  // NEW — added by M003
```

This is a backward-compatible addition (new member in a union — existing consumers handle it via their `default`/`else` branches).

### 4.3 Expose in Index

In `packages/core/src/index.ts`, add `MemorySaveError` to both the import and the exports section:

```typescript
export {
  ...
  MemorySaveError,
} from "./errors.js";
```

### 4.4 Split `attempt` Counter (Non-Streaming)

In the non-streaming `_execute()` function:

1. Replace `let attempt = 0;` with `let providerAttempt = 0;` and `let toolAttempt = 0;`
2. In the `executeWithRetry` onRetry callback, change `attempt = retryAttempt` to `providerAttempt = retryAttempt`
3. In the fallback/no-retry catch block (line 536), change `calculateDelay(attempt, ...)` to `calculateDelay(providerAttempt, ...)`
4. In the tool retry catch block (line 618), change `calculateDelay(attempt, ...)` to `calculateDelay(toolAttempt, ...)` — and bump `toolAttempt++` before calling, or define a local counter

The streaming path also needs fixing: `attempt` on line 754 is used for stream-setup retry and tool retry (line 990). Either promote a separate tool round attempt counter or use a fresh 0-based value for `calculateDelay` in the tool retry path.

### 4.5 `finalizePipeline()` Memory Save Error

Replace:

```typescript
throw new ContextLoadError('memory', error);
```

With:

```typescript
throw new MemorySaveError(error);
```

### 4.6 What NOT to Do

- Do NOT change `ContextLoadError`'s `retryable` flag — it is correct for actual context loading failures
- Do NOT add the new error code to index.ts exports as a TypeScript type export — the union member is automatically available
- Do NOT wrap the memory save call in a retry loop — the design decision (D-M2-1/A) is intentional
- Do NOT change the `finalizePipeline` signature — it already uses `throw` for error propagation

---

## 5. Files to Modify

| File                                                   | Action               | Notes                                                       |
| ------------------------------------------------------ | -------------------- | ----------------------------------------------------------- |
| `packages/core/src/interfaces.ts`                      | MODIFY (additive)    | Add `'MEMORY_SAVE_FAILED'` to `OrchestratorErrorCode` union |
| `packages/core/src/errors.ts`                          | MODIFY (additive)    | Add `MemorySaveError` class                                 |
| `packages/core/src/pipeline.ts`                        | MODIFY (bugfix)      | Split `attempt` counter in non-streaming and streaming      |
| `packages/core/src/pipeline.ts`                        | MODIFY (bugfix)      | Change `finalizePipeline` to throw `MemorySaveError`        |
| `packages/core/src/index.ts`                           | MODIFY (additive)    | Export `MemorySaveError`                                    |
| `packages/core/tests/integration/streaming.test.ts`    | MODIFY (test update) | Update memory save failure test to expect `MemorySaveError` |
| `packages/core/tests/integration/orchestrator.test.ts` | MODIFY (test update) | Update memory save failure test to expect `MemorySaveError` |

---

## 6. Implementation Strategy

### Step 1: Add `MemorySaveError` to errors.ts

- Add the class after `ContextProviderError` (line 165)
- Add `isRetryable` test return values in `tests/unit/errors.test.ts`:
  - `isRetryable(new MemorySaveError(new Error('test')))` → `false`

### Step 2: Add `'MEMORY_SAVE_FAILED'` to interfaces.ts

- Add it to the `OrchestratorErrorCode` union alphabetically (before `'PROVIDER_AUTH_FAILED'`)
- This is a non-breaking addition per `rules/constraints.md` §Interface Modification Rules

### Step 3: Export from index.ts

- Add `MemorySaveError` to the exported error classes block

### Step 4: Fix `finalizePipeline` memory save error

- Replace `throw new ContextLoadError('memory', error)` with `throw new MemorySaveError(error)`
- Also update any descriptive comment that references `ContextLoadError`

### Step 5: Split `attempt` counter in non-streaming path

- Change `let attempt = 0` to `let providerAttempt = 0` and `let toolAttempt = 0`
- Update the `executeWithRetry` callback: `attempt = retryAttempt` → `providerAttempt = retryAttempt`
- Update line 536: `calculateDelay(attempt, ...)` → `calculateDelay(providerAttempt, ...)`
- Update line 618: `calculateDelay(attempt, ...)` → `calculateDelay(toolAttempt, ...)`, add `toolAttempt++` or use a fresh counter

### Step 6: Fix streaming tool retry `attempt` usage

- Line 990 uses `attempt` from the stream-setup retry loop (line 754)
- Since tool retries have no accumulated attempt counter, use a fresh `0`-based approach or maintain `let streamToolAttempt = 0` at the top of the streaming generator

### Step 7: Update tests

- `streaming.test.ts` line 565: change expected error from `ContextLoadError` to `MemorySaveError`
- `orchestrator.test.ts` (memory save test): change expected error from `ContextLoadError` to `MemorySaveError`
- `errors.test.ts`: add `MemorySaveError` to the `isRetryable() → false` test cases

### Step 8: Verify

Run:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage
```

---

## 7. Verification Requirements

After implementation, the SPBED MUST run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

### Specific assertions to verify:

1. `isRetryable(new MemorySaveError(new Error('cause')))` returns `false`
2. `MemorySaveError.code` is `'MEMORY_SAVE_FAILED'`
3. Memory save failure during `finalizePipeline()` throws `MemorySaveError`, not `ContextLoadError`
4. Tool retry delay calculation uses an independent attempt counter, not the provider retry counter
5. Provider retry `onRetry` callback events carry the correct provider-side attempt number (this should be unchanged — `executeWithRetry` manages its own counter internally and passes it to `onRetry`)
6. All existing tests pass without modification except the memory save error type assertions

### If a Test Fails:

1. **Memory save error type tests:** Update the expected error class from `ContextLoadError` to `MemorySaveError` — these are intentional assertion updates
2. **Retry timing tests:** If a test measures delay behavior and was dependent on the bug (e.g., a test that expected inflated tool retry delays), it must be updated to expect correct behavior
3. **Other failures:** Investigate for unintended side effects of the counter split

---

## 8. Risk Assessment

| Risk                                                         | Likelihood | Impact | Mitigation                                                                                          |
| ------------------------------------------------------------ | ---------- | ------ | --------------------------------------------------------------------------------------------------- |
| Existing test expects `ContextLoadError` for memory save     | High       | Low    | Update test assertion — intentional change                                                          |
| Counter split misses a reference to `attempt`                | Medium     | Medium | Grep for all `attempt` references in pipeline.ts after change; compile check will catch type errors |
| Streaming tool retry `attempt` (line 990) inadvertently zero | Low        | Low    | `calculateDelay(0, ...)` = `baseDelayMs * 2^0` = `baseDelayMs` — correct first-retry behavior       |
| New `MemorySaveError` not exported from index.ts             | Low        | Low    | TypeScript compilation error on export — caught by `pnpm typecheck`                                 |

---

## 9. References

- `.opencode/rules/architecture.md` — Execution Flow steps 9–10 (COMPLETING → COMPLETED)
- `.opencode/rules/interfaces-core.md` — Frozen contracts, `OrchestratorErrorCode` union
- `.opencode/rules/interfaces-runtime.md` — Frozen contracts, `RunOutput`, `StreamChunk`
- `.opencode/rules/constraints.md` — Interface modification rules (additive only)
- `.opencode/rules/error-taxonomy.md` — Error hierarchy and `isRetryable()` rules
- `.opencode/workflows/error-handling.md` — Error throwing/catching patterns
- `.opencode/workflows/testing-standards.md` — `MockMemoryAdapter` error-injection pattern
- `packages/core/src/pipeline.ts` — Lines 337–343 (memory save), lines 422–677 (\_execute attempt counter)
- `packages/core/src/errors.ts` — Existing error hierarchy
- `packages/core/src/interfaces.ts` — `OrchestratorErrorCode` union
- `packages/core/tests/integration/streaming.test.ts` — Memory save failure test (line 565)
- `packages/core/tests/integration/orchestrator.test.ts` — Memory save failure test
