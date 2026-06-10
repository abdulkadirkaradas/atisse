import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { StreamChunk, Tool, LifecycleState } from '../../src/interfaces.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { LifecycleStateMachine } from '../../src/lifecycle.js';
import {
  ProviderUnavailableError,
  ProviderRateLimitError,
  MaxRetriesExceededError,
  TimeoutExceededError,
  OrchestratorError,
} from '../../src/errors.js';

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
    // First attempt fails
    provider.failureOnCall(1, new ProviderUnavailableError('Connection refused'));
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

  // ── HIGH PRIORITY: Coverage gap tests (Iteration 2) ─────────────────

  it('retry bifurcation: mid-stream error chunk vs rejection', async () => {
    vi.useRealTimers();

    // Scenario A: Mid-stream error chunk — error is yielded, NO retry triggered
    const providerA = new MockProvider('mid-stream-bifurcation-a');
    providerA.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Before ' },
        { type: 'error', error: new ProviderRateLimitError('Rate limited', 50) },
        { type: 'text', delta: 'After' },
        { type: 'done', usage: { prompt: 0, completion: 0, total: 0 } },
      ],
    });

    const orchestratorA = new Orchestrator({
      provider: providerA,
      retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const resultA = (await orchestratorA.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunksA: StreamChunk[] = [];
    for await (const chunk of resultA) {
      chunksA.push(chunk);
    }

    // Mid-stream error yields the error chunk; pipeline continues to done
    const errorChunksA = chunksA.filter((c) => c.type === 'error');
    expect(errorChunksA).toHaveLength(1);
    expect(
      (errorChunksA[0] as { type: 'error'; error: ProviderRateLimitError }).error,
    ).toBeInstanceOf(ProviderRateLimitError);

    // Done chunk appears — pipeline completed normally
    expect(chunksA.some((c) => c.type === 'done')).toBe(true);

    // Mid-stream error does NOT trigger a retry
    expect(providerA.callCount()).toBe(1);

    // Scenario B: Rejection (single error chunk) — retry IS triggered
    const providerB = new MockProvider('rejection-bifurcation-b');
    providerB.failureOnCall(1, new ProviderRateLimitError('Rate limited', 50));
    providerB.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Retry succeeded' },
        { type: 'done', usage: { prompt: 0, completion: 9, total: 9 } },
      ],
    });

    const orchestratorB = new Orchestrator({
      provider: providerB,
      retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const resultB = (await orchestratorB.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunksB: StreamChunk[] = [];
    for await (const chunk of resultB) {
      chunksB.push(chunk);
    }

    // Rejection with maxAttempts: 2 triggers a retry
    expect(providerB.callCount()).toBe(2);

    // Retry succeeded — text from second attempt is present
    expect(chunksB.some((c) => c.type === 'text')).toBe(true);
    expect(chunksB.some((c) => c.type === 'done')).toBe(true);
  });

  it('multi-chunk stream with error as first chunk yields error (does not reject)', async () => {
    // MockProvider line 218: chunks.length === 1 && firstChunk.type === 'error' → rejection
    // When chunks.length > 1, the error chunk is YIELDED (not a rejection)
    provider.enqueueStream({
      chunks: [
        { type: 'error', error: new ProviderRateLimitError('Rate limited', 1000) },
        { type: 'done', usage: { prompt: 0, completion: 0, total: 0 } },
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

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Error is yielded as an error chunk (NOT wrapped in MAX_RETRIES_EXCEEDED)
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks).toHaveLength(1);
    expect(
      (errorChunks[0] as { type: 'error'; error: ProviderRateLimitError }).error,
    ).toBeInstanceOf(ProviderRateLimitError);

    // Pipeline still completes — done chunk appears
    expect(chunks.some((c) => c.type === 'done')).toBe(true);

    // No retry triggered — the error was yielded, not rejected
    expect(provider.callCount()).toBe(1);
  });

  it('multiple error chunks in single stream maintain pipeline integrity', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'error', error: new ProviderRateLimitError('First rate limit', 100) },
        { type: 'error', error: new ProviderUnavailableError('Second unavailable') },
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

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Both error chunks are yielded
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks).toHaveLength(2);

    expect(
      (errorChunks[0] as { type: 'error'; error: ProviderRateLimitError }).error,
    ).toBeInstanceOf(ProviderRateLimitError);
    expect(
      (errorChunks[1] as { type: 'error'; error: ProviderUnavailableError }).error,
    ).toBeInstanceOf(ProviderUnavailableError);

    // Pipeline still completes — done chunk appears
    expect(chunks.some((c) => c.type === 'done')).toBe(true);

    // No crash — provider was called once
    expect(provider.callCount()).toBe(1);
  });

  it('error chunk after tool_call does not prevent tool execution', async () => {
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

    // Create a spy on the tool's execute method
    const toolExecuteSpy = vi.spyOn(echoTool, 'execute');

    provider.enqueueStream({
      chunks: [
        {
          type: 'tool_call',
          toolCall: { id: 'call-1', name: 'echo', input: { value: 'test' } },
        },
        { type: 'error', error: new ProviderUnavailableError('Stream error after tool_call') },
        { type: 'done', usage: { prompt: 10, completion: 5, total: 15 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      tools: [echoTool],
      retry: { maxAttempts: 1, baseDelayMs: 1, jitter: false },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Error chunks: 1 from original stream (ProviderUnavailableError) + potentially
    // 1 from the second generation round failing (empty streamQueue after tool execution)
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);

    // The original provider error chunk is yielded
    const hasStreamError = errorChunks.some(
      (c) => c.type === 'error' && c.error instanceof ProviderUnavailableError,
    );
    expect(hasStreamError).toBe(true);

    // Tool execution DOES run — the pipeline continues past error chunks to tool execution
    expect(toolExecuteSpy).toHaveBeenCalledTimes(1);

    // Provider was called: 1 for the initial stream + 1 for the second round after tool execution
    // (the second call fails because streamQueue is empty after tool execution consumed the first entry)
    expect(provider.callCount()).toBe(2);
  });

  it('lifecycle state transitions after mid-stream error chunk', async () => {
    const stateTransitions: string[] = [];
    const originalTransition = LifecycleStateMachine.prototype.transition;

    vi.spyOn(LifecycleStateMachine.prototype, 'transition').mockImplementation(
      function (this: LifecycleStateMachine, to: LifecycleState) {
        stateTransitions.push(to);
        return originalTransition.call(this, to);
      },
    );

    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Before error ' },
        { type: 'error', error: new ProviderUnavailableError('Mid-stream failure') },
        { type: 'done', usage: { prompt: 5, completion: 10, total: 15 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    for await (const chunk of result) {
      void chunk;
    }

    // After a mid-stream error chunk, the pipeline completes normally.
    // The error is treated as data and yielded to the consumer; the pipeline
    // does NOT transition to FAILED.
    const completingIdx = stateTransitions.indexOf('COMPLETING');
    const completedIdx = stateTransitions.lastIndexOf('COMPLETED');
    const failedIdx = stateTransitions.indexOf('FAILED');

    expect(completingIdx).toBeGreaterThanOrEqual(0);
    expect(completedIdx).toBeGreaterThan(completingIdx);
    expect(failedIdx).toBe(-1); // Pipeline did NOT fail

    expect(stateTransitions[stateTransitions.length - 1]).toBe('COMPLETED');

    vi.restoreAllMocks();
  });

  // ── MEDIUM PRIORITY: Coverage gap tests (Iteration 2) ───────────────

  it('enqueue({ error }) in streaming mode maps error chunk correctly', async () => {
    // provider.enqueue({ error: ... }) pushes to both queue and streamQueue
    // via _entryToStreamChunks which wraps it as a single-chunk error entry.
    // generateStream then rejects this entry (single error chunk = rejection).
    // The pipeline's retry loop catches the retryable rejection.
    // With maxAttempts: 1, the rejection surfaces as MAX_RETRIES_EXCEEDED.
    provider.enqueue({ error: new ProviderUnavailableError('Service unavailable') });

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 1, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    vi.runAllTimersAsync();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Single error chunk from enqueue() causes generateStream to reject.
    // Since ProviderUnavailableError is retryable, the retry loop runs.
    // With maxAttempts: 1, this surfaces as MAX_RETRIES_EXCEEDED.
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks).toHaveLength(1);

    const err = (errorChunks[0] as { type: 'error'; error: OrchestratorError }).error;
    expect(err).toBeInstanceOf(MaxRetriesExceededError);

    // No done chunk — pipeline failed
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(0);
  });

  it('AbortSignal after error chunk does not mask provider error', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'A' },
        { type: 'error', error: new ProviderUnavailableError('Service error') },
        { type: 'done', usage: { prompt: 0, completion: 0, total: 0 } },
      ],
    });

    const controller = new AbortController();

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
      signal: controller.signal,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
      // Abort after the error chunk is consumed
      if (chunk.type === 'error') {
        controller.abort();
      }
    }

    // The provider error chunk is still present — abort after error does not mask it
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);
    const hasProviderError = errorChunks.some(
      (c) => c.type === 'error' && c.error instanceof ProviderUnavailableError,
    );
    expect(hasProviderError).toBe(true);

    // The consumer may also see a RunCancelledError if the abort is checked
    // after the error chunk is yielded, but the provider error is always present.
    // The abort signal is checked at the while-loop top; after yielding finalChunks
    // and breaking, the pipeline completes normally. The provider error thus takes priority.
  });

  it('failureOnCall takes priority over queued stream entries on later calls', async () => {
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

    // First call: succeeds with tool_call to trigger a second round
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

    // Second call: would succeed from this entry, but failureOnCall takes priority
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Should not appear' },
        { type: 'done', usage: { prompt: 10, completion: 5, total: 15 } },
      ],
    });

    // Inject failure on the second call — overrides the queued entry
    provider.failureOnCall(2, new ProviderUnavailableError('Fail on second call'));

    const orchestrator = new Orchestrator({
      provider,
      tools: [echoTool],
      retry: { maxAttempts: 1, baseDelayMs: 1, jitter: false },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // First call succeeded — text from round 1 appears
    expect(chunks.some((c) => c.type === 'text' && c.delta === 'Round 1 ')).toBe(true);

    // tool_call from first stream appears
    expect(chunks.some((c) => c.type === 'tool_call')).toBe(true);

    // Second call failed due to failureOnCall — error chunk appears
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks.length).toBeGreaterThanOrEqual(1);

    // The "Should not appear" text from the queued entry was NOT yielded
    const hasShouldNotAppear = chunks.some(
      (c) => c.type === 'text' && c.delta === 'Should not appear',
    );
    expect(hasShouldNotAppear).toBe(false);

    // Provider was called twice
    expect(provider.callCount()).toBe(2);
  });

  it('totalTimeoutMs does not replace mid-stream error chunk in streaming', async () => {
    // The streaming pipeline does NOT wrap in totalTimeoutMs (see pipeline.ts L1480-1481),
    // so a short totalTimeoutMs has NO effect on streaming error chunks.
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Before ' },
        { type: 'error', error: new ProviderUnavailableError('Stream error') },
        { type: 'done', usage: { prompt: 5, completion: 10, total: 15 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 1 }, // Very short total timeout
    });

    vi.runAllTimersAsync();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Error chunk is preserved — totalTimeoutMs does not affect streaming
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks).toHaveLength(1);
    expect(
      (errorChunks[0] as { type: 'error'; error: ProviderUnavailableError }).error,
    ).toBeInstanceOf(ProviderUnavailableError);

    // Pipeline completed with done chunk
    expect(chunks.some((c) => c.type === 'done')).toBe(true);

    // No TimeoutExceededError — totalTimeoutMs is not enforced in streaming path
    const hasTimeoutError = chunks.some(
      (c) => c.type === 'error' && c.error instanceof TimeoutExceededError,
    );
    expect(hasTimeoutError).toBe(false);
  });

  // ── LOW PRIORITY: Coverage gap tests (Iteration 2) ─────────────────

  it('MockProvider empty streamQueue fallback rejects with correct error', async () => {
    vi.useRealTimers();

    // enqueue({ error }) pushes an error entry to both queues via _entryToStreamChunks.
    // First call: generateStream picks from streamQueue (single error chunk → rejection).
    // Retry loop attempts a second call. streamQueue is now empty; fallback to queue (line 237).
    // Queue still has the original error entry → rejects again → MaxRetriesExceededError
    // wrapping the original ProviderUnavailableError.
    provider.enqueue({ error: new ProviderUnavailableError('Service unavailable') });

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 2, baseDelayMs: 1, jitter: false },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    // Error chunk is yielded as MAX_RETRIES_EXCEEDED wrapping the original
    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks).toHaveLength(1);

    const err = (errorChunks[0] as { type: 'error'; error: OrchestratorError }).error;
    expect(err).toBeInstanceOf(MaxRetriesExceededError);

    // Provider was called twice: streamQueue rejection + queue fallback rejection
    expect(provider.callCount()).toBe(2);

    // No done chunk
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(0);
  });

  it('enqueue({ error }) in streaming causes rejection not yielded error', async () => {
    // Behavioral documentation: enqueue({ error: ... }) creates a single-chunk
    // stream entry via _entryToStreamChunks. MockProvider's generateStream
    // treats a single error chunk as a REJECTION (not a yielded error).
    // The pipeline's retry loop catches this rejection and, since the error is
    // retryable, runs the retry loop. With maxAttempts: 1, it surfaces as
    // MAX_RETRIES_EXCEEDED (wrapped), not as the original error being yielded.

    // Compare with enqueueStream({ chunks: [{type:'error', error}, {type:'done'}] })
    // which has length > 1 and DOES yield the error chunk (tested above).

    provider.enqueue({ error: new ProviderUnavailableError('Service unavailable') });

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 1, baseDelayMs: 10, jitter: false },
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    vi.runAllTimersAsync();
    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    for await (const chunk of result) {
      chunks.push(chunk);
    }

    const errorChunks = chunks.filter((c) => c.type === 'error');
    expect(errorChunks).toHaveLength(1);

    // The error is wrapped in MAX_RETRIES_EXCEEDED (rejection path)
    const err = (errorChunks[0] as { type: 'error'; error: OrchestratorError }).error;
    expect(err).toBeInstanceOf(MaxRetriesExceededError);

    // The original ProviderUnavailableError is NOT yielded directly
    expect(
      errorChunks.some((c) => c.type === 'error' && c.error instanceof ProviderUnavailableError),
    ).toBe(false);

    // No done — pipeline failed
    expect(chunks.filter((c) => c.type === 'done')).toHaveLength(0);

    // Provider was called once (first call rejected, maxAttempts: 1 stops retry)
    expect(provider.callCount()).toBe(1);
  });
});
