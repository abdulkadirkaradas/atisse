# @atisse/core

[![npm version](https://img.shields.io/npm/v/@atisse/core.svg)](https://www.npmjs.com/package/@atisse/core)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

A lightweight, production-grade execution kernel for managing the LLM interaction lifecycle. Provides the orchestrator, pipeline, state machine, retry logic, hook system, and event bus that all adapter packages plug into.

## Features

- Lifecycle-managed pipeline with explicit state machine transitions
- Retry policy with configurable backoff, jitter, and max attempts
- Timeout policy per generate, tool, and total run
- Tool execution loop with configurable round limits
- Fallback provider support for high-availability setups
- Hook system with before/after hooks for run, generate, and tool phases
- Event bus with typed events for observability
- Profile system for per-run configuration overrides
- Streaming support via `AsyncIterable<StreamChunk>`
- Cancellation via `AbortSignal`
- Session memory adapter integration
- Context provider injection pipeline
- Zero runtime dependencies beyond `zod`

## Installation

```bash
npm install @atisse/core
# or
pnpm add @atisse/core
```

## Quick Start

```typescript
import { Orchestrator } from '@atisse/core';

// A provider adapter is required — see @atisse/provider-openai or @atisse/provider-anthropic
const orchestrator = new Orchestrator({
  provider: myProvider,
  systemPrompt: 'You are a helpful assistant.',
});

const result = await orchestrator.run({
  prompt: 'What is the capital of France?',
  sessionId: 'session-123',
});

console.log(result.text);
// Output: The capital of France is Paris.
```

### With streaming

```typescript
const stream = await orchestrator.run({
  prompt: 'Tell me a story.',
  stream: true,
});

for await (const chunk of stream) {
  if (chunk.type === 'text') {
    process.stdout.write(chunk.delta);
  }
}
```

### With event listeners

```typescript
const unsub = orchestrator.on('run.completed', (event) => {
  console.log(`Run ${event.runId} completed in ${event.durationMs}ms`);
});

const result = await orchestrator.run({ prompt: 'Hello' });
unsub(); // Remove listener when done
```

## API Reference

`@atisse/core` package exports the following types and classes:

<details>
<summary>Click to expand</summary>

### `Orchestrator`

The main entry point. Created with an `OrchestratorConfig` and exposes `run()` and `on()`.

**Constructor**

```typescript
new Orchestrator(config: OrchestratorConfig)
```

Validates configuration eagerly — throws `ConfigValidationError` on invalid input.

**Key Methods**

| Method | Signature                                                                     | Description                                                                                                |
| ------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `run`  | `(input: RunInput & { stream?: false }) => Promise<RunOutput>`                | Execute a single prompt interaction. Returns structured output with text, tool results, usage, and timing. |
| `run`  | `(input: RunInput & { stream: true }) => Promise<AsyncIterable<StreamChunk>>` | Execute with streaming. Yields text deltas, tool calls, and a completion event.                            |
| `on`   | `<T>(type: T, listener) => () => void`                                        | Register a typed event listener. Returns an unsubscribe function.                                          |

**`OrchestratorConfig` fields**

| Field              | Type                                  | Required | Description                                   |
| ------------------ | ------------------------------------- | -------- | --------------------------------------------- |
| `provider`         | `AIProvider`                          | Yes      | Primary LLM provider                          |
| `fallbackProvider` | `AIProvider`                          | No       | Fallback provider on primary failure          |
| `systemPrompt`     | `string`                              | No       | System-level instruction                      |
| `tools`            | `Tool[]`                              | No       | Tool definitions with execute implementations |
| `contextProviders` | `ContextProvider[]`                   | No       | Context injection providers                   |
| `memoryAdapter`    | `MemoryAdapter`                       | No       | Session memory persistence                    |
| `retry`            | `Partial<RetryPolicy>`                | No       | Retry configuration                           |
| `timeout`          | `Partial<TimeoutPolicy>`              | No       | Timeout configuration                         |
| `toolPolicy`       | `Partial<ToolPolicy>`                 | No       | Tool execution policy                         |
| `hooks`            | `Partial<HookRegistry>`               | No       | Lifecycle hooks                               |
| `profiles`         | `Record<string, OrchestratorProfile>` | No       | Named configuration profiles                  |
| `logger`           | `Logger`                              | No       | Logger instance                               |

**`RunInput` fields**

| Field       | Type                      | Description                         |
| ----------- | ------------------------- | ----------------------------------- |
| `prompt`    | `string`                  | User prompt (always `role: 'user'`) |
| `profile`   | `string`                  | Profile name to apply               |
| `sessionId` | `string`                  | Session identifier for memory       |
| `stream`    | `boolean`                 | Enable streaming mode               |
| `metadata`  | `Record<string, unknown>` | Arbitrary metadata                  |
| `signal`    | `AbortSignal`             | Cancellation signal                 |

### `OrchestratorError` hierarchy

All errors thrown by the kernel extend `OrchestratorError`. Key subtypes:

| Class                            | Code                          | Retryable |
| -------------------------------- | ----------------------------- | --------- |
| `ProviderRateLimitError`         | `PROVIDER_RATE_LIMIT`         | Yes       |
| `ProviderTimeoutError`           | `PROVIDER_TIMEOUT`            | Yes       |
| `ProviderUnavailableError`       | `PROVIDER_UNAVAILABLE`        | Yes       |
| `ProviderAuthError`              | `PROVIDER_AUTH_FAILED`        | No        |
| `ProviderMalformedResponseError` | `PROVIDER_MALFORMED_RESPONSE` | No        |
| `ToolExecutionError`             | `TOOL_EXECUTION_FAILED`       | Yes       |
| `ToolValidationError`            | `TOOL_VALIDATION_FAILED`      | No        |
| `ToolNotFoundError`              | `TOOL_NOT_FOUND`              | No        |
| `ContextLoadError`               | `CONTEXT_LOAD_FAILED`         | Yes       |
| `MaxRetriesExceededError`        | `MAX_RETRIES_EXCEEDED`        | No        |
| `ConfigValidationError`          | `CONFIG_VALIDATION_FAILED`    | No        |
| `TimeoutExceededError`           | `TIMEOUT_EXCEEDED`            | No        |
| `RunCancelledError`              | `RUN_CANCELLED`               | No        |

</details>

### Testing utilities

```typescript
import { MockProvider } from '@atisse/core/testing';

const mock = new MockProvider();
mock.enqueue({ text: 'Mock response' });
const result = await mock.generate({ messages: [] });
```

`MockProvider` supports configurable response queues, streaming, failure injection, and call inspection.

### Additional exports

- `LifecycleState` — `'INITIALIZED' | 'CONTEXT_INJECTING' | 'CONTEXT_INJECTED' | 'PROMPT_COMPOSED' | 'GENERATING' | 'TOOL_EXECUTING' | 'RETRYING' | 'FALLBACKING' | 'COMPLETING' | 'COMPLETED' | 'FAILED'`
- `LifecycleStateMachine` — State machine for lifecycle transitions
- `StreamChunk` — Discriminated union for streaming: `text`, `tool_call`, `tool_result`, `done`, `error`
- All type interfaces: `AIProvider`, `MemoryAdapter`, `ContextProvider`, `Tool`, `HookRegistry`, `Logger`, etc.

## Monorepo Ecosystem

`@atisse/*` packages are part of the [atisse](https://github.com/abdulkadirkaradas/atisse) monorepo.

- **[@atisse/context-rag](../context-rag)** — RAG context provider
- **[@atisse/memory-inmemory](../memory-inmemory)** — In-memory memory adapter
- **[@atisse/memory-redis](../memory-redis)** — Redis memory adapter
- **[@atisse/provider-anthropic](../provider-anthropic)** — Anthropic Claude provider
- **[@atisse/provider-openai](../provider-openai)** — OpenAI GPT provider

## License

MIT © [Abdulkadir Karadas(saferias)](https://github.com/abdulkadirkaradas)
