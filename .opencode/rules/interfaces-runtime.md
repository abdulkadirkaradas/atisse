# INTERFACES — RUNTIME CONTRACTS

## Frozen Public Contracts — v1 · Part 2 of 2

**STATUS: FROZEN**
Breaking changes are forbidden during v1. Backward-compatible additions (optional fields only) require SPSA approval.
Core type contracts (LifecycleState, error codes, provider, message, tool, memory, context) → `interfaces-core.md`.

Source file: `packages/core/src/interfaces.ts`

---

## Policy Contracts

```typescript
export interface RetryPolicy {
  maxAttempts: number; // TOTAL attempts (1 initial + N-1 retries); maxAttempts:3 = 3 provider calls; default: 3
  baseDelayMs: number; // default: 500
  maxDelayMs: number; // default: 30_000
  jitter: boolean; // 30% partial jitter applied when true; default: true
}

export interface TimeoutPolicy {
  generateTimeoutMs: number; // per provider call; AbortSignal injected into PromptRequest.signal; default: 30_000
  toolTimeoutMs: number; // per Tool.execute(); enforced via Promise.race in ToolController; default: 10_000
  totalTimeoutMs: number; // entire run() wall-clock; enforced via Promise.race at top level; default: 60_000
}

export interface ToolPolicy {
  maxToolRounds: number; // cumulative across entire run() — never resets on retry; default: 5; min: 1
  allowParallelTools: boolean; // MUST be false in v1; true → ConfigValidationError at construction; default: false
  toolTimeoutMs: number; // mirror of TimeoutPolicy.toolTimeoutMs; synced by profile resolver at run() entry; ToolController enforces via Promise.race; default: 10_000
}
```

---

## Run I/O Contracts

```typescript
export interface RunInput {
  prompt: string;
  profile?: string; // Record key in OrchestratorConfig.profiles
  // Missing key → ConfigValidationError at run() entry
  sessionId?: string;
  stream?: boolean; // undefined treated as false
  metadata?: Record<string, unknown>; // pass-through; kernel does not read or modify
}

export interface RunOutput {
  runId: string; // correlation key — present in all logs and events
  text: string; // always string; "" when LLM produces only tool calls
  toolResults: ToolResult[]; // all rounds combined; [] when no tools called
  usage: TokenUsage;
  durationMs: number; // wall-clock time of entire run()
  profile?: string; // active profile name; undefined if no profile used
  metadata?: Record<string, unknown>; // pass-through from RunInput.metadata
}

// Discriminated union — each type carries exactly the fields it needs
export type StreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
  | { type: 'done'; usage?: TokenUsage }
  // usage optional — some providers do not report usage in streaming mode
  | { type: 'error'; error: OrchestratorError };
// OrchestratorError imported via `import type` from errors.ts — no runtime circular dependency
// Stream always terminates with exactly one 'done' or 'error' chunk
// Consumers MUST handle unknown type values gracefully (forward-compatibility)
```

---

## Hook Contracts

Hooks are pipeline-blocking and execute serially in registration order.
Throwing aborts execution — error propagates as run() rejection.
Returning `undefined` or `null` throws an internal error — always return the context object.

```typescript
export type LifecycleHook<TContext> = (context: TContext) => Promise<TContext> | TContext;

export interface HookRegistry {
  beforeRun: ReadonlyArray<LifecycleHook<RunContext>>;
  afterRun: ReadonlyArray<LifecycleHook<AfterRunContext>>;
  beforeGenerate: ReadonlyArray<LifecycleHook<BeforeGenerateContext>>;
  afterGenerate: ReadonlyArray<LifecycleHook<AfterGenerateContext>>;
  beforeTool: ReadonlyArray<LifecycleHook<ToolContext>>;
  afterTool: ReadonlyArray<LifecycleHook<AfterToolContext>>;
}

export interface RunContext {
  input: RunInput;
  runId: string;
}
export type AfterRunContext = RunContext & { output: RunOutput };

export interface BeforeGenerateContext {
  messages: Message[];
  input: RunInput;
  runId: string;
}
// response is NOT available here — the provider has not been called yet

export interface AfterGenerateContext {
  messages: Message[];
  response: PromptResponse;
  input: RunInput;
  runId: string;
}
// In streaming mode: called AFTER the 'done' chunk — response holds accumulated text and usage

export interface ToolContext {
  toolCall: ToolCall;
  input: RunInput;
  runId: string;
}
export type AfterToolContext = ToolContext & { toolResult: ToolResult };
```

---

## Logger Contract

```typescript
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
// If not provided: a no-op logger is used — no output, no errors thrown
// Always inject a Logger in production — silent failures are difficult to diagnose
// Built-in logger implementation: V2 candidate
```

---

## Orchestrator Config Contract

```typescript
export interface OrchestratorConfig {
  provider: AIProvider; // required
  fallbackProvider?: AIProvider;
  systemPrompt?: string; // global system prompt; profile.systemPrompt replaces (not appends)
  tools?: Tool[]; // duplicate names → ConfigValidationError at construction
  contextProviders?: ContextProvider[];
  memoryAdapter?: MemoryAdapter;
  retry?: Partial<RetryPolicy>; // merged with defaults; omitted fields use defaults
  timeout?: Partial<TimeoutPolicy>;
  toolPolicy?: Partial<ToolPolicy>;
  hooks?: Partial<HookRegistry>;
  profiles?: Record<string, OrchestratorProfile>;
  // Every key MUST equal the profile.name value — mismatch → ConfigValidationError at construction
  logger?: Logger;
}
```

---

## Profile Contract

```typescript
export interface OrchestratorProfile {
  name: string; // MUST equal its Record key in OrchestratorConfig.profiles
  description?: string; // documentation only — not used by the pipeline
  provider?: AIProvider; // REPLACES base provider
  fallbackProvider?: AIProvider;
  systemPrompt?: string; // REPLACES base systemPrompt (not concatenated)
  retry?: Partial<RetryPolicy>; // deep-merged with base (profile keys override matching base keys)
  timeout?: Partial<TimeoutPolicy>;
  toolPolicy?: Partial<ToolPolicy>;
  contextProviders?: ContextProvider[]; // REPLACES base list when defined ([] also replaces)
  tools?: Tool[]; // REPLACES base list when defined ([] also replaces)
  // tools: []        → replaces base with empty list (no tools active for this profile)
  // tools: undefined → base list is preserved unchanged
  hooks?: Partial<HookRegistry>; // CONCATENATED with base (base hooks execute first)
}
```

---

## Orchestrator Class

```typescript
export class Orchestrator {
  constructor(config: OrchestratorConfig);
  // Validates eagerly at construction — throws ConfigValidationError for:
  // • provider missing
  // • any profiles[key].name !== key
  // • allowParallelTools: true
  // • maxToolRounds < 1
  // • any timeout value ≤ 0 or === Infinity
  // • duplicate tool names in the tools array

  run(input: RunInput & { stream?: false }): Promise<RunOutput>;
  run(input: RunInput & { stream: true }): Promise<AsyncIterable<StreamChunk>>;
  run(input: RunInput): Promise<RunOutput> | Promise<AsyncIterable<StreamChunk>>;
  // Third overload is the implementation signature — not part of the public API surface
  //
  // Throws ConfigValidationError at run() entry for:
  // • stream:true + fallbackProvider configured (forbidden in v1 — see CONSTRAINTS.md)
  // • stream:true + provider.capabilities.streaming === false
  // • stream:true + provider.generateStream === undefined
  // • profile key not found in config.profiles
  //
  // Never throws plain Error. Never rejects with undefined or null.

  on<T extends OrchestratorEvent['type']>(
    type: T,
    listener: (event: Extract<OrchestratorEvent, { type: T }>) => void,
  ): () => void;
  // Returns an unsubscribe function — MUST be called when listener is no longer needed
  // Registering listeners inside per-request handlers without unsubscribing causes memory leaks
}
```

---

## EventBus Contract

Internal interface — users register listeners via `orchestrator.on()` only.

```typescript
export interface EventBus {
  emit<T extends OrchestratorEvent>(event: T): void;
  on<T extends OrchestratorEvent['type']>(
    type: T,
    listener: (event: Extract<OrchestratorEvent, { type: T }>) => void,
  ): () => void;
}
```

---

## OrchestratorEvent Union

```typescript
export type OrchestratorEvent =
  | { type: 'run.started'; runId: string; timestamp: number; profile?: string }
  | { type: 'run.completed'; runId: string; durationMs: number; usage: TokenUsage }
  | { type: 'run.failed'; runId: string; error: OrchestratorError }
  // OrchestratorError instance — consumer can instanceof check; imported via `import type`
  | { type: 'generate.started'; runId: string; messageCount: number }
  | { type: 'generate.completed'; runId: string; durationMs: number; finishReason: string }
  | { type: 'tool.called'; runId: string; toolName: string; round: number }
  | { type: 'tool.completed'; runId: string; toolName: string; durationMs: number }
  | { type: 'tool.failed'; runId: string; toolName: string; error: EventErrorPayload }
  | { type: 'retry.attempt'; runId: string; attempt: number; reason: string; delayMs: number }
  | { type: 'fallback.triggered'; runId: string; reason: string }
  | { type: 'context.loaded'; runId: string; providerId: string; messageCount: number }
  | { type: 'context.failed'; runId: string; providerId: string; error: EventErrorPayload }
  | {
      type: 'profile.resolved';
      runId: string;
      profileName: string;
      overrides: {
        provider: boolean;
        tools: boolean;
        contextProviders: boolean;
        systemPrompt: boolean;
        retry: boolean;
        toolPolicy: boolean;
      };
      hookCount: number;
    };
// tool.failed / context.failed → EventErrorPayload (serialized DTO — never thrown)
// run.failed → OrchestratorError instance (actual thrown error — consumer can inspect type)
```

---

## Runtime Contract Rules

1. `run.input.prompt` is ALWAYS `role: 'user'` — never `role: 'system'`
2. `stream: true` + `fallbackProvider` → `ConfigValidationError` — forbidden in v1
3. `profiles[key].name !== key` → `ConfigValidationError` at construction
4. Duplicate tool names in `tools` array → `ConfigValidationError` at construction
5. Hook functions MUST return context — returning `undefined`/`null` throws internally
6. Event listeners MUST NOT throw — errors are silently swallowed
7. `StreamChunk` consumers MUST handle unknown `type` values (forward-compatibility)
8. `RunInput.metadata` passes through unchanged to `RunOutput.metadata`
9. `afterGenerate` hook in streaming mode is called after the `done` chunk is received
10. Tool round counter is cumulative across entire `run()` — never resets on retry
