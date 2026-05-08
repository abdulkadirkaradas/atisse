import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { Stream } from 'openai/core/streaming';

import type { Message, ToolDefinition } from '@atisse/core';

import {
  ProviderRateLimitError,
  ProviderAuthError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderMalformedResponse,
  Orchestrator,
  MaxRetriesExceededError,
} from '@atisse/core';

import { OpenAIProvider, type OpenAIProviderConfig } from '../src/index.js';

// Helper to create mock stream
function createMockStream(
  chunks: ChatCompletionChunk[],
  error?: Error,
): Stream<ChatCompletionChunk> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (error && index > 0) {
            throw error;
          }
          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }
          return { done: true, value: undefined };
        },
      };
    },
  } as unknown as Stream<ChatCompletionChunk>;
}

// Testable provider factory - creates provider and injects mock client
function createTestableProvider(
  config: OpenAIProviderConfig,
  mockCreateFn: ReturnType<typeof vi.fn>,
): OpenAIProvider {
  // Create real provider
  const provider = new OpenAIProvider(config);
  // Replace internal client with mock
  const mockClient = {
    chat: {
      completions: {
        create: mockCreateFn,
      },
    },
  };
  // Use Object.defineProperty to bypass readonly
  Object.defineProperty(provider, 'client', {
    value: mockClient,
    writable: true,
    configurable: true,
  });
  return provider;
}

describe('OpenAIProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─────────────────────────────────────────────────────────────
  // Constructor Tests (these work with real OpenAI client)
  // ─────────────────────────────────────────────────────────────

  describe('constructor', () => {
    it('should set id with default model', () => {
      const p = new OpenAIProvider({ apiKey: 'test-key' });
      expect(p.id).toBe('openai-gpt-4o');
    });

    it('should set id with custom model', () => {
      const p = new OpenAIProvider({ apiKey: 'test-key', model: 'gpt-4' });
      expect(p.id).toBe('openai-gpt-4');
    });

    it('should set id with gpt-4o-mini model', () => {
      const p = new OpenAIProvider({ apiKey: 'test-key', model: 'gpt-4o-mini' });
      expect(p.id).toBe('openai-gpt-4o-mini');
    });

    it('should set correct capabilities', () => {
      const provider = new OpenAIProvider({ apiKey: 'test-key' });
      expect(provider.capabilities).toEqual({
        streaming: true,
        toolCalling: true,
        vision: true,
        maxContextTokens: 128_000,
      });
    });

    it('should store model from config', () => {
      const provider = new OpenAIProvider({ apiKey: 'test-key', model: 'gpt-4o-mini' });
      expect((provider as unknown as { model: string }).model).toBe('gpt-4o-mini');
    });
  });

  describe('capabilities', () => {
    it('should indicate streaming support', () => {
      const provider = new OpenAIProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.streaming).toBe(true);
    });

    it('should indicate tool calling support', () => {
      const provider = new OpenAIProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.toolCalling).toBe(true);
    });

    it('should indicate vision support', () => {
      const provider = new OpenAIProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.vision).toBe(true);
    });

    it('should set maxContextTokens to 128000', () => {
      const provider = new OpenAIProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.maxContextTokens).toBe(128_000);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // generate() Method Tests
  // ─────────────────────────────────────────────────────────────

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

  // ─────────────────────────────────────────────────────────────
  // generateStream() Method Tests
  // ─────────────────────────────────────────────────────────────

  describe('generateStream()', () => {
    it('should return AsyncIterable with text delta chunks', async () => {
      const chunks: ChatCompletionChunk[] = [
        {
          id: 'chatcmpl-123',
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: undefined }],
          model: 'gpt-4o',
          usage: undefined,
        },
        {
          id: 'chatcmpl-123',
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: undefined }],
          model: 'gpt-4o',
          usage: undefined,
        },
        {
          id: 'chatcmpl-123',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        },
      ] as ChatCompletionChunk[];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(chunks));
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

    it('should return done chunk with usage at end', async () => {
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

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      let lastChunk: {
        type: string;
        usage?: { prompt: number; completion: number; total: number };
      } | null = null;
      for await (const chunk of result) {
        if (chunk.type === 'done') {
          lastChunk = chunk;
        }
      }

      expect(lastChunk).not.toBeNull();
      expect(lastChunk?.usage?.total).toBe(12);
    });

    it('should yield error chunk when stream throws', async () => {
      const chunks: ChatCompletionChunk[] = [
        {
          id: 'chatcmpl-123',
          choices: [{ index: 0, delta: { content: 'Partial' }, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: undefined,
        },
      ] as unknown as ChatCompletionChunk[];

      const streamError = new Error('Stream failed');

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(chunks, streamError));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      let errorReceived = false;
      for await (const chunk of result) {
        if (chunk.type === 'error') {
          errorReceived = true;
          expect(chunk.error).toBeInstanceOf(ProviderUnavailableError);
        }
      }

      expect(errorReceived).toBe(true);
    });

    it('should accumulate tool call argument deltas across multiple chunks and emit single complete tool_call', async () => {
      // Multiple chunks with partial tool call arguments
      const chunks: ChatCompletionChunk[] = [
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc123',
                    type: 'function',
                    function: { name: 'get_weather', arguments: '{"location":' },
                  },
                ],
              },
              finish_reason: undefined,
            },
          ],
          model: 'gpt-4o',
          usage: undefined,
        },
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_abc123',
                    function: { arguments: '"New York"}' },
                  },
                ],
              },
              finish_reason: undefined,
            },
          ],
          model: 'gpt-4o',
          usage: undefined,
        },
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'tool_calls',
            },
          ],
          model: 'gpt-4o',
          usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 },
        },
      ] as unknown as ChatCompletionChunk[];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(chunks));
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

      // Verify only ONE complete tool_call chunk is yielded
      expect(toolCallChunks).toHaveLength(1);

      // Verify the accumulated tool call has complete arguments
      const toolCall = toolCallChunks[0]!.toolCall;
      expect(toolCall.id).toBe('call_abc123');
      expect(toolCall.name).toBe('get_weather');
      expect(toolCall.input).toEqual({ location: 'New York' });
    });
  });

  // ─────────────────────────────────────────────────────────────
  // mapError() HTTP Status Mapping Tests
  // ─────────────────────────────────────────────────────────────

  describe('mapError() - HTTP status mapping', () => {
    it('should map HTTP 429 to ProviderRateLimitError', async () => {
      const mockError = {
        status: 429,
        message: 'Rate limit exceeded',
        cause: new Error('Rate limit'),
        response: {
          headers: {
            get: (key: string) => (key === 'Retry-After' ? '30' : null),
          },
        },
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
        response: {
          headers: {
            get: () => null,
          },
        },
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

    it('should re-throw OrchestratorError subclasses', async () => {
      const originalError = new ProviderMalformedResponse('No choice');

      const mockCreateFn = vi.fn().mockRejectedValue(originalError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderMalformedResponse);
    });

    it('should map unknown errors to ProviderUnavailableError', async () => {
      const unknownError = new Error('Network error');

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

  // ─────────────────────────────────────────────────────────────
  // Tool Call ID Fallback
  // ────────────���─���──────────────────────────────────────────────

  describe('tool call ID fallback', () => {
    it('should use randomUUID when SDK does not provide id', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: '', // empty ID - should trigger randomUUID fallback per interfaces-core.md Rule 9
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
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Get weather' }],
      });

      expect(result.toolCalls).toHaveLength(1);
      // Per interfaces-core.md Rule 9: adapter MUST generate randomUUID if provider omits ID
      expect(result.toolCalls?.[0]?.id).toBeTruthy();
      expect(typeof result.toolCalls?.[0]?.id).toBe('string');
      expect(result.toolCalls?.[0]?.id).not.toBe('');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // finishReason Mapping Tests
  // ─────────────────────────────────────────────────────────────

  describe('finishReason mapping', () => {
    it('should map stop to stop', async () => {
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
      });

      expect(result.finishReason).toBe('stop');
    });

    it('should map tool_calls to tool_calls', async () => {
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
                  function: { name: 'get_weather', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.finishReason).toBe('tool_calls');
    });

    it('should map length to length', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Partial' },
            finish_reason: 'length',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 4096, total_tokens: 4101 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generate({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result.finishReason).toBe('length');
    });

    it('should default to stop for unknown finishReason', async () => {
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
      });

      expect(result.finishReason).toBe('stop');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Message Mapping Tests
  // ─────────────────────────────────────────────────────────────

  describe('message mapping', () => {
    it('should map system message to OpenAI format', async () => {
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

      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(callArgs.messages[0]?.role).toBe('system');
      expect(callArgs.messages[0]?.content).toBe('You are helpful.');
      expect(callArgs.messages[1]?.role).toBe('user');
      expect(callArgs.messages[1]?.content).toBe('Hello');
    });

    it('should map assistant message with tool_calls', async () => {
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

      const messages: Message[] = [
        { role: 'user', content: 'Get weather' },
        {
          role: 'assistant',
          content: 'I will check the weather.',
          toolCalls: [{ id: 'call_123', name: 'get_weather', input: { location: 'NYC' } }],
        },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as {
        messages: Array<{
          role: string;
          tool_calls?: Array<{
            id: string;
            type: string;
            function: { name: string; arguments: string };
          }>;
        }>;
      };
      const assistantMsg = callArgs.messages[1];
      expect(assistantMsg?.role).toBe('assistant');
      expect(assistantMsg?.tool_calls).toHaveLength(1);
      expect(assistantMsg?.tool_calls?.[0]?.id).toBe('call_123');
      expect(assistantMsg?.tool_calls?.[0]?.function.name).toBe('get_weather');
    });

    it('should map tool message correctly', async () => {
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

      const messages: Message[] = [
        { role: 'user', content: 'Get weather' },
        {
          role: 'tool',
          content: 'The weather is sunny.',
          toolCallId: 'call_123',
          name: 'get_weather',
        },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as {
        messages: Array<{ role: string; tool_call_id?: string; content?: unknown }>;
      };
      const toolMsg = callArgs.messages[1];
      expect(toolMsg?.role).toBe('tool');
      expect(toolMsg?.tool_call_id).toBe('call_123');
      expect(toolMsg?.content).toBe('The weather is sunny.');
    });

    it('should handle MessageContent array', async () => {
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
        messages: Array<{ content: string | Array<{ type: string; text?: string }> }>;
      };
      const content = callArgs?.messages[0]?.content;

      // Content should now be an array of text parts
      expect(Array.isArray(content)).toBe(true);
      const contentArray = content as Array<{ type: string; text?: string }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0]?.type).toBe('text');
      expect(contentArray[0]?.text).toBe('Hello ');
      expect(contentArray[1]?.type).toBe('text');
      expect(contentArray[1]?.text).toBe('World');
    });

    it('should map MessageContent with image to OpenAI vision format', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Image received' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', url: 'https://example.com/image.jpg', mimeType: 'image/jpeg' },
          ],
        },
      ];

      await provider.generate({ messages });

      const callArgs = mockCreateFn.mock.calls[0]?.[0] as {
        messages: Array<{
          content:
            | string
            | Array<{ type: string; text?: string; image_url?: { url: string; detail: string } }>;
        }>;
      };
      const content = callArgs?.messages[0]?.content;

      // Content should be an array with text and image_url parts
      expect(Array.isArray(content)).toBe(true);
      const contentArray = content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string; detail: string };
      }>;
      expect(contentArray).toHaveLength(2);

      // First part should be text
      expect(contentArray[0]?.type).toBe('text');
      expect(contentArray[0]?.text).toBe('What is in this image?');

      // Second part should be image_url
      expect(contentArray[1]?.type).toBe('image_url');
      expect(contentArray[1]?.image_url?.url).toBe('https://example.com/image.jpg');
      expect(contentArray[1]?.image_url?.detail).toBe('auto');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Integration with Orchestrator (mocked HTTP)
  // ─────────────────────────────────────────────────────────────

  describe('integration with Orchestrator', () => {
    it('should run end-to-end with mocked OpenAI SDK', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Hello from OpenAI!' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const orchestrator = new Orchestrator({
        provider,
        timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
      });

      const result = await orchestrator.run({ prompt: 'Hi' });

      expect(result.text).toBe('Hello from OpenAI!');
      expect(result.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
      expect(result.runId).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should propagate provider errors as MaxRetriesExceededError through Orchestrator', async () => {
      const mockError = {
        status: 429,
        message: 'Rate limit exceeded',
        cause: new Error('Rate limit'),
        response: {
          headers: {
            get: () => null,
          },
        },
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const orchestrator = new Orchestrator({
        provider,
        retry: { maxAttempts: 1, baseDelayMs: 0, jitter: false },
        timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
      });

      // Orchestrator retry wraps the final error in MaxRetriesExceededError
      await expect(orchestrator.run({ prompt: 'Hi' })).rejects.toThrow(MaxRetriesExceededError);
    });
  });
});
