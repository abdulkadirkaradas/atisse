import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RunCancelledError,
  isRetryable,
  ProviderTimeoutError,
  ProviderRateLimitError,
  ProviderAuthError,
  MemorySaveError,
  ProviderUnavailableError,
} from '../../src/errors.js';
import {
  abortableSleep,
  executeWithRetry,
  calculateDelay,
  DEFAULT_RETRY,
} from '../../src/policies.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { MockMemoryAdapter } from '../fixtures/mock-memory.js';
import { echoTool } from '../fixtures/mock-tools.js';
import type { StreamChunk } from '../../src/interfaces.js';

describe('RunCancelledError', () => {
  it('has code RUN_CANCELLED', () => {
    const error = new RunCancelledError();
    expect(error.code).toBe('RUN_CANCELLED');
  });

  it('is not retryable', () => {
    expect(isRetryable(new RunCancelledError())).toBe(false);
  });

  it('has correct message', () => {
    const error = new RunCancelledError();
    expect(error.message).toBe('Run was cancelled');
  });

  it('error.name equals constructor name', () => {
    const error = new RunCancelledError();
    expect(error.name).toBe('RunCancelledError');
  });
});

// ── GAPS 1 & 10: isRetryable type coverage ──────────────────────────────────

describe('isRetryable', () => {
  it('returns true for ProviderTimeoutError', () => {
    expect(isRetryable(new ProviderTimeoutError('timeout'))).toBe(true);
  });

  it('returns true for ProviderRateLimitError', () => {
    expect(isRetryable(new ProviderRateLimitError('rate limited'))).toBe(true);
  });

  it('returns false for plain Error', () => {
    expect(isRetryable(new Error('plain error'))).toBe(false);
  });

  it('returns false for null input', () => {
    expect(isRetryable(null)).toBe(false);
  });

  it('returns false for undefined input', () => {
    expect(isRetryable(undefined)).toBe(false);
  });
});

// ── abortableSleep ──────────────────────────────────────────────────────────

describe('abortableSleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves false when no signal provided', async () => {
    const promise = abortableSleep(100);
    vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(false);
  });

  it('resolves false when signal never aborted', async () => {
    const controller = new AbortController();
    const promise = abortableSleep(100, controller.signal);
    vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toBe(false);
  });

  it('resolves true when signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await abortableSleep(100, controller.signal);
    expect(result).toBe(true);
  });

  it('resolves true when signal aborted during sleep', async () => {
    const controller = new AbortController();
    const sleepPromise = abortableSleep(100_000, controller.signal);

    controller.abort();

    const result = await sleepPromise;
    expect(result).toBe(true);
  });

  // GAP 14: listener cleanup
  it('removes abort event listener after timer completes normally', async () => {
    const controller = new AbortController();
    const removeSpy = vi.spyOn(controller.signal, 'removeEventListener');

    const promise = abortableSleep(100, controller.signal);
    await vi.runAllTimersAsync();
    await promise;

    expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function));
    removeSpy.mockRestore();
  });
});

// ── executeWithRetry signal param ────────────────────────────────────────────

describe('executeWithRetry signal param', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('works without signal param (backward compat)', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockResolvedValue('success');
    const result = await executeWithRetry(fn, DEFAULT_RETRY);
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
  });

  it('throws RunCancelledError when signal already aborted before retry', async () => {
    vi.useRealTimers();
    const controller = new AbortController();
    let callCount = 0;
    const fn = vi.fn(async () => {
      callCount++;
      if (callCount < 2) {
        throw new ProviderTimeoutError('timeout');
      }
      return 'success';
    });

    const retryPromise = executeWithRetry(
      fn,
      { ...DEFAULT_RETRY, maxAttempts: 3, baseDelayMs: 50 },
      undefined,
      controller.signal,
    );

    controller.abort();

    await expect(retryPromise).rejects.toThrow(RunCancelledError);
    vi.useFakeTimers();
  });

  // GAP 2: pre-aborted signal — fn() fails with retryable error, retry skipped
  it('throws RunCancelledError when signal already aborted before executeWithRetry call with retryable error', async () => {
    vi.useRealTimers();
    const controller = new AbortController();
    controller.abort(); // Pre-abort before executeWithRetry

    const fn = vi.fn().mockRejectedValue(new ProviderTimeoutError('timeout'));

    await expect(
      executeWithRetry(
        fn,
        { ...DEFAULT_RETRY, maxAttempts: 2, baseDelayMs: 1000, jitter: false },
        undefined,
        controller.signal,
      ),
    ).rejects.toThrow(RunCancelledError);

    // fn() was called once, retry was skipped due to pre-aborted signal
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
  });

  // GAP 3: non-retryable error in retry loop → rethrow immediately
  it('rethrows non-retryable error immediately without retrying', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockRejectedValue(new ProviderAuthError('auth failed'));

    await expect(
      executeWithRetry(fn, { ...DEFAULT_RETRY, maxAttempts: 3, baseDelayMs: 1000, jitter: false }),
    ).rejects.toThrow(ProviderAuthError);

    expect(fn).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
  });

  // GAP 11: signal fires during fn() execution — cooperative cancellation
  it('propagates RunCancelledError when fn() detects signal abort mid-execution', async () => {
    const controller = new AbortController();

    const fn = vi.fn(async () => {
      // Cooperative cancellation: wait for signal abort
      await new Promise<void>((_, reject) => {
        if (controller.signal.aborted) {
          reject(new RunCancelledError());
          return;
        }
        controller.signal.addEventListener('abort', () => reject(new RunCancelledError()), {
          once: true,
        });
      });
      return 'success';
    });

    const promise = executeWithRetry(
      fn,
      { ...DEFAULT_RETRY, maxAttempts: 3, baseDelayMs: 1000, jitter: false },
      undefined,
      controller.signal,
    );

    controller.abort();

    await expect(promise).rejects.toThrow(RunCancelledError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // GAP 12: onRetry callback is called with correct attempt and error
  it('calls onRetry with attempt count and error on retry', async () => {
    vi.useRealTimers();
    const onRetry = vi.fn();
    let callCount = 0;
    const error = new ProviderTimeoutError('timeout');
    const fn = vi.fn(async () => {
      callCount++;
      if (callCount < 2) {
        throw error;
      }
      return 'success';
    });

    await executeWithRetry(
      fn,
      { ...DEFAULT_RETRY, maxAttempts: 2, baseDelayMs: 10, jitter: false },
      onRetry,
    );

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, error); // first retry = attempt 1
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
  });
});

// ── GAP 13: calculateDelay ──────────────────────────────────────────────────

describe('calculateDelay', () => {
  const basePolicy = {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    jitter: false,
  };

  it('calculates exponential backoff (baseDelayMs * 2^attempt)', () => {
    expect(calculateDelay(0, basePolicy)).toBe(1000); // 1000 * 2^0
    expect(calculateDelay(1, basePolicy)).toBe(2000); // 1000 * 2^1
    expect(calculateDelay(2, basePolicy)).toBe(4000); // 1000 * 2^2
    expect(calculateDelay(3, basePolicy)).toBe(8000); // 1000 * 2^3
  });

  it('caps exponential value at maxDelayMs', () => {
    const cappedPolicy = { ...basePolicy, maxDelayMs: 5000 };
    // 1000 * 2^3 = 8000 → capped at 5000
    expect(calculateDelay(3, cappedPolicy)).toBe(5000);
    // 1000 * 2^10 = huge → capped at 5000
    expect(calculateDelay(10, cappedPolicy)).toBe(5000);
  });

  it('applies partial jitter when jitter is true', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const jitterPolicy = { ...basePolicy, jitter: true };
    // exponential = 2000, jitter = 2000 * 0.3 * 0.5 = 300, total = 2300
    expect(calculateDelay(1, jitterPolicy)).toBe(2300);
    vi.restoreAllMocks();
  });

  it('uses retryAfterMs from ProviderRateLimitError when present', () => {
    const error = new ProviderRateLimitError('rate limited', 5000);
    // retryAfterMs = 5000, capped at 30000
    expect(calculateDelay(1, basePolicy, error)).toBe(5000);
  });

  it('caps retryAfterMs at maxDelayMs', () => {
    const error = new ProviderRateLimitError('rate limited', 50_000);
    // retryAfterMs = 50000, capped at 30000
    expect(calculateDelay(1, basePolicy, error)).toBe(30_000);
  });

  it('falls back to exponential when ProviderRateLimitError has no retryAfterMs', () => {
    const error = new ProviderRateLimitError('rate limited', undefined);
    // No retryAfterMs → use exponential: 1000 * 2^1 = 2000
    expect(calculateDelay(1, basePolicy, error)).toBe(2000);
  });

  it('returns 0 when baseDelayMs is 0 and attempt is 0', () => {
    const zeroBase = { ...basePolicy, baseDelayMs: 0 };
    expect(calculateDelay(0, zeroBase)).toBe(0);
  });
});

// ── AbortSignal in RunInput - Integration ────────────────────────────────────

describe('AbortSignal in RunInput - Integration', () => {
  let provider: MockProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new MockProvider('abort-test');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /* ── Basic cases (existing) ── */

  it('throws RunCancelledError when signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const orchestrator = new Orchestrator({ provider });

    await expect(orchestrator.run({ prompt: 'test', signal: controller.signal })).rejects.toThrow(
      RunCancelledError,
    );
  });

  it('completes normally when signal is provided but never aborted', async () => {
    provider.enqueue({ text: 'Hello, world!' });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({ provider });

    const result = await orchestrator.run({ prompt: 'test', signal: controller.signal });
    expect(result.text).toBe('Hello, world!');
  });

  it('propagates signal to PromptRequest.signal', async () => {
    provider.enqueue({ text: 'response' });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({ provider });

    await orchestrator.run({ prompt: 'test', signal: controller.signal });

    const lastRequest = provider.lastRequest();
    expect(lastRequest?.signal).toBeDefined();
  });

  /* ── GAP 4: Non-streaming mid-generation abort ── */

  it('throws RunCancelledError when abort fires during non-streaming generation retry delay', async () => {
    provider.enqueue({ error: new ProviderTimeoutError('timeout') });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 100_000, maxDelayMs: 100_000, jitter: false },
    });

    const promise = orchestrator.run({ prompt: 'test', signal: controller.signal });

    // Provider fails with retryable error; abort fires during the retry delay
    controller.abort();

    await expect(promise).rejects.toThrow(RunCancelledError);
  });

  /* ── GAP 5: Abort during tool execution ── */

  it('throws RunCancelledError when abort fires during tool execution round', async () => {
    provider.enqueue({
      text: '',
      toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'test' } }],
    });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({
      provider,
      tools: [echoTool],
      retry: { maxAttempts: 1, baseDelayMs: 0, jitter: false },
    });

    const promise = orchestrator.run({ prompt: 'test', signal: controller.signal });

    // Abort fires during tool execution; signal is not checked during tool round
    // but is caught at the next generation round's abortRunCall check
    controller.abort();

    await expect(promise).rejects.toThrow(RunCancelledError);
  });

  /* ── GAP 6: Abort during memory save finalization ── */

  it('throws RunCancelledError when abort fires before memory save and does not save memory', async () => {
    const memory = new MockMemoryAdapter();
    provider.enqueue({ text: 'response' });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({
      provider,
      memoryAdapter: memory,
      retry: { maxAttempts: 1, baseDelayMs: 0, jitter: false },
    });

    const promise = orchestrator.run({
      prompt: 'test',
      sessionId: 'session-1',
      signal: controller.signal,
    });

    // Abort fires during finalization phase, before memory save check
    controller.abort();

    await expect(promise).rejects.toThrow(RunCancelledError);

    // Verify memory was NOT saved because abortRunCall threw before the save
    const saved = await memory.load('session-1');
    expect(saved).toHaveLength(0);
  });

  /* ── GAP 7: Fallback provider abort — no abortRunCall checkpoint ── */

  it('propagates abort signal to fallback provider PromptRequest.signal', async () => {
    const fallbackProvider = new MockProvider('fallback');
    fallbackProvider.enqueue({ text: 'fallback response' });

    provider.enqueue({ error: new ProviderTimeoutError('timeout') });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({
      provider,
      fallbackProvider,
      retry: { maxAttempts: 1, baseDelayMs: 0, jitter: false }, // No retries → immediate fallback
    });

    // Primary fails with maxAttempts=1 → MaxRetriesExceededError
    // Fallback triggered in handleProviderError — no abortRunCall checkpoint there
    const result = await orchestrator.run({ prompt: 'test', signal: controller.signal });
    expect(result.text).toBe('fallback response');

    // The abort signal IS propagated to the fallback provider via PromptRequest
    // even though there's no explicit abortRunCall check in handleProviderError
    const fallbackRequest = fallbackProvider.lastRequest();
    expect(fallbackRequest?.signal).toBeDefined();
  });

  it('throws RunCancelledError when abort fires during retry delay before fallback can be triggered', async () => {
    const fallbackProvider = new MockProvider('fallback');
    fallbackProvider.enqueue({ text: 'fallback response' });

    provider.enqueue({ error: new ProviderTimeoutError('timeout') });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({
      provider,
      fallbackProvider,
      retry: { maxAttempts: 2, baseDelayMs: 100_000, maxDelayMs: 100_000, jitter: false },
    });

    const promise = orchestrator.run({ prompt: 'test', signal: controller.signal });

    // Provider fails with retryable error → executeWithRetry enters retry delay
    // Abort fires during the delay → RunCancelledError thrown before fallback
    controller.abort();

    await expect(promise).rejects.toThrow(RunCancelledError);
  });

  /* ── GAP 8: buildPromptRequest composed signal (AbortSignal.any) ── */

  it('passes composed signal (not raw user signal) when both signal and timeout are configured', async () => {
    provider.enqueue({ text: 'response' });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 60_000, totalTimeoutMs: 120_000, toolTimeoutMs: 30_000 },
    });

    await orchestrator.run({ prompt: 'test', signal: controller.signal });

    const lastRequest = provider.lastRequest();
    expect(lastRequest?.signal).toBeDefined();
    // The signal on the request should be the composed signal, not the raw user signal
    expect(lastRequest?.signal).not.toBe(controller.signal);
  });

  /* ── GAP 9: MemorySaveError + abort priority ── */

  it('throws MemorySaveError when memory save fails and signal is not aborted before check', async () => {
    const memory = new MockMemoryAdapter();
    memory.saveError = new ProviderUnavailableError('storage unavailable');
    provider.enqueue({ text: 'response' });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({
      provider,
      memoryAdapter: memory,
      retry: { maxAttempts: 1, baseDelayMs: 0, jitter: false },
    });

    // Signal is NOT aborted — abortRunCall passes, then memory save throws
    await expect(
      orchestrator.run({
        prompt: 'test',
        sessionId: 'session-1',
        signal: controller.signal,
      }),
    ).rejects.toThrow(MemorySaveError);
  });

  /* ── GAP 15: MockProvider.generateStream signal propagation ── */

  it('propagates signal to PromptRequest.signal in streaming mode', async () => {
    provider.enqueue({ text: 'streaming response' });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 60_000, totalTimeoutMs: 120_000 },
    });

    const stream = (await orchestrator.run({
      prompt: 'test',
      stream: true,
      signal: controller.signal,
    })) as AsyncIterable<StreamChunk>;

    // Consume the stream
    for await (const _chunk of stream) {
      /* drain */
    }

    const lastRequest = provider.lastRequest();
    expect(lastRequest?.signal).toBeDefined();
  });

  /* ── Existing streaming tests ── */

  it('yields error chunk when signal aborted during streaming', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Hello ' },
        { type: 'text', delta: 'world' },
      ],
    });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 60_000, totalTimeoutMs: 120_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
      signal: controller.signal,
    })) as AsyncIterable<StreamChunk>;

    controller.abort();

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    const errorChunk = chunks.find((c) => c.type === 'error');
    expect(errorChunk).toBeDefined();
    if (errorChunk?.type === 'error') {
      expect(errorChunk.error.code).toBe('RUN_CANCELLED');
    }
  });

  it('abort during streaming retry delay yields error chunk', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'retried' },
        { type: 'done', usage: { prompt: 5, completion: 5, total: 10 } },
      ],
    });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 100_000, maxDelayMs: 100_000, jitter: false },
      timeout: { generateTimeoutMs: 60_000, totalTimeoutMs: 120_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
      signal: controller.signal,
    })) as AsyncIterable<StreamChunk>;

    controller.abort();

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    expect(chunks.some((c) => c.type === 'error')).toBe(true);
    const errorChunk = chunks.find((c) => c.type === 'error');
    if (errorChunk?.type === 'error') {
      expect(errorChunk.error.code).toBe('RUN_CANCELLED');
    }
  });
});
