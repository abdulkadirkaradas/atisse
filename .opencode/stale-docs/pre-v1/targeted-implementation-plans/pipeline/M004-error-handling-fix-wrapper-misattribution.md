# M004 — Error Handling: Fix `handleOrchestratorError` Wrapper Misattribution

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA pipeline enterprise analysis — Error Handling (Strong)

---

## 1. Task Summary

Fix `handleOrchestratorError()` in `packages/core/src/pipeline.ts` (lines 1133–1155) which wraps non-`OrchestratorError` `Error` instances as `HookExecutionError`. This is a **misattribution** — not every unhandled `Error` in the pipeline originates from a hook. Create a semantically neutral `PipelineInternalError` type for the generic catch-all wrapper, and reserve `HookExecutionError` for actual hook execution failures.

---

## 2. Context (Why This Exists)

The `handleOrchestratorError` function is a catch-all error normalizer used throughout the pipeline. Its purpose is to ensure that ANY value thrown inside the pipeline (even non-`Error` values like strings or `null`) becomes an `OrchestratorError` instance, satisfying the `StreamChunk` error contract (`{ type: 'error', error: OrchestratorError }`).

Current implementation (lines 1144–1153):

```typescript
if (error instanceof OrchestratorErrorClass) {
  err = error; // Pass through — correct
} else if (error instanceof Error) {
  err = new HookExecutionError(error.message, error); // MISATTRIBUTION
} else {
  err = new TimeoutExceededError(timeoutMs ?? config.timeout.totalTimeoutMs); // Also wrong
}
```

**The problem:** `HookExecutionError` has `code: 'HOOK_EXECUTION_FAILED'` and `retryable: false`. When a non-hook `Error` is thrown — for example:

- A `TypeError` from a bug in pipeline code
- A `RangeError` from the prompt composer
- A generic `Error` from user-land hook code that wasn't caught earlier
- An `Error` from `ToolController` that escaped its try/catch

...it gets mislabeled as a hook execution failure. This misattribution propagates to:

- `run.failed` events (consumers see `code: 'HOOK_EXECUTION_FAILED'`)
- `StreamChunk.error` in streaming mode (same wrong code)
- Log output
- Any error monitoring/alerting that filters by error code

**The root cause:** `handleOrchestratorError` is called from MANY contexts (provider retry catch, tool execution catch, hook catch, generic outer catch), but it has no way to distinguish WHERE the error came from. It assumes all non-`OrchestratorError` `Error` instances are from hooks, which is incorrect.

---

## 3. Issues/Changes

### Issue: `HookExecutionError` Misattribution

| Field       | Value                                                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                                           |
| Lines       | 1147–1149                                                                                                                                 |
| Severity    | HIGH                                                                                                                                      |
| Description | All non-`OrchestratorError` `Error` instances are wrapped as `HookExecutionError`, regardless of their actual source.                     |
| Fix         | Create a generic `PipelineInternalError` type for catch-all wrapping; reserve `HookExecutionError` for explicit hook error handling only. |

### Affected Call Sites

`handleOrchestratorError` is called at these locations (all will now return `PipelineInternalError` instead of `HookExecutionError` for non-`OrchestratorError` inputs):

| Location                               | Line | Context                                   |
| -------------------------------------- | ---- | ----------------------------------------- |
| Non-streaming `executeWithRetry` catch | 499  | Provider generation retry failure         |
| Non-streaming tool execution catch     | 654  | Outer catch-all for \_execute             |
| Non-streaming afterGenerate hook catch | 633  | Hook error wrapping                       |
| Streaming stream-setup catch           | 769  | Provider generateStream Promise rejection |
| Streaming stream-retry catch           | 1042 | Outer catch-all for streaming generator   |
| Streaming afterGenerate hook catch     | 1011 | Hook error wrapping                       |

Note: Lines 633 and 1011 are hook-specific catch blocks. The call to `handleOrchestratorError` here is still appropriate because the function is purely a wrapper — the hook error wrapping should still create a `PipelineInternalError` for non-`OrchestratorError` input, since the actual hook context is preserved by the error message. However, an even better approach is to handle hook errors explicitly in their own catch blocks.

---

## 4. Architectural Directives

### 4.1 New Error Class: `PipelineInternalError`

Add to `packages/core/src/errors.ts` in the Lifecycle Errors section (after `ConfigValidationError`):

```typescript
/**
 * Generic internal pipeline error — thrown when an unclassified Error
 * propagates through the pipeline without being caught by a more specific handler.
 *
 * This is the catch-all wrapper used by handleOrchestratorError() to satisfy
 * the StreamChunk error contract. It does NOT imply a hook execution failure —
 * use HookExecutionError only when the error source is confirmed to be a hook.
 *
 * Not retryable — pipeline-internal errors are always fatal.
 */
export class PipelineInternalError extends OrchestratorError {
  readonly code = 'PIPELINE_INTERNAL_ERROR' as const;
  readonly retryable = false;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}
```

### 4.2 New Error Code in the Union

Add `'PIPELINE_INTERNAL_ERROR'` to the `OrchestratorErrorCode` union in `packages/core/src/interfaces.ts`:

```typescript
export type OrchestratorErrorCode =
  | ...
  | 'HOOK_EXECUTION_FAILED'
  | 'PIPELINE_INTERNAL_ERROR'  // NEW — added by M004
  | 'PROVIDER_AUTH_FAILED'
```

This is a backward-compatible addition (new member in a union — existing consumers with exhaustive checks will get a compile error if they use `never` assertions, but this is standard TypeScript union extensibility).

### 4.3 Update `handleOrchestratorError()`

Change lines 1147–1149 from:

```typescript
} else if (error instanceof Error) {
  // Wrap non-OrchestratorError instances to satisfy the StreamChunk error contract
  err = new HookExecutionError(error.message, error);
```

To:

```typescript
} else if (error instanceof Error) {
  // Wrap non-OrchestratorError instances to satisfy the StreamChunk error contract.
  // Use PipelineInternalError — NOT HookExecutionError — because the error source
  // is unknown at this point. HookExecutionError is reserved for confirmed hook
  // failures (explicitly caught in hook try/catch blocks).
  err = new PipelineInternalError(error.message, error);
```

### 4.4 Export from Index

In `packages/core/src/index.ts`, add `PipelineInternalError` to the exports:

```typescript
export {
  ...
  PipelineInternalError,
} from "./errors.js";
```

### 4.5 What NOT to Do

- Do NOT remove `HookExecutionError` — it remains valid for explicit hook error wrapping
- Do NOT change the function signature of `handleOrchestratorError` — it still returns `OrchestratorError`
- Do NOT add a `source` parameter to distinguish error origins — that is a larger refactoring outside v1 scope
- Do NOT change the `TimeoutExceededError` wrapping for non-Error values (the `else` branch on line 1151) — that path handles truly unknown values and the timeout attribution is acceptable as a fallback
- Do NOT modify `HookExecutionError`'s `retryable` or `code` properties — they are correct for actual hook failures

---

## 5. Files to Modify

| File                                      | Action            | Notes                                                                                         |
| ----------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`         | MODIFY (additive) | Add `'PIPELINE_INTERNAL_ERROR'` to `OrchestratorErrorCode`                                    |
| `packages/core/src/errors.ts`             | MODIFY (additive) | Add `PipelineInternalError` class                                                             |
| `packages/core/src/pipeline.ts`           | MODIFY (bugfix)   | Change `handleOrchestratorError` wrapper from `HookExecutionError` to `PipelineInternalError` |
| `packages/core/src/index.ts`              | MODIFY (additive) | Export `PipelineInternalError`                                                                |
| `packages/core/tests/unit/errors.test.ts` | MODIFY (additive) | Add `PipelineInternalError` to `isRetryable() → false` tests                                  |

---

## 6. Implementation Strategy

### Step 1: Add `PipelineInternalError` to errors.ts

- Add the class after `ConfigValidationError` (line 266)
- Follow the same pattern as other error classes: `extends OrchestratorError`, `readonly code`, `readonly retryable`

### Step 2: Add `'PIPELINE_INTERNAL_ERROR'` to interfaces.ts

- Add it to the `OrchestratorErrorCode` union between `'HOOK_EXECUTION_FAILED'` and `'PROVIDER_AUTH_FAILED'`
- This is a non-breaking addition per `rules/constraints.md` §Interface Modification Rules

### Step 3: Update `handleOrchestratorError()`

- Change the `else if (error instanceof Error)` branch to use `PipelineInternalError` instead of `HookExecutionError`
- Update the comment to explain the reasoning (as shown in §4.3)

### Step 4: Export from index.ts

- Add `PipelineInternalError` to the exported error classes block

### Step 5: Update tests

- Add `PipelineInternalError` to `isRetryable() → false` test cases in `errors.test.ts`
- Verify the error code literal: `new PipelineInternalError('test').code === 'PIPELINE_INTERNAL_ERROR'`
- Verify `isRetryable(new PipelineInternalError('test'))` returns `false`

### Step 6: Verify

Run:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage
```

All existing tests MUST pass without modification — this fix only changes the class name used for wrapping, which affects the error type propagated to consumers. No test should be asserting `HookExecutionError` from a non-hook source.

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

1. `new PipelineInternalError('test').code === 'PIPELINE_INTERNAL_ERROR'`
2. `isRetryable(new PipelineInternalError('test'))` returns `false`
3. When a plain `Error` with message `'something broke'` passes through `handleOrchestratorError`, the result is `PipelineInternalError` with message `'something broke'`
4. When an `OrchestratorError` subtype passes through `handleOrchestratorError`, it passes through unchanged (this existing behavior must be preserved)
5. `HookExecutionError` is still throwable and still has `code: 'HOOK_EXECUTION_FAILED'` — it is preserved for explicit hook contexts

### If a Test Fails:

1. **Test asserts `HookExecutionError` where the source is not a hook:** Update the assertion to expect `PipelineInternalError`. This is the intended behavior change.
2. **Test asserts a specific error code string:** The code changed from `'HOOK_EXECUTION_FAILED'` to `'PIPELINE_INTERNAL_ERROR'`. Update the assertion.
3. **Any other failure:** Investigate for unintended side effects — the change is limited to one class name in one function.

---

## 8. Risk Assessment

| Risk                                                                                | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| External consumer checks for `error.code === 'HOOK_EXECUTION_FAILED'` and breaks    | Medium     | Low    | This is a bugfix — the previous behavior was incorrect; consumers relying on the wrong code must update. Documented as bug fix in release notes.                                                                                                                                                                                                                     |
| Test asserts `HookExecutionError` in catch-all scenarios                            | Medium     | Low    | Update test assertions — intentional fix                                                                                                                                                                                                                                                                                                                             |
| `PipelineInternalError` not exported from index.ts                                  | Low        | Low    | Caught by `pnpm typecheck` on any consumer import                                                                                                                                                                                                                                                                                                                    |
| Ambiguity between `PipelineInternalError` and `HookExecutionError` in hook contexts | Low        | Low    | Hook-specific catch blocks (lines 630–635, 1008–1012) still call `handleOrchestratorError`, which now returns `PipelineInternalError`. This is acceptable because the error message and cause still identify the hook origin. True hook-error attribution requires a larger refactoring (passing source context to `handleOrchestratorError`) which is out of scope. |

---

## 9. References

- `.opencode/rules/architecture.md` — Execution Flow, error propagation patterns
- `.opencode/rules/interfaces-core.md` — Frozen contracts, `OrchestratorErrorCode` union
- `.opencode/rules/error-taxonomy.md` — Error hierarchy, `isRetryable()` rules
- `.opencode/rules/constraints.md` — Interface modification rules (additive only)
- `.opencode/workflows/error-handling.md` — Catching patterns, cause preservation
- `packages/core/src/pipeline.ts` — Lines 1133–1155 (`handleOrchestratorError`), all call sites
- `packages/core/src/errors.ts` — Existing error hierarchy, placement for `PipelineInternalError`
- `packages/core/src/interfaces.ts` — `OrchestratorErrorCode` union
- `packages/core/tests/unit/errors.test.ts` — `isRetryable()` test cases
