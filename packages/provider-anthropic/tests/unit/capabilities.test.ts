import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../../src/index.js';

describe('AnthropicProvider Unit Tests - Capabilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('capabilities', () => {
    it('should indicate streaming support', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.streaming).toBe(true);
    });

    it('should indicate tool calling support', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.toolCalling).toBe(true);
    });

    it('should indicate vision support', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.vision).toBe(true);
    });

    it('should set maxContextTokens to 200000', () => {
      const provider = new AnthropicProvider({ apiKey: 'test-key' });
      expect(provider.capabilities.maxContextTokens).toBe(200_000);
    });
  });
});
