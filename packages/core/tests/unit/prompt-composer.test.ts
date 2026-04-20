import { describe, it, expect, beforeEach } from 'vitest';
import { PromptComposer } from '../../src/prompt-composer.js';
import type { Message } from '../../src/interfaces.js';

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
  });
});
