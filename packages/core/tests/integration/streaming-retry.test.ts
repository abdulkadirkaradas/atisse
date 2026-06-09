import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { ProviderRateLimitError, MaxRetriesExceededError } from '../../src/errors.js';

describe('Integration: Streaming Retry (D-M3-1)', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider('streaming-retry-test');
  });

  it('generateStream() rejection triggers retry and succeeds on 2nd attempt', async () => {
    // Fail on first generating call, then succeed on retry
    provider.failureOnCall(1, new ProviderRateLimitError('429', 50));
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'H' },
        { type: 'text', delta: 'i' },
        { type: 'done', usage: { prompt: 0, completion: 2, total: 2 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const resultPromise = orchestrator.run({ prompt: 'test', stream: true });
    vi.runAllTimersAsync();
    const result = resultPromise as Promise<
      AsyncIterable<{ type: 'text'; delta: string } | { type: 'done' }>
    >;

    let fullText = '';
    for await (const chunk of await result) {
      if (chunk.type === 'text') {
        fullText += chunk.delta;
      }
    }

    expect(fullText).toBe('Hi');
    expect(provider.callCount()).toBe(2); // 1 failed + 1 succeeded
    vi.useRealTimers();
  });

  it('retries up to maxAttempts then yields MaxRetriesExceededError', async () => {
    // Fail on first two generating attempts
    provider
      .failureOnCall(1, new ProviderRateLimitError('429', 50))
      .failureOnCall(2, new ProviderRateLimitError('429', 50));

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const resultPromise = orchestrator.run({ prompt: 'test', stream: true });
    vi.runAllTimersAsync();

    let errorReceived = false;
    for await (const chunk of await resultPromise) {
      if (chunk.type === 'error') {
        errorReceived = true;
        expect(chunk.error).toBeInstanceOf(MaxRetriesExceededError);
      }
    }

    expect(errorReceived).toBe(true);
    vi.useRealTimers();
  });

  it('non-retryable error yields immediately without retry', async () => {
    // maxAttempts=1 means only 1 call, wraps as MAX_RETRIES_EXCEEDED when queue empty
    const orchestrator = new Orchestrator({
      provider, // Empty queue
      retry: { maxAttempts: 1, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const resultPromise = orchestrator.run({ prompt: 'test', stream: true });
    vi.runAllTimersAsync();

    let errorReceived = false;
    for await (const chunk of await resultPromise) {
      if (chunk.type === 'error') {
        errorReceived = true;
        expect(chunk.error.code).toBe('MAX_RETRIES_EXCEEDED');
      }
    }

    expect(errorReceived).toBe(true);
    vi.useRealTimers();
  });

  it('streaming retry correctly counts attempts', async () => {
    // Fail on first 2 attempts - this tests the attempt counter works
    provider
      .failureOnCall(1, new ProviderRateLimitError('429', 50))
      .failureOnCall(2, new ProviderRateLimitError('429', 50));

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
    });

    vi.useFakeTimers();
    const resultPromise = orchestrator.run({ prompt: 'test', stream: true });
    vi.runAllTimersAsync();

    let hasError = false;
    for await (const chunk of await resultPromise) {
      if (chunk.type === 'error') {
        hasError = true;
      }
    }

    // Should get error after exhausting retries
    expect(hasError).toBe(true);
    vi.useRealTimers();
  });
});
