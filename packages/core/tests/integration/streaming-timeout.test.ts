import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamChunk, AIProvider } from '../../src/interfaces.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { TimeoutExceededError, RunCancelledError, PipelineInternalError } from '../../src/errors.js';

describe('Integration: Streaming Timeout (D-M3-2)', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider('streaming-timeout-test');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Note: This test uses fake timers for deterministic behavior and is the higher-quality
  // version of streaming.test.ts:677 (which uses real timers). The fake-timer approach is
  // preferred because it avoids real delays, eliminates flakiness, and runs faster.
  it('generateTimeoutMs correctly interrupts streaming with idle timeout', async () => {
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

  it('default timeout merge - streaming works without explicit timeout config', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Default' },
        { type: 'done', usage: { prompt: 0, completion: 7, total: 7 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    let text = '';
    for await (const chunk of result) {
      if (chunk.type === 'text') text += chunk.delta;
    }

    expect(text).toBe('Default');
  });
});
