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
  ProviderMalformedResponseError,
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

    it('run.input.prompt is always role: user (never system)', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const orchestrator = new Orchestrator({
        provider,
        systemPrompt: 'You are a helpful assistant.',
      });

      await orchestrator.run({ prompt: 'Hello, world!' });

      const lastRequest = provider.lastRequest();
      expect(lastRequest).toBeDefined();

      // Verify user prompt message has role: 'user'
      const userMessage = lastRequest!.messages.find((m) => m.content === 'Hello, world!');
      expect(userMessage).toBeDefined();
      expect(userMessage!.role).toBe('user');

      // Verify NO message has role: 'system' with user prompt content (S-2 boundary)
      const systemMessages = lastRequest!.messages.filter(
        (m) => m.role === 'system' && m.content === 'Hello, world!',
      );
      expect(systemMessages).toHaveLength(0);
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

    it('retry.maxAttempts: 0 throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            retry: { maxAttempts: 0 },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('retry.maxAttempts: -1 throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            retry: { maxAttempts: -1 },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('retry.maxAttempts: Infinity throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            retry: { maxAttempts: Infinity },
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

  });

  describe('Streaming validation', () => {
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

    it('stream: true + base-level fallbackProvider throws ConfigValidationError', async () => {
      const provider = createProvider();
      // capabilities.streaming is true by default — don't set to false
      // to isolate the fallbackProvider check (orchestrator.ts:167) from the
      // streaming capabilities check

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

  describe('Provider retryable error handling', () => {
    it('retries on ProviderTimeoutError and succeeds', async () => {
      const provider = createProvider();
      provider
        .enqueue({ error: new ProviderTimeoutError('timeout') })
        .enqueue({ text: 'Success after timeout' });

      const orchestrator = new Orchestrator({
        provider,
        retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      vi.useFakeTimers();
      const resultPromise = orchestrator.run({ prompt: 'test' });
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.text).toBe('Success after timeout');
      expect(provider.wasCalledTimes(2)).toBe(true);
      vi.useRealTimers();
    });

    it('retries on ProviderUnavailableError and succeeds', async () => {
      const provider = createProvider();
      provider
        .enqueue({ error: new ProviderUnavailableError('Down for maintenance') })
        .enqueue({ text: 'Success after recovery' });

      const orchestrator = new Orchestrator({
        provider,
        retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      vi.useFakeTimers();
      const resultPromise = orchestrator.run({ prompt: 'test' });
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.text).toBe('Success after recovery');
      expect(provider.wasCalledTimes(2)).toBe(true);
      vi.useRealTimers();
    });
  });

  describe('Provider non-retryable error handling', () => {
    it('throws ProviderMalformedResponseError immediately without retry', async () => {
      const provider = createProvider();
      provider.enqueue({ error: new ProviderMalformedResponseError('Malformed JSON response') });

      const orchestrator = new Orchestrator({
        provider,
        retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
      });

      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(ProviderMalformedResponseError);
      expect(provider.wasCalledTimes(1)).toBe(true);
    });
  });

  describe('AbortSignal cancellation', () => {
    it('throws RunCancelledError when AbortSignal is already aborted', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Should not be called' });

      const orchestrator = new Orchestrator({ provider });
      const signal = AbortSignal.abort();

      await expect(orchestrator.run({ prompt: 'test', signal })).rejects.toThrow(RunCancelledError);
      expect(provider.wasCalledTimes(0)).toBe(true);
    });

    it('throws RunCancelledError when signal aborts during run', async () => {
      let callCount = 0;
      let providerCallResolve: () => void;
      const providerCalled = new Promise<void>((resolve) => {
        providerCallResolve = resolve;
      });

      const abortAwareProvider: AIProvider = {
        id: 'abort-aware',
        capabilities: {
          streaming: false,
          toolCalling: false,
          vision: false,
          maxContextTokens: 128_000,
        },
        async generate(request: PromptRequest) {
          callCount++;
          providerCallResolve();
          if (request.signal?.aborted) {
            throw new RunCancelledError();
          }
          // Wait for abort signal while generating
          await new Promise<PromptResponse>((_resolve, reject) => {
            const onAbort = () => reject(new RunCancelledError());
            request.signal?.addEventListener('abort', onAbort, { once: true });
          });
          // Unreachable
          return {
            text: '',
            toolCalls: [],
            usage: { prompt: 0, completion: 0, total: 0 },
            finishReason: 'stop',
          };
        },
      };

      const controller = new AbortController();
      const orchestrator = new Orchestrator({ provider: abortAwareProvider });

      const runPromise = orchestrator.run({ prompt: 'test', signal: controller.signal });

      // Wait for the pipeline to reach provider.generate()
      await providerCalled;

      // Verify provider was called exactly once before abort
      expect(callCount).toBe(1);

      // Abort mid-execution
      controller.abort();

      await expect(runPromise).rejects.toThrow(RunCancelledError);
    });
  });

  describe('Constructor timeout validation', () => {
    it('generateTimeoutMs: 0 throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            timeout: { generateTimeoutMs: 0 },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('generateTimeoutMs: -1 throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            timeout: { generateTimeoutMs: -1 },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('generateTimeoutMs: Infinity throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            timeout: { generateTimeoutMs: Infinity },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('toolTimeoutMs: 0 throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            timeout: { toolTimeoutMs: 0 },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('toolTimeoutMs: -1 throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            timeout: { toolTimeoutMs: -1 },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('toolTimeoutMs: Infinity throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            timeout: { toolTimeoutMs: Infinity },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('totalTimeoutMs: 0 throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            timeout: { totalTimeoutMs: 0 },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('totalTimeoutMs: -1 throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            timeout: { totalTimeoutMs: -1 },
          }),
      ).toThrow(ConfigValidationError);
    });

    it('totalTimeoutMs: Infinity throws ConfigValidationError', () => {
      expect(
        () =>
          new Orchestrator({
            provider: createProvider(),
            timeout: { totalTimeoutMs: Infinity },
          }),
      ).toThrow(ConfigValidationError);
    });
  });

  describe('Profile existence validation', () => {
    it('throws ConfigValidationError when profile is not found at run()', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const orchestrator = new Orchestrator({ provider });

      await expect(orchestrator.run({ prompt: 'test', profile: 'nonexistent' })).rejects.toThrow(
        ConfigValidationError,
      );
      expect(provider.wasCalledTimes(0)).toBe(true);
    });
  });

  describe('Context provider errors', () => {
    it('throws ContextLoadError when context provider provide() throws', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Should not be called' });

      const failingContextProvider: ContextProvider = {
        id: 'failing-provider',
        async provide() {
          throw new Error('Context retrieval failed');
        },
      };

      const orchestrator = new Orchestrator({
        provider,
        contextProviders: [failingContextProvider],
      });

      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(ContextLoadError);
      expect(provider.wasCalledTimes(0)).toBe(true);
    });

    it('emits context.failed event when context provider throws', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Should not be called' });

      const failingContextProvider: ContextProvider = {
        id: 'failing-provider',
        async provide() {
          throw new Error('Context retrieval failed');
        },
      };

      const orchestrator = new Orchestrator({
        provider,
        contextProviders: [failingContextProvider],
      });

      const events: Array<{ type: string; providerId?: string; runId?: string; error?: unknown }> =
        [];
      const unsub = orchestrator.on('context.failed', (e) => events.push(e));

      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(ContextLoadError);
      unsub();

      expect(events).toHaveLength(1);
      expect(events[0]!.type).toBe('context.failed');
      expect(events[0]!.runId).toBeDefined();
      expect(events[0]!.providerId).toBe('failing-provider');
      expect(events[0]!.error).toEqual({
        code: 'CONTEXT_LOAD_FAILED',
        message: expect.any(String),
        retryable: true,
      });
    });
  });

  describe('Memory error handling', () => {
    it('propagates error when memory load fails', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const memory = new MockMemoryAdapter();
      memory.loadError = new ProviderUnavailableError('Database unavailable');

      const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

      await expect(
        orchestrator.run({ prompt: 'test', sessionId: 'session-load-fail' }),
      ).rejects.toThrow(ProviderUnavailableError);
      expect(provider.wasCalledTimes(0)).toBe(true);
    });
  });

  describe('Tool resolution errors', () => {
    it('throws ToolNotFoundError for unregistered tool name (fail-fast)', async () => {
      const provider = createProvider();
      provider.enqueue({
        text: '',
        toolCalls: [{ id: 'call-1', name: 'unknown-tool', input: {} }],
        finishReason: 'tool_calls',
      });

      const orchestrator = new Orchestrator({
        provider,
        tools: [],
      });

      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(ToolNotFoundError);
      // Provider should only be called once (initial generate) — fail-fast after tool validation
      expect(provider.wasCalledTimes(1)).toBe(true);
    });
  });

  describe('Generation events', () => {
    it('emits generate.started and generate.completed events', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const orchestrator = new Orchestrator({ provider });

      const startedEvents: Array<{ type: string; messageCount?: number; runId?: string }> = [];
      const completedEvents: Array<{ type: string; finishReason?: string; runId?: string }> = [];
      const unsub1 = orchestrator.on('generate.started', (e) => startedEvents.push(e));
      const unsub2 = orchestrator.on('generate.completed', (e) => completedEvents.push(e));

      await orchestrator.run({ prompt: 'test' });
      unsub1();
      unsub2();

      expect(startedEvents).toHaveLength(1);
      expect(startedEvents[0]!.runId).toBeDefined();
      expect(startedEvents[0]!.messageCount).toBe(1);
      expect(completedEvents).toHaveLength(1);
      expect(completedEvents[0]!.runId).toBeDefined();
      expect(completedEvents[0]!.finishReason).toBe('stop');
    });
  });

  describe('Tool hooks', () => {
    it('executes beforeTool and afterTool hooks during tool execution', async () => {
      const provider = createProvider();
      provider
        .enqueue({
          text: '',
          toolCalls: [{ id: 'call-1', name: 'echo', input: { value: 'test' } }],
          finishReason: 'tool_calls',
        })
        .enqueue({ text: 'Final response' });

      const beforeToolHook = vi.fn(async (ctx: ToolContext) => ctx);
      const afterToolHook = vi.fn(async (ctx: AfterToolContext) => ctx);

      const orchestrator = new Orchestrator({
        provider,
        tools: [echoTool],
        hooks: { beforeTool: [beforeToolHook], afterTool: [afterToolHook] },
      });

      await orchestrator.run({ prompt: 'test' });

      expect(beforeToolHook).toHaveBeenCalledTimes(1);
      expect(afterToolHook).toHaveBeenCalledTimes(1);
      // Verify beforeTool was called before afterTool
      expect(beforeToolHook.mock.invocationCallOrder[0] as number).toBeLessThan(
        afterToolHook.mock.invocationCallOrder[0] as number,
      );
    });
  });

  describe('Memory behavior', () => {
    it('isolates memory between different sessions', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response 1' }).enqueue({ text: 'Response 2' });

      const memory = new MockMemoryAdapter();

      const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

      await orchestrator.run({ prompt: 'Hello from A', sessionId: 'session-a' });
      await orchestrator.run({ prompt: 'Hello from B', sessionId: 'session-b' });

      const sessionA = await memory.load('session-a');
      const sessionB = await memory.load('session-b');

      // Each session should only have its own messages
      expect(sessionA).toHaveLength(2);
      expect(sessionA[0]!.content).toBe('Hello from A');
      expect(sessionB).toHaveLength(2);
      expect(sessionB[0]!.content).toBe('Hello from B');
    });

    it('accumulates memory across multiple run() calls with same sessionId', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'First' }).enqueue({ text: 'Second' });

      const memory = new MockMemoryAdapter();

      const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

      await orchestrator.run({ prompt: 'Run 1', sessionId: 'session-acc' });
      await orchestrator.run({ prompt: 'Run 2', sessionId: 'session-acc' });

      const saved = await memory.load('session-acc');
      // 2 messages per run (user + assistant) x 2 runs = 4 total
      expect(saved).toHaveLength(4);
      expect(saved[0]!.content).toBe('Run 1');
      expect(saved[2]!.content).toBe('Run 2');
    });

    it('handles memoryBudget ≤ 0 gracefully (no memory truncation)', async () => {
      const provider = createProvider();
      provider.capabilities.maxContextTokens = 100; // Very low, making memoryBudget negative
      provider.enqueue({ text: 'Success with low maxContextTokens' });

      const orchestrator = new Orchestrator({ provider });
      const result = await orchestrator.run({ prompt: 'test' });

      expect(result.text).toBe('Success with low maxContextTokens');
      expect(provider.wasCalledTimes(1)).toBe(true);
    });
  });

  describe('Finish reason handling', () => {
    it('finishReason length exits generation loop without further provider calls', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Truncated output', finishReason: 'length' });
      // No additional entries — if provider is called again, MockProvider throws ProviderUnavailableError

      const orchestrator = new Orchestrator({ provider });

      const result = await orchestrator.run({ prompt: 'test' });
      expect(result.text).toBe('Truncated output');
      expect(provider.wasCalledTimes(1)).toBe(true);
    });
  });

  describe('Pipeline error wrapping', () => {
    it('wraps plain Error as PipelineInternalError', async () => {
      let callCount = 0;
      const errorProvider: AIProvider = {
        id: 'error-provider',
        capabilities: {
          streaming: false,
          toolCalling: false,
          vision: false,
          maxContextTokens: 128_000,
        },
        async generate() {
          callCount++;
          throw new Error('boom');
        },
      };

      const orchestrator = new Orchestrator({ provider: errorProvider });
      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(PipelineInternalError);
      expect(callCount).toBe(1);
    });

    it('wraps non-Error throw as TimeoutExceededError', async () => {
      let callCount = 0;
      const stringProvider: AIProvider = {
        id: 'string-provider',
        capabilities: {
          streaming: false,
          toolCalling: false,
          vision: false,
          maxContextTokens: 128_000,
        },
        async generate() {
          callCount++;
          throw 'string error';
        },
      };

      const orchestrator = new Orchestrator({ provider: stringProvider });
      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(TimeoutExceededError);
      expect(callCount).toBe(1);
    });
  });

  describe('TimeoutExceededError from totalTimeoutMs', () => {
    it('throws TimeoutExceededError in non-streaming path with totalTimeoutMs', async () => {
      // Provider that never resolves
      const stuckProvider: AIProvider = {
        id: 'stuck',
        capabilities: {
          streaming: false,
          toolCalling: false,
          vision: false,
          maxContextTokens: 128_000,
        },
        async generate() {
          await new Promise(() => {}); // Never resolves
          return {
            text: '',
            toolCalls: [],
            usage: { prompt: 0, completion: 0, total: 0 },
            finishReason: 'stop',
          };
        },
      };

      vi.useFakeTimers();
      const orchestrator = new Orchestrator({
        provider: stuckProvider,
        timeout: { totalTimeoutMs: 50 },
      });

      const runPromise = orchestrator.run({ prompt: 'test' });
      // Suppress unhandled rejection from the hanging pipeline promise
      // after withTimeout short-circuits with TimeoutExceededError
      runPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(60);
      await expect(runPromise).rejects.toThrow(TimeoutExceededError);
      vi.clearAllTimers();
      vi.useRealTimers();
    });
  });

  describe('Profile override merging', () => {
    it('overrides systemPrompt from profile', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Profile response' });

      const orchestrator = new Orchestrator({
        provider,
        systemPrompt: 'Base system prompt',
        profiles: {
          custom: {
            name: 'custom',
            systemPrompt: 'Custom system prompt',
          },
        },
      });

      await orchestrator.run({ prompt: 'test', profile: 'custom' });

      const lastRequest = provider.lastRequest();
      expect(
        lastRequest?.messages.some(
          (m) => m.role === 'system' && m.content === 'Custom system prompt',
        ),
      ).toBe(true);
    });

    it('overrides provider from profile', async () => {
      const baseProvider = createProvider();
      baseProvider.enqueue({ text: 'Should not be called' });

      const profileProvider = new MockProvider('profile-test');
      profileProvider.enqueue({ text: 'From profile provider' });

      const orchestrator = new Orchestrator({
        provider: baseProvider,
        profiles: {
          custom: {
            name: 'custom',
            provider: profileProvider,
          },
        },
      });

      const result = await orchestrator.run({ prompt: 'test', profile: 'custom' });
      expect(result.text).toBe('From profile provider');
    });

    it('uses base provider when no profile is specified', async () => {
      const baseProvider = createProvider();
      baseProvider.enqueue({ text: 'Base response' });

      const profileProvider = new MockProvider('profile-test');

      const orchestrator = new Orchestrator({
        provider: baseProvider,
        profiles: {
          custom: {
            name: 'custom',
            provider: profileProvider,
          },
        },
      });

      const result = await orchestrator.run({ prompt: 'test' });
      expect(result.text).toBe('Base response');
    });

    it('tools override replaces base tools completely', async () => {
      const provider = createProvider();
      provider
        .enqueue({
          text: '',
          toolCalls: [{ id: 'call-1', name: 'profile-tool', input: { input: 'test' } }],
          finishReason: 'tool_calls',
        })
        .enqueue({ text: 'Success with profile tool' });

      const baseTool: Tool = {
        name: 'base-tool',
        description: 'Base only tool',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        async execute() {
          return {};
        },
      };

      const profileTool: Tool = {
        name: 'profile-tool',
        description: 'Profile only tool',
        inputSchema: {
          type: 'object',
          properties: { input: { type: 'string' } },
          required: ['input'],
          additionalProperties: false,
        },
        async execute(input) {
          return input;
        },
      };

      const orchestrator = new Orchestrator({
        provider,
        tools: [baseTool],
        profiles: {
          custom: {
            name: 'custom',
            tools: [profileTool],
          },
        },
        retry: { maxAttempts: 1, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      vi.useFakeTimers();
      const resultPromise = orchestrator.run({ prompt: 'test', profile: 'custom' });
      await vi.runAllTimersAsync();
      const result = await resultPromise;
      expect(result.text).toBe('Success with profile tool');

      // Verify full replacement: profile tool present, base tool absent
      const lastRequest = provider.lastRequest();
      expect(lastRequest?.tools?.some((t) => t.name === 'profile-tool')).toBe(true);
      expect(lastRequest?.tools?.some((t) => t.name === 'base-tool')).toBe(false);

      vi.useRealTimers();
    });

    it('contextProviders override replaces base contextProviders completely', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const baseCtxProvider: ContextProvider = {
        id: 'base-ctx',
        async provide() {
          return [{ role: 'system', content: 'Base context' }];
        },
      };

      const profileCtxProvider: ContextProvider = {
        id: 'profile-ctx',
        async provide() {
          return [{ role: 'system', content: 'Profile context' }];
        },
      };

      const orchestrator = new Orchestrator({
        provider,
        contextProviders: [baseCtxProvider],
        profiles: {
          custom: {
            name: 'custom',
            contextProviders: [profileCtxProvider],
          },
        },
      });

      await orchestrator.run({ prompt: 'test', profile: 'custom' });
      const lastRequest = provider.lastRequest();
      expect(lastRequest?.messages.some((m) => m.content === 'Profile context')).toBe(true);
      expect(lastRequest?.messages.some((m) => m.content === 'Base context')).toBe(false);
    });

    it('retry deep merge applies profile overrides on top of defaults', async () => {
      const provider = createProvider();
      provider
        .enqueue({ error: new ProviderRateLimitError('429', 50) })
        .enqueue({ error: new ProviderRateLimitError('429', 50) })
        .enqueue({ error: new ProviderRateLimitError('429', 50) });

      const orchestrator = new Orchestrator({
        provider,
        profiles: {
          custom: {
            name: 'custom',
            retry: { baseDelayMs: 10, jitter: false },
          },
        },
        timeout: { totalTimeoutMs: 60_000 },
      });

      vi.useFakeTimers();
      const runPromise = orchestrator.run({ prompt: 'test', profile: 'custom' });
      // Suppress unhandled rejection from the retry rejection
      runPromise.catch(() => {});
      await vi.runAllTimersAsync();
      // maxAttempts: 3 preserved from defaults — all 3 retries exhausted
      await expect(runPromise).rejects.toThrow(MaxRetriesExceededError);
      expect(provider.wasCalledTimes(3)).toBe(true);
      vi.useRealTimers();
    });

    it('timeout deep merge applies profile overrides on top of defaults', async () => {
      // Provider that never resolves — ensures timeout fires via totalTimeoutMs
      const stuckProvider: AIProvider = {
        id: 'stuck',
        capabilities: {
          streaming: false,
          toolCalling: false,
          vision: false,
          maxContextTokens: 128_000,
        },
        async generate() {
          await new Promise(() => {}); // Never resolves
          return {
            text: '',
            toolCalls: [],
            usage: { prompt: 0, completion: 0, total: 0 },
            finishReason: 'stop',
          };
        },
      };

      vi.useFakeTimers();
      const orchestrator = new Orchestrator({
        provider: stuckProvider,
        profiles: {
          custom: {
            name: 'custom',
            timeout: { totalTimeoutMs: 50 }, // Override default 60s to 50ms
          },
        },
      });

      const runPromise = orchestrator.run({ prompt: 'test', profile: 'custom' });
      // Suppress unhandled rejection from the hanging pipeline promise
      runPromise.catch(() => {});
      await vi.advanceTimersByTimeAsync(60);
      // 50ms profile timeout fires instead of default 60s — proves override took effect
      await expect(runPromise).rejects.toThrow(TimeoutExceededError);
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it('toolPolicy deep merge applies profile overrides on top of defaults', async () => {
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
        .enqueue({ text: 'Should not be reached' });

      const orchestrator = new Orchestrator({
        provider,
        tools: [echoTool],
        profiles: {
          custom: {
            name: 'custom',
            toolPolicy: { maxToolRounds: 1 },
          },
        },
      });

      await expect(orchestrator.run({ prompt: 'test', profile: 'custom' })).rejects.toThrow(
        MaxToolRoundsExceededError,
      );
      expect(provider.wasCalledTimes(2)).toBe(true); // First generate + first tool round
    });

    it('hooks concatenation merges base and profile hooks in order', async () => {
      const provider = createProvider();
      provider.enqueue({ text: 'Response' });

      const baseBeforeRun = vi.fn(async (ctx) => ctx);
      const profileBeforeRun = vi.fn(async (ctx) => ctx);

      const orchestrator = new Orchestrator({
        provider,
        hooks: { beforeRun: [baseBeforeRun] },
        profiles: {
          custom: {
            name: 'custom',
            hooks: { beforeRun: [profileBeforeRun] },
          },
        },
      });

      await orchestrator.run({ prompt: 'test', profile: 'custom' });

      expect(baseBeforeRun).toHaveBeenCalledTimes(1);
      expect(profileBeforeRun).toHaveBeenCalledTimes(1);
      // Base hooks execute first, then profile hooks
      expect(baseBeforeRun.mock.invocationCallOrder[0] as number).toBeLessThan(
        profileBeforeRun.mock.invocationCallOrder[0] as number,
      );
    });
  });
});
