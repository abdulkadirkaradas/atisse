# M008 — Streaming Chunk Buffering Fix

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA pipeline gaps analysis — TD-6 / Imp-3 (HIGH)

---

## 1. Task Summary

Replace the current collect-then-`Promise.race` approach for streaming chunk consumption with a per-chunk idle timeout pattern. Currently, `executeStreamingPipeline` collects ALL `StreamChunk` objects into an in-memory array before yielding any to the consumer, defeating the purpose of streaming and creating unbounded memory growth for large responses. The fix must preserve the `generateTimeoutMs` timeout but apply it as an idle-timeout between chunks rather than as a whole-stream timeout.

---

## 2. Context (Why This Exists)

### Current Behavior

In `packages/core/src/pipeline.ts`, lines 817–830:

```typescript
const chunks = await Promise.race([
  (async () => {
    const collected: StreamChunk[] = [];
    for await (const chunk of streamIterable) {
      collected.push(chunk);
      if (chunk.type === 'error') {
        streamError = chunk.error;
      }
    }
    return collected;
  })(),
  rejectAfter(config.timeout.generateTimeoutMs),
]);
```

The `Promise.race` wraps two promises:
1. An async IIFE that fully consumes the `AsyncIterable<StreamChunk>` into an array (`collected`)
2. `rejectAfter(generateTimeoutMs)` which rejects with `TimeoutExceededError`

After the race resolves (lines 832–864), the collected chunks are iterated and yielded to the consumer. This means:
- **No chunks reach the consumer until the entire stream is consumed** — defeats streaming's purpose
- **Unbounded memory growth** — a 100MB response sits entirely in the `collected` array
- **Timeout means total data loss** — if `rejectAfter` wins, the entire collected buffer is discarded, even though chunks were received successfully before the timeout
- **Mid-stream errors are detected but not actionable** — the `streamError` flag is set but the pipeline is already holding all chunks, so the consumer gets nothing until the loop finishes

### Affected Code Locations

| Location               | Lines     | Role                                        |
| ---------------------- | --------- | ------------------------------------------- |
| `pipeline.ts`          | 817–830   | Collect-then-race — THE BUG                 |
| `pipeline.ts`          | 832–864   | Post-collection chunk processing loop        |
| `pipeline.ts`          | 690–1064  | Entire `executeStreamingPipeline` function   |
| `policies.ts`          | 99–105    | `rejectAfter()` — timer used by the race     |

### What the Fix Must Preserve

- `config.timeout.generateTimeoutMs` must still be honored as a safety net against hanging streams
- `StreamChunk` yield order must be preserved (text deltas, then tool_calls, then done/error)
- `streamError` detection must continue to work for mid-stream provider errors
- Accumulated usage from `'done'` chunks and accumulated text must still be tracked
- `generateTimeoutMs === 0` means no timeout (currently the code injects `null` in the spread on line 749 — the `PromptRequest.signal` is already guarded; the stream consumption timeout must be guarded similarly)

---

## 3. Issues/Changes

### Issue: Streaming timeout collects ALL chunks before yielding

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| File        | `packages/core/src/pipeline.ts`                                                                  |
| Lines       | 817–830                                                                                          |
| Severity    | HIGH                                                                                             |
| Description | `Promise.race` wrapping entire stream consumption forces all chunks into memory before any yield |
| Fix         | Replace collect-then-race with per-chunk idle-timeout wrapper on the async iterator              |

---

## 4. Architectural Directives

### 4.1 New Internal Utility: `asyncIteratorWithIdleTimeout`

Create a file-private helper in `pipeline.ts` that wraps any `AsyncIterable<T>` with per-iteration timeout:

```typescript
/**
 * Wraps an AsyncIterable with a per-iteration idle timeout.
 * If the time between consecutive `next()` calls exceeds `timeoutMs`,
 * the wrapped iterator throws TimeoutExceededError.
 *
 * When timeoutMs <= 0, passthrough with no timeout wrapping.
 * Preserves yield order — each chunk is yielded as it arrives.
 *
 * File-private — NOT exported.
 */
async function* asyncIteratorWithIdleTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  onTimeout?: () => void,
): AsyncGenerator<T, void, undefined>;
```

**Design constraints:**
- MUST NOT collect chunks into an intermediate buffer — yield each chunk as it arrives from the inner iterator
- MUST use a per-iteration `Promise.race([next(), rejectAfter(timeoutMs)])` inside the `for await` loop, NOT wrapping the entire loop
- When `timeoutMs <= 0`, the function MUST be a transparent passthrough (no timeout overhead)
- MUST NOT add runtime dependencies — the timeout mechanism stays within `policies.ts` (using `rejectAfter`)
- MUST support an optional `onTimeout` callback for logging/metrics (called before throwing)
- The `onTimeout` parameter is optional — when not provided, the function just throws `TimeoutExceededError`

### 4.2 Required Signature of `rejectAfter` for the Cleanup Contract

The `rejectAfter` timer leak (addressed in M009) is a dependency of M008. SPBED MUST implement M009 **first**, then use the cleaned-up `rejectAfter` or `withTimeout` in M008.

The implementation MUST verify that the timer created for each per-chunk timeout is properly cleaned up when the next chunk arrives. If implementing as a combination of `rejectAfter` + manual `clearTimeout`, the `asyncIteratorWithIdleTimeout` generator MUST call `clearTimeout` on each loop iteration before awaiting the next `next()`.

**Reference pattern for the per-iteration loop:**

```typescript
const iterator = iterable[Symbol.asyncIterator]();
let result: IteratorResult<T>;

while (true) {
  // Per-chunk timeout via Promise.race
  const nextPromise = iterator.next();
  if (timeoutMs > 0) {
    result = await Promise.race([
      nextPromise,
      rejectAfter(timeoutMs),
    ]);
  } else {
    result = await nextPromise;
  }

  if (result.done) return;
  yield result.value;
}
```

**NOTE:** The above is an illustrative pattern. The actual implementation MUST be compatible with the M009 fix for `rejectAfter`. If M009 converts `rejectAfter` to a `withTimeout` wrapper with automatic timer cleanup, use that instead.

### 4.3 Replace the Collect-Then-Race Block

Replace lines 817–830 (the entire `const chunks = await Promise.race(...)` block and the subsequent `for (const chunk of chunks)` processing loop):

```typescript
// BEFORE:
const chunks = await Promise.race([...collected, rejectAfter(...)]);
for (const chunk of chunks) { ... }

// AFTER:
for await (const chunk of asyncIteratorWithIdleTimeout(
  streamIterable,
  config.timeout.generateTimeoutMs,
)) {
  // Process each chunk as it arrives (same switch logic as lines 833-863)
  switch (chunk.type) {
    case 'text': ...
    case 'tool_call': ...
    case 'done': ...
    case 'error': ...
    default: ...
  }
}
```

### 4.4 What NOT to Do

- Do NOT change the `StreamChunk` discriminated union — it is frozen
- Do NOT change `PromptRequest` — `signal` remains the per-request timeout; the idle timeout is a separate concern at the stream consumption level
- Do NOT remove `rejectAfter` from `policies.ts` — it still has valid uses (non-streaming `totalTimeoutMs`, tool timeout in `ToolController`)
- Do NOT change the `executeStreamingPipeline` function signature — it still yields `AsyncGenerator<StreamChunk>`
- Do NOT add `AbortSignal` logic to the idle timeout — that is a separate concern (M010)
- Do NOT change the behavior when `generateTimeoutMs === 0` — the current non-streaming path already handles this (line 749), and the idle timeout must match: `timeoutMs <= 0` → passthrough
- Do NOT remove the existing `promptRequest.signal` logic (lines 744–750) — the `AbortSignal.timeout` is still needed for the provider SDK's HTTP request timeout; the idle timeout is an additional safety net at the stream consumption layer

### 4.5 Error Propagation Rules

- If the idle timeout fires (no chunk received within `generateTimeoutMs`): throw `TimeoutExceededError(generateTimeoutMs)` — this is caught by the existing outer `catch` (lines 1041–1063) which yields `{ type: 'error', error: err }` and returns
- If the inner iterator throws (provider mid-stream error): the `for await` propagates the error to the outer `catch` which handles it via `handleOrchestratorError` — same as current behavior for non-chunk errors
- Mid-stream error chunks (`chunk.type === 'error'`) are yielded immediately to the consumer and the `streamError` flag is set — the loop continues to consume remaining chunks until the stream ends naturally or the idle timeout fires

---

## 5. Files to Modify

| File                            | Action          | Notes                                                                   |
| ------------------------------- | --------------- | ----------------------------------------------------------------------- |
| `packages/core/src/pipeline.ts` | MODIFY          | Replace lines 817–864: add `asyncIteratorWithIdleTimeout`, restructure stream consumption loop |
| `packages/core/src/pipeline.ts` | MODIFY (import) | Ensure `rejectAfter` remains imported from `./policies.js` (already present on line 33) |
| `packages/core/src/policies.ts` | MODIFY (M009)   | M009 fix must be in place first — `rejectAfter` timer cleanup           |

**No other files.** This is a pipeline-internal change. No public API changes.

---

## 6. Implementation Strategy

### Step 1: Implement M009 First

M009 (rejectAfter timer leak fix) MUST be implemented before M008. The per-chunk timeout creates and discards a timer on every iteration — without M009's cleanup, each chunk yielded leaks a timer handle.

### Step 2: Add `asyncIteratorWithIdleTimeout` to pipeline.ts

- Add the file-private generator function before `executeStreamingPipeline`
- Signature and behavior per Section 4.1
- Use `rejectAfter(timeoutMs)` from `policies.ts` (post-M009 fix) for the per-iteration timeout
- Handle `timeoutMs <= 0` as transparent passthrough

### Step 3: Restructure Stream Consumption in `executeStreamingPipeline`

- Remove the `const chunks = await Promise.race(...)` block (lines 817–830)
- Remove the `streamError` variable declaration (line 815) and all references to `streamError` (lines 823–825, 867–886)
- Replace with `for await (const chunk of asyncIteratorWithIdleTimeout(...))` loop
- The switch/case processing logic (lines 833–863) moves inside the new `for await` loop body
- Accumulated usage from `'done'` chunks continues to work
- `accumulatedText` updates happen per chunk as before

### Step 4: Handle `streamError` Removal

The `streamError` variable was used for mid-stream error chunks (lines 823–825 to set it, lines 867–886 to check it after collection). In the new per-chunk approach, `error` chunks are yielded immediately — there is no post-processing block. Remove:

- `let streamError: OrchestratorErrorClass | undefined;` declaration (line 815)
- The `if (chunk.type === 'error') { streamError = chunk.error; }` inside the old collection IIFE (lines 823–825)
- The entire `if (streamError) { ... }` block (lines 867–886)

The `'error'` chunk is yielded to the consumer inside the switch, and the loop continues. After the loop completes normally, the pipeline proceeds to build `response` and check `finishReason` as before. If an error chunk was received, the consumer already got it — the pipeline should still attempt to construct a response from whatever chunks were received.

**NOTE:** The `response` construction (lines 889–894) must still handle the case where `accumulatedText` is empty due to an early error chunk. This is already handled by the existing code — `response.text` will be `''` and `response.finishReason` will be `'stop'` or `'tool_calls'`. The `afterGenerate` hooks will fire normally. The consumer already received the error chunk and can act on it.

### Step 5: Verify

Run full test suite — all streaming tests must pass.

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

1. **Streaming with idle timeout:** Stream that pauses between chunks longer than `generateTimeoutMs` → `TimeoutExceededError` thrown, `{ type: 'error' }` chunk yielded
2. **Streaming within idle timeout:** Stream that delivers chunks within `generateTimeoutMs` → all chunks yielded normally, `{ type: 'done' }` chunk yielded
3. **`generateTimeoutMs === 0`:** No timeout wrapping — stream delivered normally regardless of inter-chunk delay
4. **Mid-stream error chunk:** Provider yields `{ type: 'error' }` → chunk yielded immediately to consumer, pipeline continues to completion
5. **Tool calls in streaming:** `tool_call` chunks yielded immediately, `tool_result` chunks yielded after execution
6. **Memory bound:** Large stream (1000+ chunks) does not accumulate all chunks in memory before yielding — verify via test that intermediate chunks are yielded
7. **All existing streaming tests pass:** `streaming.test.ts`, `streaming-hooks.test.ts`, `streaming-error.test.ts`, `streaming-retry.test.ts`, `streaming-timeout.test.ts`

### If a Test Fails:

1. Check whether the test was relying on the buggy collect-before-yield behavior (unlikely)
2. Check whether the test was asserting about the intermediate `collected` array (impossible — it was file-private)
3. If a streaming timeout test fails, verify the timeout timing changed from "whole-stream timeout" to "per-chunk idle timeout" — the test may need updated expectations about WHEN the timeout fires, not WHETHER it fires
4. If uncertain, return to SPSA for guidance

---

## 8. Risk Assessment

| Risk                                                   | Likelihood | Impact | Mitigation                                                                                      |
| ------------------------------------------------------ | ---------- | ------ | ----------------------------------------------------------------------------------------------- |
| Per-chunk timer creation/destruction in tight loop     | Medium     | Low    | Each chunk creates one timer — at ~10 chunks/s this is negligible. Timer cleanup via M009 fix.  |
| Behavior change for `generateTimeoutMs` semantics      | Medium     | Low    | Semantics shift from "timeout on total stream duration" to "idle timeout between chunks". Documented clearly. Both are valid timeout policies. |
| `streamError` removal breaks error handling            | Low        | Medium | Error chunks are yielded immediately — consumer sees them. Pipeline still reaches completion.   |
| Idle timeout fires during long tool execution pause    | Low        | Medium | Tool execution happens AFTER stream consumption completes (the `for await` loop finishes before tool execution). No timeout risk. |
| Per-chunk timeout delays stream termination on error   | Low        | Low    | After an error chunk, `for await` continues until iterator `done`. Provider stream typically terminates quickly after error. |
| `rejectAfter` not yet fixed (M009 dependency)          | N/A        | HIGH   | **Hard dependency.** M008 MUST NOT be implemented before M009. Each per-chunk iteration creates a timer that must be cleaned up. |

---

## 9. References

- `.opencode/rules/architecture.md` — Streaming Execution Flow section
- `.opencode/rules/interfaces-core.md` — `StreamChunk` discriminated union, `AIProvider.generateStream`
- `.opencode/rules/interfaces-runtime.md` — `RunInput.stream`, timeout policy
- `.opencode/rules/constraints.md` — streaming + fallback forbidden
- `.opencode/workflows/testing-standards.md` — `MockProvider` streaming behavior
- `.opencode/workflows/observability-standards.md` — Required log points for streaming
- `packages/core/src/pipeline.ts` — Lines 690–1064 (`executeStreamingPipeline`)
- `packages/core/src/policies.ts` — `rejectAfter()` (pre-M009 fix)
- `packages/core/src/errors.ts` — `TimeoutExceededError`
- `packages/core/src/testing/mock-provider.ts` — `MockProviderStreamEntry` for test control
