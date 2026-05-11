import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Message, ToolDefinition, StreamChunk } from '@atisse/core';

import {
  ProviderRateLimitError,
  ProviderAuthError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderMalformedResponse,
  OrchestratorError,
} from '@atisse/core';

import { AnthropicProvider, type AnthropicProviderConfig } from '../../src/index.js';

// ── Mock Stream ────────────────────────────────────────────────

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicTextDelta {
  type: 'text_delta';
  text: string;
}
interface AnthropicInputJSONDelta {
  type: 'input_json_delta';
  partial_json: string;
}

type AnthropicStreamEvent =
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | {
      type: 'content_block_delta';
      index: number;
      delta: AnthropicTextDelta | AnthropicInputJSONDelta;
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: string; stop_sequence: string | null };
      usage?: { output_tokens: number };
    }
  | { type: 'message_stop' };

interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

function createMockStream(chunks: AnthropicStreamEvent[], error?: Error): AsyncIterable<unknown> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (error && index > 0) throw error;
          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }
          return { done: true, value: undefined } as const;
        },
      };
    },
  };
}

// ── Testable Provider Factory ──────────────────────────────────

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

  // ── Constructor ────────────────────────────────────────────

  describe('constructor', () => {
    it('should set id with default model', () => {
      const p = new AnthropicProvider({ apiKey: 'test-key' });
      expect(p.id).toBe('anthropic-claude-sonnet-4-5');
    });

    it('should set id with custom model', () => {
      const p = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-4' });
      expect(p.id).toBe('anthropic-claude-4');
    });

    it('should set correct capabilities', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      expect(provider.capabilities).toEqual({
        streaming: true,
        toolCalling: true,
        vision: true,
        maxContextTokens: 200_000,
      });
    });

    it('should store model from config', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-3-opus' });
      expect((provider as unknown as { model: string }).model).toBe('claude-3-opus');
    });
  });

  // ── Capabilities ───────────────────────────────────────────

  describe('capabilities', () => {
    it('should indicate streaming support', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.streaming).toBe(true);
    });

    it('should indicate tool calling support', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.toolCalling).toBe(true);
    });

    it('should indicate vision support', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.vision).toBe(true);
    });

    it('should set maxContextTokens to 200000', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.maxContextTokens).toBe(200_000);
    });
  });

  // ── generate() ─────────────────────────────────────────────

  describe('generate()', () => {
    it('should return correct PromptResponse shape with text', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello, world!' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result).toEqual({
        text: 'Hello, world!',
        usage: { prompt: 10, completion: 5, total: 15 },
        finishReason: 'stop',
      });
      expect(result.toolCalls).toBeUndefined();
    });

    it('should concatenate multiple text content blocks', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'world!' },
        ],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.text).toBe('Hello world!');
    });

    it('should extract system messages and pass separately', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await provider.generate({
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Hi' },
        ],
      });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.system).toBe('You are a helpful assistant.');
      expect(callArgs.messages).toHaveLength(1);
      const msgs = callArgs.messages as Array<{ role: string }>;
      expect(msgs[0]?.role).toBe('user');
    });

    it('should concatenate multiple system messages', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 20, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await provider.generate({
        messages: [
          { role: 'system', content: 'System A.' },
          { role: 'system', content: 'System B.' },
          { role: 'user', content: 'Hi' },
        ],
      });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.system).toBe('System A.\nSystem B.');
    });

    it('should map role:tool messages to role:user with tool_result blocks', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 30, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const messages: Message[] = [
        { role: 'user', content: 'Get weather' },
        {
          role: 'assistant',
          content: 'Checking...',
          toolCalls: [{ id: 'call_123', name: 'get_weather', input: { location: 'NYC' } }],
        },
        {
          role: 'tool',
          content: 'Sunny',
          toolCallId: 'call_123',
          name: 'get_weather',
        },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const toolMsg = callArgs.messages[2];
      expect(toolMsg?.role).toBe('user');
      expect(toolMsg?.content).toEqual([
        { type: 'tool_result', tool_use_id: 'call_123', content: 'Sunny' },
      ]);
    });

    it('should map role:tool with MessageContent including image', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Image processed' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 30, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const messages: Message[] = [
        { role: 'user', content: 'Process image' },
        {
          role: 'assistant',
          content: 'Let me process',
          toolCalls: [{ id: 'call_img', name: 'process_image', input: {} }],
        },
        {
          role: 'tool',
          content: [
            { type: 'text', text: 'Result: ' },
            { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' },
          ],
          toolCallId: 'call_img',
          name: 'process_image',
        },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const toolMsg = callArgs.messages[2];
      expect(toolMsg?.role).toBe('user');
      expect(toolMsg?.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: 'call_img',
          content: [
            { type: 'text', text: 'Result: ' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
            },
          ],
        },
      ]);
    });

    it('should map tool calls correctly in response', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_123',
            name: 'get_weather',
            input: { location: 'NYC' },
          },
        ],
        model: 'claude-sonnet-4-5',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 15, output_tokens: 25 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Get weather' }],
      });

      expect(result.text).toBe('');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls?.[0]).toEqual({
        id: 'tu_123',
        name: 'get_weather',
        input: { location: 'NYC' },
      });
      expect(result.finishReason).toBe('tool_calls');
    });

    it('should use randomUUID fallback when ToolCall.id is empty', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: '',
            name: 'get_weather',
            input: { location: 'NYC' },
          },
        ],
        model: 'claude-sonnet-4-5',
        stop_reason: 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 20 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Get weather' }],
      });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls?.[0]?.id).toBeTruthy();
      expect(typeof result.toolCalls?.[0]?.id).toBe('string');
      expect(result.toolCalls?.[0]?.id).not.toBe('');
    });

    it('should map stop_sequence finish_reason to stop', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'stop_sequence',
        stop_sequence: '\n\nHuman:',
        usage: { input_tokens: 10, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.finishReason).toBe('stop');
    });

    it('should map max_tokens finish_reason to length', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Partial' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'max_tokens',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 4096 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.finishReason).toBe('length');
    });

    it('should throw ProviderMalformedResponse for null stop_reason', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'response' }],
        model: 'claude-sonnet-4-5',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await expect(
        provider.generate({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      ).rejects.toThrow(ProviderMalformedResponse);
    });

    it('should throw ProviderMalformedResponse for unrecognized stop_reason', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hmm' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'unknown_reason',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await expect(
        provider.generate({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      ).rejects.toThrow(ProviderMalformedResponse);
    });

    it('should pass tools to Anthropic API', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const tools: ToolDefinition[] = [
        {
          name: 'get_weather',
          description: 'Get weather for a location',
          inputSchema: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name' },
            },
            required: ['location'],
          },
        },
      ];

      await provider.generate({
        messages: [{ role: 'user', content: 'Weather?' }],
        tools,
      });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as { tools: unknown[] };
      expect(callArgs.tools).toHaveLength(1);
      expect(callArgs.tools[0]).toEqual({
        name: 'get_weather',
        description: 'Get weather for a location',
        input_schema: {
          type: 'object',
          properties: {
            location: { type: 'string', description: 'City name' },
          },
          required: ['location'],
        },
      });
    });

    it('should forward AbortSignal in generate()', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
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

    it('should forward providerOptions', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        providerOptions: { top_p: 0.9, metadata: { user_id: 'abc' } },
      });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.top_p).toBe(0.9);
      expect((callArgs.metadata as Record<string, unknown>).user_id).toBe('abc');
    });

    it('should throw ProviderMalformedResponse when content array is missing', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as unknown as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await expect(
        provider.generate({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      ).rejects.toThrow(ProviderMalformedResponse);
    });
  });

  // ── generateStream() ───────────────────────────────────────

  describe('generateStream()', () => {
    it('should return Promise<AsyncIterable<StreamChunk>>', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result).toBeDefined();
      expect(typeof result[Symbol.asyncIterator]).toBe('function');
    });

    it('should yield text delta chunks', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' world' } },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const collected: string[] = [];
      for await (const chunk of result) {
        if (chunk.type === 'text') {
          collected.push(chunk.delta);
        }
      }

      expect(collected.join('')).toBe('Hello world');
    });

    it('should accumulate tool input deltas and emit single tool_call at content_block_stop', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_123', name: 'get_weather', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"location":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"NYC"}' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 15 },
        },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Get weather for NYC' }],
      });

      const toolCallChunks: Array<{
        type: string;
        toolCall: { id: string; name: string; input: unknown };
      }> = [];
      for await (const chunk of result) {
        if (chunk.type === 'tool_call') {
          toolCallChunks.push(
            chunk as { type: 'tool_call'; toolCall: { id: string; name: string; input: unknown } },
          );
        }
      }

      expect(toolCallChunks).toHaveLength(1);
      const toolCall = toolCallChunks[0]!.toolCall;
      expect(toolCall.id).toBe('tu_123');
      expect(toolCall.name).toBe('get_weather');
      expect(toolCall.input).toEqual({ location: 'NYC' });
    });

    it('should terminate with done chunk carrying usage', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      let doneChunk: StreamChunk | null = null;
      for await (const chunk of result) {
        if (chunk.type === 'done') {
          doneChunk = chunk;
        }
      }

      expect(doneChunk).not.toBeNull();
      expect(doneChunk!.type).toBe('done');
      if (doneChunk!.type === 'done') {
        expect(doneChunk?.usage).toBeDefined();
        expect(doneChunk?.usage?.total).toBe(2);
      }
    });

    it('should reject the Promise on connection error before first chunk (ADR-019)', async () => {
      const connectionError = new Error('Connection refused');
      const mockCreateFn = vi.fn().mockRejectedValue(connectionError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await expect(
        provider.generateStream({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      ).rejects.toThrow();
    });

    it('should yield error chunk when stream throws mid-stream', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
      ];

      const streamError = new Error('Stream interrupted');
      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents, streamError));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      let errorChunk: StreamChunk | null = null;
      for await (const chunk of result) {
        if (chunk.type === 'error') {
          errorChunk = chunk;
        }
      }

      expect(errorChunk).not.toBeNull();
      if (errorChunk && errorChunk.type === 'error') {
        expect(errorChunk.error).toBeInstanceOf(OrchestratorError);
      }
    });

    it('should yield done chunk even with no usage when message_stop has no usage', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      let doneChunk: StreamChunk | null = null;
      for await (const chunk of result) {
        if (chunk.type === 'done') {
          doneChunk = chunk;
        }
      }

      expect(doneChunk).not.toBeNull();
      expect(doneChunk!.type).toBe('done');
    });
  });

  // ── Error Mapping ──────────────────────────────────────────

  describe('mapError() - HTTP status mapping', () => {
    it('should map HTTP 429 to ProviderRateLimitError with retryAfterMs', async () => {
      const mockError = {
        status: 429,
        message: 'Rate limit exceeded',
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
      const mockError = {
        status: 429,
        message: 'Rate limit exceeded',
        cause: new Error('Rate limit'),
        headers: {},
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

    it('should map HTTP 401 to ProviderAuthError', async () => {
      const mockError = {
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
    });

    it('should map HTTP 403 to ProviderAuthError', async () => {
      const mockError = {
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
    });

    it('should map HTTP 408 to ProviderTimeoutError', async () => {
      const mockError = {
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
    });

    it('should map HTTP 500 to ProviderUnavailableError', async () => {
      const mockError = {
        status: 500,
        message: 'Internal server error',
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
    });

    it('should map HTTP 502 to ProviderUnavailableError', async () => {
      const mockError = {
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
    });

    it('should map HTTP 503 to ProviderUnavailableError', async () => {
      const mockError = {
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
    });

    it('should NOT re-wrap OrchestratorError — rethrow directly', async () => {
      const originalError = new ProviderMalformedResponse('Bad data');

      const mockCreateFn = vi.fn().mockRejectedValue(originalError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderMalformedResponse);
      expect(caughtError).toBe(originalError);
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

  // ── Message Mapping ────────────────────────────────────────

  describe('message mapping', () => {
    it('should include maxTokens and temperature in request', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 3 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 200,
        temperature: 0.5,
      });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.max_tokens).toBe(200);
      expect(callArgs.temperature).toBe(0.5);
    });

    it('should map MessageContent array for user messages', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
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

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as {
        messages: Array<{ content: string | Array<{ type: string; text: string }> }>;
      };
      const content = callArgs.messages[0]?.content;

      expect(Array.isArray(content)).toBe(true);
      const contentArray = content as Array<{ type: string; text: string }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0]?.type).toBe('text');
      expect(contentArray[0]?.text).toBe('Hello ');
      expect(contentArray[1]?.type).toBe('text');
      expect(contentArray[1]?.text).toBe('World');
    });

    it('should map image content to Anthropic vision format', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Image received' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 15, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', url: 'data:image/jpeg;base64,/9j/4AAQ==', mimeType: 'image/jpeg' },
          ],
        },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as {
        messages: Array<{
          content: Array<{
            type: string;
            text?: string;
            source?: { type: string; media_type: string; data: string };
          }>;
        }>;
      };
      const content = callArgs.messages[0]?.content;

      expect(Array.isArray(content)).toBe(true);
      const contentArray = content as Array<{
        type: string;
        text?: string;
        source?: { type: string; media_type: string; data: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0]?.type).toBe('text');
      expect(contentArray[0]?.text).toBe('What is in this image?');
      expect(contentArray[1]?.type).toBe('image');
      expect(contentArray[1]?.source?.media_type).toBe('image/jpeg');
      expect(contentArray[1]?.source?.data).toBe('/9j/4AAQ==');
    });

    it('should throw ProviderMalformedResponse for non-data-URI image URL', async () => {
      const mockResponse = {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Response' }],
        model: 'claude-sonnet-4-5',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      } as AnthropicMessageResponse;

      const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe' },
            { type: 'image', url: 'https://example.com/image.jpg', mimeType: 'image/jpeg' },
          ],
        },
      ];

      await expect(provider.generate({ messages })).rejects.toThrow(ProviderMalformedResponse);
    });

    it('should forward AbortSignal in generateStream()', async () => {
      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream([]));
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
});
