# @atisse/provider-openai

[![npm version](https://img.shields.io/npm/v/@atisse/provider-openai.svg)](https://www.npmjs.com/package/@atisse/provider-openai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

An OpenAI GPT provider adapter for `@atisse/core`. Implements the `AIProvider` interface to connect the orchestrator pipeline to OpenAI's GPT models, including GPT-4o.

## Features

- Full support for OpenAI GPT models via the Chat Completions API
- Streaming via `generateStream()` with per-character text deltas and tool call accumulation
- Tool calling with automatic function argument JSON parsing
- Vision support via image URL content
- 128K context window on supported models
- Automatic error mapping to `@atisse/core` error types (rate limit, auth, timeout, unavailable)
- Provider options passthrough with reserved key validation
- AbortSignal support for cancellation

## Installation

```bash
npm install @atisse/provider-openai
# or
pnpm add @atisse/provider-openai
```

> `@atisse/core` and `openai@^6.39.1` are peer dependencies. Install them alongside this package.

## Quick Start

```typescript
import { Orchestrator } from '@atisse/core';
import { OpenAIProvider } from '@atisse/provider-openai';

const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY,
  model: 'gpt-4o',
});

const orchestrator = new Orchestrator({
  provider,
  systemPrompt: 'You are a helpful assistant.',
});

const result = await orchestrator.run({
  prompt: 'What is the meaning of life?',
});

console.log(result.text);
```

### With streaming

```typescript
const stream = await orchestrator.run({
  prompt: 'Tell me a joke.',
  stream: true,
});

for await (const chunk of stream) {
  if (chunk.type === 'text') {
    process.stdout.write(chunk.delta);
  }
}
```

### With tools

```typescript
const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({
    apiKey: process.env.OPENAI_API_KEY,
  }),
  tools: [
    {
      name: 'search_web',
      description: 'Search the web for information',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
      },
      async execute(input: { query: string }) {
        return { results: [`Result for ${input.query}`] };
      },
    },
  ],
});

const result = await orchestrator.run({
  prompt: 'Search for latest news about AI.',
});
```

## API Reference

`@atisse/provider-openai` package exports the following types and classes:

<details>
<summary>Click to expand</summary>

### `OpenAIProvider`

Implements `AIProvider` from `@atisse/core`.

**Constructor**

```typescript
new OpenAIProvider(config: OpenAIProviderConfig)
```

**`OpenAIProviderConfig` fields**

| Field     | Type     | Default  | Description                                                          |
| --------- | -------- | -------- | -------------------------------------------------------------------- |
| `apiKey`  | `string` | —        | OpenAI API key (required)                                            |
| `model`   | `string` | `gpt-4o` | GPT model identifier                                                 |
| `baseURL` | `string` | —        | Custom API base URL (optional, supports OpenAI-compatible endpoints) |

**Capabilities**

| Property           | Value     |
| ------------------ | --------- |
| `streaming`        | `true`    |
| `toolCalling`      | `true`    |
| `vision`           | `true`    |
| `maxContextTokens` | `128_000` |

**Methods**

| Method           | Signature                                                         | Description                                                                                           |
| ---------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `generate`       | `(request: PromptRequest) => Promise<PromptResponse>`             | Non-streaming completion. Maps messages, tools, and options into an OpenAI Chat Completions API call. |
| `generateStream` | `(request: PromptRequest) => Promise<AsyncIterable<StreamChunk>>` | Streaming completion. Yields `text`, `tool_call`, and `done` chunks.                                  |

**Error mapping**

| HTTP Status | Core Error                 | Retryable |
| ----------- | -------------------------- | --------- |
| 429         | `ProviderRateLimitError`   | Yes       |
| 401, 403    | `ProviderAuthError`        | No        |
| 408         | `ProviderTimeoutError`     | Yes       |
| 500+        | `ProviderUnavailableError` | Yes       |

</details>

## Monorepo Ecosystem

`@atisse/*` packages are part of the [atisse](https://github.com/abdulkadirkaradas/atisse) monorepo.

- **[@atisse/core](../core)** — Execution kernel (required peer dependency)
- **[@atisse/context-rag](../context-rag)** — RAG context provider
- **[@atisse/memory-inmemory](../memory-inmemory)** — In-memory memory adapter
- **[@atisse/memory-redis](../memory-redis)** — Redis memory adapter
- **[@atisse/provider-anthropic](../provider-anthropic)** — Anthropic Claude provider

## License

MIT © [Abdulkadir Karadas(saferias)](https://github.com/abdulkadirkaradas)
