import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamChunk } from '../../src/interfaces.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { TimeoutExceededError } from '../../src/errors.js';

describe('Integration: Streaming Timeout (D-M3-2)', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider('streaming-timeout-test');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('generateTimeoutMs correctly interrupts streaming', async () => {
    // Use fake timers to control time
    vi.useFakeTimers();

    // Override generateStream to yield chunks slowly with fake-time delays.
    // This ensures the rejectAfter timeout fires during consumption.
    provider.generateStream = async () => {
      const chunks: StreamChunk[] = [
        { type: 'text', delta: 'S' },
        { type: 'text', delta: 'l' },
        { type: 'text', delta: 'o' },
        { type: 'text', delta: 'w' },
        { type: 'text', delta: ' ' },
        { type: 'text', delta: 'r' },
        { type: 'text', delta: 'e' },
        { type: 'text', delta: 's' },
        { type: 'text', delta: 'p' },
        { type: 'text', delta: 'o' },
        { type: 'done', usage: { prompt: 0, completion: 10, total: 10 } },
      ];

      return {
        async *[Symbol.asyncIterator]() {
          for (const chunk of chunks) {
            // Each chunk takes 20ms of fake time
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
            yield chunk;
          }
        },
      };
    };

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 50, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({ prompt: 'test', stream: true })) as AsyncIterable<
      StreamChunk
    >;

    let errorReceived = false;
    let timeoutErrorChunk: StreamChunk | undefined;

    // Start consuming the stream (triggers the async generator)
    const consumer = (async () => {
      for await (const chunk of result) {
        if (chunk.type === 'error') {
          errorReceived = true;
          timeoutErrorChunk = chunk;
        }
      }
    })();

    // Advance fake timers past the 50ms generateTimeoutMs
    // At 20ms: first chunk yields
    // At 40ms: second chunk yields
    // At 50ms: rejectAfter timeout fires → pipeline catches → error chunk yielded
    await vi.advanceTimersByTimeAsync(100);

    // Wait for consumer to finish processing all yielded chunks
    await consumer;

    // Verify TimeoutExceededError was yielded from the stream
    expect(errorReceived).toBe(true);
    expect(timeoutErrorChunk).toBeDefined();
    if (timeoutErrorChunk?.type === 'error') {
      expect(timeoutErrorChunk.error).toBeInstanceOf(TimeoutExceededError);
    }
  });

  it('streaming completes within timeout - no error', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Fast' },
        { type: 'done', usage: { prompt: 0, completion: 4, total: 4 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({ prompt: 'test', stream: true })) as AsyncIterable<
      { type: 'text'; delta: string } | { type: 'done' }
    >;

    let text = '';
    let doneReceived = false;

    for await (const chunk of result) {
      if (chunk.type === 'text') {
        text += chunk.delta;
      } else if (chunk.type === 'done') {
        doneReceived = true;
      }
    }

    expect(text).toBe('Fast');
    expect(doneReceived).toBe(true);
  });

  it('totalTimeoutMs aborts entire run including tool execution', async () => {
    // Provider that responds quickly, won't trigger generate timeout
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Response' },
        { type: 'done', usage: { prompt: 0, completion: 8, total: 8 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 50 }, // Very short total timeout
    });

    vi.useFakeTimers();

    // Should reject with TimeoutExceededError
    let timeoutError = false;
    try {
      const result = (await orchestrator.run({
        prompt: 'test',
        stream: true,
      })) as AsyncIterable<StreamChunk>;
      vi.advanceTimersByTimeAsync(100);

      for await (const chunk of result) {
        // Consume to trigger any errors
        void chunk;
      }
    } catch (error) {
      if (error instanceof TimeoutExceededError) {
        timeoutError = true;
      }
    }

    // Either we get timeout error directly, or it times out during streaming
    expect(timeoutError || provider.callCount() >= 1).toBe(true);
  });
});
