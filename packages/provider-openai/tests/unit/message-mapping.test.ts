import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestableProvider } from '../mock-provider.js';
import type { Message } from '@atisse/core';
import type { ChatCompletion } from 'openai/resources/chat/completions';

describe('OpenAIProvider Unit Tests - Message Mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
});
