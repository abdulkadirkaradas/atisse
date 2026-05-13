import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../../src/index.js';

describe('OpenAIProvider Unit Tests - Capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
