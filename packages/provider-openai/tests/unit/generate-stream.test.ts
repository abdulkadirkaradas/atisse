import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import { ProviderUnavailableError } from '@atisse/core';
import { createMockStream, createTestableProvider } from '../mock-provider.js';

describe('OpenAIProvider Unit Tests - generateStream()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
});
