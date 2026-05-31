import type { RetryPolicy, TimeoutPolicy, ToolPolicy } from './interfaces.js';
import type { OrchestratorError } from './errors.js';
import { isRetryable } from './errors.js';
import { MaxRetriesExceededError, ProviderRateLimitError, TimeoutExceededError } from './errors.js';

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

// ── Timeout Utilities ─────────────────────────────────────────────────────────────────

/**
 * Wraps a promise with a timeout that rejects with TimeoutExceededError.
 * The internal setTimeout is CLEANED UP if the wrapped promise settles first.
 *
 * When ms <= 0, returns the original promise with no timeout wrapping.
 */
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

// ── Exports ───────────────────────────────────────────────────────────────────────────

export {
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT,
  DEFAULT_TOOL_POLICY,
  mergeRetryPolicy,
  mergeTimeoutPolicy,
  mergeToolPolicy,
  calculateDelay,
  withTimeout,
  sleep,
  executeWithRetry,
};
