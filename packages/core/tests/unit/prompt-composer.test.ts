import { describe, it, expect, beforeEach } from 'vitest';
import { PromptComposer } from '../../src/prompt-composer.js';
import type { Message, MessageContent } from '../../src/interfaces.js';

describe('PromptComposer', () => {
  let composer: PromptComposer;

  beforeEach(() => {
    composer = new PromptComposer();
  });

  describe('compose()', () => {
    it('assembles messages in correct order', () => {
      const result = composer.compose({
        systemPrompt: 'system',
        contextMessages: [{ role: 'system', content: 'context' }],
        memoryMessages: [{ role: 'user', content: 'memory user' }],
        userPrompt: 'user prompt',
      });

      expect(result).toHaveLength(4);
      expect(result[0]!.role).toBe('system');
      expect(result[0]!.content).toBe('system');
      expect(result[1]!.role).toBe('system');
      expect(result[1]!.content).toBe('context');
      expect(result[2]!.role).toBe('user');
      expect(result[3]!.role).toBe('user');
      expect(result[3]!.content).toBe('user prompt');
    });

    it('omits system message when systemPrompt is empty', () => {
      const result = composer.compose({
        systemPrompt: '',
        contextMessages: [],
        memoryMessages: [],
        userPrompt: 'user',
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.role).toBe('user');
    });

    it('omits system message when systemPrompt is undefined', () => {
      const result = composer.compose({
        systemPrompt: undefined as unknown as string,
        contextMessages: [],
        memoryMessages: [],
        userPrompt: 'user',
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.role).toBe('user');
    });

    it('userPrompt always has role: user (never system)', () => {
      const result = composer.compose({
        systemPrompt: 'system',
        contextMessages: [],
        memoryMessages: [],
        userPrompt: 'malicious input',
      });

      const userMessage = result.find((m) => m.content === 'malicious input');
      expect(userMessage?.role).toBe('user');
    });

    it('context messages never trimmed', () => {
      const longContext: Array<{ role: 'system'; content: string }> = Array(100)
        .fill(null)
        .map((_, i) => ({
          role: 'system' as const,
          content: `context ${i}`,
        }));

      const result = composer.compose({
        systemPrompt: 'system',
        contextMessages: longContext,
        memoryMessages: [],
        userPrompt: 'user',
        maxTokens: 10,
      });

      expect(result.filter((m) => m.role === 'system')).toHaveLength(101);
    });

    it('memory messages are trimmed when maxTokens set', () => {
      const memoryMessages: Message[] = Array(10)
        .fill(null)
        .map((_, i) => ({
          role: 'user' as const,
          content: `memory message ${i}`.repeat(50),
        }));

      const result = composer.compose({
        systemPrompt: undefined as unknown as string,
        contextMessages: [],
        memoryMessages,
        userPrompt: 'user',
        maxTokens: 100,
      });

      expect(result.length).toBeLessThan(10);
    });

    it('trimming drops oldest memory messages first', () => {
      const memoryMessages: Message[] = [
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'second message' },
      ];

      const result = composer.compose({
        systemPrompt: undefined as unknown as string,
        contextMessages: [],
        memoryMessages,
        userPrompt: 'user',
        maxTokens: 5,
      });

      expect(result.some((m) => m.content === 'first message')).toBe(false);
      expect(result.some((m) => m.content === 'second message')).toBe(true);
    });

    it('handles empty arrays', () => {
      const result = composer.compose({
        systemPrompt: undefined as unknown as string,
        contextMessages: [],
        memoryMessages: [],
        userPrompt: 'user',
      });

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ role: 'user', content: 'user' });
    });

    it('estimates tokens for MessageContent[] text-only arrays', () => {
      const textContent: MessageContent[] = [
        { type: 'text', text: 'hello world' },
        { type: 'text', text: 'foo bar baz' },
      ];

      const result = composer.compose({
        systemPrompt: undefined as unknown as string,
        contextMessages: [],
        memoryMessages: [
          { role: 'user', content: textContent },
        ],
        userPrompt: 'user',
        maxTokens: 5,
      });

      // text length = 11 + 11 = 22, Math.ceil(22/4) = 6 tokens
      // 6 > 5, so the memory message should be trimmed
      expect(result).toHaveLength(1);
      expect(result[0]!.content).toBe('user');
    });

    it('estimates tokens for MessageContent[] mixed text and image items', () => {
      const mixedContent: MessageContent[] = [
        { type: 'text', text: 'a'.repeat(20) },
        { type: 'image', url: 'https://example.com/img.jpg', mimeType: 'image/jpeg' },
      ];

      const result = composer.compose({
        systemPrompt: undefined as unknown as string,
        contextMessages: [],
        memoryMessages: [
          { role: 'user', content: mixedContent },
        ],
        userPrompt: 'user',
        maxTokens: 5,
      });

      // text length = 20, Math.ceil(20/4) = 5 tokens
      // images contribute nothing to text token estimate
      // 5 <= 5, so memory message should be kept
      expect(result).toHaveLength(2);
      expect(result[0]!.role).toBe('user');
    });

    it('includes systemPrompt with whitespace as valid content', () => {
      const result = composer.compose({
        systemPrompt: ' ',
        contextMessages: [],
        memoryMessages: [],
        userPrompt: 'user',
      });

      // Whitespace is not empty string — current behavior keeps it
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: 'system', content: ' ' });
      expect(result[1]).toEqual({ role: 'user', content: 'user' });
    });

    it('handles empty memory with maxTokens set', () => {
      const result = composer.compose({
        systemPrompt: 'system',
        contextMessages: [{ role: 'system', content: 'context' }],
        memoryMessages: [],
        userPrompt: 'user',
        maxTokens: 100,
      });

      // Empty memory with maxTokens should not crash — produces system + context + user
      expect(result).toHaveLength(3);
      expect(result[0]!.role).toBe('system');
      expect(result[0]!.content).toBe('system');
      expect(result[1]!.role).toBe('system');
      expect(result[1]!.content).toBe('context');
      expect(result[2]!.role).toBe('user');
      expect(result[2]!.content).toBe('user');
    });

    it('preserves all memory messages when totalTokens equals maxTokens', () => {
      // Each message has text length 20 → Math.ceil(20/4) = 5 tokens
      // Two messages = 10 tokens total
      const memoryMessages: Message[] = [
        { role: 'user', content: 'a'.repeat(20) },
        { role: 'assistant', content: 'b'.repeat(20) },
      ];

      const result = composer.compose({
        systemPrompt: undefined as unknown as string,
        contextMessages: [],
        memoryMessages,
        userPrompt: 'user',
        maxTokens: 10, // exact boundary — totalTokens === maxTokens
      });

      // No trimming at exact boundary (<= check)
      expect(result).toHaveLength(3);
      expect(result[0]!.content).toBe('a'.repeat(20));
      expect(result[1]!.content).toBe('b'.repeat(20));
      expect(result[2]!.content).toBe('user');
    });

    it('drops all memory messages when maxTokens is 0', () => {
      const memoryMessages: Message[] = [
        { role: 'user', content: 'message 1' },
        { role: 'assistant', content: 'message 2' },
      ];

      const result = composer.compose({
        systemPrompt: 'system',
        contextMessages: [],
        memoryMessages,
        userPrompt: 'user',
        maxTokens: 0,
      });

      // Zero budget should drop all memory messages
      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: 'system', content: 'system' });
      expect(result[1]).toEqual({ role: 'user', content: 'user' });
    });

    it('drops single oversized memory message when it exceeds maxTokens', () => {
      const memoryMessages: Message[] = [
        { role: 'user', content: 'a'.repeat(100) }, // Math.ceil(100/4) = 25 tokens
      ];

      const result = composer.compose({
        systemPrompt: undefined as unknown as string,
        contextMessages: [],
        memoryMessages,
        userPrompt: 'user',
        maxTokens: 10, // 25 > 10 — single message exceeds budget
      });

      // Single oversized message gets fully dropped
      expect(result).toHaveLength(1);
      expect(result[0]!.role).toBe('user');
      expect(result[0]!.content).toBe('user');
    });
  });
});
