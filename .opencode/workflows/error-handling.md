# ERROR HANDLING

## How to Handle and Throw Errors Correctly

---

## Golden Rules

1. **Never throw plain `Error`** — always throw a typed `OrchestratorError` subclass
2. **Never catch and swallow** — let the kernel's policy engine decide
3. **Never lose the cause** — always pass `cause` to preserve the original stack trace
4. **Type your catches** — use `error: unknown`, then narrow
5. **Distinguish retryable from fatal** — the error class declares this, not the caller

---

## Throwing Errors

### In Adapters (Provider / Memory / Context)

Map external errors to the correct kernel error type:

```typescript
// CORRECT
try {
  return await this.client.generate(params);
} catch (error: unknown) {
  if (error instanceof Error) {
    const status = (error as any).status;
    if (status === 429) throw new ProviderRateLimitError(error.message, undefined, error);
    if (status === 401) throw new ProviderAuthError(error.message, error);
    if (status >= 500) throw new ProviderUnavailableError(error.message, error);
  }
  throw new ProviderUnavailableError('Unexpected error', error);
}

// WRONG — plain Error loses retry context
throw new Error('Rate limited');

// WRONG — swallowing the cause
throw new ProviderRateLimitError('Rate limited'); // no cause = lost stack trace
```

### In Hooks

Hooks throw to abort execution:

```typescript
// CORRECT — throw a typed error to abort with context
hooks: {
  beforeRun: [
    async (ctx) => {
      if (isBlocked(ctx.input)) {
        throw new PolicyError('Content blocked by moderation policy');
      }
      return ctx;
    },
  ];
}

// WRONG — throwing plain Error (still works but loses type info)
throw new Error('Blocked');
```

### In Tools

Tools throw to signal execution failure:

```typescript
execute: async (input: unknown) => {
  // Validate first — ToolValidationError is FATAL (won't retry)
  const parsed = mySchema.safeParse(input);
  if (!parsed.success) {
    throw new ToolValidationError(
      'calculator',
      parsed.error.errors.map((e) => e.message),
    );
  }

  // Execution failure — ToolExecutionError is RETRYABLE
  try {
    return await externalApi.call(parsed.data);
  } catch (error: unknown) {
    throw new ToolExecutionError('calculator', error);
  }
};
```

---

## Catching Errors

### In the kernel / pipeline

```typescript
// Narrow to unknown, then check type
try {
  result = await provider.generate(request);
} catch (error: unknown) {
  if (!isRetryable(error)) throw error; // FATAL — rethrow immediately
  // retryable — handle in retry loop
  lastError = error;
}
```

### In user code

```typescript
try {
  const result = await orchestrator.run({ prompt });
} catch (error: unknown) {
  if (error instanceof ProviderAuthError) {
    // configuration problem — tell user to check API key
    return res.status(500).json({ error: 'AI service configuration error' });
  }
  if (error instanceof MaxRetriesExceededError) {
    // transient — user can retry later
    return res.status(503).json({ error: 'AI service temporarily unavailable' });
  }
  if (error instanceof FallbackExhaustedError) {
    // both providers down — alert on-call
    alerting.critical('ALL_LLM_PROVIDERS_DOWN');
    return res.status(503).json({ error: 'Service unavailable' });
  }
  if (error instanceof TokenLimitExceededError) {
    // user input too long — tell user
    return res.status(400).json({ error: 'Input too long' });
  }
  // Unexpected — rethrow or log as unknown
  throw error;
}
```

---

## Error Context Preservation

Always include `cause` when wrapping errors:

```typescript
// CORRECT — full stack trace preserved through cause chain
throw new ProviderUnavailableError('OpenAI 503', originalError);

// WRONG — original stack trace lost
throw new ProviderUnavailableError('OpenAI 503');
```

---

## The `isRetryable()` Helper

```typescript
import { isRetryable } from '@atisse/core';

// Returns true only for OrchestratorError instances with retryable === true
// Unknown errors return false — treated as FATAL by default
if (!isRetryable(error)) throw error;
```

---

## Event Bus Error Isolation

Event listeners MUST NOT throw. Wrap listener code in try/catch:

```typescript
orchestrator.on('run.failed', (event) => {
  try {
    errorTracker.capture(event.error);
  } catch {
    // silently ignore — listener failure must never affect the kernel
  }
});
```

---

## Error Message Guidelines

- Describe WHAT happened, not HOW it happened internally
- Include relevant identifiers (toolName, sessionId, attempt count)
- Do NOT include secrets, API keys, or raw HTTP bodies
- Do NOT expose internal system paths or implementation details

```typescript
// CORRECT
throw new ToolExecutionError('web_search', error);
// message: "Tool execution failed: web_search"

// WRONG — exposes internal detail
throw new ToolExecutionError(`Failed at line 47 of redis-client.ts`);

// WRONG — exposes secret
throw new ProviderAuthError(`API key sk-abc123 rejected`);
```
