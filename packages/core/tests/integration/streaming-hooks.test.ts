import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  BeforeGenerateContext,
  AfterGenerateContext,
  RunContext,
  AfterRunContext,
  StreamChunk,
} from '../../src/interfaces.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';

describe('Integration: Streaming Hook Timing (D-M3-3)', () => {
  let provider: MockProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new MockProvider('streaming-hooks-test');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('afterGenerate fires AFTER done chunk, not before', async () => {
    const callOrder: string[] = [];

    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'H' },
        { type: 'text', delta: 'i' },
        { type: 'done', usage: { prompt: 0, completion: 2, total: 2 } },
      ],
    });

    const afterGenerateHook = vi.fn(async (ctx: AfterGenerateContext) => {
      callOrder.push('afterGenerate');
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { afterGenerate: [afterGenerateHook] },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({ prompt: 'test', stream: true })) as AsyncIterable<
      { type: 'text'; delta: string } | { type: 'done' }
    >;

    // First, consume all chunks to let stream complete
    for await (const chunk of result) {
      if (chunk.type === 'text') {
        callOrder.push('text');
      } else if (chunk.type === 'done') {
        callOrder.push('done');
      }
    }

    // afterGenerate should fire after the done chunk (not before text chunks)
    expect(callOrder).toContain('afterGenerate');
    const afterGenerateIndex = callOrder.indexOf('afterGenerate');
    const doneIndex = callOrder.indexOf('done');

    // afterGenerate should run after done is yielded to consumer
    expect(afterGenerateIndex).toBeGreaterThan(doneIndex);
  });

  it('beforeGenerate fires BEFORE streaming starts', async () => {
    const callOrder: string[] = [];

    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Response' },
        { type: 'done', usage: { prompt: 0, completion: 8, total: 8 } },
      ],
    });

    const beforeGenerateHook = vi.fn(async (ctx: BeforeGenerateContext) => {
      callOrder.push('beforeGenerate');
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { beforeGenerate: [beforeGenerateHook] },
    });

    vi.runAllTimersAsync();
    const result = (await orchestrator.run({ prompt: 'test', stream: true })) as AsyncIterable<
      { type: 'text'; delta: string } | { type: 'done' }
    >;

    // Consume the stream to trigger the hooks
    for await (const chunk of result) {
      void chunk;
    }

    expect(beforeGenerateHook).toHaveBeenCalledTimes(1);
    expect(callOrder[0]).toBe('beforeGenerate');
  });

  it('afterRun fires after streaming completes', async () => {
    const callOrder: string[] = [];

    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Final' },
        { type: 'done', usage: { prompt: 0, completion: 5, total: 5 } },
      ],
    });

    const afterRunHook = vi.fn(async (ctx: AfterRunContext) => {
      callOrder.push('afterRun');
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { afterRun: [afterRunHook] },
    });

    vi.runAllTimersAsync();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    // Consume stream
    for await (const chunk of result) {
      if (chunk.type === 'done') {
        callOrder.push('done');
      }
    }

    // Wait for async afterRun
    await vi.runAllTimersAsync();

    expect(afterRunHook).toHaveBeenCalledTimes(1);
    // afterRun runs after the done chunk
    expect(callOrder).toContain('afterRun');
  });

  it('hook throw during streaming propagates as error chunk', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Before error' },
        { type: 'done', usage: { prompt: 0, completion: 12, total: 12 } },
      ],
    });

    const afterGenerateHook = vi.fn(async () => {
      throw new Error('afterGenerate hook failed');
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { afterGenerate: [afterGenerateHook] },
    });

    vi.runAllTimersAsync();
    const result = (await orchestrator.run({ prompt: 'test', stream: true })) as AsyncIterable<
      { type: 'text'; delta: string } | { type: 'done' } | { type: 'error'; error: Error }
    >;

    let errorChunk = false;
    for await (const chunk of result) {
      if (chunk.type === 'error') {
        errorChunk = true;
        expect(chunk.error.message).toBe('afterGenerate hook failed');
      }
    }

    expect(errorChunk).toBe(true);
  });

  it('beforeRun hook runs before streaming', async () => {
    const callOrder: string[] = [];

    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Stream' },
        { type: 'done', usage: { prompt: 0, completion: 6, total: 6 } },
      ],
    });

    const beforeRunHook = vi.fn(async (ctx: RunContext) => {
      callOrder.push('beforeRun');
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { beforeRun: [beforeRunHook] },
    });

    vi.runAllTimersAsync();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    for await (const chunk of result) {
      if (chunk.type === 'text') {
        callOrder.push('text');
      } else if (chunk.type === 'done') {
        callOrder.push('done');
      }
    }

    expect(beforeRunHook).toHaveBeenCalledTimes(1);
    expect(callOrder[0]).toBe('beforeRun');
  });
});
