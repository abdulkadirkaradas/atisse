# @atisse/core

[![npm version](https://img.shields.io/npm/v/@atisse/core)](https://www.npmjs.com/package/@atisse/core)
[![CI](https://github.com/abdulkadirkaradas/atisse/actions/workflows/ci.yml/badge.svg)](https://github.com/abdulkadirkaradas/atisse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**A lightweight, production-grade execution kernel for managing the LLM interaction lifecycle.**

---

## The Problem

Most AI integrations fall into one of two anti-patterns. Raw SDK calls have no retry, no fallback, no memory, and no observability — they break in production. Heavy frameworks like LangChain introduce opaque abstractions, hidden behavior, and vendor lock-in that make debugging and testing painful.

The gap between these two extremes is a production-ready, minimal orchestration layer that manages the lifecycle of an LLM call without becoming a framework. That is what `@atisse/core` provides.

---

## How It Compares

|                           | LangChain | Vercel AI SDK | **@atisse/core** |
| ------------------------- | --------- | ------------- | ---------------- |
| Weight                    | Heavy     | Light         | Minimal          |
| Focus                     | Framework | Frontend      | Backend kernel   |
| Hidden behavior           | High      | Medium        | None             |
| Vendor lock-in            | Yes       | Partial       | No               |
| Production retry/fallback | Complex   | None          | First-class      |
| Tool lifecycle            | Opaque    | Limited       | Explicit         |
| Streaming                 | Yes       | First-class   | First-class      |
| Testability               | Hard      | Medium        | MockProvider     |

---

## Quick Start

```bash
pnpm add @atisse/core @atisse/provider-openai

npm install @atisse/core @atisse/provider-openai
```

```typescript
import { Orchestrator } from '@atisse/core';
import { OpenAIProvider } from '@atisse/provider-openai';

const apiKey = process.env.OPENAI_KEY ?? '';
if (!apiKey) throw new Error('OPENAI_KEY environment variable is required');

const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({ apiKey }),
  retry: { maxAttempts: 3 },
});

const result = await orchestrator.run({ prompt: 'Hello' });
console.log(result.text);
```

Behind the scenes: context was loaded, the prompt was composed, the provider was called with retry policy enforced, and the result was returned with usage and timing data — all in a deterministic, observable pipeline.

---

## Packages

Each package has its own `README.md` with detailed API documentation, installation guides, and code examples.

| Package                                                                 | Description                                    |
| ----------------------------------------------------------------------- | ---------------------------------------------- |
| [`@atisse/core`](./packages/core/README.md)                             | Kernel, frozen interfaces, `MockProvider`      |
| [`@atisse/provider-openai`](./packages/provider-openai/README.md)       | OpenAI adapter (GPT-4o, GPT-4o-mini)           |
| [`@atisse/provider-anthropic`](./packages/provider-anthropic/README.md) | Anthropic adapter (Claude 3.5 Sonnet, Haiku)   |
| [`@atisse/memory-inmemory`](./packages/memory-inmemory/README.md)       | Reference in-memory `MemoryAdapter`            |
| [`@atisse/memory-redis`](./packages/memory-redis/README.md)             | Redis-backed `MemoryAdapter` with TTL support  |
| [`@atisse/context-rag`](./packages/context-rag/README.md)               | RAG `ContextProvider` — pluggable vector store |

---

## Links

- [Getting Started](docs/getting-started.md)
- [Writing Adapters](docs/writing-adapters.md)
- [API Reference](docs/api/)
- [Examples](examples/)
- [GitHub Discussions](https://github.com/abdulkadirkaradas/atisse/discussions)