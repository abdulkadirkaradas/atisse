import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextLoadError, ContextProviderError } from '@atisse/core';
import type { ContextProviderInput, SystemMessage } from '@atisse/core';

import { RAGContextProvider, type VectorStore, type VectorDocument } from '../src/index.js';

function createMockStore(docs: VectorDocument[] | Error): VectorStore {
  return {
    id: 'test-store',
    search: vi.fn().mockImplementation(async (_query: string, _topK?: number) => {
      if (docs instanceof Error) throw docs;
      return docs;
    }),
  };
}

describe('RAGContextProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Constructor ────────────────────────────────────────────

  describe('constructor', () => {
    it('should set id from vectorStore.id by default', () => {
      const store = createMockStore([]);
      const provider = new RAGContextProvider({ vectorStore: store });
      expect(provider.id).toBe('rag-test-store');
    });

    it('should use custom id when provided', () => {
      const store = createMockStore([]);
      const provider = new RAGContextProvider({ vectorStore: store, id: 'my-rag' });
      expect(provider.id).toBe('my-rag');
    });

    it('should use default topK of 5', () => {
      const store = createMockStore([]);
      const provider = new RAGContextProvider({ vectorStore: store });
      expect((provider as unknown as { topK: number }).topK).toBe(5);
    });

    it('should use custom topK when provided', () => {
      const store = createMockStore([]);
      const provider = new RAGContextProvider({ vectorStore: store, topK: 10 });
      expect((provider as unknown as { topK: number }).topK).toBe(10);
    });
  });

  // ── provide() ──────────────────────────────────────────────

  describe('provide()', () => {
    it('should return SystemMessage[] with role:system', async () => {
      const docs: VectorDocument[] = [
        { content: 'Context about AI.' },
        { content: 'More details.' },
      ];
      const store = createMockStore(docs);
      const provider = new RAGContextProvider({ vectorStore: store });

      const result = await provider.provide({ prompt: 'Tell me about AI' });

      expect(result).toHaveLength(2);
      expect(result[0]?.role).toBe('system');
      expect(result[0]?.content).toBe('Context about AI.');
      expect(result[1]?.role).toBe('system');
      expect(result[1]?.content).toBe('More details.');
    });

    it('should return empty array when search returns empty', async () => {
      const store = createMockStore([]);
      const provider = new RAGContextProvider({ vectorStore: store });

      const result = await provider.provide({ prompt: 'Unknown topic' });

      expect(result).toEqual([]);
    });

    it('should call search with input.prompt and configured topK', async () => {
      const docs: VectorDocument[] = [{ content: 'Result' }];
      const store = createMockStore(docs);
      const provider = new RAGContextProvider({ vectorStore: store, topK: 3 });

      await provider.provide({ prompt: 'Search query' });

      expect(store.search).toHaveBeenCalledWith('Search query', 3);
    });

    it('should NOT include input.prompt in any output message (S-2, S-6)', async () => {
      const docs: VectorDocument[] = [{ content: 'Some context.' }];
      const store = createMockStore(docs);
      const provider = new RAGContextProvider({ vectorStore: store });

      const input: ContextProviderInput = { prompt: 'sensitive user data' };
      const result = await provider.provide(input);

      // Security assertion: prompt should never appear in output
      for (const msg of result) {
        expect(msg.content).not.toContain('sensitive user data');
      }
    });

    it('should throw ContextLoadError when vectorStore.search() throws (infra failure)', async () => {
      const infraError = new Error('Connection refused to vector DB');
      const store = createMockStore(infraError);
      const provider = new RAGContextProvider({ vectorStore: store });

      await expect(provider.provide({ prompt: 'test' })).rejects.toThrow(ContextLoadError);
    });

    it('should throw ContextProviderError when search returns non-array', async () => {
      const store: VectorStore = {
        id: 'bad-store',
        search: vi.fn().mockResolvedValue(null),
      };
      const provider = new RAGContextProvider({ vectorStore: store });

      await expect(provider.provide({ prompt: 'test' })).rejects.toThrow(ContextProviderError);
    });

    it('should throw ContextProviderError when doc is missing content field', async () => {
      const store: VectorStore = {
        id: 'bad-store',
        search: vi.fn().mockResolvedValue([{ metadata: { key: 'val' } }]),
      };
      const provider = new RAGContextProvider({ vectorStore: store });

      await expect(provider.provide({ prompt: 'test' })).rejects.toThrow(ContextProviderError);
    });

    it('should return compile-time SystemMessage[] type', async () => {
      const docs: VectorDocument[] = [{ content: 'Test' }];
      const store = createMockStore(docs);
      const provider = new RAGContextProvider({ vectorStore: store });

      const result: SystemMessage[] = await provider.provide({ prompt: 'test' });

      expect(result[0]?.role).toBe('system');
    });
  });
});
