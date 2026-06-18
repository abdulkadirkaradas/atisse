# @atisse/context-rag

[![npm version](https://img.shields.io/npm/v/@atisse/context-rag.svg)](https://www.npmjs.com/package/@atisse/context-rag)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

A RAG (Retrieval-Augmented Generation) context provider for `@atisse/core`. Queries a vector store at pipeline startup and injects retrieved documents as system messages before the LLM generates a response.

## Features

- Plugs into the core context injection pipeline — documents are retrieved before generation begins
- Works with any vector store implementation via the `VectorStore` interface
- Configurable document count via `topK` parameter
- Automatically prefixes system messages with retrieved document content
- Integrates with the core retry policy for reliable vector store queries

## Installation

```bash
npm install @atisse/context-rag
# or
pnpm add @atisse/context-rag
```

> `@atisse/core` is a peer dependency. Install it alongside this package.

## Quick Start

```typescript
import { Orchestrator } from '@atisse/core';
import { RAGContextProvider } from '@atisse/context-rag';
import type { VectorStore, VectorDocument } from '@atisse/context-rag';

// Implement a VectorStore against your preferred vector database
class MyVectorStore implements VectorStore {
  readonly id = 'my-store';

  async search(query: string, topK?: number): Promise<VectorDocument[]> {
    // Replace with actual vector search — this is a stub
    return [
      {
        content: 'Paris is the capital of France, located on the River Seine.',
        metadata: { source: 'geography-db' },
      },
    ];
  }
}

const vectorStore = new MyVectorStore();
const ragProvider = new RAGContextProvider({
  vectorStore,
  topK: 3,
});

const orchestrator = new Orchestrator({
  provider: myProvider,
  contextProviders: [ragProvider],
  systemPrompt: 'Answer based on the retrieved context.',
});

const result = await orchestrator.run({
  prompt: 'What is the capital of France?',
});
```

## API Reference

`@atisse/context-rag` package exports the following types and classes:

<details>
<summary>Click to expand</summary>

### `RAGContextProvider`

Implements `ContextProvider` from `@atisse/core`. Queries the vector store during the context injection phase and converts results into `SystemMessage[]` entries.

**Constructor**

```typescript
new RAGContextProvider(config: RAGContextProviderConfig)
```

**`RAGContextProviderConfig` fields**

| Field         | Type          | Default                | Description                             |
| ------------- | ------------- | ---------------------- | --------------------------------------- |
| `vectorStore` | `VectorStore` | —                      | Vector store implementation (required)  |
| `topK`        | `number`      | `5`                    | Maximum number of documents to retrieve |
| `id`          | `string`      | `rag-{vectorStore.id}` | Unique provider identifier              |

**Method: `provide`**

```typescript
provide(input: ContextProviderInput): Promise<SystemMessage[]>
```

Called by the core pipeline during the `CONTEXT_INJECTING` phase. Returns an array of system messages with retrieved document content. Returns an empty array if no documents match.

### `VectorStore` interface

```typescript
interface VectorStore {
  readonly id: string;
  search(query: string, topK?: number): Promise<VectorDocument[]>;
}
```

### `VectorDocument` interface

```typescript
interface VectorDocument {
  content: string;
  metadata?: Record<string, unknown>;
}
```

</details>

### Error handling

The provider wraps vector store errors using `ContextLoadError` from `@atisse/core`. If the store returns non-array results or documents missing the `content` field, a `ContextProviderError` is thrown. Both error types are retryable by the core pipeline.

## Monorepo Ecosystem

`@atisse/*` packages are part of the [atisse](https://github.com/abdulkadirkaradas/atisse) monorepo.

- **[@atisse/core](../core)** — Execution kernel (required peer dependency)
- **[@atisse/memory-inmemory](../memory-inmemory)** — In-memory memory adapter
- **[@atisse/memory-redis](../memory-redis)** — Redis memory adapter
- **[@atisse/provider-anthropic](../provider-anthropic)** — Anthropic Claude provider
- **[@atisse/provider-openai](../provider-openai)** — OpenAI GPT provider

## License

MIT © [Abdulkadir Karadas(saferias)](https://github.com/abdulkadirkaradas)
