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

  // Note: Kept despite asyncIteratorWithIdleTimeout being chunk-type-agnostic, because it
  // explicitly documents the idle-timeout behavior when a tool_call chunk is the first chunk
  // yielded. This serves as a behavioral spec for the tool_call + idle timeout combination.
  it('streaming with tool calls and idle timeout fires timeout error', async () => {
    vi.useFakeTimers();

    // Custom generator: tool_call chunk immediately, then long delay before done
    provider.generateStream = async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'tool_call',
          toolCall: {
            id: 'test_id',
            name: 'test_tool',
            arguments: '{}',
            input: {},
          },
          usage: { prompt: 0, completion: 0, total: 0 },
        };

        // Delay that exceeds the idle timeout
        await new Promise<void>((resolve) => setTimeout(resolve, 200));

        yield {
          type: 'done',
          usage: { prompt: 0, completion: 0, total: 0 },
          toolCall: {
            id: 'test_id',
            name: 'test_tool',
            arguments: '{}',
            input: {},
          },
        };
      },
    });

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 50, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    let errorChunk: StreamChunk | undefined;
    const consumer = (async () => {
      for await (const chunk of result) {
        if (chunk.type === 'error') {
          errorChunk = chunk;
        }
      }
    })();

    // Advance past the idle timeout (50ms) but before the done delay (200ms)
    await vi.advanceTimersByTimeAsync(100);
    await consumer;

    expect(errorChunk).toBeDefined();
    if (errorChunk?.type === 'error') {
      expect(errorChunk.error).toBeInstanceOf(TimeoutExceededError);
    }
  });

  it('user AbortSignal takes priority over idle timeout mid-stream', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();

    provider.generateStream = async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', delta: 'A' };
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        yield { type: 'text', delta: 'B' };
        yield { type: 'done', usage: { prompt: 0, completion: 2, total: 2 } };
      },
    });

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
      signal: ac.signal,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    const consumer = (async () => {
      for await (const chunk of result) {
        chunks.push(chunk);
      }
    })();

    // Advance past first chunk (immediate), generator now waiting on setTimeout(200)
    await vi.advanceTimersByTimeAsync(50);

    // Abort user signal mid-stream — verifies RunCancelledError is yielded
    ac.abort();

    // Advance remaining timers
    await vi.advanceTimersByTimeAsync(200);
    await consumer;

    const errorChunks = chunks.filter(
      (c): c is Extract<StreamChunk, { type: 'error' }> => c.type === 'error',
    );
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);
    expect(errorChunks[0]?.error).toBeInstanceOf(RunCancelledError);
  });

  // ── G1: generateTimeoutMs <= 0 passthrough ────────────────────────────
  // Profile-level timeout bypasses constructor validation (orchestrator.ts L84-99)
  // which only validates config.timeout at the top level. The profile value of 0
  // is merged via mergeTimeoutPolicy (policies.ts L46-54), overriding the default
  // of 30000. At pipeline.ts L118, timeoutMs <= 0 triggers the passthrough path,
  // meaning no per-chunk idle timeout is applied. This test verifies that the stream
  // completes successfully despite inter-chunk delays that would exceed a normal timeout.

  it('profile-level generateTimeoutMs:0 bypasses idle timeout via passthrough', async () => {
    vi.useFakeTimers();

    const orch = new Orchestrator({
      provider,
      profiles: {
        no_idle: {
          name: 'no_idle',
          timeout: { generateTimeoutMs: 0 },
        },
      },
    });

    // Custom generator with a delay that would trigger idle timeout if passthrough
    // were NOT active (pipeline.ts L118: timeoutMs <= 0 → skip idle timeout wrapping)
    provider.generateStream = async () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'text', delta: 'S' };
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
        yield { type: 'text', delta: 'low' };
        yield { type: 'done', usage: { prompt: 0, completion: 4, total: 4 } };
      },
    });

    const result = (await orch.run({
      prompt: 'test',
      stream: true,
      profile: 'no_idle',
    })) as AsyncIterable<StreamChunk>;

    let text = '';
    const consumer = (async () => {
      for await (const chunk of result) {
        if (chunk.type === 'text') text += chunk.delta;
      }
    })();

    // Advance timers fully — the 200ms setTimeout in the generator fires,
    // remaining chunks are yielded. Because generateTimeoutMs:0 disables the
    // idle timeout, no TimeoutExceededError is thrown.
    await vi.advanceTimersByTimeAsync(500);
    await consumer;

    expect(text).toBe('Slow');
  });

  // ── G3: Pre-stream API call timeout ────────────────────────────────────
  // This tests the OTHER timeout mechanism in pipeline.ts: AbortSignal.timeout()
  // created in buildPromptRequest (L72-74). This fires during the generateStream()
  // API call itself (before any chunks are yielded), as opposed to the per-chunk
  // idle timeout which fires between chunks. MockProvider does not observe
  // request.signal, so we use a custom inline provider that hangs until the signal fires.

  it('pre-stream AbortSignal.timeout cancels hanging generateStream', async () => {
    vi.useFakeTimers();

    const hangingProvider: AIProvider = {
      id: 'hanging',
      capabilities: { streaming: true, toolCalling: false, vision: false, maxContextTokens: 128_000 },
      generate: async () => {
        throw new Error('unused');
      },
      generateStream: async (request) => {
        // Hang until the request's AbortSignal fires (from AbortSignal.timeout)
        return new Promise<AsyncIterable<StreamChunk>>((_resolve, reject) => {
          if (request.signal?.aborted) {
            reject(request.signal.reason);
            return;
          }
          request.signal?.addEventListener('abort', () => {
            reject(request.signal?.reason);
          });
        });
      },
    };

    const orchestrator = new Orchestrator({
      provider: hangingProvider,
      timeout: { generateTimeoutMs: 50, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const resultPromise = orchestrator.run({ prompt: 'test', stream: true });

    // Advance past the AbortSignal.timeout(50) — the signal fires, the
    // hanging provider's promise rejects, and the pipeline wraps the error.
    await vi.advanceTimersByTimeAsync(100);

    let errorReceived = false;
    for await (const chunk of await resultPromise) {
      if (chunk.type === 'error') {
        errorReceived = true;
        // The non-OrchestratorError (DOMException/TimeoutError) is wrapped
        // as PipelineInternalError by handleOrchestratorError (pipeline.ts L176)
        expect(chunk.error).toBeInstanceOf(PipelineInternalError);
      }
    }

    expect(errorReceived).toBe(true);
  });
});
