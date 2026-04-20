import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateDelay,
  rejectAfter,
  executeWithRetry,
  executeWithFallback,
  DEFAULT_RETRY,
} from '../../src/policies.js';
import {
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderAuthError,
  MaxRetriesExceededError,
  FallbackExhaustedError,
} from '../../src/errors.js';
import type { RetryPolicy } from '../../src/interfaces.js';

describe('policies', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('calculateDelay', () => {
    it('calculates exponential backoff', () => {
      // With jitter disabled, we can predict exact values
      vi.setSystemTime(0); // Fixed time for deterministic jitter
      const policy: RetryPolicy = {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
        jitter: false,
      };

      // attempt 0 -> first retry delay
      expect(calculateDelay(0, policy)).toBe(500);
      expect(calculateDelay(1, policy)).toBe(1000);
      expect(calculateDelay(2, policy)).toBe(2000);
    });

    it('respects maxDelayMs cap', () => {
      const policy: RetryPolicy = {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 1000,
        jitter: false,
      };

      // attempt 2 would be 2000 but capped to 1000
      expect(calculateDelay(2, policy)).toBe(1000);
    });

    it('applies jitter when enabled', () => {
      const policy: RetryPolicy = {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30_000,
        jitter: true,
      };

      vi.setSystemTime(0);
      const delay = calculateDelay(0, policy);

      // Base + 0-30% variance
      expect(delay).toBeGreaterThan(1000);
      expect(delay).toBeLessThanOrEqual(1300);
    });

    it('uses retryAfterMs from ProviderRateLimitError when present', () => {
      const policy: RetryPolicy = {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
        jitter: false,
      };
      const error = new ProviderRateLimitError('rate limited', 5000);

      // retryAfterMs overrides exponential calculation
      expect(calculateDelay(0, policy, error)).toBe(5000);
    });

    it('caps retryAfterMs to maxDelayMs', () => {
      const policy: RetryPolicy = {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
        jitter: false,
      };
      const error = new ProviderRateLimitError('rate limited', 100_000);

      // 100_000 capped to 30_000
      expect(calculateDelay(0, policy, error)).toBe(30_000);
    });
  });

  describe('rejectAfter', () => {
    it('rejects with TimeoutExceededError after specified ms', async () => {
      const promise = rejectAfter(100);

      vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow('Execution timed out after 100ms');
    });
  });

  describe('executeWithRetry', () => {
    it('succeeds on first attempt', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await executeWithRetry(fn, DEFAULT_RETRY);

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries when error is retryable', async () => {
      // Need longer timeout for sleep-based retry
      vi.useRealTimers();
      const callCount = vi.fn();
      const fn = vi.fn(async () => {
        callCount();
        if (callCount.mock.calls.length < 2) {
          throw new ProviderTimeoutError('timeout');
        }
        return 'success';
      });

      const result = await executeWithRetry(fn, {
        ...DEFAULT_RETRY,
        maxAttempts: 3,
        baseDelayMs: 50,
      });

      vi.useFakeTimers();
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws immediately when error is fatal (not retryable)', async () => {
      const fn = vi.fn().mockRejectedValue(new ProviderAuthError('auth failed'));

      await expect(executeWithRetry(fn, DEFAULT_RETRY)).rejects.toThrow(ProviderAuthError);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws MaxRetriesExceededError when max attempts reached', async () => {
      vi.useRealTimers();
      const fn = vi.fn().mockRejectedValue(new ProviderTimeoutError('timeout'));

      await expect(
        executeWithRetry(fn, { ...DEFAULT_RETRY, maxAttempts: 2, baseDelayMs: 10 }),
      ).rejects.toThrow(MaxRetriesExceededError);
      vi.useFakeTimers();
    });

    it('calls onRetry callback before each retry', async () => {
      vi.useRealTimers();
      const onRetry = vi.fn();
      let callCount = 0;
      const fn = vi.fn(async () => {
        callCount++;
        if (callCount < 2) {
          throw new ProviderTimeoutError('timeout');
        }
        return 'success';
      });

      await executeWithRetry(fn, { ...DEFAULT_RETRY, maxAttempts: 3, baseDelayMs: 10 }, onRetry);
      vi.useFakeTimers();

      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(1, expect.any(ProviderTimeoutError));
    });

    it('rethrows non-OrchestratorError', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('plain error'));

      await expect(executeWithRetry(fn, DEFAULT_RETRY)).rejects.toThrow(Error);
    });
  });

  describe('executeWithFallback', () => {
    it('succeeds with primary', async () => {
      const primary = vi.fn().mockResolvedValue('primary success');
      const fallback = vi.fn().mockResolvedValue('fallback success');

      const result = await executeWithFallback(primary, fallback, DEFAULT_RETRY);

      expect(result).toBe('primary success');
      expect(primary).toHaveBeenCalledTimes(1);
      expect(fallback).not.toHaveBeenCalled();
    });

    it('uses fallback when primary fails with MaxRetriesExceededError', async () => {
      const primary = vi
        .fn()
        .mockRejectedValue(new MaxRetriesExceededError(3, new ProviderTimeoutError('timeout')));
      const fallback = vi.fn().mockResolvedValue('fallback success');

      const result = await executeWithFallback(primary, fallback, DEFAULT_RETRY);

      expect(result).toBe('fallback success');
      expect(fallback).toHaveBeenCalledTimes(1);
    });

    it('throws FallbackExhaustedError when both fail', async () => {
      const primary = vi
        .fn()
        .mockRejectedValue(new MaxRetriesExceededError(3, new ProviderTimeoutError('timeout')));
      const fallback = vi.fn().mockRejectedValue(new ProviderAuthError('fallback auth failed'));

      await expect(executeWithFallback(primary, fallback, DEFAULT_RETRY)).rejects.toThrow(
        FallbackExhaustedError,
      );
    });

    it('rethrows non-MaxRetriesExceededError from primary', async () => {
      const primary = vi.fn().mockRejectedValue(new ProviderAuthError('auth failed'));
      const fallback = vi.fn().mockResolvedValue('fallback success');

      await expect(executeWithFallback(primary, fallback, DEFAULT_RETRY)).rejects.toThrow(
        ProviderAuthError,
      );
      expect(fallback).not.toHaveBeenCalled();
    });

    it('does not retry fallback - called only once', async () => {
      const primary = vi
        .fn()
        .mockRejectedValue(new MaxRetriesExceededError(3, new ProviderTimeoutError('timeout')));
      const fallback = vi.fn().mockRejectedValue(new ProviderTimeoutError('timeout'));

      await expect(executeWithFallback(primary, fallback, DEFAULT_RETRY)).rejects.toThrow(
        FallbackExhaustedError,
      );
      expect(fallback).toHaveBeenCalledTimes(1); // Not retried!
    });
  });
});
