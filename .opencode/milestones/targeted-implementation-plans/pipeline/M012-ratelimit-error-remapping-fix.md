# M012 — ProviderRateLimitError Remapping Fix

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA pipeline gaps analysis — TD-10 (LOW)

---

## 1. Task Summary

Fix the OpenAI adapter's `mapErrorToOrchestratorError` method which incorrectly wraps `ProviderRateLimitError` (and other typed errors) back into `ProviderUnavailableError`, losing the `retryAfterMs` metadata and preventing downstream retry-after handling in the delay calculation.

---

## 2. Context (Why This Exists)

### Current Behavior

The OpenAI adapter has **two** error mapping functions:

1. **`mapError()`** (lines 303–349) — used in the non-streaming `generate()` path. Correctly maps HTTP 429 to `ProviderRateLimitError` with `retryAfterMs` extracted from the `Retry-After` header. Also correctly maps 401→`ProviderAuthError`, 408→`ProviderTimeoutError`, 500+→`ProviderUnavailableError`.

2. **`mapErrorToOrchestratorError()`** (lines 283–301) — used in `assembleStreamingChunks()` (the streaming path's catch handler, line 277). **This is the bug.** It takes already-correctly-mapped errors and wraps them back into `ProviderUnavailableError`:

```typescript
private mapErrorToOrchestratorError(error: unknown): ProviderUnavailableError {
  if (error instanceof ProviderRateLimitError) {
    return new ProviderUnavailableError('Rate limit exceeded', error);  // BUG
  }
  if (error instanceof ProviderAuthError) {
    return new ProviderUnavailableError('Authentication failed', error); // BUG
  }
  // ...
}
```

This means:
- A streaming mid-stream HTTP 429 starts as `ProviderRateLimitError` (via `mapError` in `generateStream`'s outer try/catch)
- OR it enters `assembleStreamingChunks`'s inner catch as a raw error
- Either way, `mapErrorToOrchestratorError` converts it to `ProviderUnavailableError`
- `retryAfterMs` is lost
- The pipeline's `calculateDelay()` (which checks `error instanceof ProviderRateLimitError`) never sees the rate limit error, so it uses exponential backoff instead of the provider's requested `retry-after`

The **Anthropic** adapter has no such issue — it uses `toOrchestratorError()` consistently in both the non-streaming and streaming paths, correctly returning `ProviderRateLimitError` for 429.

### Affected Code Locations

| File                              | Lines           | Role                                         |
| --------------------------------- | --------------- | -------------------------------------------- |
| `provider-openai/src/index.ts`    | 283–301         | `mapErrorToOrchestratorError()` — THE BUG   |
| `provider-openai/src/index.ts`    | 276–281         | Call site in `assembleStreamingChunks()`     |
| `provider-openai/src/index.ts`    | 165–168, 205–208| `mapError()` — correctly used in non-streaming |

---

## 3. Issues/Changes

### Issue: Streaming error mapping loses error semantics

| Field       | Value                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------- |
| File        | `packages/provider-openai/src/index.ts`                                                     |
| Lines       | 283–301                                                                                     |
| Severity    | LOW                                                                                         |
| Description | `mapErrorToOrchestratorError` wraps typed errors into `ProviderUnavailableError`, losing type info |
| Fix         | Replace with pass-through: return the error as-is if it's already an `OrchestratorError`    |

---

## 4. Architectural Directives

### 4.1 Fix `mapErrorToOrchestratorError` — Pass Through Already-Correct Errors

The simplest and most correct fix: **remove the remapping logic entirely.** The `assembleStreamingChunks` catch handler already has access to the original error. If `generateStream` (the outer function) catches the raw error, it passes through `mapError` which correctly classifies it. Then `assembleStreamingChunks`'s inner catch gets either:

- An already-correctly-mapped `OrchestratorError` (if `generateStream`'s try/catch wrapped it)
- A raw SDK error thrown mid-stream (which `assembleStreamingChunks`'s inner `for await` catch receives)

Replace the entire `mapErrorToOrchestratorError` function with a simple pass-through:

```typescript
private mapErrorToOrchestratorError(error: unknown): OrchestratorError {
  if (error instanceof OrchestratorError) {
    return error;
  }

  // Convert raw errors using the same logic as mapError
  const err = error as OpenAIErrorResponse;
  if (err.status !== undefined) {
    // Reuse the same mapping as the non-streaming path
    return this.mapError(error);
  }

  // Fallback for truly unknown errors
  return new ProviderUnavailableError('Provider unavailable', error);
}
```

**Actually, even simpler:** Remove `mapErrorToOrchestratorError` entirely and use `mapError` directly. The `mapError` function already throws (`never` return type) — change the `assembleStreamingChunks` catch to not call `mapErrorToOrchestratorError` and instead use the same `mapError` call as the non-streaming path.

**Recommended approach:**

Replace the catch in `assembleStreamingChunks` (line 277):

```typescript
// BEFORE:
} catch (error: unknown) {
  const mappedError = this.mapErrorToOrchestratorError(error);
  yield { type: 'error', error: mappedError };
  return;
}

// AFTER:
} catch (error: unknown) {
  try {
    this.mapError(error); // throws the correctly-classified error
  } catch (mapped: unknown) {
    yield { type: 'error', error: mapped as OrchestratorError };
    return;
  }
}
```

Or, even simpler: **remove `mapErrorToOrchestratorError` entirely** and replace the `catch` body with a direct pass-through:

```typescript
// SIMPLEST APPROACH:
} catch (error: unknown) {
  yield {
    type: 'error',
    error: error instanceof OrchestratorError
      ? error
      : new ProviderUnavailableError('Provider unavailable', error),
  };
  return;
}
```

**The SPSA recommends the simplest approach:** Remove the `mapErrorToOrchestratorError` method entirely (it is private and only used in one place). In the `assembleStreamingChunks` catch handler, check if the error is already an `OrchestratorError` (pass through) or wrap it in `ProviderUnavailableError`. This is safe because:

- If the error comes from `generateStream`'s outer try/catch (lines 205–208), `mapError()` was already applied — it's already an `OrchestratorError`
- If the error is a raw SDK error thrown mid-stream (from `for await`), it was NOT mapped by `mapError()` — it should be wrapped in `ProviderUnavailableError`

### 4.2 Update MockProvider to Support RateLimit Testing

The `MockProvider` (`packages/core/src/testing/mock-provider.ts`) should be able to inject `ProviderRateLimitError` for testing the remapping fix. This is already supported — `MockProvider.failureOnCall()` accepts any `OrchestratorError`. The existing tests in `http-status-mapping.test.ts` already test the non-streaming 429 mapping. No changes needed to MockProvider for the fix itself, but SPBED should add a streaming-specific test.

### 4.3 What NOT to Do

- Do NOT change `ProviderRateLimitError` — it already exists with `retryAfterMs?: number` parameter (correct)
- Do NOT change `ProviderUnavailableError` — it is still correct for HTTP 500+ errors
- Do NOT change the kernel pipeline's error handling — the pipeline already correctly checks `error instanceof ProviderRateLimitError` in `calculateDelay` (policies.ts line 79)
- Do NOT add the `ProviderRateLimitError` to the `isRetryable` false list — it is already `retryable: true`
- Do NOT change the Anthropic adapter — it already has correct behavior
- Do NOT change the `StreamChunk['error']` type — it accepts `OrchestratorError`, so `ProviderRateLimitError` is valid

---

## 5. Files to Modify

| File                                  | Action            | Notes                                                              |
| ------------------------------------- | ----------------- | ------------------------------------------------------------------ |
| `packages/provider-openai/src/index.ts` | MODIFY (remove + simplify) | Remove `mapErrorToOrchestratorError`; fix `assembleStreamingChunks` catch |
| `packages/provider-openai/tests/unit/http-status-mapping.test.ts` | MODIFY (additive) | Add streaming-specific test for 429 → ProviderRateLimitError |

---

## 6. Implementation Strategy

### Step 1: Remove `mapErrorToOrchestratorError`

Delete the private method entirely (lines 283–301).

### Step 2: Fix `assembleStreamingChunks` Catch

Replace lines 276–281 with the pass-through pattern from 4.1.

### Step 3: Add Test Coverage

Add a test in `http-status-mapping.test.ts` that verifies streaming (via `generateStream`) correctly preserves `ProviderRateLimitError`:

```typescript
it('should preserve ProviderRateLimitError in streaming path', async () => {
  const mockError = {
    status: 429,
    message: 'Rate limit exceeded',
    cause: new Error('Rate limit'),
    response: {
      headers: {
        get: (key: string) => (key === 'Retry-After' ? '30' : null),
      },
    },
  };

  const mockCreateFn = vi.fn().mockRejectedValue(mockError);
  const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

  const iterable = await provider.generateStream({
    messages: [{ role: 'user', content: 'Hi' }],
  });

  const chunks: StreamChunk[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }

  expect(chunks).toHaveLength(1);
  expect(chunks[0].type).toBe('error');
  if (chunks[0].type === 'error') {
    expect(chunks[0].error).toBeInstanceOf(ProviderRateLimitError);
    expect((chunks[0].error as ProviderRateLimitError).retryAfterMs).toBe(30000);
  }
});
```

### Step 4: Verify

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

---

## 7. Verification Requirements

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

### Specific assertions:

1. **Streaming HTTP 429 → `ProviderRateLimitError`:** `generateStream` with 429 error returns `{ type: 'error', error: ProviderRateLimitError }` with `retryAfterMs: 30000`
2. **Streaming HTTP 429 without Retry-After:** `retryAfterMs` is `undefined`
3. **Non-streaming HTTP 429 still works:** Existing tests pass unchanged
4. **`mapErrorToOrchestratorError` removed:** Method no longer exists on `OpenAIProvider`
5. **All existing tests pass:** No behavioral change to non-streaming path, Anthropic path, or pipeline

---

## 8. Risk Assessment

| Risk                                                  | Likelihood | Impact | Mitigation                                              |
| ----------------------------------------------------- | ---------- | ------ | ------------------------------------------------------- |
| Removing private method breaks something              | Low        | Low    | `mapErrorToOrchestratorError` is private, called once. TypeScript catches any missed reference. |
| `assembleStreamingChunks` catch catches wrong error type | Low      | Low    | `instanceof OrchestratorError` check is correct; raw errors wrapped as before |
| Streaming error propagation changes behavior          | Low        | Low    | Consumer already sees `{ type: 'error' }` — only the error TYPE changes, not the control flow |

---

## 9. References

- `packages/provider-openai/src/index.ts` — Lines 283–301 (`mapErrorToOrchestratorError`), 276–281 (catch call site), 303–349 (`mapError`)
- `packages/provider-anthropic/src/index.ts` — Lines 496–524 (`toOrchestratorError` — correct reference implementation)
- `packages/core/src/errors.ts` — `ProviderRateLimitError`, `ProviderUnavailableError`, `OrchestratorError`
- `packages/core/src/policies.ts` — `calculateDelay()` line 79 (instanceof ProviderRateLimitError check)
- `packages/provider-openai/tests/unit/http-status-mapping.test.ts` — Existing non-streaming 429 test
- `.opencode/rules/error-taxonomy.md` — Error hierarchy and retryable classification
- `.opencode/rules/constraints.md` — No plain Error throws
