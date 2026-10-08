import { runContextProviderConformanceTests } from '@atisse/core/testing';

import { RAGContextProvider } from '../../src/index.js';
import { InMemoryVectorStore } from '../fixtures/in-memory-vector-store.js';

runContextProviderConformanceTests(
  'RAGContextProvider',
  () => new RAGContextProvider({ vectorStore: new InMemoryVectorStore() }),
);
