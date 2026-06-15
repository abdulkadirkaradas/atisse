import type { ContextProvider, ContextProviderInput, SystemMessage } from '@atisse/core';
import { ContextLoadError, ContextProviderError } from '@atisse/core';

export interface VectorDocument {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface VectorStore {
  readonly id: string;
  search(query: string, topK?: number): Promise<VectorDocument[]>;
}

export interface RAGContextProviderConfig {
  vectorStore: VectorStore;
  topK?: number;
  id?: string;
}

export class RAGContextProvider implements ContextProvider {
  readonly id: string;
  private readonly vectorStore: VectorStore;
  private readonly topK: number;

  constructor(config: RAGContextProviderConfig) {
    this.vectorStore = config.vectorStore;
    this.topK = config.topK ?? 5;
    this.id = config.id ?? `rag-${config.vectorStore.id}`;
  }

  async provide(input: ContextProviderInput): Promise<SystemMessage[]> {
    let docs: VectorDocument[];

    try {
      docs = await this.vectorStore.search(input.prompt, this.topK);
    } catch (error: unknown) {
      throw new ContextLoadError(this.id, error);
    }

    if (!Array.isArray(docs)) {
      throw new ContextProviderError(this.id, new Error(`VectorStore.search() returned non-array`));
    }

    if (docs.length === 0) return [];

    for (const doc of docs) {
      if (typeof doc.content !== 'string') {
        throw new ContextProviderError(
          this.id,
          new Error(`VectorStore.search() returned doc missing "content" field`),
        );
      }
    }

    return docs.map((doc) => ({
      role: 'system' as const,
      content: doc.content,
    }));
  }
}
