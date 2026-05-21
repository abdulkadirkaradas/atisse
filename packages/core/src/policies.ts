import type { RetryPolicy, TimeoutPolicy, ToolPolicy } from './interfaces.js';
import type { OrchestratorError } from './errors.js';
import { isRetryable } from './errors.js';
import {
  MaxRetriesExceededError,
  FallbackExhaustedError,
  ProviderRateLimitError,
  TimeoutExceededError,
  OrchestratorError as OrchestratorErrorClass,
} from './errors.js';

// ── Default Constants (internal — NOT exported) ───────────────────────────────────────

const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: true,
};

const DEFAULT_TIMEOUT: TimeoutPolicy = {
  generateTimeoutMs: 30_000,
  toolTimeoutMs: 10_000,
  totalTimeoutMs: 60_000,
};

const DEFAULT_TOOL_POLICY: ToolPolicy = {
  maxToolRounds: 5,
  allowParallelTools: false,
  toolTimeoutMs: 10_000,
};

// ── Merge Utilities (internal — NOT exported) ──────────────────────────────────────

/**
 * Merge of retry policies.
 * Override values replace base values — not deep merged.
 */
function mergeRetryPolicy(base: RetryPolicy, override?: Partial<RetryPolicy>): RetryPolicy {
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
  };
}

/**
 * Merge of timeout policies.
 * Override values replace base values — not deep merged.
 */
function mergeTimeoutPolicy(base: TimeoutPolicy, override?: Partial<TimeoutPolicy>): TimeoutPolicy {
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
  };
}

/**
 * Merge of tool policies.
 * Override values replace base values — not deep merged.
 */
function mergeToolPolicy(base: ToolPolicy, override?: Partial<ToolPolicy>): ToolPolicy {
  if (!override) {
    return base;
  }
  return {
    ...base,
    ...override,
  };
}

// ── Delay Calculation ───────────────────────────────────────────────────────────────

/**
 * Calculate exponential backoff delay with optional jitter.
 * When ProviderRateLimitError.retryAfterMs is present, use it instead of exponential value.
 */
function calculateDelay(attempt: number, policy: RetryPolicy, error?: OrchestratorError): number {
  // Check for explicit retry-after from rate limit error
  if (error instanceof ProviderRateLimitError && error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, policy.maxDelayMs);
  }

  const exponential = policy.baseDelayMs * Math.pow(2, attempt);
  const capped = Math.min(exponential, policy.maxDelayMs);

  if (policy.jitter) {
    return capped + Math.random() * 0.3 * capped;
  }

  return capped;
}

// ── Timeout Utility (internal — NOT exported) ────────────────────────────────────────

/**
 * Creates a promise that rejects with TimeoutExceededError after specified milliseconds.
 * Used in all Promise.race timeout guards throughout the codebase.
 */
function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => {
      reject(new TimeoutExceededError(ms));
    }, ms);
  });
}

// ── Internal Utilities (internal — NOT exported) ─────────────────────────────────────

/**
 * Async sleep utility - compatible with vi.useFakeTimers() for testing.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// ── Core Retry Logic ─────────────────────────────────────────────────────────────────

/**
 * Execute a function with retry logic.
 * First call is attempt 0; first retry is attempt 1.
 * - isRetryable(error) === false → rethrow immediately (no delay, no counter increment)
 * - attempt === policy.maxAttempts → throw MaxRetriesExceededError(attempts, lastError)
 * - Call onRetry?.(attempt, error) before each retry delay
 */
async function executeWithRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  onRetry?: (attempt: number, error: OrchestratorError) => void,
): Promise<T> {
  let attempt = 0;
  let lastError: OrchestratorError | undefined;

  while (attempt < policy.maxAttempts) {
    try {
      return await fn();
    } catch (error: unknown) {
      // Non-retryable errors rethrow immediately
      if (!isRetryable(error)) {
        throw error;
      }

      lastError = error as OrchestratorError;
      attempt++;

      // If we've reached max attempts, throw MaxRetriesExceededError
      if (attempt >= policy.maxAttempts) {
        throw new MaxRetriesExceededError(attempt, lastError);
      }

      // Call onRetry callback before the delay
      onRetry?.(attempt, lastError);

      // Calculate delay and sleep
      const delay = calculateDelay(attempt, policy, lastError);
      await sleep(delay);
    }
  }

  // If maxAttempts is 0, the loop won't run and we need to handle that
  // In practice this shouldn't happen due to validation, but TypeScript needs coverage
  if (attempt === 0 && policy.maxAttempts === 0) {
    throw new MaxRetriesExceededError(0, new TimeoutExceededError(0));
  }

  throw new MaxRetriesExceededError(attempt, lastError ?? new TimeoutExceededError(0));
}

/**
 * Execute a function with fallback support.
 * - When primary throws MaxRetriesExceededError and fallback is defined → call fallback once (no retry)
 * - When fallback also fails → throw FallbackExhaustedError(primaryError, fallbackError)
 */
async function executeWithFallback<T>(
  primary: () => Promise<T>,
  fallback: (() => Promise<T>) | undefined,
  policy: RetryPolicy,
  onRetry?: (attempt: number, error: OrchestratorError) => void,
): Promise<T> {
  try {
    return await executeWithRetry(primary, policy, onRetry);
  } catch (error: unknown) {
    // Check if primary failed with MaxRetriesExceededError and fallback is available
    if (error instanceof MaxRetriesExceededError && fallback !== undefined) {
      try {
        // Call fallback once (no retry on fallback)
        return await fallback();
      } catch (fallbackError: unknown) {
        // Ensure fallback error is an OrchestratorError
        const fallbackOrchestratorError: OrchestratorError =
          fallbackError instanceof OrchestratorErrorClass
            ? fallbackError
            : new TimeoutExceededError(0);
        throw new FallbackExhaustedError(error, fallbackOrchestratorError);
      }
    }

    // Re-throw the original error
    throw error;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────────────

export {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT,
  DEFAULT_TOOL_POLICY,
  mergeRetryPolicy,
  mergeTimeoutPolicy,
  mergeToolPolicy,
  calculateDelay,
  rejectAfter,
  sleep,
  executeWithRetry,
  executeWithFallback,
};
