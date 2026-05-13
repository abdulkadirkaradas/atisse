import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../../src/index.js';

describe('OpenAIProvider Unit Tests - Constructor(these work with real OpenAI client)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
});
