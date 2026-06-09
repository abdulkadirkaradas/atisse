import { describe, it, expect, vi, afterEach } from 'vitest';
import type {
  AIProvider,
  OrchestratorConfig,
  Tool,
  ContextProvider,
  ToolContext,
  AfterToolContext,
  PromptRequest,
  PromptResponse,
} from '../../src/interfaces.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import {
  ProviderRateLimitError,
  ProviderAuthError,
  ProviderUnavailableError,
  ProviderTimeoutError,
  ProviderMalformedResponse,
  MaxRetriesExceededError,
  FallbackExhaustedError,
  ConfigValidationError,
  ToolValidationError,
  ToolNotFoundError,
  ContextLoadError,
  MemorySaveError,
  RunCancelledError,
  TimeoutExceededError,
  PipelineInternalError,
  MaxToolRoundsExceededError,
} from '../../src/errors.js';
import { failingTool, validationFailTool, echoTool } from '../fixtures/mock-tools.js';
import { MockMemoryAdapter } from '../fixtures/mock-memory.js';

// Helper to create a fresh provider
const createProvider = () => new MockProvider('test-provider');

describe('Integration: Orchestrator Core Run', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  describe('Simple run scenarios', () => {
    it('returns text when provider returns text', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Hello, world!' });

      const orchestrator = new Orchestrator({ provider });
      const result = await orchestrator.run({ prompt: 'Say hello' });

      expect(result.text).toBe('Hello, world!');
    });

    it('RunOutput.runId is a valid UUID', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const orchestrator = new Orchestrator({ provider });
      const result = await orchestrator.run({ prompt: 'test' });

      expect(result.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('RunOutput.metadata passes through from RunInput.metadata', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const orchestrator = new Orchestrator({ provider });
      const input = {
        prompt: 'test',
        metadata: { userId: 'user-123', source: 'web' },
      };
      const result = await orchestrator.run(input);

      expect(result.metadata).toEqual({ userId: 'user-123', source: 'web' });
    });

    it('stream: true validates streaming capability before execution', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Hello world' });

      const orchestrator = new Orchestrator({ provider });

      const result = await orchestrator.run({ prompt: 'hi', stream: true });
      let fullText = '';
      for await (const chunk of result as AsyncIterable<
        { type: 'text'; delta: string } | { type: 'done' }
      >) {
        if (chunk.type === 'text') {
          fullText += chunk.delta;
        }
      }
      expect(fullText).toBe('Hello world');
    });
  });

  describe('Memory integration', () => {
    it('loads memory before generation with sessionId', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const memory = new MockMemoryAdapter();
      // Pre-populate session
      await memory.save('session-1', [
        { role: 'user', content: 'Previous message' },
        { role: 'assistant', content: 'Previous response' },
      ]);

      const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });
      await orchestrator.run({ prompt: 'test', sessionId: 'session-1' });

      // Verify provider received memory messages in the request
      const lastRequest = provider.lastRequest();
      expect(lastRequest).toBeDefined();
      const messages = lastRequest!.messages;
      // Should have: system (optional), context, memory (2 messages), user
      expect(messages.length).toBeGreaterThanOrEqual(3);
    });

    it('saves memory atomically at COMPLETING with sessionId', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const memory = new MockMemoryAdapter();

      const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });
      await orchestrator.run({ prompt: 'test', sessionId: 'session-2' });

      // Check that messages were saved
      const saved = await memory.load('session-2');
      expect(saved).toHaveLength(2);
      expect(saved[0]!.role).toBe('user');
      expect(saved[1]!.role).toBe('assistant');
    });

    it('transitions to FAILED when memory save fails (D-M2-1/A)', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const memory = new MockMemoryAdapter();
      memory.saveError = new MemorySaveError(new Error('Injected'));

      const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

      await expect(orchestrator.run({ prompt: 'test', sessionId: 'session-3' })).rejects.toThrow(
        MemorySaveError,
      );
    });
  });

  describe('Retry + Fallback', () => {
    it('retries on rate limit error and succeeds', async () => {
      const provider = createProvider();
      provider
        .enqueue({ error: new ProviderRateLimitError('429', 50) })
        .enqueue({ error: new ProviderRateLimitError('429', 50) })
        .enqueue({ text: 'Success on 3rd attempt' });

      const orchestrator = new Orchestrator({
        provider,
        retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 }, // Ensure total timeout is long enough
      });

      vi.useFakeTimers();
      const resultPromise = orchestrator.run({ prompt: 'test' });
      vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.text).toBe('Success on 3rd attempt');
      expect(provider.wasCalledTimes(3)).toBe(true);
      vi.useRealTimers();
    });

    it('does NOT retry on auth error - immediate failure', async () => {
      const provider = createProvider();
      provider.enqueue({ error: new ProviderAuthError('Invalid API key') });

      const orchestrator = new Orchestrator({
        provider,
        retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
      });

      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(ProviderAuthError);
      expect(provider.wasCalledTimes(1)).toBe(true);
    });

    it('throws MaxRetriesExceededError when max retries exceeded with no fallback', async () => {
      const provider = createProvider();
      provider
        .enqueue({ error: new ProviderRateLimitError('429', 50) })
        .enqueue({ error: new ProviderRateLimitError('429', 50) })
        .enqueue({ error: new ProviderRateLimitError('429', 50) });

      const orchestrator = new Orchestrator({
        provider,
        retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      vi.useFakeTimers();
      const runPromise = orchestrator.run({ prompt: 'test' });
      vi.runAllTimersAsync();
      await expect(runPromise).rejects.toThrow(MaxRetriesExceededError);
      vi.useRealTimers();
    });

    it('fallback provider called exactly once when max retries exceeded + fallback configured', async () => {
      const primary = createProvider();
      primary
        .enqueue({ error: new ProviderRateLimitError('429', 50) })
        .enqueue({ error: new ProviderRateLimitError('429', 50) })
        .enqueue({ error: new ProviderRateLimitError('429', 50) });

      const fallback = createProvider();
      fallback.enqueue({ text: 'Fallback response' });

      const orchestrator = new Orchestrator({
        provider: primary,
        fallbackProvider: fallback,
        retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      vi.useFakeTimers();
      const resultPromise = orchestrator.run({ prompt: 'test' });
      vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.text).toBe('Fallback response');
      expect(primary.wasCalledTimes(3)).toBe(true);
      expect(fallback.wasCalledTimes(1)).toBe(true);
      vi.useRealTimers();
    });

    it('throws FallbackExhaustedError when both primary and fallback fail', async () => {
      const primary = createProvider();
      primary
        .enqueue({ error: new ProviderRateLimitError('429', 50) })
        .enqueue({ error: new ProviderRateLimitError('429', 50) })
        .enqueue({ error: new ProviderRateLimitError('429', 50) });

      const fallback = createProvider();
      fallback.enqueue({ error: new ProviderUnavailableError('Fallback down') });

      const orchestrator = new Orchestrator({
        provider: primary,
        fallbackProvider: fallback,
        retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      vi.useFakeTimers();
      const runPromise = orchestrator.run({ prompt: 'test' });
      vi.runAllTimersAsync();
      await expect(runPromise).rejects.toThrow(FallbackExhaustedError);
      vi.useRealTimers();
    });
  });

  describe('Tool execution', () => {
    it('tool call triggers execution and second generate - tool results present', async () => {
      const provider = createProvider();
      provider
        .enqueue({
          text: '',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'hello' } }],
          finishReason: 'tool_calls',
        })
        .enqueue({ text: 'Final response after tool' });

      const tool: Tool = {
        name: 'echo',
        description: 'Echo tool',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        async execute(input) {
          return input;
        },
      };

      const orchestrator = new Orchestrator({ provider, tools: [tool] });
      const result = await orchestrator.run({ prompt: 'Use echo tool' });

      // Text is empty because finishReason was 'tool_calls' on first call
      expect(result.toolResults).toHaveLength(1);
      expect(result.toolResults[0]!.output).toEqual({ value: 'hello' });
    });

    it('maxToolRoundsExceededError thrown when round limit exceeded (D-M2-4)', async () => {
      const provider = createProvider();
      provider
        .enqueue({
          text: '',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: '1' } }],
          finishReason: 'tool_calls',
        })
        .enqueue({
          text: '',
          toolCalls: [{ id: 'call-2', name: 'echo', input: { value: '2' } }],
          finishReason: 'tool_calls',
        })
        .enqueue({
          text: 'final',
          finishReason: 'stop',
        });

      const tool: Tool = {
        name: 'echo',
        description: 'Echo tool',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        async execute(input) {
          return input;
        },
      };

      const maxToolRounds: number = 1; // Set to 1 to ensure throw after 1st round
      const orchestrator = new Orchestrator({
        provider,
        tools: [tool],
        toolPolicy: { maxToolRounds: maxToolRounds },
      });

      // With maxToolRounds: 1, should throw immediately after 1st round
      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(
        // The standard `${rounds}/${maxToolRounds}` pattern is replaced here by `${maxToolRounds}/${maxToolRounds}` due to the specific test setup.
        // see; errors.ts -> MaxToolRoundsExceededError -> L195
        `Tool round limit exceeded: ${maxToolRounds}/${maxToolRounds}`,
      );
    }, 10_000);

    it('ToolValidationError causes FAILED - provider NOT called again', async () => {
      const provider = createProvider();
      provider.enqueue({
        text: '',
        toolCalls: [{ id: 'call-1', name: 'validation-fail-tool', input: { bad: 'input' } }],
        finishReason: 'tool_calls',
      });

      const orchestrator = new Orchestrator({
        provider,
        tools: [validationFailTool],
      });

      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(ToolValidationError);
      // Provider only called once (initial generate)
      expect(provider.wasCalledTimes(1)).toBe(true);
    });

    it('ToolExecutionError causes RETRYING - second attempt may succeed', async () => {
      const provider = createProvider();
      provider
        .enqueue({
          text: '',
          toolCalls: [{ id: 'call-1', name: 'failing-tool', input: { input: 'test' } }],
          finishReason: 'tool_calls',
        })
        .enqueue({ text: 'Recovery success' });

      const orchestrator = new Orchestrator({
        provider,
        tools: [failingTool],
        retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      vi.useFakeTimers();
      const resultPromise = orchestrator.run({ prompt: 'test' });
      vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.text).toBe('Recovery success');
      vi.useRealTimers();
    });
  });

  describe('Hooks', () => {
    it('beforeRun hook throw prevents provider from being called', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Should not be called' });

      const beforeRunHook = vi.fn(async () => {
        throw new Error('beforeRun rejected');
      });

      const orchestrator = new Orchestrator({
        provider,
        hooks: { beforeRun: [beforeRunHook] },
      });

      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow('beforeRun rejected');
      expect(provider.wasCalledTimes(0)).toBe(true);
    });

    it('beforeGenerate hook modifies messages sent to provider', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const beforeGenerateHook = vi.fn(async (ctx) => {
        ctx.messages.push({ role: 'user', content: 'Added by hook' });
        return ctx;
      });

      const orchestrator = new Orchestrator({
        provider,
        hooks: { beforeGenerate: [beforeGenerateHook] },
      });

      await orchestrator.run({ prompt: 'test' });

      const lastRequest = provider.lastRequest();
      expect(lastRequest?.messages.some((m) => m.content === 'Added by hook')).toBe(true);
    });

    it('afterGenerate hook throw causes run abort', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const afterGenerateHook = vi.fn(async () => {
        throw new Error('afterGenerate failed');
      });

      const orchestrator = new Orchestrator({
        provider,
        hooks: { afterGenerate: [afterGenerateHook] },
        timeout: { generateTimeoutMs: 1000, toolTimeoutMs: 1000, totalTimeoutMs: 5000 },
      });

      // Kernel has explicit try-catch for hook error propagation
      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow('afterGenerate failed');
    }, 10_000);

    it('afterRun receives completed RunOutput', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Final output' });

      const afterRunHook = vi.fn(async (ctx) => {
        // Verify we have the output
        expect(ctx.output.text).toBe('Final output');
        expect(ctx.output.runId).toBeDefined();
        return ctx;
      });

      const orchestrator = new Orchestrator({
        provider,
        hooks: { afterRun: [afterRunHook] },
      });

      await orchestrator.run({ prompt: 'test' });
      expect(afterRunHook).toHaveBeenCalledTimes(1);
    });
  });

  describe('Constructor validation', () => {
    it('missing provider throws ConfigValidationError', () => {
      expect(() => new Orchestrator({} as OrchestratorConfig)).toThrow(ConfigValidationError);
    });

    it('profiles[key].name !== key throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            profiles: {
              myprofile: { name: 'different-name' },
            },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('allowParallelTools: true throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            toolPolicy: { allowParallelTools: true },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('maxToolRounds: 0 throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            toolPolicy: { maxToolRounds: 0 },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('duplicate tool names throws ConfigValidationError', () => {
      const tool: Tool = {
        name: 'duplicate',
        description: 'Tool',
        inputSchema: { type: 'object', properties: {} },
        async execute() {},
      };

      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            tools: [tool, tool],
          }),
      ).toThrow(ConfigValidationError);
    });

    it('empty tool inputSchema throws ConfigValidationError', () => {
      const tool: Tool = {
        name: 'empty-schema-tool',
        description: 'Tool with empty schema',
        inputSchema: {}, // FORBIDDEN
        async execute() {},
      };

      expect(() => new Orchestrator({ provider: createProvider(), tools: [tool] })).toThrow(
        ConfigValidationError,
      );
    });

    it('stream: true + fallbackProvider throws ConfigValidationError at run()', async () => {
      const provider = createProvider();
      provider.capabilities.streaming = false;

      const orchestrator = new Orchestrator({
        provider,
        fallbackProvider: createProvider(),
      });

      await expect(orchestrator.run({ prompt: 'test', stream: true })).rejects.toThrow(
        ConfigValidationError,
      );
    });

    it('stream: true + capabilities.streaming === false throws ConfigValidationError', async () => {
      const provider = createProvider();
      provider.capabilities.streaming = false;

      const orchestrator = new Orchestrator({ provider });

      await expect(orchestrator.run({ prompt: 'test', stream: true })).rejects.toThrow(
        ConfigValidationError,
      );
    });

    it('stream: true + generateStream === undefined throws ConfigValidationError', async () => {
      // Create a provider without generateStream method
      const noStreamProvider: AIProvider = {
        id: 'no-stream-provider',
        capabilities: {
          streaming: true, // Capabilities say streaming is supported...
          toolCalling: true,
          vision: false,
          maxContextTokens: 128_000,
        },
        // generateStream is intentionally omitted — undefined
        async generate() {
          return {
            text: 'response',
            toolCalls: [],
            usage: { prompt: 0, completion: 0, total: 0 },
            finishReason: 'stop',
          };
        },
      };

      const orchestrator = new Orchestrator({ provider: noStreamProvider });

      await expect(orchestrator.run({ prompt: 'test', stream: true })).rejects.toThrow(
        ConfigValidationError,
      );
    });
  });

  describe('Events', () => {
    it('run.started emitted with runId', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const orchestrator = new Orchestrator({ provider });

      const events: Array<{ type: string; runId?: string }> = [];
      const unsub = orchestrator.on('run.started', (e) => events.push(e));

      await orchestrator.run({ prompt: 'test' });
      unsub();

      expect(events).toHaveLength(1);
      expect(events[0]!.runId).toBeDefined();
    });

    it('run.completed emitted with usage and durationMs', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const orchestrator = new Orchestrator({ provider });

      const events: Array<{ type: string; usage?: { total: number }; durationMs?: number }> = [];
      const unsub = orchestrator.on('run.completed', (e) => events.push(e));

      await orchestrator.run({ prompt: 'test' });
      unsub();

      expect(events).toHaveLength(1);
      expect(events[0]!.usage?.total).toBeGreaterThanOrEqual(0);
      expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('run.failed carries OrchestratorError instance', async () => {
      const provider = createProvider();
      provider.enqueue({ error: new ProviderAuthError('Test') });

      const orchestrator = new Orchestrator({ provider });

      const events: Array<{ type: string; error?: Error }> = [];
      const unsub = orchestrator.on('run.failed', (e) => events.push(e));

      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow();
      unsub();

      expect(events).toHaveLength(1);
      expect(events[0]!.error).toBeInstanceOf(Error);
    });

    it('retry.attempt emitted per retry', async () => {
      const provider = createProvider();
      provider
        .enqueue({ error: new ProviderRateLimitError('429', 50) })
        .enqueue({ text: 'Success' });

      const orchestrator = new Orchestrator({
        provider,
        retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      const events: Array<{ type: string; attempt?: number }> = [];
      const unsub = orchestrator.on('retry.attempt', (e) => events.push(e));

      vi.useFakeTimers();
      const runPromise = orchestrator.run({ prompt: 'test' });
      vi.runAllTimersAsync();
      await runPromise;
      unsub();

      expect(events).toHaveLength(1);
      expect(events[0]!.attempt).toBe(1);
      vi.useRealTimers();
    });

    it('fallback.triggered emitted when fallback activates', async () => {
      const primary = createProvider();
      primary.enqueue({ error: new ProviderRateLimitError('429', 50) });

      const fallback = createProvider();
      fallback.enqueue({ text: 'Fallback' });

      const orchestrator = new Orchestrator({
        provider: primary,
        fallbackProvider: fallback,
        retry: { maxAttempts: 1, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      const events: Array<{ type: string }> = [];
      const unsub = orchestrator.on('fallback.triggered', (e) => events.push(e));

      vi.useFakeTimers();
      const runPromise = orchestrator.run({ prompt: 'test' });
      vi.runAllTimersAsync();
      await runPromise;
      unsub();

      expect(events).toHaveLength(1);
      vi.useRealTimers();
    });

    it('tool.called + tool.completed emitted per tool', async () => {
      const provider = createProvider();
      provider
        .enqueue({
          text: '',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'test' } }],
          finishReason: 'tool_calls',
        })
        .enqueue({ text: 'Done' });

      const tool: Tool = {
        name: 'echo',
        description: 'Echo tool',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        async execute(input) {
          return input;
        },
      };

      const orchestrator = new Orchestrator({ provider, tools: [tool] });

      const calledEvents: Array<{ type: string; toolName?: string }> = [];
      const completedEvents: Array<{ type: string; toolName?: string }> = [];
      const unsub1 = orchestrator.on('tool.called', (e) => calledEvents.push(e));
      const unsub2 = orchestrator.on('tool.completed', (e) => completedEvents.push(e));

      await orchestrator.run({ prompt: 'test' });
      unsub1();
      unsub2();

      expect(calledEvents).toHaveLength(1);
      expect(calledEvents[0]!.toolName).toBe('echo');
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]!.toolName).toBe('echo');
    });

    it('tool.failed carries EventErrorPayload', async () => {
      const provider = createProvider();
      provider
        .enqueue({
          text: '',
          toolCalls: [{ id: 'call-1', name: 'failing-tool', input: { input: 'test' } }],
          finishReason: 'tool_calls',
        })
        .enqueue({ text: 'Will retry' });

      const orchestrator = new Orchestrator({
        provider,
        tools: [failingTool],
        retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      const events: Array<{ type: string; error?: { retryable?: boolean } }> = [];
      const unsub = orchestrator.on('tool.failed', (e) => events.push(e));

      vi.useFakeTimers();
      const runPromise = orchestrator.run({ prompt: 'test' });
      vi.runAllTimersAsync();
      await runPromise;
      unsub();

      expect(events).toHaveLength(1);
      expect(events[0]!.error?.retryable).toBe(true);
      vi.useRealTimers();
    });

    it('orchestrator.on() unsubscribe stops listener from firing', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'First run' }).enqueue({ text: 'Second run' });

      const orchestrator = new Orchestrator({ provider });

      const eventCount = { current: 0 };
      const listener = () => {
        eventCount.current++;
      };
      const unsub = orchestrator.on('run.completed', listener);

      await orchestrator.run({ prompt: 'run1' });
      unsub(); // Unsubscribe after first run

      await orchestrator.run({ prompt: 'run2' }); // Should not trigger listener

      expect(eventCount.current).toBe(1);
    });

    it('multiple .on() calls accumulate listeners - all fire on event', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const orchestrator = new Orchestrator({ provider });

      let callCount = 0;
      const listener1 = () => callCount++;
      const listener2 = () => callCount++;
      const listener3 = () => callCount++;

      orchestrator.on('run.completed', listener1);
      orchestrator.on('run.completed', listener2);
      orchestrator.on('run.completed', listener3);

      await orchestrator.run({ prompt: 'test' });

      // All 3 listeners should have fired
      expect(callCount).toBe(3);
    });
  });
});
