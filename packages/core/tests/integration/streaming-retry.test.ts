import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AIProvider, StreamChunk, Tool } from '../../src/interfaces.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import {
  ProviderRateLimitError,
  MaxRetriesExceededError,
  ProviderTimeoutError,
  ProviderAuthError,
  ProviderUnavailableError,
  PipelineInternalError,
  RunCancelledError,
  ConfigValidationError,
} from '../../src/errors.js';

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
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // Advance timers past the retry sleep (10ms delay + margin)
    await vi.advanceTimersByTimeAsync(100);
    await consumer;

    const fullText = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
      .map((c) => c.delta)
      .join('');

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
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // Advance timers past retry sleeps (3 calls × 10ms delay + margin)
    await vi.advanceTimersByTimeAsync(100);
    await consumer;

    const errorReceived = chunks.some(
      (c): c is Extract<StreamChunk, { type: 'error' }> =>
        c.type === 'error' && c.error instanceof MaxRetriesExceededError,
    );

    expect(errorReceived).toBe(true);
    vi.useRealTimers();
  });

  it('maxAttempts: 1 with empty queue wraps retryable error as MaxRetriesExceededError', async () => {
    // maxAttempts=1 means only 1 call, wraps as MAX_RETRIES_EXCEEDED when queue empty
    const orchestrator = new Orchestrator({
      provider, // Empty queue
      retry: { maxAttempts: 1, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // No retry sleep needed — maxAttempts=1 exhausts immediately
    await vi.advanceTimersByTimeAsync(100);
    await consumer;

    const errorReceived = chunks.some(
      (c): c is Extract<StreamChunk, { type: 'error' }> =>
        c.type === 'error' && c.error.code === 'MAX_RETRIES_EXCEEDED',
    );

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
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // Advance timers past retry sleeps (3 calls × 10ms delay + margin)
    await vi.advanceTimersByTimeAsync(100);
    await consumer;

    // Should get error after exhausting retries with correct attempt count
    const errorChunks = chunks.filter(
      (c): c is Extract<StreamChunk, { type: 'error' }> => c.type === 'error',
    );
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);
    expect((errorChunks[0]!.error as MaxRetriesExceededError).attempts).toBe(3);
    vi.useRealTimers();
  });

  // ════════════════════════════════════════════════════════════════════
  // NEW COVERAGE GAP TESTS (FLAG-1 through FLAG-9)
  // ════════════════════════════════════════════════════════════════════

  it('FLAG-1: ProviderTimeoutError triggers retry and succeeds on 2nd attempt', async () => {
    // ProviderTimeoutError is retryable — the retry loop should catch the
    // rejection, retry, and succeed on the second call.
    provider.failureOnCall(1, new ProviderTimeoutError('timeout'));
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Recovered from timeout' },
        { type: 'done', usage: { prompt: 0, completion: 19, total: 19 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // Advance timers past the retry sleep (10ms delay + margin)
    await vi.advanceTimersByTimeAsync(100);
    await consumer;

    const fullText = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
      .map((c) => c.delta)
      .join('');

    expect(fullText).toBe('Recovered from timeout');
    // 1 failed attempt + 1 successful retry
    expect(provider.callCount()).toBe(2);
    vi.useRealTimers();
  });

  it('FLAG-2: ProviderRateLimitError retryAfterMs used for retry delay calculation', async () => {
    // ProviderRateLimitError with retryAfterMs=5000. The retry delay is calculated
    // by policies.ts calculateDelay() (L76-79), which checks
    // ProviderRateLimitError.retryAfterMs first and uses
    // Math.min(retryAfterMs, maxDelayMs) — overriding baseDelayMs.
    // With fake timers the actual delay is irrelevant; the test proves retry
    // completes correctly with a non-zero retryAfterMs and the expected call count.
    provider.failureOnCall(1, new ProviderRateLimitError('429', 5000));
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Delayed retry success' },
        { type: 'done', usage: { prompt: 0, completion: 20, total: 20 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      // baseDelayMs=10 would give ~10ms delay, but retryAfterMs=5000 overrides it
      retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 60_000, totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // Advance timers past the retry sleep (retryAfterMs=5000 + margin)
    await vi.advanceTimersByTimeAsync(6000);
    await consumer;

    const fullText = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
      .map((c) => c.delta)
      .join('');

    expect(fullText).toBe('Delayed retry success');
    // 1 failed + 1 retry success
    expect(provider.callCount()).toBe(2);
    vi.useRealTimers();
  });

  it('FLAG-3: MaxRetriesExceededError.retryable is false', async () => {
    // Exhaust retries with maxAttempts=2, then verify the yielded error's
    // `retryable` property is `false`. MaxRetriesExceededError is never retryable
    // — it's a terminal error indicating the retry budget was consumed.
    provider
      .failureOnCall(1, new ProviderRateLimitError('429', 50))
      .failureOnCall(2, new ProviderRateLimitError('429', 50));

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // Advance timers past retry sleeps (2 calls × 10ms delay + margin)
    await vi.advanceTimersByTimeAsync(100);
    await consumer;

    const errorChunks = chunks.filter(
      (c): c is Extract<StreamChunk, { type: 'error' }> => c.type === 'error',
    );
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);
    expect(errorChunks[0]!.error).toBeInstanceOf(MaxRetriesExceededError);
    expect(errorChunks[0]!.error.retryable).toBe(false);
    vi.useRealTimers();
  });

  it('FLAG-4: AbortSignal during retry backoff sleep yields RunCancelledError before retry recovery', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();

    // First call fails with retryable error. The retry loop enters
    // abortableSleep(delayMs, signal). We abort the signal during the sleep,
    // which should take priority over the retry recovery.
    provider.failureOnCall(1, new ProviderRateLimitError('429', 50));
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Should not appear' },
        { type: 'done', usage: { prompt: 0, completion: 9, total: 9 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      // Delay is 50ms (retryAfterMs=50 capped at maxDelayMs=30000).
      // With fake timers the setTimeout won't fire until we advance timers.
      retry: { maxAttempts: 2, baseDelayMs: 5000, jitter: false },
      timeout: { generateTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
      signal: controller.signal,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // Advance timers by 1ms to drain the microtask queue and let the generator
    // start executing. This triggers: initializePipeline → while loop →
    // executeStreamingGenerationRound → generateStream (rejects) →
    // retry catch → abortRunCall → abortableSleep(50, signal).
    // The setTimeout(50ms) is pending (fake timers). The abort listener is registered.
    await vi.advanceTimersByTimeAsync(1);

    // Abort DURING the retry backoff sleep — the abort listener fires synchronously,
    // resolving the sleep promise. abortRunCall throws RunCancelledError.
    controller.abort();

    // Let RunCancelledError propagate through the pipeline and get yielded
    // as an error chunk.
    await vi.advanceTimersByTimeAsync(100);
    await consumer;

    const errorChunks = chunks.filter(
      (c): c is Extract<StreamChunk, { type: 'error' }> => c.type === 'error',
    );
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);
    expect(errorChunks[0]!.error).toBeInstanceOf(RunCancelledError);

    // No text chunks — the retry was aborted before recovery could complete
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(0);

    // Provider was called once (the retry was interrupted before the 2nd call)
    expect(provider.callCount()).toBe(1);
    vi.useRealTimers();
  });

  it('FLAG-5: second-round generateStream rejection in tool loop triggers retry and recovers', async () => {
    vi.useRealTimers();

    const echoTool: Tool = {
      name: 'echo',
      description: 'Echoes input',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
        additionalProperties: false,
      },
      async execute(input: unknown) {
        return input;
      },
    };

    // Round 1: generateStream succeeds with tool_call (triggers tool execution)
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Round 1 ' },
        {
          type: 'tool_call',
          toolCall: { id: 'call-1', name: 'echo', input: { value: 'hello' } },
        },
        { type: 'done', usage: { prompt: 5, completion: 2, total: 7 } },
      ],
    });

    // Round 2 retry: after the retry of the failed 2nd generateStream
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Retry success from tool loop' },
        { type: 'done', usage: { prompt: 10, completion: 20, total: 30 } },
      ],
    });

    // Fail the SECOND generateStream call (round 2 initial attempt)
    // The first call (round 1) succeeds, tool executes, round 2 calls
    // generateStream again — this one fails and triggers the retry.
    provider.failureOnCall(2, new ProviderUnavailableError('Service unavailable in tool loop'));

    const orchestrator = new Orchestrator({
      provider,
      tools: [echoTool],
      retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunkTypes: string[] = [];
    const textChunks: string[] = [];
    for await (const chunk of result) {
      chunkTypes.push(chunk.type);
      if (chunk.type === 'text') {
        textChunks.push(chunk.delta);
      }
    }

    // Round 1 text
    expect(textChunks.join('')).toContain('Round 1');
    // Round 2 retry text
    expect(textChunks.join('')).toContain('Retry success from tool loop');

    // tool_call from round 1
    expect(chunkTypes).toContain('tool_call');
    // tool_result from tool execution
    expect(chunkTypes).toContain('tool_result');
    // Stream completed
    expect(chunkTypes).toContain('done');
    // No error — retry recovered
    expect(chunkTypes).not.toContain('error');

    // Provider call count: call 1 (success) + call 2 (failure) + call 3 (retry success) = 3
    expect(provider.callCount()).toBe(3);
  });

  it('FLAG-6: mixed retryable→non-retryable sequence stops retry and yields non-retryable error', async () => {
    // First call: retryable ProviderRateLimitError → retry fires
    // Second call: non-retryable ProviderAuthError → retry stops immediately
    // Error chunk contains ProviderAuthError (NOT MaxRetriesExceededError)
    provider
      .failureOnCall(1, new ProviderRateLimitError('429', 50))
      .failureOnCall(2, new ProviderAuthError('Auth failed'));

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // Advance timers past the retry sleep (10ms delay + margin)
    await vi.advanceTimersByTimeAsync(100);
    await consumer;

    const errorChunks = chunks.filter(
      (c): c is Extract<StreamChunk, { type: 'error' }> => c.type === 'error',
    );
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);
    // Non-retryable error passes through directly — NOT wrapped as MaxRetriesExceededError
    expect(errorChunks[0]!.error).toBeInstanceOf(ProviderAuthError);
    expect(errorChunks[0]!.error.retryable).toBe(false);

    // Two calls were made: 1 retryable failure → retry → 1 non-retryable failure → stop
    expect(provider.callCount()).toBe(2);
    vi.useRealTimers();
  });

  it('FLAG-7: plain Error from inline provider wraps as PipelineInternalError in retry loop', async () => {
    // MockProvider only throws OrchestratorError subclasses, so we use an inline
    // AIProvider that throws a plain Error. The pipeline wraps it as
    // PipelineInternalError via handleOrchestratorError. Since PipelineInternalError
    // has retryable=false, the retry loop exits immediately without retrying.
    let inlineCallCount = 0;

    const plainErrorProvider: AIProvider = {
      id: 'plain-error',
      capabilities: {
        streaming: true,
        toolCalling: false,
        vision: false,
        maxContextTokens: 128_000,
      },
      generate: async () => {
        throw new Error('unused');
      },
      generateStream: async () => {
        inlineCallCount++;
        throw new Error('Something went wrong in the provider');
      },
    };

    const orchestrator = new Orchestrator({
      provider: plainErrorProvider,
      // maxAttempts=2 means 2 retry attempts available, but the non-retryable
      // PipelineInternalError should stop retry immediately after the first call
      retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // No retry sleep timer needed — PipelineInternalError is non-retryable
    await vi.advanceTimersByTimeAsync(100);
    await consumer;

    const errorChunks = chunks.filter(
      (c): c is Extract<StreamChunk, { type: 'error' }> => c.type === 'error',
    );
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);
    expect(errorChunks[0]!.error).toBeInstanceOf(PipelineInternalError);
    expect(errorChunks[0]!.error.message).toContain('Something went wrong in the provider');
    // PipelineInternalError is non-retryable
    expect(errorChunks[0]!.error.retryable).toBe(false);

    // Only 1 call — PipelineInternalError is not retryable
    expect(inlineCallCount).toBe(1);
    vi.useRealTimers();
  });

  it('FLAG-8: jitter: true works correctly in streaming retry', async () => {
    // With jitter enabled, the retry delay includes a random component.
    // Since timing is non-deterministic with jitter, this test only verifies
    // that retry works correctly (correct text, correct call count) — not
    // the specific delay value.
    provider.failureOnCall(1, new ProviderRateLimitError('429', 50));
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Jitter retry success' },
        { type: 'done', usage: { prompt: 0, completion: 18, total: 18 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 2, baseDelayMs: 10, jitter: true },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // Advance timers past the retry sleep (10ms base delay + jitter + margin)
    await vi.advanceTimersByTimeAsync(100);
    await consumer;

    const fullText = chunks
      .filter((c): c is Extract<StreamChunk, { type: 'text' }> => c.type === 'text')
      .map((c) => c.delta)
      .join('');

    expect(fullText).toBe('Jitter retry success');
    // 1 failed + 1 retry success
    expect(provider.callCount()).toBe(2);
    vi.useRealTimers();
  });

  it('FLAG-9: baseDelayMs: 0 boundary works correctly in streaming retry', async () => {
    // Boundary test: baseDelayMs=0 produces a delay of 0*2^attempt = 0ms
    // for the first retry. The exponential backoff formula from policies.ts
    // calculateDelay() computes: baseDelayMs * Math.pow(2, attempt).
    // With baseDelayMs=0, the delay is always 0 — effectively no delay between
    // retries. The retry should still succeed correctly.
    provider.failureOnCall(1, new ProviderRateLimitError('429', 50));
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Zero delay retry success' },
        { type: 'done', usage: { prompt: 0, completion: 22, total: 22 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 2, baseDelayMs: 0, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;
    vi.runAllTimersAsync();

    let fullText = '';
    for await (const chunk of result) {
      if (chunk.type === 'text') {
        fullText += chunk.delta;
      }
    }

    expect(fullText).toBe('Zero delay retry success');
    // 1 failed + 1 retry success
    expect(provider.callCount()).toBe(2);
    vi.useRealTimers();
  });

  // ════════════════════════════════════════════════════════════════════
  // FLAG-10: Constructor validates retry.maxAttempts >= 1 (v1 constraint)
  // ════════════════════════════════════════════════════════════════════

  it('retry.maxAttempts: 0 in streaming context throws ConfigValidationError at construction', () => {
    const provider = new MockProvider('flag10-stream');
    expect(
      () =>
        new Orchestrator({
          provider,
          retry: { maxAttempts: 0 },
        }),
    ).toThrow(ConfigValidationError);
  });

  it('retry.maxAttempts: -1 in streaming context throws ConfigValidationError at construction', () => {
    const provider = new MockProvider('flag10-negative');
    expect(
      () =>
        new Orchestrator({
          provider,
          retry: { maxAttempts: -1 },
        }),
    ).toThrow(ConfigValidationError);
  });
});
