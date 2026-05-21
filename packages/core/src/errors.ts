import type { LifecycleState, OrchestratorErrorCode } from './interfaces.js';

/**
 * Base error class for all orchestrator errors.
 */
export abstract class OrchestratorError extends Error {
  abstract readonly code: OrchestratorErrorCode;
  abstract readonly retryable: boolean;

  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
    // V8-specific API - intentionally uses type cast to avoid adding Node.js types to src/
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
    if ((Error as any).captureStackTrace) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      (Error as any).captureStackTrace(this, this.constructor);
    }
  }
}

// ── Provider Errors ───────────────────────────────────────────

/**
 * Rate limit error from provider - retryable with optional delay.
 */
export class ProviderRateLimitError extends OrchestratorError {
  readonly code = 'PROVIDER_RATE_LIMIT' as const;
  readonly retryable = true;

  constructor(
    message: string,
    public readonly retryAfterMs?: number,
    cause?: unknown,
  ) {
    super(message, cause);
  }
}

/**
 * Timeout error from provider - retryable.
 */
export class ProviderTimeoutError extends OrchestratorError {
  readonly code = 'PROVIDER_TIMEOUT' as const;
  readonly retryable = true;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Provider unavailable error - retryable.
 */
export class ProviderUnavailableError extends OrchestratorError {
  readonly code = 'PROVIDER_UNAVAILABLE' as const;
  readonly retryable = true;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Authentication error from provider - not retryable.
 */
export class ProviderAuthError extends OrchestratorError {
  readonly code = 'PROVIDER_AUTH_FAILED' as const;
  readonly retryable = false;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Malformed response from provider - not retryable.
 */
export class ProviderMalformedResponse extends OrchestratorError {
  readonly code = 'PROVIDER_MALFORMED_RESPONSE' as const;
  readonly retryable = false;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

// ── Tool Errors ───────────────────────────────────────────────

/**
 * Tool execution failure - retryable.
 */
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

/**
 * Tool input validation failure - not retryable.
 */
export class ToolValidationError extends OrchestratorError {
  readonly code = 'TOOL_VALIDATION_FAILED' as const;
  readonly retryable = false;

  constructor(
    public readonly toolName: string,
    public readonly validationErrors: string[],
  ) {
    super(`Tool input validation failed: ${toolName}`);
  }
}

/**
 * Tool not found error - not retryable.
 */
export class ToolNotFoundError extends OrchestratorError {
  readonly code = 'TOOL_NOT_FOUND' as const;
  readonly retryable = false;

  constructor(public readonly toolName: string) {
    super(`Tool not registered: ${toolName}`);
  }
}

// ── Context Errors ───────────────────────────────────────────

/**
 * Context load failure (infrastructure) - retryable.
 */
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

/**
 * Context provider business logic error - retryable.
 */
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

/**
 * Maximum retry attempts exceeded - not retryable.
 */
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

/**
 * Maximum tool rounds exceeded - not retryable.
 * Thrown when tool execution rounds exceed the configured limit.
 */
export class MaxToolRoundsExceededError extends OrchestratorError {
  readonly code = 'MAX_TOOL_ROUNDS_EXCEEDED' as const;
  readonly retryable = false;
  constructor(
    public readonly rounds: number,
    public readonly maxRounds: number,
  ) {
    super(`Tool round limit exceeded: ${rounds}/${maxRounds}`);
  }
}

/**
 * Token limit exceeded - not retryable.
 * Note: Kernel does not throw this internally; exists for user hooks.
 */
export class TokenLimitExceededError extends OrchestratorError {
  readonly code = 'TOKEN_LIMIT_EXCEEDED' as const;
  readonly retryable = false;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Execution timeout exceeded - not retryable.
 */
export class TimeoutExceededError extends OrchestratorError {
  readonly code = 'TIMEOUT_EXCEEDED' as const;
  readonly retryable = false;

  constructor(public readonly timeoutMs: number) {
    super(`Execution timed out after ${timeoutMs}ms`);
  }
}

/**
 * Both primary and fallback providers failed - not retryable.
 */
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

/**
 * Invalid state transition - not retryable.
 */
export class InvalidStateTransitionError extends OrchestratorError {
  readonly code = 'INVALID_STATE_TRANSITION' as const;
  readonly retryable = false;

  constructor(
    public readonly from: LifecycleState,
    public readonly to: LifecycleState | 'any',
  ) {
    super(`Invalid state transition: ${from} → ${to}`);
  }
}

/**
 * Configuration validation failure - not retryable.
 */
export class ConfigValidationError extends OrchestratorError {
  readonly code = 'CONFIG_VALIDATION_FAILED' as const;
  readonly retryable = false;

  constructor(public readonly validationErrors: string[]) {
    super(`Config validation failed: ${validationErrors.join(', ')}`);
  }
}

// ── Hook Errors ───────────────────────────────────────────────

/**
 * Hook execution failure - not retryable.
 * Thrown when a hook function throws an error that is not already an OrchestratorError.
 */
export class HookExecutionError extends OrchestratorError {
  readonly code = 'HOOK_EXECUTION_FAILED' as const;
  readonly retryable = false;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
  }
}

/**
 * Determines if an error is retryable.
 * Returns true only for OrchestratorError instances with retryable === true.
 */
export function isRetryable(error: unknown): boolean {
  return error instanceof OrchestratorError && error.retryable;
}
