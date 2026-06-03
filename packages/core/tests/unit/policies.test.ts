import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  calculateDelay,
  withTimeout,
  executeWithRetry,
  DEFAULT_RETRY,
  DEFAULT_TIMEOUT,
  DEFAULT_TOOL_POLICY,
  mergeRetryPolicy,
  mergeTimeoutPolicy,
  mergeToolPolicy,
  abortableSleep,
  sleep,
} from '../../src/policies.js';
import {
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderAuthError,
  MaxRetriesExceededError,
  TimeoutExceededError,
  RunCancelledError,
} from '../../src/errors.js';
import type { RetryPolicy, TimeoutPolicy, ToolPolicy } from '../../src/interfaces.js';

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

    it('returns jittered value that can exceed maxDelayMs', () => {
      // Jitter is added AFTER the cap, so the final value can exceed maxDelayMs
      vi.setSystemTime(0);
      const policy: RetryPolicy = {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 800,
        jitter: true,
      };

      // attempt 0: exponential = 1000, capped = 800, jitter = 800 + 0-240 = 800-1040
      const delay = calculateDelay(0, policy);
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(1040);
    });

    it('returns 0 for retryAfterMs=0 (immediate retry)', () => {
      const policy: RetryPolicy = {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
        jitter: false,
      };
      const error = new ProviderRateLimitError('rate limited', 0);

      expect(calculateDelay(0, policy, error)).toBe(0);
    });

    it('falls through to exponential backoff when retryAfterMs is undefined', () => {
      const policy: RetryPolicy = {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
        jitter: false,
      };
      const error = new ProviderRateLimitError('rate limited');

      // retryAfterMs is undefined, so exponential backoff is used
      expect(calculateDelay(0, policy, error)).toBe(500);
    });

    it('handles negative attempt (fractional exponential)', () => {
      const policy: RetryPolicy = {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30_000,
        jitter: false,
      };

      // attempt -1: 1000 * 2^(-1) = 500
      expect(calculateDelay(-1, policy)).toBe(500);
      // attempt -2: 1000 * 2^(-2) = 250
      expect(calculateDelay(-2, policy)).toBe(250);
    });
  });

  describe('withTimeout', () => {
    it('rejects with TimeoutExceededError after specified ms', async () => {
      const promise = withTimeout(new Promise(() => {}), 100);

      vi.runAllTimersAsync();

      await expect(promise).rejects.toThrow('Execution timed out after 100ms');
    });

    it('resolves when wrapped promise resolves before timeout', async () => {
      const result = await withTimeout(Promise.resolve('ok'), 100);
      expect(result).toBe('ok');
    });

    it('rejects when wrapped promise rejects before timeout', async () => {
      await expect(
        withTimeout(Promise.reject(new Error('fail')), 100),
      ).rejects.toThrow('fail');
    });

    it('passes through when ms <= 0', async () => {
      const result = await withTimeout(Promise.resolve('no-timeout'), 0);
      expect(result).toBe('no-timeout');
    });

    it('passes through when ms is NaN (guard returns promise directly)', async () => {
      // NaN <= 0 is false, so it proceeds to the timeout branch.
      // setTimeout with NaN fires on the next tick, but the resolved
      // wrapped promise wins the race.
      const result = await withTimeout(Promise.resolve('ok'), NaN);
      expect(result).toBe('ok');
    });

    describe('timer cleanup', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('clears timer when wrapped promise resolves before timeout', async () => {
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        await withTimeout(Promise.resolve('ok'), 100_000);
        expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
      });

      it('clears timer when wrapped promise rejects before timeout', async () => {
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        await expect(
          withTimeout(Promise.reject(new Error('fail')), 100_000),
        ).rejects.toThrow('fail');
        expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
      });

      it('calls clearTimeout even when timeout fires first (no-op safeguard)', async () => {
        const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
        const promise = withTimeout(new Promise(() => {}), 100);
        vi.runAllTimersAsync();
        await expect(promise).rejects.toThrow('Execution timed out after 100ms');
        expect(clearTimeoutSpy).toHaveBeenCalled();
      });
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

});
