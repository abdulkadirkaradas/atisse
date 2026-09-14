# M009 — `rejectAfter()` Timer Leak Fix

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA pipeline gaps analysis — TD-3 / Imp-2 (MED)

---

## 1. Task Summary

Fix the dangling `setTimeout` in `rejectAfter()` that is never cleaned up when the competing promise in a `Promise.race` resolves first. The fix must preserve the existing function signature (`rejectAfter(ms: number): Promise<never>`), keep `sleep()` compatible with `vi.useFakeTimers()`, and handle all call sites. This is a **prerequisite** for M008 (streaming chunk buffering) which will create and discard per-chunk timers in a loop.

---

## 2. Context (Why This Exists)

### Current Behavior

`rejectAfter()` in `packages/core/src/policies.ts` (lines 99–105):

```typescript
function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new TimeoutExceededError(ms));
    }, ms);
  });
}
```

This creates a `setTimeout` and returns a promise. When used in `Promise.race`:

```typescript
return await Promise.race([_execute(), rejectAfter(config.timeout.totalTimeoutMs)]);
```

If `_execute()` resolves first, `rejectAfter`'s timer handle is orphaned — the `setTimeout` callback still fires, calling `reject()` on an already-settled promise (a no-op), but the timer itself keeps the Node.js event loop alive until it fires. In long-running server processes, repeated `run()` calls accumulate these orphaned timers.

### Affected Call Sites

| Location      | Lines     | Usage                                             |
| ------------- | --------- | ------------------------------------------------- |
| `pipeline.ts` | 405       | `Promise.race([_execute(), rejectAfter(timeout)])` — non-streaming total timeout |
| `pipeline.ts` | 818–830   | `Promise.race([...collected, rejectAfter(timeout)])` — streaming generate timeout (will be removed by M008, but must be fixed for safety until then) |
| `pipeline.ts` | (future)  | M008's `asyncIteratorWithIdleTimeout` will create per-chunk timeouts — these MUST be cleaned up |

### Requirements

1. **No change to `rejectAfter(ms: number): Promise<never>` signature** — the return type `Promise<never>` is used in type inference for `Promise.race` results
2. **`sleep()` must remain `vi.useFakeTimers()` compatible** — the test at `policies.test.ts` line 101 uses `vi.runAllTimersAsync()` and expects `rejectAfter` to work with fake timers
3. **Must work with both `Promise.race` call sites** — the non-streaming total timeout (line 405) and the streaming generate timeout (lines 818–830, until M008 replaces it)
4. **Must also fix the timer leak inside any per-chunk timeout created by M008**

---

## 3. Issues/Changes

### Issue: `rejectAfter()` timer handle never cleared

| Field       | Value                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| File        | `packages/core/src/policies.ts`                                          |
| Lines       | 99–105                                                                   |
| Severity    | MEDIUM                                                                   |
| Description | `setTimeout` timer handle is orphaned when competing promise wins race   |
| Fix         | Create a `withTimeout` wrapper that returns both promise and cancel fn   |

---

## 4. Architectural Directives

### 4.1 Chosen Approach: New `withTimeout()` Wrapper

Replace `rejectAfter`'s responsibility of "race against a timeout" with a composed utility. The approach:

**Remove `rejectAfter` from `policies.ts` exports** and replace its role with a new `withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>` wrapper that internally manages timer cleanup.

```typescript
/**
 * Wraps a promise with a timeout that rejects with TimeoutExceededError.
 * The internal setTimeout is CLEANED UP if the wrapped promise settles first.
 *
 * When ms <= 0, returns the original promise with no timeout wrapping.
 *
 * @param promise - The promise to wrap with a timeout
 * @param ms - Timeout in milliseconds (<= 0 means no timeout)
 * @returns The result of the wrapped promise, or throws TimeoutExceededError
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T>;
```

**Keep `rejectAfter` as a file-private function** (not exported) used only internally by `withTimeout` and `sleep` — it creates the timeout promise. The timer cleanup happens inside `withTimeout`:

```typescript
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) {
    return promise;
  }

  let timerHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerHandle = setTimeout(() => {
      reject(new TimeoutExceededError(ms));
    }, ms);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    return result;
  } finally {
    if (timerHandle !== undefined) {
      clearTimeout(timerHandle);
    }
  }
}
```

**Key design points:**
- `timerHandle` is captured in the timeout promise's executor and accessible in the `finally` block
- `clearTimeout` on an already-fired timer is a harmless no-op — the `finally` block runs after `await Promise.race` settles
- The `finally` block ensures cleanup even if the wrapped promise rejects
- When `ms <= 0`, the function is a transparent passthrough with zero timer overhead

### 4.2 Update `sleep()` for Consistency

`sleep()` in `policies.ts` (lines 112–116) already creates a `setTimeout` that fires naturally — it is NOT leaked because `sleep` returns a promise that resolves when the timer fires. No change needed.

However, `sleep()` must remain `vi.useFakeTimers()` compatible. Verify that `withTimeout` also works with fake timers — the `Promise.race` + fake timers pattern is already tested in `policies.test.ts` (line 101: `vi.runAllTimersAsync()`).

### 4.3 Update Call Sites in `pipeline.ts`

Replace all `rejectAfter(...)` usage in `Promise.race` with `withTimeout(promise, ms)`:

**Call site 1 — Non-streaming total timeout (line 405):**

```typescript
// BEFORE:
return await Promise.race([_execute(), rejectAfter(config.timeout.totalTimeoutMs)]);

// AFTER:
return await withTimeout(_execute(), config.timeout.totalTimeoutMs);
```

**Call site 2 — Streaming generate timeout (lines 818–830, if M008 is NOT yet implemented):**

This call site will be removed by M008. However, if M009 is implemented first (as recommended), update this call site to use the `withTimeout`-compatible pattern:

```typescript
// BEFORE:
const chunks = await Promise.race([
  (async () => { ... })(),
  rejectAfter(config.timeout.generateTimeoutMs),
]);

// AFTER:
const chunks = await withTimeout(
  (async () => { ... })(),
  config.timeout.generateTimeoutMs,
);
```

### 4.4 What NOT to Do

- Do NOT change the exported symbol name `rejectAfter` — existing imports will break. Either keep `rejectAfter` with the new semantics, or remove it and add `withTimeout`. **Decision: Remove `rejectAfter` from exports, add `withTimeout` as export.** Update imports in `pipeline.ts` accordingly.
- Do NOT use `AbortSignal.timeout()` — it has different semantics (creates an `AbortSignal` that requires an `AbortController`) and is already used for `promptRequest.signal` in the pipeline. Using it here would conflate cancellation with timeout.
- Do NOT modify `sleep()` — it is intentionally a simple timer-based sleep without cleanup concerns
- Do NOT change the `TimeoutExceededError` constructor signature — it already accepts `timeoutMs: number`
- Do NOT use `Symbol.dispose` or `using` — while Node.js 24 supports explicit resource management, the `finally` block approach is simpler and doesn't require structural changes to the rest of the codebase
- Do NOT attempt to fix timer leaks in `ToolController` — tool timeouts are a separate concern and use a different timer mechanism

### 4.5 Non-Streaming Path: Architectural Note

The non-streaming `_execute()` inner function (line 415) is an async function that itself contains retry/fallback loops. When `withTimeout` wraps it:
- If the timeout fires, the `_execute()` promise is NOT cancelled — it continues running in the background. This is the **existing behavior** (the original `Promise.race` also didn't cancel `_execute()`).
- The `withTimeout` wrapper ensures the `setTimeout` is cleaned up when `_execute()` wins the race, fixing the leak.
- The `_execute()` function will eventually complete and its result will be discarded — this is pre-existing and acceptable for v1.

---

## 5. Files to Modify

| File                            | Action         | Notes                                                                      |
| ------------------------------- | -------------- | -------------------------------------------------------------------------- |
| `packages/core/src/policies.ts` | MODIFY         | Remove exported `rejectAfter`, add exported `withTimeout`, keep file-private `rejectAfter` |
| `packages/core/src/pipeline.ts` | MODIFY (import)| Change `rejectAfter` import to `withTimeout`; update both call sites      |

**No other files.** The public API of `@atisse/core` does not export from `policies.ts` — all policy exports are internal to the kernel.

### Import Update in `pipeline.ts`

```typescript
// BEFORE (line 33):
import { calculateDelay, rejectAfter, sleep, executeWithRetry } from './policies.js';

// AFTER:
import { calculateDelay, sleep, executeWithRetry, withTimeout } from './policies.js';
```

---

## 6. Implementation Strategy

### Step 1: Export `withTimeout`, Remove Exported `rejectAfter` in `policies.ts`

- Add `withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>` as a new exported function
- Remove `rejectAfter` from the export list on lines 172–183 (currently exported as named export)
- Keep the `rejectAfter` function itself as a file-private helper (remove `function` keyword export or move it above the export block without inclusion)

**Before (export block):**
```typescript
export {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT,
  DEFAULT_TOOL_POLICY,
  mergeRetryPolicy,
  mergeTimeoutPolicy,
  mergeToolPolicy,
  calculateDelay,
  rejectAfter,   // ← REMOVE
  sleep,
  executeWithRetry,
};
```

**After (export block):**
```typescript
export {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT,
  DEFAULT_TOOL_POLICY,
  mergeRetryPolicy,
  mergeTimeoutPolicy,
  mergeToolPolicy,
  calculateDelay,
  withTimeout,   // ← ADD
  sleep,
  executeWithRetry,
};
```

`rejectAfter` stays in the file as a private function used by `withTimeout` internally.

### Step 2: Update `pipeline.ts` Imports

- Replace `rejectAfter` with `withTimeout` in the import from `./policies.js`
- Update TypeScript to remove the unused import

### Step 3: Update Call Site 1 — Non-Streaming Total Timeout

Replace the `Promise.race` with `withTimeout` call.

### Step 4: Update Call Site 2 — Streaming Generate Timeout

Replace the `Promise.race` with `withTimeout` call. (This code will be removed by M008, but must be correct until then.)

### Step 5: Verify

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

### Step 6: Validate Fake Timer Compatibility

The existing test at `policies.test.ts` line 101 uses `vi.runAllTimersAsync()` with `rejectAfter`. After the change, `withTimeout` is used instead. The test MUST be updated to use `withTimeout`:

```typescript
// Update the 'rejectAfter' describe block to test 'withTimeout'
describe('withTimeout', () => {
  it('rejects with TimeoutExceededError after specified ms', async () => {
    const promise = withTimeout(new Promise(() => {}), 100);
    vi.runAllTimersAsync();
    await expect(promise).rejects.toThrow('Execution timed out after 100ms');
  });
});
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

1. **`withTimeout` resolves:** Wrapped promise resolves before timeout → `withTimeout` returns the result, timer is cleaned up
2. **`withTimeout` rejects (timeout):** Wrapped promise takes longer than `ms` → `TimeoutExceededError` is thrown
3. **`withTimeout` rejects (promise error):** Wrapped promise rejects before timeout → rejection propagates, timer is cleaned up
4. **`ms <= 0`:** No timeout wrapping — behaves as passthrough
5. **`rejectAfter` no longer exported:** Importing `rejectAfter` from `./policies.js` fails with a TypeScript error
6. **All existing tests pass:** `policies.test.ts`, `streaming.test.ts`, `streaming-timeout.test.ts`, streaming error tests
7. **Fake timer compatibility:** `vi.useFakeTimers()` + `vi.runAllTimersAsync()` + `withTimeout` works (existing test pattern)

---

## 8. Risk Assessment

| Risk                                                         | Likelihood | Impact | Mitigation                                                                                   |
| ------------------------------------------------------------ | ---------- | ------ | -------------------------------------------------------------------------------------------- |
| `finally` block runs before `Promise.race` completes         | Low        | Medium | `await` guarantees settlement before `finally` — standard Promise semantics                 |
| `clearTimeout` on already-fired timer is a no-op but wastes CPU | Low     | Low    | Negligible — one extra function call per timeout + race                                      |
| Test relies on `rejectAfter` export                          | High       | Low    | Only one test file (`policies.test.ts`) uses it — straightforward update                    |
| `ms <= 0` passthrough breaks existing callers                | Low        | Medium | Non-streaming path always has `totalTimeoutMs` > 0 (default 60_000). Streaming path default 30_000. Passthrough is safety net only. |
| `withTimeout` behaves differently from `rejectAfter` in edge cases | Low   | Medium | Semantics are identical for callers passing the result through `Promise.race` — the `Promise.race` is now inside `withTimeout` instead of outside |

---

## 9. References

- `packages/core/src/policies.ts` — Lines 99–105 (`rejectAfter`), lines 172–183 (exports)
- `packages/core/src/pipeline.ts` — Line 405 (non-streaming total timeout), lines 818–830 (streaming generate timeout)
- `packages/core/src/errors.ts` — `TimeoutExceededError` (lines 215–222)
- `packages/core/tests/unit/policies.test.ts` — Lines 97–105 (`rejectAfter` test)
- `packages/core/src/testing/mock-provider.ts` — `MockProvider` for streaming test control
- `.opencode/rules/constraints.md` — No plain Error throws, no synchronous blocking
- `.opencode/rules/philosophy.md` — Principle 6: Production-Ready Defaults (timer leaks are production-unready)
