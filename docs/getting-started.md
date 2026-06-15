# Getting Started

## Installation

```bash
pnpm add @atisse/core @atisse/provider-openai
```

`@atisse/core` is the execution kernel. `@atisse/provider-openai` is the OpenAI provider adapter. For Anthropic:

```bash
pnpm add @atisse/provider-anthropic
```

Also see the [quick-start example](../README.md#quick-start) in the README for a minimal runnable setup.

## First Run

See the [quick-start example](../README.md#quick-start) in the README for a complete minimal setup. Once you have an `Orchestrator` instance, the output shape is:

### Output Shape

```typescript
interface RunOutput {
  runId: string; // correlation key for logs and events
  text: string; // full response text ("" when LLM returns only tool calls)
  toolResults: ToolResult[]; // [] when no tools called
  usage: {
    prompt: number; // input tokens
    completion: number; // output tokens
    total: number; // may differ from prompt+completion (cached tokens)
  };
  durationMs: number; // wall-clock time of the entire run()
  profile?: string; // active profile name, if any
  metadata?: Record<string, unknown>; // pass-through from RunInput.metadata
}
```

## Configuration Reference

All `OrchestratorConfig` fields:

| Field              | Type                                   | Default                                                                     | Description                                             |
| ------------------ | -------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| `provider`         | `AIProvider`                           | — (required)                                                                | Primary LLM provider                                    |
| `fallbackProvider` | `AIProvider?`                          | —                                                                           | Secondary provider on max-retry exhaustion              |
| `systemPrompt`     | `string?`                              | —                                                                           | Global system prompt; profile.systemPrompt replaces     |
| `tools`            | `Tool[]?`                              | —                                                                           | Tool definitions; duplicate names throw at construction |
| `contextProviders` | `ContextProvider[]?`                   | —                                                                           | Context providers for injection-time retrieval          |
| `memoryAdapter`    | `MemoryAdapter?`                       | —                                                                           | Session persistence adapter                             |
| `retry`            | `Partial<RetryPolicy>?`                | `{ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30000, jitter: true }`     | Retry policy — partial overrides merge with defaults    |
| `timeout`          | `Partial<TimeoutPolicy>?`              | `{ generateTimeoutMs: 30000, toolTimeoutMs: 10000, totalTimeoutMs: 60000 }` | Timeout policy — partial overrides merge with defaults  |
| `toolPolicy`       | `Partial<ToolPolicy>?`                 | `{ maxToolRounds: 5, allowParallelTools: false, toolTimeoutMs: 10000 }`     | Tool execution policy                                   |
| `hooks`            | `Partial<HookRegistry>?`               | —                                                                           | Lifecycle hooks — serial, pipeline-blocking             |
| `profiles`         | `Record<string, OrchestratorProfile>?` | —                                                                           | Named behavior presets; key must equal profile.name     |
| `logger`           | `Logger?`                              | no-op                                                                       | Structured logger                                       |

### Validation at Construction

The constructor throws `ConfigValidationError` for:

- Missing `provider`
- `profiles[key].name !== key`
- `allowParallelTools: true`
- `maxToolRounds < 1`
- Timeout values `<= 0` or `Infinity`
- `retry.maxAttempts < 1` or `Infinity`
- Duplicate tool names
- Empty tool `inputSchema` (`{}`)

## Adding Tools

A tool implements the `Tool` interface:

```typescript
import type { Tool } from '@atisse/core';
import { ToolValidationError } from '@atisse/core';

const calculatorTool: Tool = {
  name: 'calculator',
  description: 'Performs arithmetic operations',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add'], description: 'Operation to perform' },
      a: { type: 'number', description: 'First operand' },
      b: { type: 'number', description: 'Second operand' },
    },
    required: ['action', 'a', 'b'],
    additionalProperties: false,
  },
  async execute(input: unknown) {
    const data = input as { action?: string; a?: number; b?: number };
    if (data.action === 'add' && typeof data.a === 'number' && typeof data.b === 'number') {
      return { result: data.a + data.b };
    }
    throw new ToolValidationError('calculator', ['unsupported operation']);
  },
};

const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({ apiKey }),
  tools: [calculatorTool],
});
```

### Schema Requirements

- `inputSchema` must follow JSON Schema — Zod `safeParse` inside `execute()` is the recommended pattern for type-safe access
- `additionalProperties: false` is required
- Empty `inputSchema` (`{}`) is forbidden — throws `ConfigValidationError` at construction

### Error Handling

Throw typed errors from `execute()`:

| Error                 | When                             | Retryable |
| --------------------- | -------------------------------- | --------- |
| `ToolExecutionError`  | Execution failure (e.g. network) | Yes       |
| `ToolValidationError` | Invalid input format             | No        |

The kernel catches these and maps them to `ToolResult.error`, which is returned to the LLM for the next tool round.

## Memory

Add conversation persistence with a `MemoryAdapter` and pass `sessionId` on each `run()`:

```typescript
import { InMemoryAdapter } from '@atisse/memory-inmemory';

const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({ apiKey }),
  memoryAdapter: new InMemoryAdapter(),
});

// First turn
await orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' });

// Second turn — previous conversation is loaded automatically
await orchestrator.run({ prompt: 'What did I just say?', sessionId: 'session-1' });
```

### Save Semantics

`MemoryAdapter.save()` **appends** to existing history — it never replaces. Each `run()` saves exactly one user message and one assistant message. See ADR-012.

### Available Adapters

| Package                   | Class                | Production                    |
| ------------------------- | -------------------- | ----------------------------- |
| `@atisse/memory-inmemory` | `InMemoryAdapter`    | No (reference impl)           |
| `@atisse/memory-redis`    | `RedisMemoryAdapter` | Yes (TTL, connection pooling) |

```typescript
import { RedisMemoryAdapter } from '@atisse/memory-redis';
import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();

const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({ apiKey }),
  memoryAdapter: new RedisMemoryAdapter({ client }),
});
```

## Streaming

Enable streaming by passing `stream: true` to `run()`:

```typescript
const stream = await orchestrator.run({ prompt: 'Write a poem', stream: true });

for await (const chunk of stream) {
  switch (chunk.type) {
    case 'text':
      process.stdout.write(chunk.delta);
      break;
    case 'tool_call':
      console.log('\n[Tool call:', chunk.toolCall.name, ']');
      break;
    case 'tool_result':
      console.log('\n[Tool result:', chunk.toolResult, ']');
      break;
    case 'done':
      console.log('\n[Done - usage:', chunk.usage, ']');
      break;
    case 'error':
      console.error('\n[Error:', chunk.error.message, ']');
      break;
  }
}
```

### Stream Chunk Types

| Type          | Fields                     | Description           |
| ------------- | -------------------------- | --------------------- |
| `text`        | `delta: string`            | Text delta            |
| `tool_call`   | `toolCall: ToolCall`       | Tool call request     |
| `tool_result` | `toolResult: ToolResult`   | Tool execution result |
| `done`        | `usage?: TokenUsage`       | Stream complete       |
| `error`       | `error: OrchestratorError` | Stream error          |

The stream always terminates with exactly one `done` or `error` chunk. Consumers MUST handle unknown `type` values for forward-compatibility.

### Forbidden Combination

`stream: true` with `fallbackProvider` configured throws `ConfigValidationError` at `run()` entry — a provider failure mid-stream cannot be transparently recovered when the consumer has already received partial output (ADR-017).

## Profiles

Profiles let you define multiple behavior presets on a single `Orchestrator` instance:

```typescript
const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({ apiKey, model: 'gpt-4o' }),
  profiles: {
    editor: {
      name: 'editor',
      systemPrompt: 'You are a copy editor. Review text for grammar and clarity.',
    },
    analyzer: {
      name: 'analyzer',
      systemPrompt: 'You are a data analyst. Provide structured analysis.',
      tools: [analyticsTool],
    },
  },
});

const editorResult = await orchestrator.run({ prompt: 'Fix this text', profile: 'editor' });
const analyzerResult = await orchestrator.run({ prompt: 'Analyze this data', profile: 'analyzer' });
```

### Profile Merge Rules

| Field                            | Merge Strategy                                        |
| -------------------------------- | ----------------------------------------------------- |
| `provider`                       | Replaces base provider                                |
| `fallbackProvider`               | Replaces base fallback                                |
| `systemPrompt`                   | Replaces base systemPrompt                            |
| `retry`, `timeout`, `toolPolicy` | Deep merge — profile keys override matching base keys |
| `contextProviders`               | Replaces base list when defined (`[]` = empty list)   |
| `tools`                          | Replaces base list when defined (`[]` = empty list)   |
| `hooks`                          | Concatenated — base hooks execute first               |

**Important distinction:**

- `tools: []` — replaces base tools with an empty list (no tools active for this profile)
- `tools: undefined` — base tool list is preserved unchanged

### Profile Validation

- `profiles[key].name !== key` → `ConfigValidationError` at construction
- Missing profile key at `run()` entry → `ConfigValidationError`

## Observability

### Event Bus

Register event listeners with `orchestrator.on()`:

```typescript
const unsubscribe = orchestrator.on('run.completed', (event) => {
  console.log(`Run ${event.runId} completed in ${event.durationMs}ms`);
  console.log(`Token usage:`, event.usage);
});

orchestrator.on('run.failed', (event) => {
  console.error(`Run ${event.runId} failed:`, event.error.message);
});

orchestrator.on('retry.attempted', (event) => {
  console.log(`Retry ${event.attempt}: ${event.reason}, delay ${event.delayMs}ms`);
});

orchestrator.on('fallback.triggered', (event) => {
  console.log(`Falling back: ${event.reason}`);
});

// Later — unsubscribe to prevent memory leaks
unsubscribe();
```

### Available Event Types

| Event                | Payload                                    | Description                       |
| -------------------- | ------------------------------------------ | --------------------------------- |
| `run.started`        | `runId, timestamp, profile?`               | Run started                       |
| `run.completed`      | `runId, durationMs, usage, timings?`       | Run completed successfully        |
| `run.failed`         | `runId, error`                             | Run failed with an error          |
| `generate.started`   | `runId, messageCount`                      | Provider generation started       |
| `generate.completed` | `runId, durationMs, finishReason`          | Provider generation completed     |
| `tool.called`        | `runId, toolName, round`                   | Tool execution started            |
| `tool.completed`     | `runId, toolName, durationMs`              | Tool execution succeeded          |
| `tool.failed`        | `runId, toolName, error`                   | Tool execution failed             |
| `retry.attempted`    | `runId, attempt, reason, delayMs`          | Retry attempt triggered           |
| `fallback.triggered` | `runId, reason`                            | Fallback provider activated       |
| `context.loaded`     | `runId, providerId, messageCount`          | Context provider returned results |
| `context.failed`     | `runId, providerId, error`                 | Context provider failed           |
| `profile.resolved`   | `runId, profileName, overrides, hookCount` | Profile resolved for the run      |

**Important:** Event listeners MUST NOT throw — errors are silently swallowed. Always wrap listener logic in try/catch.

### Lifecycle Hooks

Hooks are pipeline-blocking and execute serially in registration order. A throwing hook aborts execution.

```typescript
const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({ apiKey }),
  hooks: {
    beforeRun: [
      (ctx) => {
        console.log(`Run ${ctx.runId} starting`);
        return ctx; // MUST return context
      },
    ],
    afterGenerate: [
      (ctx) => {
        console.log(`Generation finished: ${ctx.response.finishReason}`);
        return ctx;
      },
    ],
  },
});
```

Available hook points: `beforeRun`, `afterRun`, `beforeGenerate`, `afterGenerate`, `beforeTool`, `afterTool`.
