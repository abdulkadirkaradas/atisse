import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Message, ToolDefinition } from '@atisse/core';

import {
  ProviderRateLimitError,
  ProviderAuthError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderMalformedResponse,
  OrchestratorError,
} from '@atisse/core';

import { AnthropicProvider, type AnthropicProviderConfig } from '../src/index.js';

interface AnthropicErrorResponse {
  status?: number;
  message?: string;
  cause?: unknown;
  headers?: Record<string, string | undefined>;
}

function createMockStream(events: unknown[]): AsyncIterable<unknown> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index < events.length) {
            return { done: false, value: events[index++] };
          }
          return { done: true, value: undefined };
        },
      };
    },
  };
}

function createTestableProvider(
  config: AnthropicProviderConfig,
  mockCreateFn: ReturnType<typeof vi.fn>,
): AnthropicProvider {
  const provider = new AnthropicProvider(config);
  const mockClient = {
    messages: {
      create: mockCreateFn,
    },
  };
  Object.defineProperty(provider, 'client', {
    value: mockClient,
    writable: true,
    configurable: true,
  });
  return provider;
}

describe('AnthropicProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should set id with default model', () => {
      const p = new AnthropicProvider({ apiKey: 'test-key' });
      expect(p.id).toBe('anthropic-claude-sonnet-4-5');
    });

    it('should set id with custom model', () => {
      const p = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-3-haiku' });
      expect(p.id).toBe('anthropic-claude-3-haiku');
    });

    it('should set correct capabilities', () => {
      const p = new AnthropicProvider({ apiKey: 'test-key' });
      expect(p.capabilities).toEqual({
        streaming: true,
        toolCalling: true,
        vision: true,
        maxContextTokens: 200_000,
      });
    });
  });

  describe('generate()', () => {
    it('should return correct PromptResponse shape', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from Claude!' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result).toEqual({
        text: 'Hello from Claude!',
        usage: { prompt: 10, completion: 5, total: 15 },
        finishReason: 'stop',
      });
    });

    it('should concatenate multiple text content blocks into single text field', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'World' },
        ],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.text).toBe('Hello World');
    });

    it('should extract system messages separately, not in messages array', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Understood' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 15, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.system).toBe('You are helpful.');

      const sentMessages = callArgs.messages as Array<{ role: string }>;
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.role).toBe('user');
    });

    it('should map role: tool to role: user with tool_result content blocks', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const messages: Message[] = [
        { role: 'user', content: 'Get weather' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_123', name: 'get_weather', input: {} }],
        },
        {
          role: 'tool',
          content: 'Sunny',
          toolCallId: 'toolu_123',
          name: 'get_weather',
        },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as Record<string, unknown>;
      const sentMessages = callArgs.messages as Array<{ role: string; content: unknown }>;

      const toolMsg = sentMessages[2]!;
      expect(toolMsg.role).toBe('user');
      expect(toolMsg.content).toEqual([
        { type: 'tool_result', tool_use_id: 'toolu_123', content: 'Sunny' },
      ]);
    });

    it('should map role: tool with image content to Anthropic image block in tool_result', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Image processed' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const messages: Message[] = [
        { role: 'user', content: 'Process image' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'toolu_456', name: 'process_image', input: {} }],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'Here is the result: ' },
            { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' },
          ],
          toolCallId: 'toolu_456',
          name: 'process_image',
        },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as Record<string, unknown>;
      const sentMessages = callArgs.messages as Array<{ role: string; content: unknown }>;

      const toolMsg = sentMessages[2]!;
      expect(toolMsg.role).toBe('user');
      const toolResultContent = (toolMsg.content as Array<Record<string, unknown>>)[0]!
        .content as Array<Record<string, unknown>>;
      expect(toolResultContent).toHaveLength(2);
      expect(toolResultContent[0]).toEqual({ type: 'text', text: 'Here is the result: ' });
      expect(toolResultContent[1]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
      });
    });

    it('should map tool calls correctly with ToolCall.id fallback', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_abc', name: 'get_weather', input: { location: 'NYC' } },
        ],
        model: 'claude-sonnet-4-5',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Get weather' }],
      });

      expect(result.finishReason).toBe('tool_calls');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls?.[0]).toEqual({
        id: 'toolu_abc',
        name: 'get_weather',
        input: { location: 'NYC' },
      });
      expect(result.text).toBe('');
    });

    it('should map stop_sequence finish_reason to stop', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Stopped by sequence' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'stop_sequence',
        stop_sequence: '\n',
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.finishReason).toBe('stop');
    });

    it('should map end_turn finish_reason to stop', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.finishReason).toBe('stop');
    });

    it('should map max_tokens finish_reason to length', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Partial' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'max_tokens',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4096 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.finishReason).toBe('length');
    });

    it('should throw ProviderMalformedResponse for unrecognized stop_reason', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: '???' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'unknown_reason',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await expect(
        provider.generate({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow(ProviderMalformedResponse);
    });

    it('should throw ProviderMalformedResponse when response has no content array', async () => {
      const mockMessage: Record<string, unknown> = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: undefined,
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: OrchestratorError | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as OrchestratorError;
      }

      expect(caughtError).toBeInstanceOf(ProviderMalformedResponse);
      expect(caughtError!.retryable).toBe(false);
    });

    it('should throw ProviderMalformedResponse when response is missing valid usage', async () => {
      const mockMessage: Record<string, unknown> = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: undefined,
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: OrchestratorError | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as OrchestratorError;
      }

      expect(caughtError).toBeInstanceOf(ProviderMalformedResponse);
      expect(caughtError!.retryable).toBe(false);
    });

    it('should pass maxTokens, temperature, tools, and providerOptions to SDK', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const tools: ToolDefinition[] = [
        {
          name: 'get_weather',
          description: 'Get weather',
          inputSchema: { type: 'object', properties: {}, required: [] },
        },
      ];

      await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 500,
        temperature: 0.5,
        tools,
        providerOptions: { top_p: 0.9 },
      });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.max_tokens).toBe(500);
      expect(callArgs.temperature).toBe(0.5);
      expect(callArgs.tools).toHaveLength(1);
      expect(callArgs.top_p).toBe(0.9);
    });

    it('should forward AbortSignal to SDK', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const controller = new AbortController();

      await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
      });

      const secondArg = mockCreateFn.mock.calls[0]?.[1] as { signal: AbortSignal } | undefined;
      expect(secondArg).toBeDefined();
      expect(secondArg?.signal).toBe(controller.signal);
    });

    it('should map user content with MessageContent array', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 15, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'World' },
          ],
        },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as Record<string, unknown>;
      const sentMessages = callArgs.messages as Array<{ role: string; content: unknown }>;
      const content = sentMessages[0]?.content;
      expect(Array.isArray(content)).toBe(true);
      const contentArr = content as Array<{ type: string; text?: string }>;
      expect(contentArr).toHaveLength(2);
      expect(contentArr[0]).toEqual({ type: 'text', text: 'Hello ' });
      expect(contentArr[1]).toEqual({ type: 'text', text: 'World' });
    });

    it('should map image content to Anthropic vision format with data URI', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Image received' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 15, output_tokens: 5 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', url: 'data:image/jpeg;base64,/9j/4AAQ=', mimeType: 'image/jpeg' },
          ],
        },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as Record<string, unknown>;
      const sentMessages = callArgs.messages as Array<{ role: string; content: unknown }>;
      const content = sentMessages[0]?.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(2);
      expect(content[1]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQ=' },
      });
    });

    it('should throw ProviderMalformedResponse for non-data-URI image URL', async () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key' });

      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', url: 'https://example.com/image.jpg', mimeType: 'image/jpeg' },
          ],
        },
      ];

      await expect(
        provider.generate({ messages }),
      ).rejects.toThrow(ProviderMalformedResponse);
    });
  });

  describe('generateStream()', () => {
    it('should return Promise<AsyncIterable<StreamChunk>>', async () => {
      const streamEvents = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result[Symbol.asyncIterator]).toBeDefined();
    });

    it('should yield text delta chunks for text content blocks', async () => {
      const streamEvents = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const textChunks: string[] = [];
      for await (const chunk of result) {
        if (chunk.type === 'text') {
          textChunks.push(chunk.delta);
        }
      }

      expect(textChunks.join('')).toBe('Hello world');
    });

    it('should accumulate tool input deltas and emit single tool_call at content_block_stop', async () => {
      const streamEvents = [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_abc', name: 'get_weather', input: {} },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"location":' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"NYC"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Get weather' }],
      });

      const toolCallChunks: Array<{ type: string; toolCall: { id: string; name: string; input: unknown } }> = [];
      for await (const chunk of result) {
        if (chunk.type === 'tool_call') {
          toolCallChunks.push(chunk as { type: 'tool_call'; toolCall: { id: string; name: string; input: unknown } });
        }
      }

      expect(toolCallChunks).toHaveLength(1);
      expect(toolCallChunks[0]!.toolCall).toEqual({
        id: 'toolu_abc',
        name: 'get_weather',
        input: { location: 'NYC' },
      });
    });

    it('should terminate with done chunk carrying usage', async () => {
      const streamEvents = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      let doneChunk: { type: string; usage?: { prompt: number; completion: number; total: number } } | undefined;
      for await (const chunk of result) {
        if (chunk.type === 'done') {
          doneChunk = chunk;
        }
      }

      expect(doneChunk).toBeDefined();
      expect(doneChunk!.usage?.completion).toBe(5);
    });

    it('should reject the Promise when connection error occurs before streaming', async () => {
      const connectionError = new Error('Connection refused');

      const mockCreateFn = vi.fn().mockRejectedValue(connectionError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await expect(
        provider.generateStream({ messages: [{ role: 'user', content: 'Hi' }] }),
      ).rejects.toThrow(ProviderUnavailableError);
    });

    it('should yield error chunk when iterator error occurs mid-stream', async () => {
      const streamEvents = [
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
      ];

      const mockStream = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new Error('Stream interrupted');
            },
          };
        },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockStream);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      let errorChunk: { type: string; error: Error } | undefined;
      for await (const chunk of result) {
        if (chunk.type === 'error') {
          errorChunk = chunk as { type: 'error'; error: Error };
        }
      }

      expect(errorChunk).toBeDefined();
      expect(errorChunk!.error).toBeInstanceOf(OrchestratorError);
    });

    it('should NOT re-wrap already-mapped OrchestratorError in mid-stream error', async () => {
      const mockStream = {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              throw new ProviderRateLimitError('Rate limit', 1000);
            },
          };
        },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockStream);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      let errorChunk: { type: string; error: Error } | undefined;
      for await (const chunk of result) {
        if (chunk.type === 'error') {
          errorChunk = chunk as { type: 'error'; error: Error };
        }
      }

      expect(errorChunk).toBeDefined();
      expect(errorChunk!.error).toBeInstanceOf(ProviderRateLimitError);
      expect(errorChunk!.error).not.toBeInstanceOf(ProviderUnavailableError);
    });

    it('should forward AbortSignal to SDK', async () => {
      const streamEvents = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const controller = new AbortController();

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
        signal: controller.signal,
      });

      for await (const _chunk of result) {
        void _chunk;
      }

      const secondArg = mockCreateFn.mock.calls[0]?.[1] as { signal: AbortSignal } | undefined;
      expect(secondArg).toBeDefined();
      expect(secondArg?.signal).toBe(controller.signal);
    });
  });

  describe('mapError() - HTTP status mapping', () => {
    it('should map HTTP 429 to ProviderRateLimitError with retryAfterMs', async () => {
      const mockError: AnthropicErrorResponse = {
        status: 429,
        message: 'Rate limited',
        cause: new Error('Rate limit'),
        headers: { 'retry-after': '30' },
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderRateLimitError);
      expect((caughtError as unknown as { retryAfterMs: number }).retryAfterMs).toBe(30000);
    });

    it('should map HTTP 429 without Retry-After header', async () => {
      const mockError: AnthropicErrorResponse = {
        status: 429,
        message: 'Rate limited',
        cause: new Error('Rate limit'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderRateLimitError);
      expect((caughtError as unknown as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
    });

    it('should map HTTP 401 to ProviderAuthError (retryable: false)', async () => {
      const mockError: AnthropicErrorResponse = {
        status: 401,
        message: 'Invalid API key',
        cause: new Error('Unauthorized'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderAuthError);
      expect((caughtError as OrchestratorError).retryable).toBe(false);
    });

    it('should map HTTP 503 to ProviderUnavailableError (retryable: true)', async () => {
      const mockError: AnthropicErrorResponse = {
        status: 503,
        message: 'Service unavailable',
        cause: new Error('Service down'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderUnavailableError);
      expect((caughtError as OrchestratorError).retryable).toBe(true);
    });

    it('should map HTTP 403 to ProviderAuthError', async () => {
      const mockError: AnthropicErrorResponse = {
        status: 403,
        message: 'Forbidden',
        cause: new Error('Forbidden'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderAuthError);
      expect((caughtError as OrchestratorError).retryable).toBe(false);
    });

    it('should map HTTP 408 to ProviderTimeoutError', async () => {
      const mockError: AnthropicErrorResponse = {
        status: 408,
        message: 'Request timeout',
        cause: new Error('Timeout'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderTimeoutError);
      expect((caughtError as OrchestratorError).retryable).toBe(true);
    });

    it('should map HTTP 500 to ProviderUnavailableError', async () => {
      const mockError: AnthropicErrorResponse = {
        status: 500,
        message: 'Internal error',
        cause: new Error('Server error'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderUnavailableError);
      expect((caughtError as OrchestratorError).retryable).toBe(true);
    });

    it('should map HTTP 502 to ProviderUnavailableError', async () => {
      const mockError: AnthropicErrorResponse = {
        status: 502,
        message: 'Bad gateway',
        cause: new Error('Bad gateway'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderUnavailableError);
      expect((caughtError as OrchestratorError).retryable).toBe(true);
    });

    it('should not re-wrap already-mapped OrchestratorError', async () => {
      const originalError = new ProviderMalformedResponse('Bad response');

      const mockCreateFn = vi.fn().mockRejectedValue(originalError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderMalformedResponse);
      expect(caughtError?.message).toBe('Bad response');
    });

    it('should map unknown errors to ProviderUnavailableError', async () => {
      const unknownError = new Error('Network disconnected');

      const mockCreateFn = vi.fn().mockRejectedValue(unknownError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderUnavailableError);
    });
  });

  describe('tool call ID fallback', () => {
    it('should use randomUUID when SDK does not provide id in content block', async () => {
      const mockMessage = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: '', name: 'get_weather', input: { location: 'NYC' } },
        ],
        model: 'claude-sonnet-4-5',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      };

      const mockCreateFn = vi.fn().mockResolvedValue(mockMessage);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Get weather' }],
      });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls?.[0]?.id).toBeTruthy();
      expect(typeof result.toolCalls?.[0]?.id).toBe('string');
    });

    it('should use randomUUID when tool_use block id is absent in streaming', async () => {
      const streamEvents = [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: '', name: 'get_weather', input: {} },
        },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Get weather' }],
      });

      for await (const chunk of result) {
        if (chunk.type === 'tool_call') {
          expect(chunk.toolCall.id).toBeTruthy();
          expect(typeof chunk.toolCall.id).toBe('string');
        }
      }
    });
  });
});
