import { describe, it, expect, vi } from 'vitest';
import { ContextLoadError, ContextProviderError } from '@atisse/core';
import { RAGContextProvider, type VectorStore } from '../src/index.js';

function createMockVectorStore(overrides?: Partial<VectorStore>): VectorStore {
  return {
    id: 'test-store',
    search: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('RAGContextProvider', () => {
  describe('constructor', () => {
    it('sets id from vectorStore.id when no custom id given', () => {
      const store = createMockVectorStore({ id: 'my-vectors' });
      const provider = new RAGContextProvider({ vectorStore: store });
      expect(provider.id).toBe('rag-my-vectors');
    });

    it('uses custom id when provided', () => {
      const store = createMockVectorStore();
      const provider = new RAGContextProvider({ vectorStore: store, id: 'custom-rag' });
      expect(provider.id).toBe('custom-rag');
    });

    it('defaults topK to 5', async () => {
      const search = vi.fn().mockResolvedValue([{ content: 'doc' }]);
      const store = createMockVectorStore({ search });
      const provider = new RAGContextProvider({ vectorStore: store });

      await provider.provide({ prompt: 'test' });

      expect(search).toHaveBeenCalledWith('test', 5);
    });

    it('accepts custom topK', async () => {
      const search = vi.fn().mockResolvedValue([{ content: 'doc' }]);
      const store = createMockVectorStore({ search });
      const provider = new RAGContextProvider({ vectorStore: store, topK: 10 });

      await provider.provide({ prompt: 'test' });

      expect(search).toHaveBeenCalledWith('test', 10);
    });
  });

  describe('provide()', () => {
    it('returns SystemMessage[] with role: system', async () => {
      const store = createMockVectorStore({
        search: vi.fn().mockResolvedValue([
          { content: 'doc one' },
          { content: 'doc two' },
        ]),
      });
      const provider = new RAGContextProvider({ vectorStore: store });

      const result = await provider.provide({ prompt: 'test query' });

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ role: 'system', content: 'doc one' });
      expect(result[1]).toEqual({ role: 'system', content: 'doc two' });
    });

    it('returns [] when vectorStore.search() returns empty array', async () => {
      const store = createMockVectorStore({
        search: vi.fn().mockResolvedValue([]),
      });
      const provider = new RAGContextProvider({ vectorStore: store });

      const result = await provider.provide({ prompt: 'test query' });

      expect(result).toEqual([]);
    });

    it('input.prompt is NOT present in any output message content', async () => {
      const store = createMockVectorStore({
        search: vi.fn().mockResolvedValue([
          { content: 'retrieved knowledge' },
        ]),
      });
      const provider = new RAGContextProvider({ vectorStore: store });

      const result = await provider.provide({ prompt: 'sensitive user input' });

      for (const msg of result) {
        expect(msg.content).not.toContain('sensitive user input');
      }
    });

    it('vectorStore.search() called with input.prompt and configured topK', async () => {
      const search = vi.fn().mockResolvedValue([
        { content: 'result' },
      ]);
      const store = createMockVectorStore({ search });
      const provider = new RAGContextProvider({ vectorStore: store, topK: 3 });

      await provider.provide({ prompt: 'my query' });

      expect(search).toHaveBeenCalledWith('my query', 3);
    });

    it('vectorStore.search() throws (connectivity) → ContextLoadError', async () => {
      const store = createMockVectorStore({
        search: vi.fn().mockRejectedValue(new Error('Connection refused')),
      });
      const provider = new RAGContextProvider({ vectorStore: store });

      await expect(provider.provide({ prompt: 'test' })).rejects.toThrow(ContextLoadError);
    });

    it('ContextLoadError is retryable', async () => {
      const store = createMockVectorStore({
        search: vi.fn().mockRejectedValue(new Error('timeout')),
      });
      const provider = new RAGContextProvider({ vectorStore: store });

      try {
        await provider.provide({ prompt: 'test' });
        expect.unreachable('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ContextLoadError);
        expect((error as ContextLoadError).retryable).toBe(true);
      }
    });

    it('VectorStore.search() returns malformed shape → ContextProviderError', async () => {
      const store = createMockVectorStore({
        search: vi.fn().mockResolvedValue([{ noContent: true }]),
      });
      const provider = new RAGContextProvider({ vectorStore: store });

      await expect(provider.provide({ prompt: 'test' })).rejects.toThrow(ContextProviderError);
    });

    it('ContextProviderError is retryable', async () => {
      const store = createMockVectorStore({
        search: vi.fn().mockResolvedValue([{ noContent: true }]),
      });
      const provider = new RAGContextProvider({ vectorStore: store });

      try {
        await provider.provide({ prompt: 'test' });
        expect.unreachable('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ContextProviderError);
        expect((error as ContextProviderError).retryable).toBe(true);
      }
    });

    it('returns non-array from search (null) → ContextProviderError is retryable', async () => {
      const store = createMockVectorStore({
        search: vi.fn().mockResolvedValue(null),
      });
      const provider = new RAGContextProvider({ vectorStore: store });

      try {
        await provider.provide({ prompt: 'test' });
        expect.unreachable('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ContextProviderError);
        expect((error as ContextProviderError).retryable).toBe(true);
      }
    });

    it('returns non-array from search (undefined) → ContextProviderError is retryable', async () => {
      const store = createMockVectorStore({
        search: vi.fn().mockResolvedValue(undefined),
      });
      const provider = new RAGContextProvider({ vectorStore: store });

      try {
        await provider.provide({ prompt: 'test' });
        expect.unreachable('should have thrown');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(ContextProviderError);
        expect((error as ContextProviderError).retryable).toBe(true);
      }
    });

    it('output messages have role: system (type-level check)', async () => {
      const store = createMockVectorStore({
        search: vi.fn().mockResolvedValue([
          { content: 'knowledge', metadata: { source: 'wiki' } },
        ]),
      });
      const provider = new RAGContextProvider({ vectorStore: store });

      const result = await provider.provide({ prompt: 'test' });

      for (const msg of result) {
        expect(msg.role).toBe('system');
      }
    });
  });
});
