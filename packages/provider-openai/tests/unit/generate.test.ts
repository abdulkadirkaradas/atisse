import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockStream, createTestableProvider } from '../mock-provider.js';
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { ToolDefinition } from '@atisse/core';

describe('OpenAIProvider Unit Tests - generate()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generate()', () => {
    it('should return correct PromptResponse shape with text', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Hello, world!' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result).toEqual({
        text: 'Hello, world!',
        toolCalls: [],
        usage: { prompt: 10, completion: 5, total: 15 },
        finishReason: 'stop',
      });
    });

    it('should return correct PromptResponse shape with tool calls', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location":"NYC"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
            index: 0,
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 20,
          total_tokens: 30,
        },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Get weather' }],
      });

      expect(result.text).toBe('');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls?.[0]).toEqual({
        id: 'call_123',
        name: 'get_weather',
        input: { location: 'NYC' },
      });
      expect(result.finishReason).toBe('tool_calls');
      expect(result.usage.total).toBe(30);
    });

    it('should handle empty tool calls array', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        tools: [],
      });

      expect(result.text).toBe('Response');
    });

    it('should include maxTokens and temperature in request', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 100,
        temperature: 0.7,
      });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(callArgs.max_tokens).toBe(100);
      expect(callArgs.temperature).toBe(0.7);
    });

    it('should pass tools to OpenAI API', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Done' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
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
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a location',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string', description: 'City name' },
            },
            required: ['location'],
          },
        },
      });
    });

    it('should forward AbortSignal to OpenAI SDK in generate()', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const controller = new AbortController();
      const signal = controller.signal;

      await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        signal,
      });

      // The signal is passed as the second argument to create()
      const secondArg = mockCreateFn.mock.calls[0]?.[1] as { signal: AbortSignal } | undefined;
      expect(secondArg).toBeDefined();
      expect(secondArg?.signal).toBe(signal);
    });

    it('should forward providerOptions to OpenAI SDK in generate()', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
        providerOptions: { top_p: 0.9, seed: 12345 },
      });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as { top_p: number; seed: number };
      expect(callArgs.top_p).toBe(0.9);
      expect(callArgs.seed).toBe(12345);
    });

    it('should forward AbortSignal to OpenAI SDK in generateStream()', async () => {
      const chunks: ChatCompletionChunk[] = [
        {
          id: 'chatcmpl-123',
          choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        },
      ] as ChatCompletionChunk[];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(chunks));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const controller = new AbortController();
      const signal = controller.signal;

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
        signal,
      });

      // Consume stream to ensure the call was made
      for await (const _chunk of result) {
        void _chunk;
      }

      // The signal is passed as the second argument to create()
      const secondArg = mockCreateFn.mock.calls[0]?.[1] as { signal: AbortSignal } | undefined;
      expect(secondArg).toBeDefined();
      expect(secondArg?.signal).toBe(signal);
    });
  });
});
