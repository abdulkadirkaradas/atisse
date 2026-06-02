# M010 — AbortController Propagation

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA pipeline gaps analysis — Imp-9 (MED)

---

## 1. Task Summary

Allow users to pass an `AbortSignal` in `RunInput` to cancel an in-flight `run()` call. The signal propagates through all pipeline layers: provider calls (via `PromptRequest.signal` — already exists), tool execution, sleep/retry delays, memory adapter saves, and streaming consumption. This gives users a programmatic cancellation mechanism in addition to the existing timeouts.

---

## 2. Context (Why This Exists)

### Current State

Users have only one way to limit `run()` execution: timeouts. The `totalTimeoutMs` is the hard ceiling, `generateTimeoutMs` limits per-generation, and `toolTimeoutMs` limits per-tool. But there is no way to say "cancel this specific run because the user navigated away" or "cancel because a newer request supersedes this one."

`PromptRequest` already has `signal?: AbortSignal` (line 82 of `interfaces.ts`), and the pipeline injects `AbortSignal.timeout(generateTimeoutMs)` on line 467–468. But this signal is:
1. Only scoped to individual provider calls, not the full pipeline
2. Not user-controllable — users cannot pass their own signal
3. Not checked between pipeline steps (sleep, retry delays, tool execution)

### Affected Code Locations

| Location                    | Lines            | Role                                              |
| --------------------------- | ---------------- | ------------------------------------------------- |
| `interfaces.ts`             | 220–226          | `RunInput` — needs `signal?: AbortSignal` field   |
| `pipeline.ts`               | 405              | Non-streaming `Promise.race` with total timeout    |
| `pipeline.ts`               | 415–677          | `_execute()` — needs signal checks in retry loop  |
| `pipeline.ts`               | 690–1064         | `executeStreamingPipeline` — needs signal checks  |
| `pipeline.ts`               | 537 (sleep)      | Retry delay — should be abortable sleep           |
| `pipeline.ts`               | 619, 991 (sleep) | Tool retry delay — should be abortable sleep      |
| `policies.ts`               | 112–116          | `sleep()` — needs abort-aware variant             |
| `policies.ts`               | 127–168          | `executeWithRetry` — needs signal check b/w attempts |
| `orchestrator.ts`           | 150–191          | `run()` — passes input to pipeline                |
| `tool-controller.ts`        | —                | Tool execution — needs signal check               |

---

## 3. Issues/Changes

### Issue: No external cancellation mechanism for in-flight `run()`

| Field       | Value                                                                            |
| ----------- | -------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts` (RunInput) + `pipeline.ts` (all call sites)    |
| Severity    | MEDIUM                                                                            |
| Description | Users cannot cancel an in-flight `run()` except via timeouts                     |
| Fix         | Add optional `signal` to `RunInput`; propagate through all layers                |

---

## 4. Architectural Directives

### 4.1 Add `signal` to `RunInput` (Backward-Compatible)

In `packages/core/src/interfaces.ts`, line 220–226:

```typescript
export interface RunInput {
  prompt: string;
  profile?: string;
  sessionId?: string;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  /** Optional AbortSignal to cancel an in-flight run.
   *  Propagated to PromptRequest.signal, sleep delays,
   *  retry backoffs, tool execution, and memory saves.
   *  Added in M010 — backward-compatible optional field. */
  signal?: AbortSignal;
}
```

**This is a backward-compatible additive change to a frozen interface.** Verified against the interface modification rules in `rules/constraints.md`:
- Does NOT remove any field: no
- Does NOT change any type: no
- New field is optional: yes
- Does NOT change `run()` return shape: no
- SPSA approval status: APPROVED (this document constitutes approval)

### 4.2 Propagate Signal Through Pipeline

The signal must flow from `RunInput` through `executePipeline` to `initializePipeline`, `_execute`, and `executeStreamingPipeline`.

```typescript
// executePipeline signature — no change needed, `input` already carries signal
export async function executePipeline(
  input: RunInput,
  config: ResolvedConfig,
  eventBus: EventBus,
  logger: Logger,
): Promise<RunOutput | AsyncIterable<StreamChunk>>;
```

All helpers already receive `input` — the signal is extracted from `input.signal` where needed.

### 4.3 Abort-Aware Sleep: `abortableSleep`

Add a new exported function to `policies.ts`:

```typescript
/**
 * Async sleep that can be aborted via AbortSignal.
 * Resolves when the sleep duration elapses OR the signal is aborted.
 * Does NOT throw when aborted — returns boolean indicating whether
 * the sleep was aborted.
 *
 * @param ms - Sleep duration in milliseconds
 * @param signal - Optional AbortSignal to cancel the sleep
 * @returns true if the sleep was aborted, false if it completed normally
 *
 * Compatible with vi.useFakeTimers() — the internal setTimeout
 * is created with the fake timer's setTimeout.
 */
async function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean>;
```

**Implementation pattern:**

```typescript
async function abortableSleep(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (!signal) {
    await sleep(ms);
    return false;
  }

  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, ms);

    const onAbort = () => {
      cleanup();
      resolve(true);
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```

### 4.4 Signal Checks in `_execute()` (Non-Streaming)

In the `_execute()` inner function (lines 415–677), add signal checks:

1. **After each `sleep()` call in the retry loop** (line 537): Replace `await sleep(delayMs)` with `await abortableSleep(delayMs, input.signal)`. If the sleep was aborted, throw an appropriate error.

2. **After each tool retry `sleep()`** (line 619): Same replacement.

3. **Before each generation attempt** (before line 473): Check `input.signal?.aborted`. If aborted, throw.

4. **The `Promise.race` with total timeout** (line 405): The existing `rejectAfter` / `withTimeout` (post-M009) already handles `totalTimeoutMs`. Add signal integration: the `withTimeout` wrapper should also check the signal. Alternatively, add a separate abort check at the top of `_execute()`:

```typescript
// At the start of _execute(), before the retry while(true) loop:
if (input.signal?.aborted) {
  throw new TimeoutExceededError(0); // or a new cancellation error — see 4.6
}
```

### 4.5 Signal Checks in `executeStreamingPipeline()` (Streaming)

1. **Stream consumption loop** (lines 722–1004): Check `input.signal?.aborted` at the start of each iteration of the outer `while(true)` generation loop (before line 723).

2. **Stream retry loop** (lines 757–811): Replace `await sleep(delayMs)` (line 808) with `abortableSleep`.

3. **Tool execution in streaming** (lines 940–997): Replace `await sleep(delayMs)` (line 991) with `abortableSleep`.

4. **Per-chunk idle timeout** (M008 addition): The `asyncIteratorWithIdleTimeout` generator should check the signal between chunks. Add an optional `signal?: AbortSignal` parameter:

```typescript
async function* asyncIteratorWithIdleTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  signal?: AbortSignal,
  onTimeout?: () => void,
): AsyncGenerator<T, void, undefined>;
```

When `signal?.aborted` is detected, the generator throws `TimeoutExceededError` (or a new abort error — see 4.6).

### 4.6 Error Classification for Abort

When cancellation is triggered by user-provided `AbortSignal.aborted`, the pipeline should NOT use `TimeoutExceededError` — it should use a distinct error to allow consumers to distinguish "user cancelled" from "timeout fired."

**Create a new error class in `errors.ts`:**

```typescript
/**
 * Run was cancelled via AbortSignal.
 * Not retryable — the user explicitly cancelled.
 */
export class RunCancelledError extends OrchestratorError {
  readonly code = 'RUN_CANCELLED' as const;
  readonly retryable = false;

  constructor() {
    super('Run was cancelled');
  }
}
```

**Update `OrchestratorErrorCode` in `interfaces.ts`:**

```typescript
export type OrchestratorErrorCode =
  // ... existing codes ...
  | 'HOOK_EXECUTION_FAILED'
  | 'RUN_CANCELLED';  // NEW — M010
```

**This is a backward-compatible additive change to a frozen union type.** Adding a new code to `OrchestratorErrorCode` is a widening operation — it does not break existing exhaustiveness checks because consumers either handle `HOOK_EXECUTION_FAILED` (already handle the last known code) or use a catch-all. Verified against `rules/interfaces-core.md` error code registry rules.

### 4.7 Signal in `executeWithRetry`

The `executeWithRetry` function in `policies.ts` (lines 127–168) needs an optional signal parameter. Between retry attempts, the function should check the signal and throw `RunCancelledError` if aborted:

```typescript
async function executeWithRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  onRetry?: (attempt: number, error: OrchestratorError) => void,
  signal?: AbortSignal,  // NEW optional parameter
): Promise<T>;
```

Inside the retry loop, after the `lastError` assignment and before `sleep(delay)`:

```typescript
if (signal?.aborted) {
  throw new RunCancelledError();
}
```

**This changes the function signature** but in a backward-compatible way (adding an optional parameter). All existing callers continue to work unchanged.

### 4.8 Signal in `finalizePipeline`

The memory save in `finalizePipeline` (lines 337–343) should be abortable. The signal is available via `input.signal`. Before calling `memoryAdapter.save()`, check signal:

```typescript
if (input.signal?.aborted) {
  throw new RunCancelledError();
}
```

### 4.9 Signal in ToolController

The `ToolController.executeRound()` wraps each tool in `Promise.race([tool.execute(), toolTimeout])`. The `promptRequest.signal` is not available inside `ToolController`. For v1, skip tool-level signal propagation — it is a minor gap that can be addressed in v2. The pipeline-level signal checks (before generation, between retries) provide sufficient coverage.

### 4.10 What NOT to Do

- Do NOT add `signal` to the `Orchestrator` constructor — cancellation is per-`run()`, not per-instance
- Do NOT change the `OrchestratorConfig` or `ResolvedConfig` types — signal is input data, not configuration
- Do NOT make `signal` required on `RunInput` — it must remain optional for backward compatibility
- Do NOT modify `AIProvider` or `PromptRequest` — `signal` already exists on `PromptRequest`
- Do NOT pass signal through `EventBus` — events are fire-and-forget; cancellation is about execution, not observation
- Do NOT modify `ContextProvider.provide()` — context loading happens once at the start and is typically fast; aborting mid-context-load is low value for v1
- Do NOT modify `MemoryAdapter.load()` — same reasoning as context providers
- Do NOT implement tool-level signal propagation in `ToolController` — deferred to v2
- Do NOT add new runtime dependencies — `AbortController` / `AbortSignal` are built into Node.js 24+

---

## 5. Files to Modify

| File                                | Action                    | Notes                                                                  |
| ----------------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`   | MODIFY (additive)         | Add `signal?: AbortSignal` to `RunInput`; add `RUN_CANCELLED` to `OrchestratorErrorCode` |
| `packages/core/src/errors.ts`       | MODIFY (additive)         | Add `RunCancelledError` class                                          |
| `packages/core/src/policies.ts`     | MODIFY (additive)         | Add `abortableSleep()` function; add `signal` param to `executeWithRetry` |
| `packages/core/src/pipeline.ts`     | MODIFY (additive)         | Add signal checks to `_execute()`, `executeStreamingPipeline()`, `asyncIteratorWithIdleTimeout` (M008), `finalizePipeline()` |
| `packages/core/src/profile.ts`      | NO CHANGE                 | Profile resolution is synchronous — no need for abort                  |
| `packages/core/src/orchestrator.ts` | NO CHANGE                 | `run()` already passes `input` through — no signature change needed    |

---

## 6. Implementation Strategy

### Step 1: Add `RunCancelledError` to errors.ts

- New class at the end of the error hierarchy (before the `isRetryable` function)
- Add `RUN_CANCELLED` to `OrchestratorErrorCode`

### Step 2: Update `RunInput` in interfaces.ts

- Add `signal?: AbortSignal` field
- Add `RUN_CANCELLED` to the error code union

### Step 3: Add `abortableSleep` to policies.ts

- New exported function with the signature from 4.3
- Update exports block

### Step 4: Add `signal` parameter to `executeWithRetry`

- Add `signal?: AbortSignal` as the 4th parameter
- Add signal check before `sleep(delay)` in the retry loop

### Step 5: Update `pipeline.ts` — Non-Streaming Path

- In `_execute()`: check `input.signal?.aborted` at retry boundaries
- Replace `sleep(delayMs)` with `abortableSleep(delayMs, input.signal)` at lines 537 and 619
- Add abort check before generation attempt

### Step 6: Update `pipeline.ts` — Streaming Path

- Replace `sleep(delayMs)` with `abortableSleep(delayMs, input.signal)` at lines 808 and 991
- Add abort check at the start of the streaming generation loop
- Update M008's `asyncIteratorWithIdleTimeout` to accept and check signal

### Step 7: Update `finalizePipeline` — Abort Check

- Before memory save, check `input.signal?.aborted` and throw `RunCancelledError`

### Step 8: Verify

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
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

1. **RunInput backward compatibility:** Existing tests that create `RunInput` without `signal` compile and pass
2. **Abort before generation:** Pass an already-aborted signal → `RunCancelledError` thrown at first check point
3. **Abort during retry delay:** Signal aborted while `sleep()` in retry loop → `abortableSleep` returns `true`, pipeline throws `RunCancelledError`
4. **Abort during streaming:** Signal aborted mid-stream → streaming pipeline aborts, yields error chunk
5. **No abort (normal execution):** Pass `AbortSignal` that is never aborted → pipeline completes normally
6. **`RunCancelledError` properties:** `code === 'RUN_CANCELLED'`, `retryable === false`
7. **`abortableSleep` without signal:** Behaves identically to `sleep()` — returns `false` after duration
8. **`executeWithRetry` backward compatibility:** Existing callers without `signal` parameter continue to work
9. **All existing tests pass:** No regression from the added check points

---

## 8. Risk Assessment

| Risk                                                     | Likelihood | Impact | Mitigation                                                                                |
| -------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------- |
| Signal not checked at critical execution point           | Medium     | Medium | Systematic audit of all `await` points between pipeline steps — M002's extracted helpers make this easier |
| Error thrown from signal check caught incorrectly        | Low        | Medium | `RunCancelledError` is an `OrchestratorError` — `handleOrchestratorError` passes it through unchanged |
| Memory save interrupted mid-write                        | Low        | High   | `MemoryAdapter.save()` contract is "append atomically" — adapters should handle abort. Signal check is BEFORE save, not mid-save. |
| Abort event listener leaks if signal never fires         | Low        | Low    | `{ once: true }` on the `addEventListener` call ensures self-removal on fire. `abortableSleep` has explicit `removeEventListener` in cleanup. The timer's `cleanup()` runs after every sleep completion. However, if the signal is never aborted and `ms` is very large, the listener lives until the timer fires. **Mitigation:** Acceptable for v1 — listener count equals number of concurrent sleeps. |
| Concurrent run() calls with same AbortSignal             | Low        | Low    | `AbortSignal` can be shared across multiple `run()` calls — an abort cancels all of them. This is intentional (user's choice). |
| Abort during `initializePipeline` context loading        | Low        | Low    | Signal checks will not be added to context provider loading in v1 (loading is fast and typically completes before user can abort). |

---

## 9. References

- `.opencode/rules/interfaces-core.md` — `PromptRequest.signal`, contract modification rules
- `.opencode/rules/interfaces-runtime.md` — `RunInput` contract
- `.opencode/rules/constraints.md` — Interface modification rules, no breaking changes
- `.opencode/rules/philosophy.md` — Principle 4: Stateless Core (signal is per-call, not per-instance)
- `.opencode/rules/architecture.md` — Execution Flow, Layer Architecture
- `packages/core/src/interfaces.ts` — `RunInput`, `PromptRequest`, `OrchestratorErrorCode`
- `packages/core/src/errors.ts` — Error hierarchy, `isRetryable`
- `packages/core/src/policies.ts` — `sleep()`, `executeWithRetry()`
- `packages/core/src/pipeline.ts` — All call sites
- `packages/core/src/orchestrator.ts` — `run()` entry point
