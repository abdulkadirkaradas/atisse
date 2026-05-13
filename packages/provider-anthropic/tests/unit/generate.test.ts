import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AnthropicMessageResponse,
  createTestableProvider,
} from '../mock-provider.js';
import { Message, ProviderMalformedResponse, ToolDefinition } from '@atisse/core';

describe('AnthropicProvider Unit Tests - generate()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
});
