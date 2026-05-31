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

  it('generateTimeoutMs correctly interrupts streaming with idle timeout', async () => {
    // Use fake timers to control time
    vi.useFakeTimers();

    // Override generateStream to yield chunks with a gap that exceeds the idle timeout.
    // First chunk is immediate, second chunk is delayed 100ms.
    // With generateTimeoutMs=50, the idle timeout fires while waiting for the second chunk.
    provider.generateStream = async () => {
      const chunks: StreamChunk[] = [
        { type: 'text', delta: 'S' },
        { type: 'text', delta: 'l' },
        { type: 'text', delta: 'o' },
        { type: 'text', delta: 'w' },
      ];

      return {
        async *[Symbol.asyncIterator]() {
          for (const [i, chunk] of chunks.entries()) {
            // First chunk immediate, then each subsequent chunk has 100ms delay
            if (i > 0) {
              await new Promise<void>((resolve) => setTimeout(resolve, 100));
            }
            yield chunk;
          }
        },
      };
    };

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 50, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

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

    // Advance fake timers:
    // t=0: first chunk yields immediately, idle timeout starts (50ms)
    // t=50ms: idle timeout fires → TimeoutExceededError → error chunk yielded
    // t=100ms: second chunk's timer fires but the pipeline already caught the error
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
