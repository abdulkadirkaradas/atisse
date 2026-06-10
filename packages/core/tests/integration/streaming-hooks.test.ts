import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  BeforeGenerateContext,
  AfterGenerateContext,
  RunContext,
  AfterRunContext,
  StreamChunk,
  Tool,
  ToolContext,
  AfterToolContext,
  TokenUsage,
  LifecycleState,
} from '../../src/interfaces.js';
import { LifecycleStateMachine } from '../../src/lifecycle.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import {
  OrchestratorError,
  PipelineInternalError,
  RunCancelledError,
  MaxToolRoundsExceededError,
  ProviderUnavailableError,
} from '../../src/errors.js';

describe('Integration: Streaming Hook Timing (D-M3-3)', () => {
  let provider: MockProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new MockProvider('streaming-hooks-test');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('afterGenerate fires AFTER done chunk, not before', async () => {
    // This test uses real timers because asyncIteratorWithIdleTimeout internally
    // creates setTimeout timers. With fake timers those timeouts never fire,
    // making the test fragile. Use real timers with a large timeout to avoid interference.
    vi.useRealTimers();

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

    // afterGenerate should fire after text chunks but before the pipeline's done
    // (provider's internal done is no longer forwarded; afterGenerate fires when
    // the provider signals stream completion, before the pipeline finalizes)
    expect(callOrder).toContain('afterGenerate');
    const afterGenerateIndex = callOrder.indexOf('afterGenerate');
    const firstTextIndex = callOrder.indexOf('text');
    const doneIndex = callOrder.indexOf('done');

    // afterGenerate fires after text chunks arrive
    expect(afterGenerateIndex).toBeGreaterThan(firstTextIndex);
    // afterGenerate fires before the pipeline's final done
    expect(afterGenerateIndex).toBeLessThan(doneIndex);
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

  it('afterRun fires before pipeline done chunk', async () => {
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

    // Consume stream — finalizePipeline (which runs afterRun) is called
    // before the pipeline yields its own done chunk
    for await (const chunk of result) {
      if (chunk.type === 'done') {
        callOrder.push('done');
      }
    }

    expect(afterRunHook).toHaveBeenCalledTimes(1);
    expect(callOrder).toContain('afterRun');

    // afterRun fires BEFORE the pipeline's done chunk —
    // finalizePipeline (pipeline.ts:574) runs before the done chunk is yielded (pipeline.ts:1438)
    const afterRunIndex = callOrder.indexOf('afterRun');
    const doneIndex = callOrder.indexOf('done');
    expect(afterRunIndex).toBeGreaterThanOrEqual(0);
    expect(doneIndex).toBeGreaterThanOrEqual(0);
    expect(afterRunIndex).toBeLessThan(doneIndex);
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

  // ── HIGH PRIORITY: Coverage gap tests ─────────────────────────────────

  it('beforeGenerate throw during streaming yields error chunk before any text', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Should not appear' },
        { type: 'done', usage: { prompt: 0, completion: 0, total: 0 } },
      ],
    });

    const beforeGenerateHook = vi.fn(async (_ctx: BeforeGenerateContext) => {
      throw new Error('beforeGenerate hook crashed');
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { beforeGenerate: [beforeGenerateHook] },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({ prompt: 'test', stream: true })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // beforeGenerate runs BEFORE stream starts, so hook error prevents any streaming
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe('error');

    const err = (chunks[0] as { type: 'error'; error: OrchestratorError }).error;
    expect(err).toBeInstanceOf(PipelineInternalError);
    expect(err.message).toContain('beforeGenerate hook crashed');

    // No text chunks should appear — stream never started
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(0);

    // Hook was called once
    expect(beforeGenerateHook).toHaveBeenCalledTimes(1);
  });

  it('beforeRun throw during streaming yields error chunk, not promise rejection', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Should not appear' },
        { type: 'done', usage: { prompt: 0, completion: 0, total: 0 } },
      ],
    });

    const beforeRunHook = vi.fn(async (_ctx: RunContext) => {
      throw new Error('beforeRun hook crashed');
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { beforeRun: [beforeRunHook] },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    // The promise resolves with AsyncIterable (not a rejection), error surfaces during iteration
    const result = (await orchestrator.run({ prompt: 'test', stream: true })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Error chunk is yielded during iteration, not as promise rejection
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe('error');

    const err = (chunks[0] as { type: 'error'; error: OrchestratorError }).error;
    expect(err).toBeInstanceOf(PipelineInternalError);
    expect(err.message).toContain('beforeRun hook crashed');

    // No text chunks — pipeline failed before streaming could start
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(0);
    expect(beforeRunHook).toHaveBeenCalledTimes(1);
  });

  it('beforeTool throw during streaming triggers retry loop, no error chunk', async () => {
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

    // First stream: yields text + tool_call for a tool
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Before tool ' },
        {
          type: 'tool_call',
          toolCall: { id: 'call-1', name: 'echo', input: { value: 'test' } },
        },
        { type: 'done', usage: { prompt: 5, completion: 2, total: 7 } },
      ],
    });

    // Second stream: retry succeeds with text
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'After retry' },
        { type: 'done', usage: { prompt: 10, completion: 5, total: 15 } },
      ],
    });

    const beforeToolHook = vi.fn(async (_ctx: ToolContext) => {
      throw new Error('beforeTool hook crashed');
    });

    const orchestrator = new Orchestrator({
      provider,
      tools: [echoTool],
      hooks: { beforeTool: [beforeToolHook] },
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

    // beforeTool hook was called once (and threw)
    expect(beforeToolHook).toHaveBeenCalledTimes(1);

    // No error chunk — the error was wrapped as ToolExecutionError and retry engaged
    expect(chunkTypes).not.toContain('error');

    // Text from the first stream is yielded before retry
    expect(textChunks.join('')).toContain('Before tool');

    // Text from the retry stream is yielded after retry
    expect(textChunks.join('')).toContain('After retry');

    // Provider was called twice: initial stream + retry stream
    expect(provider.callCount()).toBe(2);

    // Stream completed
    expect(chunkTypes).toContain('done');
  });

  it('afterTool throw during streaming triggers retry loop, no error chunk', async () => {
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

    // First stream: yields tool_call + done
    provider.enqueueStream({
      chunks: [
        {
          type: 'tool_call',
          toolCall: { id: 'call-1', name: 'echo', input: { value: 'test' } },
        },
        { type: 'done', usage: { prompt: 5, completion: 2, total: 7 } },
      ],
    });

    // Second stream: retry succeeds
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Recovered after hook failure' },
        { type: 'done', usage: { prompt: 10, completion: 5, total: 15 } },
      ],
    });

    const afterToolHook = vi.fn(async (_ctx: AfterToolContext) => {
      throw new Error('afterTool hook crashed');
    });

    const orchestrator = new Orchestrator({
      provider,
      tools: [echoTool],
      hooks: { afterTool: [afterToolHook] },
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

    // afterTool hook was called once (and threw)
    expect(afterToolHook).toHaveBeenCalledTimes(1);

    // No error chunk — retry engaged on the ToolExecutionError
    expect(chunkTypes).not.toContain('error');

    // Retry stream text appears
    expect(textChunks.join('')).toContain('Recovered after hook failure');

    // Provider called twice: initial + retry
    expect(provider.callCount()).toBe(2);

    // Stream completed
    expect(chunkTypes).toContain('done');
  });

  it('multiple beforeGenerate hooks — first throws, second does NOT execute', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Should not appear' },
        { type: 'done', usage: { prompt: 0, completion: 0, total: 0 } },
      ],
    });

    const firstHook = vi.fn(async (_ctx: BeforeGenerateContext) => {
      throw new Error('First hook failed');
    });
    const secondHook = vi.fn(async (_ctx: BeforeGenerateContext) => {
      return _ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { beforeGenerate: [firstHook, secondHook] },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({ prompt: 'test', stream: true })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Error chunk yielded
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe('error');

    // First hook was called, second was NOT
    expect(firstHook).toHaveBeenCalledTimes(1);
    expect(secondHook).not.toHaveBeenCalled();
  });

  it('multiple beforeGenerate hooks — first succeeds, second throws, error propagates', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Should not appear' },
        { type: 'done', usage: { prompt: 0, completion: 0, total: 0 } },
      ],
    });

    const firstHook = vi.fn(async (ctx: BeforeGenerateContext) => {
      return ctx;
    });
    const secondHook = vi.fn(async (_ctx: BeforeGenerateContext) => {
      throw new Error('Second hook failed');
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { beforeGenerate: [firstHook, secondHook] },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({ prompt: 'test', stream: true })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Error chunk yielded
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.type).toBe('error');

    // Both hooks called, error from second propagates
    expect(firstHook).toHaveBeenCalledTimes(1);
    expect(secondHook).toHaveBeenCalledTimes(1);
  });

  it('generateStream retry does NOT re-fire beforeGenerate hook', async () => {
    vi.useRealTimers();

    // Provider fails on first call (retryable error), succeeds on second
    provider.failureOnCall(1, new ProviderUnavailableError('Service unavailable'))
      .enqueueStream({
        chunks: [
          { type: 'text', delta: 'Success on retry' },
          { type: 'done', usage: { prompt: 10, completion: 5, total: 15 } },
        ],
      });

    const beforeGenerateHook = vi.fn(async (ctx: BeforeGenerateContext) => {
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { beforeGenerate: [beforeGenerateHook] },
      retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const textChunks: string[] = [];
    for await (const chunk of result) {
      if (chunk.type === 'text') {
        textChunks.push(chunk.delta);
      }
    }

    // beforeGenerate must fire exactly once — it fires before the retry while(true) loop
    expect(beforeGenerateHook).toHaveBeenCalledTimes(1);

    // Stream completed with retry text
    expect(textChunks.join('')).toBe('Success on retry');

    // Provider was called twice: initial failure + retry success
    expect(provider.callCount()).toBe(2);
  });

  it('AbortSignal cancellation during streaming skips afterRun hook', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Part 1' },
        { type: 'text', delta: ' Part 2' },
        { type: 'done', usage: { prompt: 5, completion: 10, total: 15 } },
      ],
    });

    const controller = new AbortController();
    const afterRunHook = vi.fn(async (ctx: AfterRunContext) => {
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { afterRun: [afterRunHook] },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
      signal: controller.signal,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
      // Abort after the first text chunk
      if (chunk.type === 'text' && chunks.filter((c) => c.type === 'text').length === 1) {
        controller.abort();
      }
    }

    // Text was received before abort
    expect(chunks.some((c) => c.type === 'text')).toBe(true);

    // AfterRun must NOT be called — finalizePipeline is skipped on abort
    expect(afterRunHook).not.toHaveBeenCalled();

    // Error chunk with RunCancelledError
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks).toHaveLength(1);
    expect(
      (errorChunks[0] as { type: 'error'; error: RunCancelledError }).error,
    ).toBeInstanceOf(RunCancelledError);

    // No done chunk — pipeline was cancelled before finalizing
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(0);
  });

  // ── MEDIUM PRIORITY: Coverage gap tests ─────────────────────────────

  it('afterRun receives correct RunOutput context during streaming', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Hello' },
        { type: 'text', delta: ' world' },
        { type: 'done', usage: { prompt: 10, completion: 20, total: 30 } },
      ],
    });

    let capturedOutput: RunContext & { output: { text: string; usage: TokenUsage; toolResults: unknown[]; durationMs: number } } | undefined;
    const afterRunHook = vi.fn(async (ctx: AfterRunContext) => {
      capturedOutput = ctx;
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { afterRun: [afterRunHook] },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    for await (const chunk of result) {
      void chunk;
    }

    expect(afterRunHook).toHaveBeenCalledTimes(1);
    expect(capturedOutput).toBeDefined();

    // Verify text matches accumulated stream content
    expect(capturedOutput!.output.text).toBe('Hello world');

    // Verify usage from provider's done chunk
    expect(capturedOutput!.output.usage.prompt).toBe(10);
    expect(capturedOutput!.output.usage.completion).toBe(20);
    expect(capturedOutput!.output.usage.total).toBe(30);

    // Verify toolResults is empty (no tools were called)
    expect(capturedOutput!.output.toolResults).toHaveLength(0);

    // Verify duration is a positive number
    expect(capturedOutput!.output.durationMs).toBeGreaterThanOrEqual(0);

    // Verify context fields
    expect(capturedOutput!.input.prompt).toBe('test');
  });

  it('empty stream yields done chunk with zero usage hooks fire correctly', async () => {
    // Stream with only a done chunk
    provider.enqueueStream({
      chunks: [
        { type: 'done', usage: { prompt: 0, completion: 0, total: 0 } },
      ],
    });

    const beforeGenerateHook = vi.fn(async (ctx: BeforeGenerateContext) => {
      return ctx;
    });
    const afterGenerateHook = vi.fn(async (ctx: AfterGenerateContext) => {
      expect(ctx.response.text).toBe('');
      expect(ctx.response.usage.total).toBe(0);
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: {
        beforeGenerate: [beforeGenerateHook],
        afterGenerate: [afterGenerateHook],
      },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Both hooks fired
    expect(beforeGenerateHook).toHaveBeenCalledTimes(1);
    expect(afterGenerateHook).toHaveBeenCalledTimes(1);

    // No text chunks
    expect(chunks.filter((c) => c.type === 'text')).toHaveLength(0);

    // Pipeline yields its own done chunk
    const doneChunks = chunks.filter((c) => c.type === 'done');
    expect(doneChunks).toHaveLength(1);
    const doneChunk = doneChunks[0] as { type: 'done'; usage?: TokenUsage };
    expect(doneChunk.usage).toBeDefined();
    expect(doneChunk.usage!.total).toBe(0);
  });

  it('afterGenerate returns null during streaming yields error chunk', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Hello' },
        { type: 'done', usage: { prompt: 5, completion: 5, total: 10 } },
      ],
    });

    // Hook returns null — violates the contract (hooks must return context)
    const afterGenerateHook = vi.fn(async () => {
      return null as unknown as AfterGenerateContext;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { afterGenerate: [afterGenerateHook] },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({ prompt: 'test', stream: true })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Text chunks are preserved (stream completed before hook)
    expect(chunks.some((c) => c.type === 'text')).toBe(true);

    // Error chunk yielded from afterGenerate null return
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks).toHaveLength(1);
    const err = (errorChunks[0] as { type: 'error'; error: OrchestratorError }).error;
    expect(err).toBeInstanceOf(PipelineInternalError);
    expect(err.message).toContain('Hook returned null/undefined');
  });

  it('MockProvider failureOnCall + beforeGenerate still fires before provider call fails', async () => {
    vi.useRealTimers();

    // Provider fails on first call — ProviderUnavailableError is retryable, so set
    // maxAttempts: 1 to ensure the error surfaces without retry
    provider.failureOnCall(1, new ProviderUnavailableError('Connection failed'));

    const beforeGenerateHook = vi.fn(async (ctx: BeforeGenerateContext) => {
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { beforeGenerate: [beforeGenerateHook] },
      retry: { maxAttempts: 1, baseDelayMs: 1, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // beforeGenerate MUST have been called before the provider call that fails
    expect(beforeGenerateHook).toHaveBeenCalledTimes(1);

    // Error chunk yielded (from provider failure)
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks).toHaveLength(1);

    // Provider was called once (maxAttempts: 1 suppresses retry)
    expect(provider.callCount()).toBe(1);

    // No done chunk — pipeline failed
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(0);
  });

  it('afterGenerate context mutation silently ignored during streaming', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Original response' },
        { type: 'done', usage: { prompt: 5, completion: 15, total: 20 } },
      ],
    });

    const afterGenerateHook = vi.fn(async (ctx: AfterGenerateContext) => {
      // Mutate messages in place — this should have no effect on output
      for (const msg of ctx.messages) {
        if (msg.role === 'user' && typeof msg.content === 'string') {
          (msg as { content: string }).content = 'Hijacked content';
        }
      }
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { afterGenerate: [afterGenerateHook] },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({ prompt: 'test', stream: true })) as AsyncIterable<StreamChunk>;

    const textChunks: string[] = [];
    for await (const chunk of result) {
      if (chunk.type === 'text') {
        textChunks.push(chunk.delta);
      }
    }

    expect(afterGenerateHook).toHaveBeenCalledTimes(1);

    // Output text is the original accumulated text, NOT hijacked
    expect(textChunks.join('')).toBe('Original response');
  });

  it('MaxToolRoundsExceeded during streaming skips afterGenerate and afterRun', async () => {
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

    // Two streams: each triggers a tool_call to exhaust tool rounds
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Round 1 ' },
        {
          type: 'tool_call',
          toolCall: { id: 'call-1', name: 'echo', input: { value: 'first' } },
        },
        { type: 'done', usage: { prompt: 5, completion: 2, total: 7 } },
      ],
    });

    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Round 2 ' },
        {
          type: 'tool_call',
          toolCall: { id: 'call-2', name: 'echo', input: { value: 'second' } },
        },
        { type: 'done', usage: { prompt: 10, completion: 4, total: 14 } },
      ],
    });

    const afterGenerateHook = vi.fn(async (ctx: AfterGenerateContext) => {
      return ctx;
    });
    const afterRunHook = vi.fn(async (ctx: AfterRunContext) => {
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      tools: [echoTool],
      hooks: {
        afterGenerate: [afterGenerateHook],
        afterRun: [afterRunHook],
      },
      toolPolicy: { maxToolRounds: 1 },
      retry: { maxAttempts: 1, baseDelayMs: 1, jitter: false },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // afterGenerate and afterRun must NOT be called
    expect(afterGenerateHook).not.toHaveBeenCalled();
    expect(afterRunHook).not.toHaveBeenCalled();

    // Error chunk with MaxToolRoundsExceededError
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks).toHaveLength(1);
    expect(
      (errorChunks[0] as { type: 'error'; error: MaxToolRoundsExceededError }).error,
    ).toBeInstanceOf(MaxToolRoundsExceededError);

    // No done chunk
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(0);

    // Provider called once — limit triggers before second stream is consumed
    // (nextRound=1 >= maxToolRounds=1 at the start of tool execution)
    expect(provider.callCount()).toBe(1);
  });

  it('enqueue() dual-queue path fires hooks identically to enqueueStream', async () => {
    // Use enqueue() instead of enqueueStream to test the dual-queue fallback path
    provider.enqueue({
      text: 'Dual queue',
      toolCalls: [],
    });

    const beforeGenerateHook = vi.fn(async (ctx: BeforeGenerateContext) => {
      return ctx;
    });
    const afterGenerateHook = vi.fn(async (ctx: AfterGenerateContext) => {
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: {
        beforeGenerate: [beforeGenerateHook],
        afterGenerate: [afterGenerateHook],
      },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const textChunks: string[] = [];
    let doneReceived = false;
    for await (const chunk of result) {
      if (chunk.type === 'text') {
        textChunks.push(chunk.delta);
      } else if (chunk.type === 'done') {
        doneReceived = true;
      }
    }

    // Hooks fire correctly
    expect(beforeGenerateHook).toHaveBeenCalledTimes(1);
    expect(afterGenerateHook).toHaveBeenCalledTimes(1);

    // Text is accumulated from character-by-character chunks (from _entryToStreamChunks)
    expect(textChunks.join('')).toBe('Dual queue');

    // Stream completed
    expect(doneReceived).toBe(true);
  });

});
