# Writing Adapters

## Overview

An adapter wraps an external system and exposes it through one of the kernel's public interfaces. The kernel knows nothing about the external system — only the interface.

| Type             | Interface         | Wraps                                |
| ---------------- | ----------------- | ------------------------------------ |
| Provider Adapter | `AIProvider`      | LLM provider SDK (OpenAI, Anthropic) |
| Memory Adapter   | `MemoryAdapter`   | Storage (Redis, Postgres, in-memory) |
| Context Provider | `ContextProvider` | Dynamic context source (RAG, DB)     |
| Tool             | `Tool`            | Executable capability (API, compute) |

**Security constraints apply to all adapter types.** Never use `eval()`, `new Function()`, or `vm.runInNewContext()` — there are no legitimate use cases for dynamic code evaluation. Error messages must describe what went wrong in user-facing terms — never expose internal file paths, stack frames, config values, or system internals (S-7). User input (`run.input.prompt`) is always mapped to `role: 'user'` — never `role: 'system'` (S-2).

For the complete implementation checklist, see [Adapter Pattern](../.opencode/workflows/adapter-pattern.md). This document covers the interface contracts and error-mapping patterns — the checklist covers build, test, and publish requirements.

---

## Provider Adapter

Implements `AIProvider` from `@atisse/core`. A provider adapter translates between the kernel's generic `PromptRequest`/`PromptResponse` shapes and a specific LLM provider SDK.

### Interface

```typescript
interface AIProvider {
  readonly id: string;                          // e.g. "openai-gpt-4o"
  readonly capabilities: ProviderCapabilities;  // streaming, toolCalling, vision, maxContextTokens
  generate(request: PromptRequest): Promise<PromptResponse>;
  generateStream?(request: PromptRequest): Promise<AsyncIterable<StreamChunk>>;
}
```

### Error Mapping

All provider errors MUST be mapped to typed `OrchestratorError` subtypes. The kernel uses the error type to make retry and fallback decisions.

| HTTP Status | Kernel Error                 | Retryable |
| ----------- | ---------------------------- | --------- |
| 429         | `ProviderRateLimitError`     | Yes       |
| 401, 403    | `ProviderAuthError`          | No        |
| 408         | `ProviderTimeoutError`       | Yes       |
| 500, 502    | `ProviderUnavailableError`   | Yes       |
| Other       | `ProviderUnavailableError`   | Yes       |

**Secret hygiene (S-1):** API keys and credentials must never appear in logs or error messages. Error messages describe what went wrong, never which value caused it. `provider.id` is configuration metadata and is safe in logs and events — credentials are not.

### Minimal Skeleton

```typescript
import type { AIProvider, PromptRequest, PromptResponse, ProviderCapabilities, StreamChunk } from '@atisse/core';
import {
  OrchestratorError,
  ProviderAuthError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '@atisse/core';

export class MyProvider implements AIProvider {
  readonly id = 'myprovider-v1';
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    toolCalling: true,
    vision: false,
    maxContextTokens: 128_000,
  };

  constructor(private config: { apiKey: string }) {}

  async generate(request: PromptRequest): Promise<PromptResponse> {
    try {
      const response = await fetch('https://api.example.com/chat', {
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ messages: request.messages }),
        signal: request.signal,
      });
      if (!response.ok) this.throwMappedError(response);
      return this.toPromptResponse(await response.json());
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (error instanceof OrchestratorError) throw error;
      throw new ProviderUnavailableError('Provider request failed', error);
    }
  }

  async generateStream(request: PromptRequest): Promise<AsyncIterable<StreamChunk>> {
    // Return an async iterable that yields StreamChunk values.
    // Connection errors surface before the first chunk — not mid-stream.
    const response = await fetch('https://api.example.com/chat', {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      body: JSON.stringify({ ...request, stream: true }),
      signal: request.signal,
    });
    if (!response.ok) this.throwMappedError(response);
    return this.toAsyncIterable(response.body!);
  }

  private throwMappedError(response: Response): never {
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get('Retry-After')) * 1000 || undefined;
      throw new ProviderRateLimitError('Rate limited', retryAfter);
    }
    if (response.status === 401 || response.status === 403) {
      throw new ProviderAuthError('Authentication failed — verify your API key');
    }
    if (response.status === 408) throw new ProviderTimeoutError('Request timed out');
    if (response.status >= 500) throw new ProviderUnavailableError('Provider unavailable');
    throw new ProviderUnavailableError(`Unexpected status ${response.status}`);
  }
}
```

---

## Memory Adapter

Implements `MemoryAdapter` from `@atisse/core`. Stores conversation history keyed by `sessionId`.

### Interface

```typescript
interface MemoryAdapter {
  load(sessionId: string): Promise<Message[]>;       // returns [] for unknown sessions
  save(sessionId: string, messages: Message[]): Promise<void>; // APPENDS — never replaces
  clear(sessionId: string): Promise<void>;            // idempotent
}
```

### Contract Rules

- `load()` returns `[]` (never throws) for unknown `sessionId` — new sessions start empty
- `save()` appends the provided batch to existing history — never replaces. The kernel calls `save()` once per `run()` at COMPLETING with `[userMessage, assistantMessage]`
- `clear()` is idempotent — deleting a non-existent session silently succeeds
- Storage keys MUST include `sessionId` to guarantee cross-session isolation (S-4). Session A's data must never appear in session B's `load()` result

### Error Mapping

Connection or infrastructure failures are thrown as `ContextLoadError` (retryable).

```typescript
import type { MemoryAdapter, Message } from '@atisse/core';
import { ContextLoadError } from '@atisse/core';

export class MyMemoryAdapter implements MemoryAdapter {
  constructor(private store: Map<string, string>) {}

  async load(sessionId: string): Promise<Message[]> {
    try {
      const raw = this.store.get(sessionId);
      if (!raw) return [];
      return JSON.parse(raw) as Message[];
    } catch (error: unknown) {
      throw new ContextLoadError('my-memory', error);
    }
  }

  async save(sessionId: string, messages: Message[]): Promise<void> {
    try {
      const existing = await this.load(sessionId);
      this.store.set(sessionId, JSON.stringify([...existing, ...messages]));
    } catch (error: unknown) {
      throw new ContextLoadError('my-memory', error);
    }
  }

  async clear(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }
}
```

---

## Context Provider

Implements `ContextProvider` from `@atisse/core`. Injects dynamic context (RAG results, database records) as `role: 'system'` messages before the prompt is sent to the LLM.

### Interface

```typescript
type ContextProviderInput = Omit<RunInput, 'stream' | 'profile'>;

interface ContextProvider {
  readonly id: string;
  provide(input: ContextProviderInput): Promise<SystemMessage[]>; // returns [] when no context
}
```

### Contract Rules

- `provide()` receives `prompt`, `sessionId`, and `metadata` — `stream` and `profile` are excluded (pipeline-internal routing fields)
- `input.prompt` MAY be used for retrieval (e.g. vector search query) but MUST NOT be forwarded as `role: 'system'` content (S-6). User-authored content mapped to the system role is a trust boundary violation
- Returns `[]` (never throws) when no context is available
- Errors are thrown as `ContextLoadError` (infrastructure/connectivity failure) or `ContextProviderError` (business-logic failure) — both are retryable

```typescript
import type { ContextProvider, ContextProviderInput, SystemMessage } from '@atisse/core';
import { ContextLoadError } from '@atisse/core';

export class MyContextProvider implements ContextProvider {
  readonly id = 'my-context';

  async provide(input: ContextProviderInput): Promise<SystemMessage[]> {
    try {
      const docs = await this.vectorStore.search(input.prompt);
      if (docs.length === 0) return [];
      return docs.map((doc) => ({
        role: 'system' as const,
        content: doc.text,
      }));
    } catch (error: unknown) {
      throw new ContextLoadError(this.id, error);
    }
  }
}
```

---

## Tool

Implements the `Tool` interface from `@atisse/core`. A tool is an executable capability that the LLM can invoke.

### Interface

```typescript
interface Tool extends ToolDefinition {
  name: string;               // snake_case, ≤64 chars
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema — empty object {} is FORBIDDEN
  execute(input: unknown): Promise<unknown>;
}
```

### Schema Requirements

- `inputSchema` must be a specific JSON Schema object — `{}` is forbidden (S-3a) and throws `ConfigValidationError` at construction
- `additionalProperties: false` is required
- All accepted fields should be explicitly typed with constraints (`maxLength`, `enum`, etc.)

### Error Handling

Throw typed errors from `execute()`:

| Error                 | When                             | Retryable |
| --------------------- | -------------------------------- | --------- |
| `ToolExecutionError`  | Execution failure (e.g. network) | Yes       |
| `ToolValidationError` | Invalid input format (schema)    | No        |

The kernel catches these, maps them to `ToolResult.error`, and returns them to the LLM for the next tool round.

```typescript
import type { Tool } from '@atisse/core';
import { ToolExecutionError, ToolValidationError } from '@atisse/core';
import { z } from 'zod';

const searchSchema = z.object({ query: z.string().min(1).max(500) });

export const searchTool: Tool = {
  name: 'search',
  description: 'Searches the web for a query.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', maxLength: 500 } },
    required: ['query'],
    additionalProperties: false,
  },
  async execute(input: unknown): Promise<unknown> {
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

## Package Structure

Every adapter follows the same layout:

```
packages/{type}-{name}/
├── src/
│   └── index.ts
├── tests/
│   └── index.test.ts
├── package.json
└── tsconfig.json          (extends ../../tsconfig.base.json)
```

### package.json Template

```json
{
  "name": "@atisse/provider-{name}",
  "peerDependencies": {
    "@atisse/core": "^1.0.0",
    "{provider-sdk}": ">=1.0.0"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint src/",
    "test": "vitest run",
    "build": "tsup"
  }
}
```

The provider SDK is declared as a `peerDependency` — the consuming application manages it. Only `@atisse/core` is a required peer dependency for all adapters.

---

## Publishing Convention

Packages follow a naming convention that identifies the adapter type at a glance:

| Type             | Pattern                   | Example                          |
| ---------------- | ------------------------- | -------------------------------- |
| Provider         | `@atisse/provider-{name}` | `@atisse/provider-openai`        |
| Memory           | `@atisse/memory-{name}`   | `@atisse/memory-inmemory`        |
| Context Provider | `@atisse/context-{name}`  | `@atisse/context-rag`            |
| Tool             | `@atisse/tool-{name}`     | `@atisse/tool-web-search`        |

Application-specific tools do not require packaging — pass them directly to `OrchestratorConfig.tools` or `OrchestratorProfile.tools`. Only publish a tool as `@atisse/tool-{name}` when it is general-purpose and useful across projects.
