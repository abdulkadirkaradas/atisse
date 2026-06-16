# @atisse/memory-redis

[![npm version](https://img.shields.io/npm/v/@atisse/memory-redis.svg)](https://www.npmjs.com/package/@atisse/memory-redis)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Redis-backed implementation of the `MemoryAdapter` interface for `@atisse/core`. Persists conversation history in Redis with configurable TTL, making it suitable for production deployments with session-based chat applications.

## Features

- Persistent conversation history via Redis
- Automatic connection management — pass an existing client or let the adapter connect with a URL
- Configurable TTL per session key (default: 1 hour)
- Append semantics on `save()` — preserves existing session history
- Keys namespaced under `atisse:session:{sessionId}`
- Auto-connect on first operation when using URL-based configuration

## Installation

```bash
npm install @atisse/memory-redis
# or
pnpm add @atisse/memory-redis
```

> `@atisse/core` and `redis@^6.0.0` are peer dependencies. Install them alongside this package.

## Quick Start

```typescript
import { Orchestrator } from '@atisse/core';
import { RedisMemoryAdapter } from '@atisse/memory-redis';

// Option 1: Connect with a URL (adapter manages the connection)
const memory = new RedisMemoryAdapter({
  url: 'redis://localhost:6379',
  ttlSeconds: 7200, // 2 hour TTL
});

// Option 2: Pass an existing Redis client
// import { createClient } from 'redis';
// const client = createClient({ url: 'redis://localhost:6379' });
// await client.connect();
// const memory = new RedisMemoryAdapter({ client });

const orchestrator = new Orchestrator({
  provider: myProvider,
  memoryAdapter: memory,
});

// Conversation history is persisted across runs
await orchestrator.run({
  prompt: 'Remember that I like cats.',
  sessionId: 'user-42',
});

await orchestrator.run({
  prompt: 'What do I like?',
  sessionId: 'user-42',
  // Core loads previous messages — the LLM has context
});
```

## API Reference

### `RedisMemoryAdapter`

Implements `MemoryAdapter` from `@atisse/core`. Stores serialized message arrays under keys prefixed with `atisse:session:`.

**Constructor**

```typescript
new RedisMemoryAdapter(config: { client: RedisClientType } | { url: string; ttlSeconds?: number })
```

Two configuration modes:

| Mode   | Field        | Type              | Default | Description                                                                              |
| ------ | ------------ | ----------------- | ------- | ---------------------------------------------------------------------------------------- |
| Client | `client`     | `RedisClientType` | —       | An existing connected Redis client instance. The adapter will not manage its lifecycle.  |
| URL    | `url`        | `string`          | —       | Redis connection URL (e.g. `redis://localhost:6379`). The adapter connects on first use. |
| URL    | `ttlSeconds` | `number`          | `3600`  | TTL for session keys in seconds.                                                         |

**Methods**

| Method  | Signature                                                   | Description                                                                               |
| ------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `load`  | `(sessionId: string) => Promise<Message[]>`                 | Retrieves all messages for the session. Returns an empty array if the key does not exist. |
| `save`  | `(sessionId: string, messages: Message[]) => Promise<void>` | Appends messages to the session's existing history using `setEx` with the configured TTL. |
| `clear` | `(sessionId: string) => Promise<void>`                      | Deletes the session key. Idempotent.                                                      |

### Error handling

Redis errors are wrapped as `ContextLoadError` from `@atisse/core`, which is retryable by the core pipeline. Connection failures during URL-based setups are handled the same way.

## Monorepo Ecosystem

`@atisse/*` packages are part of the [atisse](https://github.com/abdulkadirkaradas/atisse) monorepo.

- **[@atisse/core](../core)** — Execution kernel (required peer dependency)
- **[@atisse/context-rag](../context-rag)** — RAG context provider
- **[@atisse/memory-inmemory](../memory-inmemory)** — In-memory memory adapter
- **[@atisse/provider-anthropic](../provider-anthropic)** — Anthropic Claude provider
- **[@atisse/provider-openai](../provider-openai)** — OpenAI GPT provider

## License

MIT © [Abdulkadir Karadas(saferias)](https://github.com/abdulkadirkaradas)
