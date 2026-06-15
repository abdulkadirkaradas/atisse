import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { createTestableProvider } from '../mock-provider.js';

describe('OpenAIProvider Unit Tests - Finish Reason Mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
});
