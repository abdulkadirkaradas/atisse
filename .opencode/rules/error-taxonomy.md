# ERROR TAXONOMY

## Error Hierarchy and Retry Decision Rules

---

## Base Class

All errors thrown by the kernel extend `OrchestratorError`.
`code` is typed as `OrchestratorErrorCode` (defined in `interfaces-core.md`) — imported via `import type`.

```typescript
export abstract class OrchestratorError extends Error {
  abstract readonly code: OrchestratorErrorCode;
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor); // V8-specific; guarded for edge runtime compat
    }
  }
}
```

`fatal` field is intentionally absent — `retryable: false` already communicates the same intent.

---

## Complete Error Hierarchy

```
OrchestratorError
│
├── ProviderError
│   ├── ProviderRateLimitError       retryable:true   code: PROVIDER_RATE_LIMIT
│   ├── ProviderTimeoutError         retryable:true   code: PROVIDER_TIMEOUT
│   ├── ProviderUnavailableError     retryable:true   code: PROVIDER_UNAVAILABLE
│   ├── ProviderAuthError            retryable:false  code: PROVIDER_AUTH_FAILED
│   └── ProviderMalformedResponse    retryable:false  code: PROVIDER_MALFORMED_RESPONSE
│
├── ToolError
│   ├── ToolExecutionError           retryable:true   code: TOOL_EXECUTION_FAILED
│   ├── ToolValidationError          retryable:false  code: TOOL_VALIDATION_FAILED
│   └── ToolNotFoundError            retryable:false  code: TOOL_NOT_FOUND
│
├── ContextError
│   ├── ContextLoadError             retryable:true   code: CONTEXT_LOAD_FAILED
│   └── ContextProviderError         retryable:true   code: CONTEXT_PROVIDER_FAILED
│
├── PolicyError
│   ├── MaxRetriesExceededError      retryable:false  code: MAX_RETRIES_EXCEEDED
│   ├── TokenLimitExceededError      retryable:false  code: TOKEN_LIMIT_EXCEEDED
│   ├── TimeoutExceededError         retryable:false  code: TIMEOUT_EXCEEDED
│   └── FallbackExhaustedError       retryable:false  code: FALLBACK_EXHAUSTED
│
└── LifecycleError
    ├── InvalidStateTransitionError  retryable:false  code: INVALID_STATE_TRANSITION
    └── ConfigValidationError        retryable:false  code: CONFIG_VALIDATION_FAILED
```

---

## Full TypeScript Definitions

```typescript
// ── Provider Errors ───────────────────────────────────────────

export class ProviderRateLimitError extends OrchestratorError {
  readonly code = 'PROVIDER_RATE_LIMIT' as const;
  readonly retryable = true;
  constructor(
    message: string,
    public readonly retryAfterMs?: number, // use this delay if present; from Retry-After header
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

export class ProviderTimeoutError extends OrchestratorError {
  readonly code = 'PROVIDER_TIMEOUT' as const;
  readonly retryable = true;
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class ProviderUnavailableError extends OrchestratorError {
  readonly code = 'PROVIDER_UNAVAILABLE' as const;
  readonly retryable = true; // retries first, then triggers fallback
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class ProviderAuthError extends OrchestratorError {
  readonly code = 'PROVIDER_AUTH_FAILED' as const;
  readonly retryable = false; // retrying will not fix an auth problem
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class ProviderMalformedResponse extends OrchestratorError {
  readonly code = 'PROVIDER_MALFORMED_RESPONSE' as const;
  readonly retryable = false;
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

// ── Tool Errors ───────────────────────────────────────────────
// When caught by tool-controller.ts, ToolError fields (code, message, retryable)
// are mapped into a ToolResultError DTO stored in ToolResult.error.
// ToolResultError is never thrown — see interfaces-core.md.

export class ToolExecutionError extends OrchestratorError {
  readonly code = 'TOOL_EXECUTION_FAILED' as const;
  readonly retryable = true;
  constructor(
    public readonly toolName: string,
    cause?: unknown,
  ) {
    super(`Tool execution failed: ${toolName}`, cause);
  }
}

export class ToolValidationError extends OrchestratorError {
  readonly code = 'TOOL_VALIDATION_FAILED' as const;
  readonly retryable = false; // schema mismatch — retry will not fix
  constructor(
    public readonly toolName: string,
    public readonly validationErrors: string[],
  ) {
    super(`Tool input validation failed: ${toolName}`);
  }
}

export class ToolNotFoundError extends OrchestratorError {
  readonly code = 'TOOL_NOT_FOUND' as const;
  readonly retryable = false;
  constructor(public readonly toolName: string) {
    super(`Tool not registered: ${toolName}`);
  }
}

// ── Context Errors ────────────────────────────────────────────
// ContextLoadError   — infrastructure/connectivity failure (Redis down, network timeout)
// ContextProviderError — business-logic failure within the provider
//   (embedding service returned unexpected shape, vector store query error)

export class ContextLoadError extends OrchestratorError {
  readonly code = 'CONTEXT_LOAD_FAILED' as const;
  readonly retryable = true;
  constructor(
    public readonly providerId: string,
    cause?: unknown,
  ) {
    super(`Context load failed: ${providerId}`, cause);
  }
}

export class ContextProviderError extends OrchestratorError {
  readonly code = 'CONTEXT_PROVIDER_FAILED' as const;
  readonly retryable = true;
  constructor(
    public readonly providerId: string,
    cause?: unknown,
  ) {
    super(`Context provider error: ${providerId}`, cause);
  }
}

// ── Policy Errors ─────────────────────────────────────────────

export class MaxRetriesExceededError extends OrchestratorError {
  readonly code = 'MAX_RETRIES_EXCEEDED' as const;
  readonly retryable = false;
  constructor(
    public readonly attempts: number,
    public readonly lastError: OrchestratorError,
  ) {
    super(`Max retries exceeded after ${attempts} attempts`);
  }
}

export class TokenLimitExceededError extends OrchestratorError {
  readonly code = 'TOKEN_LIMIT_EXCEEDED' as const;
  readonly retryable = false;
  // NOTE: The kernel does NOT throw this error internally — prompt trimming handles overflow.
  // This class exists for use in beforeRun hooks where user code enforces custom limits.
  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

export class TimeoutExceededError extends OrchestratorError {
  readonly code = 'TIMEOUT_EXCEEDED' as const;
  readonly retryable = false;
  constructor(public readonly timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms`);
  }
}

export class FallbackExhaustedError extends OrchestratorError {
  readonly code = 'FALLBACK_EXHAUSTED' as const;
  readonly retryable = false;
  constructor(
    public readonly primaryError: OrchestratorError,
    public readonly fallbackError: OrchestratorError,
  ) {
    super('Both primary and fallback providers failed');
  }
}

// ── Lifecycle Errors ──────────────────────────────────────────

export class InvalidStateTransitionError extends OrchestratorError {
  readonly code = 'INVALID_STATE_TRANSITION' as const;
  readonly retryable = false;
  constructor(
    public readonly from: LifecycleState, // imported via `import type` from interfaces.ts
    public readonly to: LifecycleState | 'any', // 'any' used when assertNotTerminal() fails
  ) {
    super(`Invalid state transition: ${from} → ${to}`);
  }
}

export class ConfigValidationError extends OrchestratorError {
  readonly code = 'CONFIG_VALIDATION_FAILED' as const;
  readonly retryable = false;
  constructor(public readonly validationErrors: string[]) {
    super(`Config validation failed: ${validationErrors.join(', ')}`);
  }
}
```

---

## The `isRetryable()` Helper

```typescript
/**
 * Returns true only for OrchestratorError instances with retryable === true.
 * Unknown or plain errors return false — treated as fatal by default (safe default).
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof OrchestratorError) return error.retryable;
  return false;
}
```

---

## Retry Decision Flow

```
error thrown
    │
    ├── instanceof OrchestratorError?
    │       ├── YES → check error.retryable
    │       │         ├── true  → retry (backoff); maxAttempts reached → MaxRetriesExceededError
    │       │         │           fallback exists → FALLBACKING
    │       │         └── false → throw immediately (fatal)
    │       └── NO (unknown) → treat as fatal, rethrow
    │
    └── ProviderRateLimitError specifically?
            └── use error.retryAfterMs as delay if present
```

---

## Rules for Adapter Authors

1. Map HTTP 429 → `ProviderRateLimitError` (include `retryAfterMs` from `Retry-After` header × 1000)
2. Map HTTP 401/403 → `ProviderAuthError`
3. Map HTTP 503/502 → `ProviderUnavailableError`
4. Map network timeout → `ProviderTimeoutError`
5. Never throw plain `Error` — always throw a typed `OrchestratorError` subclass
6. Never catch and swallow — let the kernel's policy engine decide
7. Always include the original error as `cause` for debuggability

```typescript
// CORRECT
if (response.status === 429) {
  const retryAfterMs = Number(response.headers.get('Retry-After')) * 1000;
  throw new ProviderRateLimitError('Rate limited', retryAfterMs, originalError);
}
// WRONG
throw new Error('Rate limited'); // untyped — kernel cannot make retry decision
```
