import {
    beforeEach,
    describe,
    expect,
    it,
    vi
    } from 'vitest';
import { ContextLoadError, ContextProviderError, Orchestrator } from '@atisse/core';
import { MockProvider } from '@atisse/core/testing';
import type { ContextProviderInput } from '@atisse/core';

import { RAGContextProvider, type VectorStore, type VectorDocument } from '@atisse/context-rag';

function createMockStore(
  docs: VectorDocument[] | Error,
): VectorStore & { search: ReturnType<typeof vi.fn> } {
  return {
    id: 'test-store',
    search: vi.fn().mockImplementation(async (_query: string, _topK?: number) => {
      if (docs instanceof Error) throw docs;
      return docs;
    }),
  };
}

describe('RAGContextProvider + Orchestrator (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should inject context messages into messages before generation', async () => {
    const docs: VectorDocument[] = [
      { content: 'Relevant context from RAG.' },
      { content: 'More context.' },
    ];
    const store = createMockStore(docs);
    const ragProvider = new RAGContextProvider({ vectorStore: store });

    const provider = new MockProvider('test-provider');
    provider.enqueue({ text: 'Response with context' });

    const orchestrator = new Orchestrator({
      provider,
      contextProviders: [ragProvider],
    });

    const result = await orchestrator.run({ prompt: 'Tell me about AI' });

    expect(result.text).toBe('Response with context');
    expect(result.usage?.total).toBe(0);
    expect(store.search).toHaveBeenCalledWith('Tell me about AI', 5);
  });

  it('should fail-fast when vectorStore.search() throws (ADR-015)', async () => {
    const infraError = new Error('Vector DB connection timeout');
    const store = createMockStore(infraError);
    const ragProvider = new RAGContextProvider({ vectorStore: store });

    const provider = new MockProvider('test-provider');
    const contextFailedSpy = vi.fn();
    const orchestrator = new Orchestrator({
      provider,
      contextProviders: [ragProvider],
    });
    orchestrator.on('context.failed', contextFailedSpy);

    await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(ContextLoadError);
    expect(contextFailedSpy).toHaveBeenCalledTimes(1);
  });

  it('should fail-fast when vectorStore returns malformed docs', async () => {
    const store: VectorStore = {
      id: 'bad-store',
      search: vi.fn().mockResolvedValue([{ noContent: true }]),
    };
    const ragProvider = new RAGContextProvider({ vectorStore: store });

    const provider = new MockProvider('test-provider');
    const orchestrator = new Orchestrator({
      provider,
      contextProviders: [ragProvider],
    });

    await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(ContextProviderError);
  });

  it('should provide() called with ContextProviderInput (no stream/profile fields)', async () => {
    let capturedInput: ContextProviderInput | undefined;

    const ragProvider = {
      id: 'rag-test-store',
      async provide(input: ContextProviderInput) {
        capturedInput = input;
        return [{ role: 'system' as const, content: 'Context' }];
      },
    };

    const provider = new MockProvider('test-provider');
    provider.enqueue({ text: 'response' });

    const orchestrator = new Orchestrator({
      provider,
      contextProviders: [ragProvider],
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    await orchestrator.run({ prompt: 'test query' });

    expect(capturedInput).toBeDefined();
    expect(capturedInput!.prompt).toBe('test query');
    expect('stream' in capturedInput!).toBe(false);
    expect('profile' in capturedInput!).toBe(false);
  });

  it('should abort remaining context providers when first one fails', async () => {
    const failingStore: VectorStore = {
      id: 'failing-store',
      search: vi.fn().mockRejectedValue(new Error('DB down')),
    };
    const failingRag = new RAGContextProvider({ vectorStore: failingStore });

    const secondProvideSpy = vi
      .fn()
      .mockResolvedValue([{ role: 'system' as const, content: 'Should not be reached' }]);
    const secondProvider = {
      id: 'second-rag',
      provide: secondProvideSpy,
    };

    const provider = new MockProvider('test-provider');
    const contextFailedSpy = vi.fn();
    const orchestrator = new Orchestrator({
      provider,
      contextProviders: [failingRag, secondProvider],
    });
    orchestrator.on('context.failed', contextFailedSpy);

    await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(ContextLoadError);
    expect(contextFailedSpy).toHaveBeenCalledTimes(1);

    expect(secondProvideSpy).not.toHaveBeenCalled();
  });
});
