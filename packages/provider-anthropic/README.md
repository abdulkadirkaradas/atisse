# @atisse/provider-anthropic

[![npm version](https://img.shields.io/npm/v/@atisse/provider-anthropic.svg)](https://www.npmjs.com/package/@atisse/provider-anthropic)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

An Anthropic Claude provider adapter for `@atisse/core`. Implements the `AIProvider` interface to connect the orchestrator pipeline to Anthropic's Claude models, including Claude Sonnet 4.5.

## Features

- Full support for Claude models via the Anthropic Messages API
- Streaming via `generateStream()` with per-character text deltas and tool call accumulation
- Tool calling with automatic argument JSON parsing
- Vision support via data URI image content
- 200K context window
- Automatic error mapping to `@atisse/core` error types (rate limit, auth, timeout, unavailable)
- Provider options passthrough with reserved key validation
- AbortSignal support for cancellation

## Installation

```bash
npm install @atisse/provider-anthropic
# or
pnpm add @atisse/provider-anthropic
```

> `@atisse/core` and `@anthropic-ai/sdk@^0.100.1` are peer dependencies. Install them alongside this package.

## Quick Start

```typescript
import { Orchestrator } from '@atisse/core';
import { AnthropicProvider } from '@atisse/provider-anthropic';

const provider = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-5',
});

const orchestrator = new Orchestrator({
  provider,
  systemPrompt: 'You are a concise assistant.',
});

const result = await orchestrator.run({
  prompt: 'Explain quantum computing in one sentence.',
});

console.log(result.text);
```

### With streaming

```typescript
const stream = await orchestrator.run({
  prompt: 'Write a haiku about streams.',
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
  provider: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY,
  }),
  tools: [
    {
      name: 'get_weather',
      description: 'Get current weather for a location',
      inputSchema: {
        type: 'object',
        properties: {
          location: { type: 'string' },
        },
        required: ['location'],
      },
      async execute(input: { location: string }) {
        return { temperature: 22, condition: 'sunny' };
      },
    },
  ],
});

const result = await orchestrator.run({
  prompt: 'What is the weather in London?',
});
```

## API Reference

`@atisse/provider-anthropic` package exports the following types and classes:

<details>
<summary>Click to expand</summary>

### `AnthropicProvider`

Implements `AIProvider` from `@atisse/core`.

**Constructor**

```typescript
new AnthropicProvider(config: AnthropicProviderConfig)
```

**`AnthropicProviderConfig` fields**

| Field     | Type     | Default             | Description                    |
| --------- | -------- | ------------------- | ------------------------------ |
| `apiKey`  | `string` | —                   | Anthropic API key (required)   |
| `model`   | `string` | `claude-sonnet-4-5` | Claude model identifier        |
| `baseURL` | `string` | —                   | Custom API base URL (optional) |

**Capabilities**

| Property           | Value     |
| ------------------ | --------- |
| `streaming`        | `true`    |
| `toolCalling`      | `true`    |
| `vision`           | `true`    |
| `maxContextTokens` | `200_000` |

**Methods**

| Method           | Signature                                                         | Description                                                                             |
| ---------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `generate`       | `(request: PromptRequest) => Promise<PromptResponse>`             | Non-streaming completion. Maps messages, tools, and options into an Anthropic API call. |
| `generateStream` | `(request: PromptRequest) => Promise<AsyncIterable<StreamChunk>>` | Streaming completion. Yields `text`, `tool_call`, and `done` chunks.                    |

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
- **[@atisse/provider-openai](../provider-openai)** — OpenAI GPT provider

## License

MIT © [Abdulkadir Karadas(saferias)](https://github.com/abdulkadirkaradas)
