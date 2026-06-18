# @atisse/memory-inmemory

[![npm version](https://img.shields.io/npm/v/@atisse/memory-inmemory.svg)](https://www.npmjs.com/package/@atisse/memory-inmemory)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

An in-memory implementation of the `MemoryAdapter` interface for `@atisse/core`. Stores conversation history in a JavaScript `Map` keyed by session ID. Intended for development, testing, and prototyping — not for production use.

## Features

- Simple Map-based storage — no external dependencies
- Append semantics on `save()` — preserves existing session history
- Cross-session isolation via per-session keys
- Lightweight and instant setup, ideal for unit tests and local development

## Installation

```bash
npm install @atisse/memory-inmemory
# or
pnpm add @atisse/memory-inmemory
```

> `@atisse/core` is a peer dependency. Install it alongside this package.

## Quick Start

```typescript
import { Orchestrator } from '@atisse/core';
import { InMemoryAdapter } from '@atisse/memory-inmemory';

const memory = new InMemoryAdapter();

const orchestrator = new Orchestrator({
  provider: myProvider,
  memoryAdapter: memory,
});

// First turn — saves messages to session-1
await orchestrator.run({
  prompt: 'What is my name?',
  sessionId: 'session-1',
});

// Second turn — loads previous messages from session-1
await orchestrator.run({
  prompt: 'Do you remember my name now?',
  sessionId: 'session-1',
  // Core pipeline loads existing history and appends it to the generate request
});

// Clear session when done
await memory.clear('session-1');
```

## API Reference

### `InMemoryAdapter`

Implements `MemoryAdapter` from `@atisse/core`. Uses a private `Map<string, Message[]>` for storage.

**Constructor**

```typescript
new InMemoryAdapter();
```

No configuration required.

**Methods**

| Method  | Signature                                                   | Description                                                                                         |
| ------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `load`  | `(sessionId: string) => Promise<Message[]>`                 | Returns all messages for the session, or an empty array if the session does not exist.              |
| `save`  | `(sessionId: string, messages: Message[]) => Promise<void>` | Appends messages to the session's existing history. Creates the session if it does not exist.       |
| `clear` | `(sessionId: string) => Promise<void>`                      | Deletes all messages for the session. Idempotent — succeeds silently if the session does not exist. |

### Important notes

- This adapter is backed by a `Map` scoped to the adapter instance. Data is lost when the process exits.
- `save()` uses **append semantics** — existing messages are preserved and new messages are added to the end.
- The adapter does not enforce any maximum session size. Long-running sessions will accumulate all messages.
- For production workloads, use `@atisse/memory-redis` or another persistent memory adapter.

## Monorepo Ecosystem

`@atisse/*` packages are part of the [atisse](https://github.com/abdulkadirkaradas/atisse) monorepo.

- **[@atisse/core](../core)** — Execution kernel (required peer dependency)
- **[@atisse/context-rag](../context-rag)** — RAG context provider
- **[@atisse/memory-redis](../memory-redis)** — Redis memory adapter
- **[@atisse/provider-anthropic](../provider-anthropic)** — Anthropic Claude provider
- **[@atisse/provider-openai](../provider-openai)** — OpenAI GPT provider

## License

MIT © [Abdulkadir Karadas(saferias)](https://github.com/abdulkadirkaradas)
