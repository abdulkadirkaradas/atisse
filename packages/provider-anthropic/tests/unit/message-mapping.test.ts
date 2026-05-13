import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AnthropicMessageResponse,
  createMockStream,
  createTestableProvider,
} from '../mock-provider.js';
import { type Message, ProviderMalformedResponse } from '@atisse/core';

describe('AnthropicProvider Unit Tests - Message Mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
