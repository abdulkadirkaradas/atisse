import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import { createTestableProvider } from '../mock-provider.js';

describe('OpenAIProvider Unit Tests - Tool Call ID Fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
});
