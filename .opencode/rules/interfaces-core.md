# INTERFACES — CORE CONTRACTS
## Frozen Public Contracts — v1 · Part 1 of 2

**STATUS: FROZEN**
Breaking changes are forbidden during v1. Backward-compatible additions (optional fields only) require SPSA approval.
Runtime contracts (policies, run I/O, hooks, events, config, profile, Orchestrator class) → `interfaces-runtime.md`.

Source file: `packages/core/src/interfaces.ts`

---

## Lifecycle State

Exported so consumers can type-check `InvalidStateTransitionError.from` / `.to` fields.
`errors.ts` imports this via `import type` — no runtime circular dependency.

```typescript
export type LifecycleState =
  | 'INITIALIZED'     | 'CONTEXT_INJECTING' | 'CONTEXT_INJECTED'
  | 'PROMPT_COMPOSED' | 'GENERATING'         | 'TOOL_EXECUTING'
  | 'RETRYING'        | 'FALLBACKING'         | 'COMPLETING'
  | 'COMPLETED'       | 'FAILED';
```

---

## Error Code Registry

All kernel error codes in one union. `errors.ts` imports via `import type`.
Adding a code is MINOR (union widening). Removing a code is MAJOR (breaking).

```typescript
export type OrchestratorErrorCode =
  | 'PROVIDER_RATE_LIMIT'       | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_UNAVAILABLE'      | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_MALFORMED_RESPONSE'
  | 'TOOL_EXECUTION_FAILED'     | 'TOOL_VALIDATION_FAILED'  | 'TOOL_NOT_FOUND'
  | 'CONTEXT_LOAD_FAILED'       | 'CONTEXT_PROVIDER_FAILED'
  | 'MAX_RETRIES_EXCEEDED'      | 'TOKEN_LIMIT_EXCEEDED'
  | 'TIMEOUT_EXCEEDED'          | 'FALLBACK_EXHAUSTED'
  | 'INVALID_STATE_TRANSITION'  | 'CONFIG_VALIDATION_FAILED';
```

---

## Event Error Payload

Serialized error representation for event bus payloads (`tool.failed`, `context.failed`).
Never thrown — data transfer object only.
Semantically distinct from `ToolResultError` (tool result DTO) and `OrchestratorError` (thrown errors).
Shape convergence with `ToolResultError` is accidental — may diverge in future versions.

```typescript
export interface EventErrorPayload {
  code: OrchestratorErrorCode;
  message: string;
  retryable: boolean;
}
```

---

## Provider Contracts

```typescript
export interface AIProvider {
  readonly id: string;
  // Convention: "{provider}-{model}" e.g. "openai-gpt-4o". Stable across instances.
  // Configuration metadata — not a secret; safe in event payloads and logs.
  readonly capabilities: ProviderCapabilities;
  generate(request: PromptRequest): Promise<PromptResponse>;
  generateStream?(request: PromptRequest): Promise<AsyncIterable<StreamChunk>>;
  // Promise<AsyncIterable>: connection errors surface before streaming begins.
  // Bare AsyncIterable would defer errors to the first chunk read.
}

export interface ProviderCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  vision: boolean;          // documentation only — does not affect pipeline behavior
  maxContextTokens: number; // input context limit; output limit via PromptRequest.maxTokens
}

export interface PromptRequest {
  messages: Message[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  providerOptions?: Record<string, unknown>; // provider-specific params; kernel is agnostic
  signal?: AbortSignal; // kernel-injected when generateTimeoutMs is active; honor if supported
}

export interface PromptResponse {
  text: string;           // empty string when finishReason is 'tool_calls'
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  finishReason: 'stop' | 'tool_calls' | 'length';
  // 'error' is intentionally absent — provider errors MUST be thrown, never returned in response
}
```

---

## Message Model

Discriminated union — impossible states are unrepresentable at compile time.

```typescript
export type Message =
  | { role: 'system';    content: string | MessageContent[] }
  | { role: 'user';      content: string | MessageContent[] }
  | { role: 'assistant'; content: string | MessageContent[]; toolCalls?: ToolCall[] }
  | { role: 'tool';      content: string | MessageContent[]; toolCallId: string; name: string };
  // role:'tool' — toolCallId and name are REQUIRED; links result to the originating ToolCall

export type MessageContent =
  | { type: 'text';  text: string }
  | { type: 'image'; url: string; mimeType: string };
  // url accepts data URIs (data:image/jpeg;base64,...) — adapter parses as needed

export type SystemMessage = Extract<Message, { role: 'system' }>;
// Utility type — enforces ContextProvider output trust boundary at compile time
// Derived from Message union; tracks any changes to the system arm automatically
```

**Role rules:**
- `run.input.prompt` → ALWAYS `role: 'user'` — never `role: 'system'`
- `role: 'system'` → hardcoded hook instructions, ContextProvider output, profile systemPrompt only

---

## Tool Contracts

```typescript
export interface ToolDefinition {
  name: string;
  // Convention: snake_case ≤64 chars; provider format restrictions apply — see adapter docs
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object; empty {} is FORBIDDEN — see CONSTRAINTS.md
}

export interface Tool extends ToolDefinition {
  execute(input: unknown): Promise<unknown>;
  // input/output typed as unknown — use Zod safeParse inside execute() for type narrowing
  // Typed generics: v2 candidate
  // Kernel wraps execute() in Promise.race against toolPolicy.toolTimeoutMs
}

export interface ToolCall {
  id: string;    // provider-assigned; adapter MUST generate (e.g. randomUUID) if provider omits
  name: string;
  input: unknown;
}

export type ToolResult =
  | { id: string; name: string; output: unknown;  error?: never }
  | { id: string; name: string; output?: never;   error: ToolResultError };
// output and error are mutually exclusive — discriminated union
// output MUST be JSON.stringify-serializable before entering the message pipeline

export interface ToolResultError {
  code: 'TOOL_EXECUTION_FAILED' | 'TOOL_VALIDATION_FAILED' | 'TOOL_NOT_FOUND';
  message: string;
  retryable: boolean;
}
// Data transfer object — lives in ToolResult.error only; never thrown
// Distinct from EventErrorPayload (event bus payloads) — same shape, different semantic
```

---

## Memory & Context Contracts

```typescript
export interface MemoryAdapter {
  load(sessionId: string): Promise<Message[]>;
  // Returns [] (never throws) for unknown sessionId — new sessions start empty

  save(sessionId: string, messages: Message[]): Promise<void>;
  // APPENDS the provided batch — never replaces existing history
  // Called once per run() at COMPLETING with [userMessage, assistantMessage]

  clear(sessionId: string): Promise<void>;
  // Idempotent — non-existent sessionId silently succeeds, never throws
}

export type ContextProviderInput = Omit<RunInput, 'stream' | 'profile'>;
// 'stream' and 'profile' are pipeline-internal routing fields — not exposed to providers

export interface ContextProvider {
  readonly id: string;
  provide(input: ContextProviderInput): Promise<SystemMessage[]>;
  // Returns [] (never throws) when no context is available
  // input.prompt MAY be used for retrieval queries
  // input.prompt MUST NOT be forwarded as role:'system' content — see SECURITY.md S-2, S-6
}
```

---

## Token Usage

```typescript
export interface TokenUsage {
  prompt: number;
  completion: number;
  total: number;
  // Use provider-reported value — may differ from prompt+completion (e.g. cached tokens)
}
```

---

## Contract Rules for Core Types

1. `AIProvider.id` convention: `"{provider}-{model}"` — stable across instances
2. `MemoryAdapter.load()` MUST return `[]`, not throw, for unknown sessionId
3. `MemoryAdapter.save()` MUST append — never replace existing history
4. `MemoryAdapter.clear()` MUST be idempotent — non-existent session is not an error
5. `ContextProvider.provide()` MUST return `[]`, not throw, when no context is available
6. `ContextProvider.provide()` MUST NOT map `input.prompt` to `role: 'system'` output
7. `Tool.execute()` MUST throw a typed error on failure — never return an error object
8. `ToolResult.output` MUST be `JSON.stringify`-serializable
9. `ToolCall.id` MUST be set — adapter generates via `randomUUID()` if provider omits
10. Token trimming applies to `memoryMessages` only — context and system messages are never trimmed
