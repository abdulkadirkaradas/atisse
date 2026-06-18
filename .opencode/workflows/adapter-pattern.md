# ADAPTER PATTERN

## How to Write Adapters for This Project

---

## Overview

An adapter wraps an external system and exposes it through one of the kernel's interfaces.
The kernel knows nothing about the external system — only the interface.

| Type             | Interface         | Wraps                                |
| ---------------- | ----------------- | ------------------------------------ |
| Provider Adapter | `AIProvider`      | LLM provider SDK (OpenAI, Anthropic) |
| Memory Adapter   | `MemoryAdapter`   | Storage (Redis, Postgres, in-memory) |
| Context Provider | `ContextProvider` | Dynamic context source (RAG, DB)     |

---

## Provider Adapter Checklist

- [ ] Implements `AIProvider` from `@atisse/core`
- [ ] `readonly id` follows convention: `"{provider}-{model}"` e.g. `"openai-gpt-4o"`
- [ ] `readonly capabilities` accurately reflects provider support
- [ ] `generate()` returns exactly `PromptResponse` shape
- [ ] `generateStream()` returns `Promise<AsyncIterable<StreamChunk>>` if `capabilities.streaming === true`
- [ ] ALL errors mapped to typed `OrchestratorError` subtypes
- [ ] Provider SDK declared as `peerDependency` in package.json

### Error Mapping (CRITICAL)

```typescript
private mapError(error: unknown): never {
  if (error instanceof Error) {
    const status = (error as any).status;
    if (status === 429) {
      const retryAfterMs = Number((error as any).headers?.['retry-after']) * 1000 || undefined;
      throw new ProviderRateLimitError(error.message, retryAfterMs, error);
    }
    if (status === 401 || status === 403) throw new ProviderAuthError(error.message, error);
    if (status === 408)                   throw new ProviderTimeoutError(error.message, error);
    if (status >= 500)                    throw new ProviderUnavailableError(error.message, error);
  }
  throw new ProviderUnavailableError('Unknown error', error);
}
```

---

## Memory Adapter Checklist

- [ ] Implements `MemoryAdapter` from `@atisse/core`
- [ ] `load()` returns `[]` (NOT throws) when sessionId not found
- [ ] `save()` APPENDS the provided message batch to existing history — never replaces
- [ ] `save()` is called once per `run()` at COMPLETING with `[userMessage, assistantMessage]`
- [ ] `clear()` is idempotent — non-existent sessionId silently succeeds, never throws
- [ ] Storage key always includes `sessionId` — never a global/shared key
- [ ] Storage key namespace is configurable for multi-tenant deployments
- [ ] Connection errors thrown as `ContextLoadError` (retryable)

```typescript
async load(sessionId: string): Promise<Message[]> {
  try {
    const raw = await this.store.get(sessionId);
    if (!raw) return [];   // new session — return empty, do not throw
    return JSON.parse(raw) as Message[];
  } catch (error: unknown) {
    throw new ContextLoadError(this.id, error);
  }
}

async save(sessionId: string, messages: Message[]): Promise<void> {
  try {
    const existing = await this.load(sessionId);
    await this.store.set(sessionId, JSON.stringify([...existing, ...messages]));
  } catch (error: unknown) {
    throw new ContextLoadError(this.id, error);
  }
}

async clear(sessionId: string): Promise<void> {
  try {
    await this.store.delete(sessionId); // no-op if key does not exist
  } catch (error: unknown) {
    throw new ContextLoadError(this.id, error);
  }
}
```

---

## Context Provider Checklist

- [ ] Implements `ContextProvider` from `@atisse/core`
- [ ] `readonly id` is unique
- [ ] `provide()` accepts `ContextProviderInput` (NOT `RunInput`) — `stream` and `profile` are excluded
- [ ] `provide()` returns `Promise<SystemMessage[]>` — output is always `role: 'system'`
- [ ] `provide()` returns `[]` (NOT throws) when no context found
- [ ] `input.prompt` is used for retrieval only — NEVER forwarded as `role: 'system'` content
- [ ] Content from untrusted sources is sanitized before mapping to `role: 'system'`
- [ ] Errors thrown as `ContextLoadError` or `ContextProviderError` (both retryable)

**ContextLoadError vs ContextProviderError:**

- `ContextLoadError` — infrastructure/connectivity failure (storage backend unreachable)
- `ContextProviderError` — business-logic failure (embedding service returned unexpected shape)

**`ContextProviderInput` access scope:** `provide()` receives `prompt`, `sessionId`, and `metadata`.
All fields may be read for retrieval purposes. `input.prompt` MUST NOT appear in output messages.

```typescript
async provide(input: ContextProviderInput): Promise<SystemMessage[]> {
  try {
    const docs = await this.vectorStore.search(input.prompt); // prompt used for retrieval
    if (docs.length === 0) return [];
    return docs.map(doc => ({
      role: 'system' as const,
      content: doc.text           // doc.text — NOT input.prompt
    }));
  } catch (error: unknown) {
    throw new ContextLoadError(this.id, error);
  }
}
```

---

## Tool Checklist

- [ ] `inputSchema` is specific — empty object (`{}`) is FORBIDDEN
- [ ] All accepted fields explicitly typed with constraints (`maxLength`, `enum`, etc.)
- [ ] `additionalProperties: false` set in schema
- [ ] `execute()` throws `ToolValidationError` on schema mismatch (FATAL)
- [ ] `execute()` throws `ToolExecutionError` on execution failure (retryable)
- [ ] HTTP-calling tools implement URL allowlist check
- [ ] Tool output is `JSON.stringify`-serializable

```typescript
import { z } from 'zod';
import { ToolValidationError, ToolExecutionError } from '@atisse/core';

const searchSchema = z.object({ query: z.string().max(500) });

const searchTool: Tool = {
  name: 'search',
  description: 'Searches the web for a query.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', maxLength: 500 } },
    required: ['query'],
    additionalProperties: false,
  },
  execute: async (input: unknown): Promise<unknown> => {
    const parsed = searchSchema.safeParse(input);
    if (!parsed.success) {
      throw new ToolValidationError(
        'search',
        parsed.error.issues.map((i) => i.message),
      );
    }
    try {
      return await searchAPI(parsed.data.query);
    } catch (error: unknown) {
      throw new ToolExecutionError('search', error);
    }
  },
};
```

---

## Package Structure Template

```
packages/provider-{name}/
├── src/index.ts
├── tests/index.test.ts
├── package.json
└── tsconfig.json         extends ../../tsconfig.base.json
```

### package.json

```json
{
  "name": "@atisse/provider-{name}",
  "peerDependencies": {
    "@atisse/core": "workspace:*",
    "{provider-sdk}": ">=1.0.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:coverage": "vitest run --coverage",
    "build": "tsup"
  }
}
```

---

## Tool Packaging

Application-specific tools do not require packaging — pass them directly to
`OrchestratorConfig.tools` or `OrchestratorProfile.tools`.

General-purpose tools for independent publishing follow this convention:

```
Package name:  @atisse/tool-{name}

packages/tool-{name}/
├── src/index.ts
├── tests/index.test.ts
├── package.json          peerDep on @atisse/core only (+ SDK if needed)
└── tsconfig.json
```
