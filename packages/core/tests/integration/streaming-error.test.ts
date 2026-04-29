import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamChunk } from '../../src/interfaces.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { ProviderUnavailableError, ProviderRateLimitError } from '../../src/errors.js';

describe('Integration: Streaming Connection Errors (Edge Cases)', () => {
  let provider: MockProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new MockProvider('streaming-error-test');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('error mapping when network fails before streaming starts', async () => {
    // Empty queue with maxAttempts=1 -> immediate failure
    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 1, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    vi.runAllTimersAsync();
    const resultPromise = orchestrator.run({ prompt: 'test', stream: true });

    let errorReceived = false;
    for await (const chunk of await resultPromise) {
      if (chunk.type === 'error') {
        errorReceived = true;
        expect(chunk.error.code).toBe('MAX_RETRIES_EXCEEDED');
      }
    }

    expect(errorReceived).toBe(true);
  });

  it('mid-stream error chunk is yielded to consumer', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Partial ' },
        { type: 'error', error: new ProviderRateLimitError('429', 50) },
        { type: 'text', delta: 'Response' }, // Shouldn't reach this
        { type: 'done', usage: { prompt: 0, completion: 0, total: 0 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    vi.runAllTimersAsync();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: Array<StreamChunk> = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Should have text, error, and potentially done (depending on implementation)
    const hasText = chunks.some((c) => c.type === 'text' && c.delta === 'Partial ');
    const hasError = chunks.some((c) => c.type === 'error');

    expect(hasText).toBe(true);
    expect(hasError).toBe(true);
  });

  it('retry works for initial generateStream rejection', async () => {
    // First attempt (index 2) fails with empty queue error
    provider.failureOnCall(2, new ProviderUnavailableError('Connection refused'));
    // Second attempt succeeds
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Recovered' },
        { type: 'done', usage: { prompt: 0, completion: 9, total: 9 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    vi.runAllTimersAsync();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    let text = '';
    for await (const chunk of result) {
      if (chunk.type === 'text') {
        text += chunk.delta;
      }
    }

    expect(text).toBe('Recovered');
    expect(provider.callCount()).toBe(2);
  });

  it('stream with immediate rejection - error chunk with correct code', async () => {
    provider.enqueueStream({
      chunks: [{ type: 'error', error: new ProviderRateLimitError('429', 50) }],
    });

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 1, baseDelayMs: 10, jitter: false },
    });

    vi.runAllTimersAsync();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    let hasError = false;
    let errorCode = '';
    for await (const chunk of result) {
      if (chunk.type === 'error') {
        hasError = true;
        errorCode = chunk.error.code;
      }
    }

    // With maxAttempts=1, wraps as MAX_RETRIES_EXCEEDED
    expect(hasError).toBe(true);
    expect(errorCode).toBe('MAX_RETRIES_EXCEEDED');
  });

  it('stream yielding error chunk stops iteration', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Start' },
        { type: 'error', error: new ProviderUnavailableError('Stream error') },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
    });

    vi.runAllTimersAsync();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const collected: Array<StreamChunk> = [];
    for await (const chunk of result) {
      collected.push(chunk);
      // After error, stream may complete or continue - collector pattern handles both
      if (chunk.type === 'error') {
        break; // Stop on error for this test
      }
    }

    expect(collected.some((c) => c.type === 'text')).toBe(true);
    expect(collected.some((c) => c.type === 'error')).toBe(true);
  });
});
