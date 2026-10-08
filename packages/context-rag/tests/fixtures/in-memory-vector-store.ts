import type { VectorDocument, VectorStore } from '../../src/index.js';

/**
 * In-memory vector store fixture for conformance tests.
 * No external RAG backend or network required.
 */
export class InMemoryVectorStore implements VectorStore {
  readonly id = 'test-in-memory';

  constructor(private docs: VectorDocument[] = []) {}

  async search(_query: string, _topK?: number): Promise<VectorDocument[]> {
    return this.docs;
  }
}
