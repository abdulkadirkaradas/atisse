import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Tool,
  StreamChunk,
  BeforeGenerateContext,
  TokenUsage,
  AfterGenerateContext,
} from '../../src/interfaces.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { MaxToolRoundsExceededError } from '../../src/errors.js';
import { MockMemoryAdapter } from '../fixtures/mock-memory.js';

describe('Integration: Streaming + Tool Calls (D-M3-4)', () => {
  let provider: MockProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new MockProvider('streaming-tool-test');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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

  it('tool_call chunk → pause → execute → tool_result chunk → resume → done', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Let me ' },
        { type: 'text', delta: 'check that' },
        {
          type: 'tool_call',
          toolCall: { id: 'call-1', name: 'echo', input: { value: 'hello' } },
        },
        { type: 'done', usage: { prompt: 10, completion: 5, total: 15 } },
      ],
    });

    // Second call after tool execution completes
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Tool returned: hello' },
        { type: 'done', usage: { prompt: 20, completion: 10, total: 30 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      tools: [echoTool],
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'Use the echo tool',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunkTypes: string[] = [];
    const toolResults: string[] = [];

    for await (const chunk of result) {
      chunkTypes.push(chunk.type);
      if (chunk.type === 'tool_result') {
        toolResults.push(JSON.stringify(chunk.toolResult.output));
      }
    }

    // First stream: text → tool_call → done
    // Then tool executes, tool_result yielded
    // Then second stream: text → done
    expect(chunkTypes).toContain('text');
    expect(chunkTypes).toContain('tool_call');
    expect(chunkTypes).toContain('tool_result');
    expect(chunkTypes).toContain('done');

    // tool_result should appear between the two done chunks
    const firstDoneIndex = chunkTypes.indexOf('done');
    const toolResultIndex = chunkTypes.indexOf('tool_result');
    expect(toolResultIndex).toBeGreaterThan(firstDoneIndex);

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toBe('{"value":"hello"}');

    // Provider was called twice: initial + after tool execution
    expect(provider.callCount()).toBe(2);
  });

  it('tool.called and tool.completed events fire during streaming tool execution', async () => {
    provider.enqueueStream({
      chunks: [
        {
          type: 'tool_call',
          toolCall: { id: 'call-1', name: 'echo', input: { value: 'test' } },
        },
        { type: 'done', usage: { prompt: 5, completion: 2, total: 7 } },
      ],
    });

    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Done' },
        { type: 'done', usage: { prompt: 10, completion: 5, total: 15 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      tools: [echoTool],
    });

    const calledEvents: Array<{ type: string; toolName?: string; round?: number }> = [];
    const completedEvents: Array<{ type: string; toolName?: string }> = [];

    const unsub1 = orchestrator.on('tool.called', (e) => calledEvents.push(e));
    const unsub2 = orchestrator.on('tool.completed', (e) => completedEvents.push(e));

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    // Consume stream
    for await (const _chunk of result) {
      void _chunk;
    }

    unsub1();
    unsub2();

    expect(calledEvents).toHaveLength(1);
    expect(calledEvents[0]!.toolName).toBe('echo');
    expect(calledEvents[0]!.round).toBe(1);

    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]!.toolName).toBe('echo');
  });

  it('MaxToolRoundsExceededError at correct count in streaming', async () => {
    // Every stream returns a tool_call, forcing infinite tool rounds
    // With maxToolRounds: 2, should throw after 2 rounds
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Round 1' },
        {
          type: 'tool_call',
          toolCall: { id: 'call-1', name: 'echo', input: { value: '1' } },
        },
        { type: 'done', usage: { prompt: 5, completion: 2, total: 7 } },
      ],
    });

    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Round 2' },
        {
          type: 'tool_call',
          toolCall: { id: 'call-2', name: 'echo', input: { value: '2' } },
        },
        { type: 'done', usage: { prompt: 10, completion: 4, total: 14 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      tools: [echoTool],
      toolPolicy: { maxToolRounds: 2 },
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const chunks: StreamChunk[] = [];
    let errorChunk: StreamChunk | null = null;

    for await (const chunk of result) {
      chunks.push(chunk);
      if (chunk.type === 'error') {
        errorChunk = chunk;
      }
    }

    expect(errorChunk).not.toBeNull();
    expect(errorChunk!.type).toBe('error');
    expect(
      (errorChunk as { type: 'error'; error: MaxToolRoundsExceededError }).error,
    ).toBeInstanceOf(MaxToolRoundsExceededError);

    const err = (errorChunk as { type: 'error'; error: MaxToolRoundsExceededError }).error;
    expect(err.rounds).toBe(2);
    expect(err.maxRounds).toBe(2);

    // Verify: 2 stream calls were made (each round calls generateStream once)
    expect(provider.callCount()).toBe(2);
  });

  it('streaming with no tool calls yields text and done only', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Hello' },
        { type: 'text', delta: ' world' },
        { type: 'done', usage: { prompt: 5, completion: 10, total: 15 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const result = (await orchestrator.run({
      prompt: 'Say hello',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    const textChunks: string[] = [];
    let doneReceived = false;

    for await (const chunk of result) {
      if (chunk.type === 'text') {
        textChunks.push(chunk.delta);
      } else if (chunk.type === 'done') {
        doneReceived = true;
        expect(chunk.usage).toEqual({ prompt: 5, completion: 10, total: 15 });
      }
    }

    expect(textChunks.join('')).toBe('Hello world');
    expect(doneReceived).toBe(true);
    expect(provider.callCount()).toBe(1);
  });

  it('streaming tool execution error terminates stream with error chunk', async () => {
    const errorTool: Tool = {
      name: 'error-tool',
      description: 'Always errors',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      async execute() {
        throw new Error('Tool execution failed');
      },
    };

    provider.enqueueStream({
      chunks: [
        {
          type: 'tool_call',
          toolCall: { id: 'call-1', name: 'error-tool', input: {} },
        },
        { type: 'done', usage: { prompt: 5, completion: 2, total: 7 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      tools: [errorTool],
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

    // Tool execution error propagates through pipeline catch block
    // Stream terminates with error chunk — no tool_result, no second stream
    const chunkTypes = chunks.map((c) => c.type);
    expect(chunkTypes).toContain('tool_call');
    expect(chunkTypes).toContain('error');

    // Error chunk is last — no done follows
    const lastIndex = chunkTypes.length - 1;
    expect(chunkTypes[lastIndex]).toBe('error');

    // No tool_result because tool execution threw before yielding results
    expect(chunkTypes).not.toContain('tool_result');
  });

  it('memory saved atomically at COMPLETING during streaming', async () => {
    const mockMemory = new MockMemoryAdapter();

    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Hello' },
        { type: 'done', usage: { prompt: 5, completion: 10, total: 15 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      memoryAdapter: mockMemory,
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
      sessionId: 'test-session',
    })) as AsyncIterable<StreamChunk>;

    // Consume all chunks
    for await (const chunk of result) {
      void chunk;
    }

    // Verify memory was saved with correct messages
    const savedMessages = await mockMemory.load('test-session');
    expect(savedMessages).toBeDefined();
    expect(savedMessages!.length).toBe(2);

    // First message should be user message
    expect(savedMessages![0]!.role).toBe('user');
    if (savedMessages![0]!.role === 'user') {
      const content =
        typeof savedMessages![0]!.content === 'string' ? savedMessages![0]!.content : '';
      expect(content).toBe('test');
    }

    // Second message should be assistant message with accumulated text
    expect(savedMessages![1]!.role).toBe('assistant');
    if (savedMessages![1]!.role === 'assistant') {
      const content =
        typeof savedMessages![1]!.content === 'string' ? savedMessages![1]!.content : '';
      expect(content).toBe('Hello');
    }
  });

  it('afterGenerate fires with complete accumulated response during streaming', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Hello' },
        { type: 'text', delta: ' world' },
        { type: 'done', usage: { prompt: 10, completion: 20, total: 30 } },
      ],
    });

    let afterGenerateText = '';
    let afterGenerateUsage: TokenUsage | undefined;
    const afterGenerateHook = vi.fn(async (ctx: AfterGenerateContext) => {
      afterGenerateText = ctx.response.text;
      afterGenerateUsage = ctx.response.usage;
      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { afterGenerate: [afterGenerateHook] },
    });

    const result = (await orchestrator.run({
      prompt: 'test',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    // Consume all chunks
    for await (const chunk of result) {
      void chunk;
    }

    // Verify afterGenerate was called once
    expect(afterGenerateHook).toHaveBeenCalledTimes(1);

    // Verify afterGenerate received complete accumulated text
    expect(afterGenerateText).toBe('Hello world');

    // Verify afterGenerate received usage from done chunk
    expect(afterGenerateUsage).toBeDefined();
    expect(afterGenerateUsage!.prompt).toBe(10);
    expect(afterGenerateUsage!.completion).toBe(20);
    expect(afterGenerateUsage!.total).toBe(30);
  });

  it('beforeGenerate hook modifies messages during streaming', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Response 1' },
        { type: 'done', usage: { prompt: 10, completion: 10, total: 20 } },
      ],
    });

    const messagesSentToProvider: Array<{
      content: string;
      role: string;
    }> = [];

    const beforeGenerateHook = vi.fn(async (ctx: BeforeGenerateContext) => {
      for (let i = ctx.messages.length - 1; i >= 0; i--) {
        const msg = ctx.messages[i]!;

        if (msg.role === 'user') {
          const content = typeof msg.content === 'string' ? msg.content : '';

          ctx.messages[i] = {
            ...msg,
            content: `[Modified] ${content}`,
          };

          break;
        }
      }

      messagesSentToProvider.push(
        ...ctx.messages
          .filter((m) => m.role === 'user')
          .map((m) => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content : '',
          })),
      );

      return ctx;
    });

    const orchestrator = new Orchestrator({
      provider,
      hooks: { beforeGenerate: [beforeGenerateHook] },
    });

    const result = (await orchestrator.run({
      prompt: 'original prompt',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    for await (const chunk of result) {
      void chunk;
    }

    expect(beforeGenerateHook).toHaveBeenCalledTimes(1);

    const lastRequest = provider.lastRequest();
    expect(lastRequest).toBeDefined();

    const userMessage = lastRequest!.messages.find((m) => m.role === 'user');
    expect(userMessage).toBeDefined();

    if (userMessage && typeof userMessage.content === 'string') {
      expect(userMessage.content).toContain('[Modified]');
      expect(userMessage.content).toContain('original prompt');
    }
  });

  it('generate.started event fires during streaming run', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Hello' },
        { type: 'done', usage: { prompt: 10, completion: 5, total: 15 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const events: Array<{ type: string; runId: string; messageCount?: number }> = [];

    const unsub = orchestrator.on('generate.started', (e) => events.push(e));

    const result = (await orchestrator.run({
      prompt: 'Say hello',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    // Consume stream
    for await (const _chunk of result) {
      void _chunk;
    }

    unsub();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('generate.started');
    expect(events[0]!.runId).toBeDefined();
    expect(events[0]!.messageCount).toBe(1); // Just the user message
  });

  it('generate.completed event fires after streaming finishes', async () => {
    provider.enqueueStream({
      chunks: [
        { type: 'text', delta: 'Hello' },
        { type: 'done', usage: { prompt: 10, completion: 5, total: 15 } },
      ],
    });

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
    });

    const events: Array<{ type: string; runId: string; durationMs?: number; finishReason?: string }> = [];

    const unsub = orchestrator.on('generate.completed', (e) => events.push(e));

    const result = (await orchestrator.run({
      prompt: 'Say hello',
      stream: true,
    })) as AsyncIterable<StreamChunk>;

    // Consume stream
    for await (const _chunk of result) {
      void _chunk;
    }

    unsub();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('generate.completed');
    expect(events[0]!.runId).toBeDefined();
    expect(events[0]!.durationMs).toBeDefined();
    expect(events[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(events[0]!.finishReason).toBe('stop');
  });
});
