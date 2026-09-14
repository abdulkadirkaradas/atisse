---
name: interfaces
description: Frozen v1 public contracts for @atisse/core — types, provider/tool/memory/context interfaces, run I/O, hooks, events, config, profile, Orchestrator class. Load for any adapter, any interface/type change, or any change touching run(), hooks, or events.
license: MIT
compatibility: opencode
---

# Interfaces (frozen, v1)

**Source of truth: `packages/core/src/interfaces.ts`.** This skill is a working reference,
not a substitute — if this and the source ever disagree, the source wins and this file is
stale and needs fixing. Breaking changes are forbidden in v1; backward-compatible additions
(optional fields only) require SPSA approval. See `constraints` for what counts as breaking.

## Core types

```typescript
type LifecycleState =
  | 'INITIALIZED'
  | 'CONTEXT_INJECTING'
  | 'CONTEXT_INJECTED'
  | 'PROMPT_COMPOSED'
  | 'GENERATING'
  | 'TOOL_EXECUTING'
  | 'RETRYING'
  | 'FALLBACKING'
  | 'COMPLETING'
  | 'COMPLETED'
  | 'FAILED';

type OrchestratorErrorCode =
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_MALFORMED_RESPONSE'
  | 'TOOL_EXECUTION_FAILED'
  | 'TOOL_VALIDATION_FAILED'
  | 'TOOL_NOT_FOUND'
  | 'CONTEXT_LOAD_FAILED'
  | 'CONTEXT_PROVIDER_FAILED'
  | 'MAX_RETRIES_EXCEEDED'
  | 'MEMORY_SAVE_FAILED'
  | 'MAX_TOOL_ROUNDS_EXCEEDED'
  | 'TOKEN_LIMIT_EXCEEDED'
  | 'TIMEOUT_EXCEEDED'
  | 'FALLBACK_EXHAUSTED'
  | 'INVALID_STATE_TRANSITION'
  | 'CONFIG_VALIDATION_FAILED'
  | 'HOOK_EXECUTION_FAILED'
  | 'PIPELINE_INTERNAL_ERROR'
  | 'RUN_CANCELLED';

// DTO for event payloads (tool.failed, context.failed) — never thrown.
// Structurally similar to ToolResultError but semantically distinct; may diverge later.
interface EventErrorPayload {
  code: OrchestratorErrorCode;
  message: string;
  retryable: boolean;
}
```

## Provider

```typescript
interface AIProvider {
  readonly id: string; // "{provider}-{model}" e.g. "openai-gpt-4o" — not a secret, safe to log
  readonly capabilities: ProviderCapabilities;
  generate(request: PromptRequest): Promise<PromptResponse>;
  generateStream?(request: PromptRequest): Promise<AsyncIterable<StreamChunk>>;
  // Promise<AsyncIterable>, not a bare AsyncIterable — connection errors surface before streaming starts
}
interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;
  maxContextTokens: number;
}
interface PromptRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  providerOptions?: Record<string, unknown>;
  signal?: AbortSignal; // kernel-injected via generateTimeoutMs
}
interface PromptResponse {
  text: string; // '' when finishReason is 'tool_calls'
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_calls' | 'length'; // no 'error' — provider errors are always thrown, never returned
}
```

## Message model — discriminated union, invalid states unrepresentable

```typescript
type Message =
  | { role: 'system'; content: string | MessageContent[] }
  | { role: 'user'; content: string | MessageContent[] }
  | { role: 'assistant'; content: string | MessageContent[]; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string | MessageContent[]; toolCallId: string; name: string }; // both required — links to originating ToolCall

type MessageContent =
  { type: 'text'; text: string } | { type: 'image'; url: string; mimeType: string };
type SystemMessage = Extract<Message, { role: 'system' }>; // enforces the ContextProvider trust boundary at compile time
```

**`run.input.prompt` is ALWAYS `role: 'user'`.** `role: 'system'` is reserved for hardcoded
hook instructions, `ContextProvider` output, and profile `systemPrompt` — see `security` S-2.

## Tools

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
// name: snake_case ≤64 chars. inputSchema: {} is FORBIDDEN — see constraints.

interface Tool extends ToolDefinition {
  execute(input: unknown): Promise<unknown>; // typed unknown; narrow with Zod safeParse inside
  // wrapped by the kernel in Promise.race(toolPolicy.toolTimeoutMs)
}
interface ToolCall {
  id: string;
  name: string;
  input: unknown;
} // id: adapter generates via randomUUID() if provider omits

type ToolResult =
  | { id: string; name: string; output: unknown; error?: never } // mutually exclusive with error
  | { id: string; name: string; output?: never; error: ToolResultError };
// output must be JSON.stringify-serializable before entering the message pipeline

interface ToolResultError {
  code: 'TOOL_EXECUTION_FAILED' | 'TOOL_VALIDATION_FAILED' | 'TOOL_NOT_FOUND';
  message: string;
  retryable: boolean;
}
// DTO, never thrown — lives in ToolResult.error only
```

## Memory & context

```typescript
interface MemoryAdapter {
  load(sessionId: string): Promise<Message[]>; // [] not throw, for unknown sessionId
  save(sessionId: string, messages: Message[]): Promise<void>; // APPENDS — called once per run() at COMPLETING
  clear(sessionId: string): Promise<void>; // idempotent — non-existent id silently succeeds
}
type ContextProviderInput = Omit<RunInput, 'stream' | 'profile'>; // those two fields are pipeline-internal routing only
interface ContextProvider {
  readonly id: string;
  provide(input: ContextProviderInput): Promise<SystemMessage[]>; // [] not throw; input.prompt for retrieval only, never forwarded as role:'system' content — security S-2/S-6
}
interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
} // provider-reported; may differ from prompt+completion (cached tokens)
```

## Policies

```typescript
interface RetryPolicy {
  maxAttempts: number /*TOTAL, default 3*/;
  baseDelayMs: number /*500*/;
  maxDelayMs: number /*30_000*/;
  jitter: boolean /*true, 30% partial*/;
}
interface TimeoutPolicy {
  generateTimeoutMs: number /*30_000*/;
  toolTimeoutMs: number /*10_000*/;
  totalTimeoutMs: number /*60_000, hard ceiling for whole run()*/;
}
interface ToolPolicy {
  maxToolRounds: number /*5, cumulative, never resets on retry, min 1*/;
  allowParallelTools: boolean /*MUST be false in v1*/;
  toolTimeoutMs: number;
}
```

## Run I/O

```typescript
interface RunInput {
  prompt: string;
  profile?: string;
  sessionId?: string;
  stream?: boolean /*undefined=false*/;
  metadata?: Record<string, unknown>;
  /*pass-through, kernel doesn't read it*/ signal?: AbortSignal;
}
interface RunOutput {
  runId: string;
  text: string;
  toolResults: ToolResult[];
  usage: TokenUsage;
  durationMs: number;
  profile?: string;
  metadata?: Record<string, unknown>; /*passed through from RunInput*/
}
type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
  | { type: 'done'; usage?: TokenUsage } /*optional — some providers don't report streaming usage*/
  | { type: 'error'; error: OrchestratorError };
// exactly one 'done' or 'error' terminates the stream; consumers must handle unknown `type` values gracefully
```

## Hooks — pipeline-blocking, serial, registration order

Throwing aborts execution (propagates as `run()` rejection). Returning `undefined`/`null`
throws internally — always return the context object.

```typescript
type LifecycleHook<T> = (context: T) => Promise<T> | T;
interface HookRegistry {
  beforeRun: ReadonlyArray<LifecycleHook<RunContext>>;
  afterRun: ReadonlyArray<LifecycleHook<AfterRunContext>>;
  beforeGenerate: ReadonlyArray<LifecycleHook<BeforeGenerateContext>>; // response NOT available — provider not called yet
  afterGenerate: ReadonlyArray<LifecycleHook<AfterGenerateContext>>; // streaming: fires after 'done', response is accumulated
  beforeTool: ReadonlyArray<LifecycleHook<ToolContext>>;
  afterTool: ReadonlyArray<LifecycleHook<AfterToolContext>>;
}
interface RunContext {
  input: RunInput;
  runId: string;
}
type AfterRunContext = RunContext & { output: RunOutput };
interface BeforeGenerateContext {
  messages: Message[];
  input: RunInput;
  runId: string;
}
interface AfterGenerateContext {
  messages: Message[];
  response: PromptResponse;
  input: RunInput;
  runId: string;
}
interface ToolContext {
  toolCall: ToolCall;
  input: RunInput;
  runId: string;
}
type AfterToolContext = ToolContext & { toolResult: ToolResult };
```

More on hook vs. event semantics and use cases: `hooks-events` skill.

## Logger

```typescript
interface Logger { debug/info/warn/error(msg: string, meta?: Record<string, unknown>): void; }
// no-op if not provided — always inject one in production, silent failures are hard to diagnose
```

## Config, Profile, Orchestrator

```typescript
interface OrchestratorConfig {
  provider: AIProvider;
  fallbackProvider?: AIProvider;
  systemPrompt?: string; // profile.systemPrompt REPLACES this, doesn't append
  tools?: Tool[]; // duplicate names → ConfigValidationError at construction
  contextProviders?: ContextProvider[];
  memoryAdapter?: MemoryAdapter;
  retry?: Partial<RetryPolicy>;
  timeout?: Partial<TimeoutPolicy>;
  toolPolicy?: Partial<ToolPolicy>;
  hooks?: Partial<HookRegistry>;
  profiles?: Record<string, OrchestratorProfile>; // every key MUST equal profile.name — else ConfigValidationError
  logger?: Logger;
}
interface OrchestratorProfile {
  name: string; // must equal its Record key
  description?: string; // docs only, not used by the pipeline
  provider?: AIProvider;
  fallbackProvider?: AIProvider;
  systemPrompt?: string; // REPLACES base
  retry?: Partial<RetryPolicy>;
  timeout?: Partial<TimeoutPolicy>;
  toolPolicy?: Partial<ToolPolicy>; // deep-merge, profile wins
  contextProviders?: ContextProvider[];
  tools?: Tool[]; // REPLACE base list when defined (even [])
  hooks?: Partial<HookRegistry>; // CONCATENATE with base, base first
}
class Orchestrator {
  constructor(config: OrchestratorConfig);
  // validates eagerly — ConfigValidationError for: missing provider, profiles[key].name!==key,
  // allowParallelTools:true, maxToolRounds<1, any timeout ≤0 or Infinity, duplicate tool names

  run(input: RunInput & { stream?: false }): Promise<RunOutput>;
  run(input: RunInput & { stream: true }): Promise<AsyncIterable<StreamChunk>>;
  // ConfigValidationError at run() entry for: stream:true + fallbackProvider (forbidden in v1),
  // stream:true + capabilities.streaming===false, stream:true + generateStream===undefined,
  // profile key not found. Never throws plain Error, never rejects with undefined/null.

  on<T extends OrchestratorEvent['type']>(
    type: T,
    listener: (e: Extract<OrchestratorEvent, { type: T }>) => void,
  ): () => void;
  // returns an unsubscribe fn — MUST be called or long-running servers leak listeners
}
```

## Events

```typescript
type OrchestratorEvent =
  | { type: 'run.started'; runId: string; timestamp: number; profile?: string }
  | { type: 'run.completed'; runId: string; durationMs: number; usage: TokenUsage; timings?: StepTimings }
  | { type: 'run.failed'; runId: string; error: OrchestratorError }  // actual instance, instanceof-able
  | { type: 'generate.started'|'generate.completed'; runId: string; /* + fields */ }
  | { type: 'tool.called'|'tool.completed'; runId: string; toolName: string; /* + fields */ }
  | { type: 'tool.failed'; runId: string; toolName: string; error: EventErrorPayload }
  | { type: 'context.loaded'; runId: string; providerId: string; messageCount: number }
  | { type: 'context.failed'; runId: string; providerId: string; error: EventErrorPayload }
  | { type: 'retry.attempted'; runId: string; attempt: number; reason: string; delayMs: number }
  | { type: 'fallback.triggered'; runId: string; reason: string }
  | { type: 'profile.resolved'; runId: string; profileName: string; overrides: {...}; hookCount: number };
// tool.failed/context.failed carry EventErrorPayload (DTO); run.failed carries the real OrchestratorError
```

## The 10 rules that don't fit anywhere above

1. `run.input.prompt` is always `role: 'user'`, never `role: 'system'`.
2. `stream: true` + `fallbackProvider` → forbidden, `ConfigValidationError`.
3. `profiles[key].name !== key` → `ConfigValidationError` at construction.
4. Duplicate tool names → `ConfigValidationError` at construction.
5. Hooks must return context — `undefined`/`null` throws internally.
6. Event listeners must never throw — errors are silently swallowed.
7. `StreamChunk` consumers must handle unknown `type` values (forward-compat).
8. `RunInput.metadata` passes through to `RunOutput.metadata` unchanged.
9. `afterGenerate` in streaming mode fires after the `done` chunk.
10. Tool round counter is cumulative across the whole `run()` — never resets on retry.
