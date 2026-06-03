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

    it('succeeds with maxAttempts=1 (single attempt, no retries)', async () => {
      const fn = vi.fn().mockResolvedValue('single');
      const result = await executeWithRetry(fn, {
        maxAttempts: 1,
        baseDelayMs: 100,
        maxDelayMs: 30_000,
        jitter: false,
      });
      expect(result).toBe('single');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws MaxRetriesExceededError when maxAttempts=1 and fn throws', async () => {
      const fn = vi.fn().mockRejectedValue(new ProviderTimeoutError('timeout'));

      await expect(
        executeWithRetry(
          fn,
          { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 30_000, jitter: false },
        ),
      ).rejects.toThrow(MaxRetriesExceededError);

      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries 3+ times and succeeds on the 4th attempt', async () => {
      let callCount = 0;
      const fn = vi.fn(async () => {
        callCount++;
        if (callCount < 4) {
          throw new ProviderTimeoutError('timeout');
        }
        return 'success';
      });

      const promise = executeWithRetry(
        fn,
        { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 30_000, jitter: false },
      );

      // Total delay: 20 + 40 + 80 = 140ms
      await vi.advanceTimersByTimeAsync(200);

      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(4);
    });

    it('calls onRetry for each retry attempt in multi-round scenario', async () => {
      const onRetry = vi.fn();
      let callCount = 0;
      const fn = vi.fn(async () => {
        callCount++;
        if (callCount < 4) {
          throw new ProviderTimeoutError('timeout');
        }
        return 'success';
      });

      const promise = executeWithRetry(
        fn,
        { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 30_000, jitter: false },
        onRetry,
      );

      await vi.advanceTimersByTimeAsync(200);

      await expect(promise).resolves.toBe('success');
      expect(onRetry).toHaveBeenCalledTimes(3);
      expect(onRetry).toHaveBeenNthCalledWith(1, 1, expect.any(ProviderTimeoutError));
      expect(onRetry).toHaveBeenNthCalledWith(2, 2, expect.any(ProviderTimeoutError));
      expect(onRetry).toHaveBeenNthCalledWith(3, 3, expect.any(ProviderTimeoutError));
    });

    it('uses retryAfterMs from ProviderRateLimitError in retry delay', async () => {
      const fn = vi.fn()
        .mockRejectedValueOnce(new ProviderRateLimitError('rate limited', 5000))
        .mockResolvedValueOnce('success');

      const promise = executeWithRetry(
        fn,
        { maxAttempts: 2, baseDelayMs: 100, maxDelayMs: 30_000, jitter: false },
      );

      // Let the first fn() rejection and sleep begin
      await vi.advanceTimersByTimeAsync(0);

      // Advancing only the base delay (100ms) should NOT trigger retry
      // because retryAfterMs=5000 overrides the exponential calculation
      await vi.advanceTimersByTimeAsync(100);
      expect(fn).toHaveBeenCalledTimes(1); // Still only the first call

      // Now advance the remaining retryAfterMs delay
      await vi.advanceTimersByTimeAsync(4900);

      await expect(promise).resolves.toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws RunCancelledError when signal is already aborted before retry delay', async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new ProviderTimeoutError('timeout'));

      const promise = executeWithRetry(
        fn,
        { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 30_000, jitter: false },
        undefined,
        controller.signal,
      );

      // Attach rejection handler eagerly to prevent unhandled rejection
      const rejection = expect(promise).rejects.toThrow(RunCancelledError);

      // Abort before abortableSleep starts (microtask ordering)
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);

      await rejection;
    });

    it('throws RunCancelledError when signal aborts mid-delay during executeWithRetry', async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new ProviderTimeoutError('timeout'));

      const promise = executeWithRetry(
        fn,
        { maxAttempts: 3, baseDelayMs: 5000, maxDelayMs: 30_000, jitter: false },
        undefined,
        controller.signal,
      );

      // Attach rejection handler eagerly to prevent unhandled rejection
      const rejection = expect(promise).rejects.toThrow(RunCancelledError);

      // Let the fn() reject and abortableSleep begin (process microtasks)
      await vi.advanceTimersByTimeAsync(0);

      // Abort mid-sleep — abortableSleep's 'abort' listener fires, resolves with true
      controller.abort();

      // Process the resolve(true) microtask from abortableSleep
      await vi.advanceTimersByTimeAsync(0);

      await rejection;
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws MaxRetriesExceededError with attempts=0 when maxAttempts is 0', async () => {
      const fn = vi.fn().mockResolvedValue('should not be called');

      await expect(
        executeWithRetry(
          fn,
          { maxAttempts: 0, baseDelayMs: 100, maxDelayMs: 30_000, jitter: false },
        ),
      ).rejects.toThrow(MaxRetriesExceededError);

      expect(fn).not.toHaveBeenCalled();
    });

    it('rethrows non-Error string thrown values', async () => {
      await expect(
        executeWithRetry(vi.fn().mockRejectedValue('string error'), DEFAULT_RETRY),
      ).rejects.toBe('string error');
    });

    it('rethrows null thrown values', async () => {
      await expect(
        executeWithRetry(vi.fn().mockRejectedValue(null), DEFAULT_RETRY),
      ).rejects.toBeNull();
    });

    it('rethrows object thrown values', async () => {
      const objError = { message: 'object error' };
      await expect(
        executeWithRetry(vi.fn().mockRejectedValue(objError), DEFAULT_RETRY),
      ).rejects.toBe(objError);
    });
  });

  describe('DEFAULT_TIMEOUT', () => {
    it('has expected default timeout values', () => {
      expect(DEFAULT_TIMEOUT).toEqual({
        generateTimeoutMs: 30_000,
        toolTimeoutMs: 10_000,
        totalTimeoutMs: 60_000,
      });
    });
  });

  describe('DEFAULT_TOOL_POLICY', () => {
    it('has expected default tool policy values', () => {
      expect(DEFAULT_TOOL_POLICY).toEqual({
        maxToolRounds: 5,
        allowParallelTools: false,
        toolTimeoutMs: 10_000,
      });
    });
  });

  describe('mergeRetryPolicy', () => {
    it('partial override merges correctly', () => {
      const base: RetryPolicy = {
        maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true,
      };
      const override: Partial<RetryPolicy> = { maxAttempts: 5 };

      const result = mergeRetryPolicy(base, override);

      expect(result).toEqual({
        maxAttempts: 5,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
        jitter: true,
      });
    });

    it('undefined override returns base unchanged', () => {
      const base: RetryPolicy = {
        maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true,
      };

      const result = mergeRetryPolicy(base, undefined);

      expect(result).toBe(base);
    });

    it('override replaces all base fields', () => {
      const base: RetryPolicy = {
        maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true,
      };
      const override: RetryPolicy = {
        maxAttempts: 5, baseDelayMs: 1000, maxDelayMs: 60_000, jitter: false,
      };

      const result = mergeRetryPolicy(base, override);

      expect(result).toEqual(override);
      // Original base is not mutated
      expect(base.maxAttempts).toBe(3);
    });
  });

  describe('mergeTimeoutPolicy', () => {
    it('partial override merges correctly', () => {
      const base: TimeoutPolicy = {
        generateTimeoutMs: 30_000, toolTimeoutMs: 10_000, totalTimeoutMs: 60_000,
      };
      const override: Partial<TimeoutPolicy> = { generateTimeoutMs: 60_000 };

      const result = mergeTimeoutPolicy(base, override);

      expect(result).toEqual({
        generateTimeoutMs: 60_000,
        toolTimeoutMs: 10_000,
        totalTimeoutMs: 60_000,
      });
    });

    it('undefined override returns base unchanged', () => {
      const base: TimeoutPolicy = {
        generateTimeoutMs: 30_000, toolTimeoutMs: 10_000, totalTimeoutMs: 60_000,
      };

      const result = mergeTimeoutPolicy(base, undefined);

      expect(result).toBe(base);
    });

    it('override replaces all base fields', () => {
      const base: TimeoutPolicy = {
        generateTimeoutMs: 30_000, toolTimeoutMs: 10_000, totalTimeoutMs: 60_000,
      };
      const override: TimeoutPolicy = {
        generateTimeoutMs: 60_000, toolTimeoutMs: 20_000, totalTimeoutMs: 120_000,
      };

      const result = mergeTimeoutPolicy(base, override);

      expect(result).toEqual(override);
    });
  });

  describe('mergeToolPolicy', () => {
    it('partial override merges correctly', () => {
      const base: ToolPolicy = {
        maxToolRounds: 5, allowParallelTools: false, toolTimeoutMs: 10_000,
      };
      const override: Partial<ToolPolicy> = { maxToolRounds: 10 };

      const result = mergeToolPolicy(base, override);

      expect(result).toEqual({
        maxToolRounds: 10,
        allowParallelTools: false,
        toolTimeoutMs: 10_000,
      });
    });

    it('undefined override returns base unchanged', () => {
      const base: ToolPolicy = {
        maxToolRounds: 5, allowParallelTools: false, toolTimeoutMs: 10_000,
      };

      const result = mergeToolPolicy(base, undefined);

      expect(result).toBe(base);
    });

    it('override replaces all base fields', () => {
      const base: ToolPolicy = {
        maxToolRounds: 5, allowParallelTools: false, toolTimeoutMs: 10_000,
      };
      const override: ToolPolicy = {
        maxToolRounds: 3, allowParallelTools: true, toolTimeoutMs: 5_000,
      };

      const result = mergeToolPolicy(base, override);

      expect(result).toEqual(override);
    });
  });

  describe('sleep', () => {
    it('resolves after the specified duration via setTimeout', async () => {
      const spy = vi.fn();
      sleep(100).then(spy);
      expect(spy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('abortableSleep', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns false on normal completion without signal', async () => {
      const promise = abortableSleep(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBe(false);
    });

    it('returns false on normal completion with signal', async () => {
      const controller = new AbortController();
      const promise = abortableSleep(100, controller.signal);
      await vi.advanceTimersByTimeAsync(100);
      await expect(promise).resolves.toBe(false);
    });

    it('returns true when signal is already aborted before sleep', async () => {
      const controller = new AbortController();
      controller.abort();
      const result = await abortableSleep(100, controller.signal);
      expect(result).toBe(true);
    });

    it('returns true when signal aborts mid-sleep', async () => {
      const controller = new AbortController();
      const promise = abortableSleep(1000, controller.signal);
      controller.abort();
      await expect(promise).resolves.toBe(true);
    });

    it('calls removeEventListener on abort cleanup', async () => {
      const removeEventListenerSpy = vi.spyOn(
        AbortSignal.prototype,
        'removeEventListener',
      );
      const controller = new AbortController();
      const promise = abortableSleep(1000, controller.signal);
      controller.abort();
      await promise;
      expect(removeEventListenerSpy).toHaveBeenCalled();
    });

    it('calls removeEventListener on normal completion cleanup', async () => {
      const removeEventListenerSpy = vi.spyOn(
        AbortSignal.prototype,
        'removeEventListener',
      );
      const controller = new AbortController();
      const promise = abortableSleep(100, controller.signal);
      await vi.advanceTimersByTimeAsync(100);
      await promise;
      expect(removeEventListenerSpy).toHaveBeenCalled();
    });
  });

});
