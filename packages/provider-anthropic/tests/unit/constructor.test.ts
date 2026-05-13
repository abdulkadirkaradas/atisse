import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../../src/index.js';

describe('AnthropicProvider Unit Tests - Constructor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should set id with default model', () => {
      const p = new AnthropicProvider({ apiKey: 'test-key' });
      expect(p.id).toBe('anthropic-claude-sonnet-4-5');
    });

    it('should set id with custom model', () => {
      const p = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-4' });
      expect(p.id).toBe('anthropic-claude-4');
    });

    it('should set correct capabilities', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      expect(provider.capabilities).toEqual({
        streaming: true,
        toolCalling: true,
        vision: true,
        maxContextTokens: 200_000,
      });
    });

    it('should store model from config', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key', model: 'claude-3-opus' });
      expect((provider as unknown as { model: string }).model).toBe('claude-3-opus');
    });
  });
});
