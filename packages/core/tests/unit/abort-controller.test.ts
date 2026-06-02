import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RunCancelledError, isRetryable } from '../../src/errors.js';
import { abortableSleep, executeWithRetry, DEFAULT_RETRY } from '../../src/policies.js';
import { ProviderTimeoutError } from '../../src/errors.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
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
});

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
});

describe('AbortSignal in RunInput - Integration', () => {
  let provider: MockProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new MockProvider('abort-test');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws RunCancelledError when signal already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const orchestrator = new Orchestrator({ provider });

    await expect(
      orchestrator.run({ prompt: 'test', signal: controller.signal }),
    ).rejects.toThrow(RunCancelledError);
  });

  it('completes normally when signal is provided but never aborted', async () => {
    provider.enqueue({ text: 'Hello, world!' });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({ provider });

    const result = await orchestrator.run({ prompt: 'test', signal: controller.signal });
    expect(result.text).toBe('Hello, world!');
  });

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

  it('propagates signal to PromptRequest.signal', async () => {
    provider.enqueue({ text: 'response' });

    const controller = new AbortController();
    const orchestrator = new Orchestrator({ provider });

    await orchestrator.run({ prompt: 'test', signal: controller.signal });

    const lastRequest = provider.lastRequest();
    expect(lastRequest?.signal).toBeDefined();
  });

  it('abort during streaming retry delay yields error chunk', async () => {
    provider.failureOnCall(1, new ProviderTimeoutError('first timeout'));
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
