# M2 Implementation Plan

## Core Kernel — `run()` End-to-End

**Status:** Ready to implement
**Blocker:** M1 complete
**Prerequisite Decisions:** All M1 decisions + D-M2-1(A) + D-M2-2(A)

---

## 1. Mandatory Reading Before Writing Any Code

1. `.opencode/rules/interfaces-core.md` + `.opencode/rules/interfaces-runtime.md` — frozen contracts
2. `.opencode/rules/architecture.md` — execution flow steps 1–10 (primary reference)
3. `.opencode/rules/state-machine.md` — transition table
4. `.opencode/rules/error-taxonomy.md` — retry classification
5. `.opencode/rules/constraints.md` — forbidden patterns
6. `.opencode/rules/typescript-style.md` + `.opencode/rules/implementation-standards.md`
7. `.opencode/workflows/testing-standards.md` — MockProvider API, required test scenarios

---

## 2. Approved Decisions

### D-M2-1: `MemoryAdapter.save()` failure in COMPLETING → `FAILED`

**Rationale:** A partial save corrupts the next session. Consistency over convenience.
`ContextLoadError` is thrown but pipeline transitions directly to `FAILED` — the `isRetryable()`
check is bypassed at this step because D-M2-1 locks the behavior architecturally.
The run output is not returned. The caller decides whether to retry.

### D-M2-2: Tool execution failure within a round → fail-fast, partial results discarded

**Rationale:** Consistent with ADR-015. Sending partial tool results forces the LLM to reason
over incomplete context. `ToolExecutionError` → `RETRYING`, `ToolValidationError` → `FAILED`.

### D-M2-3: Single timeout utility — `rejectAfter(ms)`

**Rationale:** `rejectAfter(ms: number): Promise<never>` is defined once in `policies.ts` and
imported wherever a `Promise.race` timeout guard is needed. No alias, no duplication.

### D-M2-4: `MaxToolRoundsExceededError` added to error taxonomy

**Rationale:** `PolicyError` does not exist in the taxonomy — using it would be a bug.
`MaxToolRoundsExceededError` is non-retryable (`retryable: false`), extends `OrchestratorError`,
and its code `'MAX_TOOL_ROUNDS_EXCEEDED'` is added to the `OrchestratorErrorCode` union.
This is a union widening (MINOR, ADR-022) — not a breaking change.

> **Note:** `.opencode/rules/interfaces-core.md` and `.opencode/rules/error-taxonomy.md` are frozen files. The additions
> required by D-M2-4 must be applied to both files before implementation begins.
> This is a MINOR backward-compatible change under SPSA authority.

---

## 3. Pre-Implementation: Contract Updates Required

Before any M2 code is written, apply the following additions to frozen files.

### `.opencode/rules/interfaces-core.md` — `OrchestratorErrorCode` union

Add `'MAX_TOOL_ROUNDS_EXCEEDED'` to the union:

```typescript
export type OrchestratorErrorCode =
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
  | 'MAX_TOOL_ROUNDS_EXCEEDED' // NEW
  | 'TOKEN_LIMIT_EXCEEDED'
  | 'TIMEOUT_EXCEEDED'
  | 'FALLBACK_EXHAUSTED'
  | 'INVALID_STATE_TRANSITION'
  | 'CONFIG_VALIDATION_FAILED';
```

### `.opencode/rules/error-taxonomy.md` — New error class
Add under `PolicyError` group:

```typescript
export class MaxToolRoundsExceededError extends OrchestratorError {
  readonly code = 'MAX_TOOL_ROUNDS_EXCEEDED' as const;
  readonly retryable = false;
  constructor(
    public readonly rounds: number,
    public readonly maxRounds: number,
  ) {
    super(`Tool round limit exceeded: ${rounds}/${maxRounds}`);
  }
}
```

### `packages/core/src/types.ts` — `ResolvedConfig` internal type

Add to `types.ts` (internal — not exported from `index.ts`):

```typescript
// Internal type — post-profile-merge config passed to pipeline.ts
// Not exported. Adapter authors never see this type.
export interface ResolvedConfig {
  provider: AIProvider;
  fallbackProvider?: AIProvider;
  systemPrompt?: string;
  tools: Map<string, Tool>;
  contextProviders: ContextProvider[];
  memoryAdapter?: MemoryAdapter;
  retry: RetryPolicy;
  timeout: TimeoutPolicy;
  toolPolicy: ToolPolicy;
  hooks: HookRegistry;
  logger: Logger;
}
```

---

## 4. Implementation Order

```
Phase 1  — policies.ts          (L1 primitive)
Phase 2  — profile.ts           (L1 primitive) ← ADDED
Phase 3  — prompt-composer.ts   (L1 primitive)
Phase 4  — tool-controller.ts   (L2 controller)
Phase 5  — hooks.ts             (L2 controller)
Phase 6  — events.ts            (L2 controller)
Phase 7  — pipeline.ts          (L3 — wires all steps together)
Phase 8  — orchestrator.ts      (L4 — public surface)
Phase 9  — memory-inmemory      (full implementation)
Phase 10 — integration tests
Phase 11 — CI update
```

Compile and typecheck after each phase before proceeding:
`pnpm --filter @atisse/core typecheck`

---

## 5. Phase 1 — `packages/core/src/policies.ts`

Layer 1 primitive. Default constants are internal — not exported.

### Implementation Checklist

**Default Constants (internal — not exported):**

- [ ] `DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true }`
- [ ] `DEFAULT_TIMEOUT: TimeoutPolicy = { generateTimeoutMs: 30_000, toolTimeoutMs: 10_000, totalTimeoutMs: 60_000 }`
- [ ] `DEFAULT_TOOL_POLICY: ToolPolicy = { maxToolRounds: 5, allowParallelTools: false }`

**Merge Utilities (internal — not exported):**

- [ ] `mergeRetryPolicy(base: RetryPolicy, override?: Partial<RetryPolicy>): RetryPolicy`
- [ ] `mergeTimeoutPolicy(base: TimeoutPolicy, override?: Partial<TimeoutPolicy>): TimeoutPolicy`
- [ ] `mergeToolPolicy(base: ToolPolicy, override?: Partial<ToolPolicy>): ToolPolicy`

**Timeout Utility (internal — not exported, used by pipeline.ts and tool-controller.ts):**

- [ ] `rejectAfter(ms: number): Promise<never>` — single canonical timeout helper (D-M2-3)
  - Returns a Promise that rejects with `TimeoutExceededError(ms)` after `ms` milliseconds
  - Used in all `Promise.race` timeout guards throughout the codebase

**Delay Calculation:**

- [ ] `calculateDelay(attempt: number, policy: RetryPolicy): number`
  - `exponential = baseDelayMs * Math.pow(2, attempt)`
  - `capped = Math.min(exponential, maxDelayMs)`
  - When `policy.jitter === true`: `capped + Math.random() * 0.3 * capped`
- [ ] When `ProviderRateLimitError.retryAfterMs` is present, use it instead of the exponential value

**Core Retry Logic:**

- [ ] `executeWithRetry<T>(fn: () => Promise<T>, policy: RetryPolicy, onRetry?: (attempt: number, error: OrchestratorError) => void): Promise<T>`
  - First call is attempt 0; first retry is attempt 1
  - `isRetryable(error) === false` → rethrow immediately
  - `attempt === policy.maxAttempts` → throw `MaxRetriesExceededError(attempts, lastError)`
  - Call `onRetry?.(attempt, error)` before each retry delay
  - `await sleep(delay)` — compatible with `vi.useFakeTimers()`
- [ ] `executeWithFallback<T>(primary: () => Promise<T>, fallback: (() => Promise<T>) | undefined, policy: RetryPolicy, onRetry?: ...): Promise<T>`
  - Primary throws `MaxRetriesExceededError` + fallback defined → call fallback once (no retry)
  - Fallback also fails → throw `FallbackExhaustedError(primaryError, fallbackError)`
- [ ] `sleep(ms: number): Promise<void>` — internal utility, not exported

**Layer constraint:** `policies.ts` must not import from any L2, L3, or L4 file.

---

## 6. Phase 2 — `packages/core/src/profile.ts`

Layer 1 primitive. Owns all profile merge logic. `orchestrator.ts` calls `resolveConfig()` —
it does not implement merge logic itself.

### Implementation Checklist

- [ ] `resolveConfig(base: OrchestratorConfig, profileName: string | undefined, tools: Map<string, Tool>): ResolvedConfig`
  - When `profileName` is undefined: build `ResolvedConfig` from base config only
  - When `profileName` is present: apply profile merge rules (see below)
  - Returns a fully resolved `ResolvedConfig` with all defaults merged in

**Merge rules per `.opencode/rules/interfaces-runtime.md` §Profile Contract:**

| Field                            | Strategy                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------- |
| `provider`, `systemPrompt`       | Profile value replaces base (`??`)                                               |
| `fallbackProvider`               | Profile value replaces base (`??`)                                               |
| `retry`, `timeout`, `toolPolicy` | Deep merge — profile keys override matching base keys                            |
| `tools`                          | Profile defined (including `[]`) → full replace; `undefined` → preserve base Map |
| `contextProviders`               | Profile defined (including `[]`) → full replace; `undefined` → preserve base     |
| `hooks`                          | Concatenate — base hooks first, profile hooks second                             |

- [ ] Apply `mergeRetryPolicy`, `mergeTimeoutPolicy`, `mergeToolPolicy` from `policies.ts`
- [ ] Apply `mergeHookRegistries` from `hooks.ts`
  - **Note:** `hooks.ts` is L2, `profile.ts` is L1. Since `profile.ts` calls `mergeHookRegistries`,
    this function must be moved to `policies.ts` (L1) or implemented inline in `profile.ts`.
    **Decision:** Implement `mergeHookRegistries` in `profile.ts` directly — it is a pure merge
    operation with no L2 dependencies.
- [ ] `tools` field in `ResolvedConfig` is always `Map<string, Tool>` — convert array to Map here
- [ ] When `profileName` is set, resolved config defaults are sourced from `DEFAULT_*` constants
      in `policies.ts`, not from the base config's `Partial<>` fields

**Layer constraint:** `profile.ts` imports from L0 only (`interfaces.ts`, `errors.ts`, `types.ts`)
and `policies.ts` (also L1). Must not import from L2, L3, or L4.

---

## 7. Phase 3 — `packages/core/src/prompt-composer.ts`

Layer 1 primitive. Stateless class — no constructor dependencies.

### Implementation Checklist

- [ ] `PromptComposer` class
- [ ] `compose(params: ComposeParams): Message[]`

```typescript
interface ComposeParams {
  systemPrompt?: string;
  contextMessages: SystemMessage[];
  memoryMessages: Message[];
  userPrompt: string;
  maxTokens?: number;
}
```

**Assembly order (frozen per `.opencode/rules/architecture.md` Step 4):**

1. `systemPrompt` → `{ role: 'system', content: systemPrompt }` (only when present)
2. `contextMessages` — never trimmed, passed through as-is
3. `memoryMessages` — trimmed via `trimToTokenLimit()` when `maxTokens` is set
4. `{ role: 'user', content: userPrompt }` — always last

- [ ] `private trimToTokenLimit(messages: Message[], maxTokens: number): Message[]`
  - Drop oldest messages first (reversed iteration)
  - `contextMessages` and `systemPrompt` are never trimmed
- [ ] `private estimateTokens(content: string | MessageContent[]): number`
  - `Math.ceil(text.length / 4)` approximation (V2 candidate — documented in code)
  - For `MessageContent[]`: sum the text length of each item

**Security constraints:**

- `userPrompt` is always mapped to `role: 'user'` — never `role: 'system'` (`.opencode/rules/security.md` S-2)
- `composeParams.userPrompt` must never appear as system message content

---

## 8. Phase 4 — `packages/core/src/tool-controller.ts`

Layer 2 controller.

### Implementation Checklist

- [ ] `ToolController` constructor: `(tools: Map<string, Tool>, policy: ToolPolicy, logger: Logger)`
- [ ] `executeRound(toolCalls: ToolCall[]): Promise<ToolResult[]>`
  - **Fail-fast (D-M2-2/A):** Stop on the first tool failure — do not return partial results
  - For each tool call in order:
    1. `tools.get(call.name)` — not found → throw `ToolNotFoundError` (FATAL)
    2. Zod `safeParse` schema validation — failure → throw `ToolValidationError` (FATAL)
    3. `Promise.race([tool.execute(validInput), rejectAfter(policy.toolTimeoutMs)])` — error → throw `ToolExecutionError` (retryable)
    4. Success → push `{ id, name, output }` to results
  - Returns `ToolResult[]` only when all tools succeed

- [ ] `private validateInput(toolName: string, input: unknown, schema: Record<string, unknown>): unknown`
  - Zod `z.object(...)` runtime schema parse using `safeParse`
  - Failure → `ToolValidationError(toolName, errors)` — no `cause` (Zod `safeParse` does not throw)

- [ ] `private executeWithTimeout(tool: Tool, input: unknown): Promise<unknown>`
  - `Promise.race([tool.execute(input), rejectAfter(policy.toolTimeoutMs)])`
  - Uses `rejectAfter()` from `policies.ts` (D-M2-3)
  - Timeout rejection → wrap as `ToolExecutionError(tool.name, cause)`
  - Thrown error from `execute` → `ToolExecutionError(tool.name, cause)`

**Layer constraint:** `tool-controller.ts` imports from L0 and L1 only. Must not import from `pipeline.ts`.

---

## 9. Phase 5 — `packages/core/src/hooks.ts`

Layer 2 controller.

### Implementation Checklist

- [ ] `runHooks<T>(hooks: ReadonlyArray<LifecycleHook<T>>, context: T): Promise<T>`
  - Serial execution — each hook receives the output of the previous hook
  - Hook returns `undefined` or `null` → throw `Error('Hook returned null/undefined — hooks must always return context')`
  - Hook throws → propagate to pipeline (no catch)

- [ ] `normalizeHookRegistry(partial?: Partial<HookRegistry>): HookRegistry`
  - For each field: `partial?.field ?? []`
  - Called by `pipeline.ts` once per run

**Note:** `mergeHookRegistries` is implemented in `profile.ts` (L1), not here, to avoid
`profile.ts` importing from L2. See Phase 2 note.

---

## 10. Phase 6 — `packages/core/src/events.ts`

Layer 2 controller.

### Implementation Checklist

- [ ] `InternalEventBus` class (internal — only the `EventBus` interface is exported as a type)
  - `private listeners: Map<string, Set<Function>>`

- [ ] `emit<T extends OrchestratorEvent>(event: T): void`
  - Synchronous listeners: call directly
  - Async listeners (`result instanceof Promise`): async IIFE + try/catch — errors silently swallowed

```typescript
// Required async listener pattern per `.opencode/rules/implementation-standards.md` §Async
const result = listener(event);
if (result instanceof Promise) {
  void (async () => {
    try {
      await result;
    } catch {
      /* swallow */
    }
  })();
}
```

- [ ] `on<T extends OrchestratorEvent['type']>(type: T, listener: ...): () => void`
  - Create `new Set()` when type absent from Map
  - Return unsubscribe closure: `() => set.delete(listener)`

- [ ] `createEventBus(): EventBus` — exported factory function

---

## 11. Phase 7 — `packages/core/src/pipeline.ts`

Layer 3. Owns all 10 execution steps. `LifecycleStateMachine`, `runId`, `tempMessages`,
and `roundCounter` are local variables scoped to each call — never stored on `this`.

### Function Signature

```typescript
export async function executePipeline(
  input: RunInput,
  config: ResolvedConfig,
  eventBus: EventBus,
  logger: Logger,
): Promise<RunOutput | AsyncIterable<StreamChunk>>;
```

### Top-Level Timeout

- [ ] `Promise.race([_execute(...), rejectAfter(config.timeout.totalTimeoutMs)])` — ADR-026
  - Uses `rejectAfter()` from `policies.ts` (D-M2-3)

### Step 1 — INITIALIZED

- [ ] `const runId = crypto.randomUUID()`
- [ ] `let roundCounter = 0`
- [ ] `const tempMessages: Message[] = []`
- [ ] `const stateMachine = new LifecycleStateMachine()`
- [ ] `emit: run.started { runId, timestamp: Date.now(), profile }`
- [ ] `log: info 'Run started' { runId, profile, sessionId }`

### Step 2 — CONTEXT_INJECTING

- [ ] `const from = stateMachine.transition('CONTEXT_INJECTING')`; log transition
- [ ] For each `ContextProvider` **sequentially**: `await provider.provide(contextProviderInput)`
  - `contextProviderInput = Omit<input, 'stream' | 'profile'>` (ADR-024)
- [ ] Success → `emit: context.loaded { runId, providerId, messageCount }`
- [ ] Error → `emit: context.failed { runId, providerId, error: toEventErrorPayload(e) }`
  - `isRetryable(e)` → `RETRYING`; otherwise → `FAILED`
- [ ] Partial results from earlier providers are discarded on failure (ADR-015)

### Step 3 — CONTEXT_INJECTED + Memory Load

- [ ] `stateMachine.transition('CONTEXT_INJECTED')`
- [ ] `const memoryMessages = input.sessionId ? await memoryAdapter.load(input.sessionId) : []`
- [ ] `tempMessages[0] = { role: 'user', content: input.prompt }` — never `role: 'system'`

### Step 4 — PROMPT_COMPOSED

- [ ] `stateMachine.transition('PROMPT_COMPOSED')`
- [ ] `messages = promptComposer.compose({ systemPrompt, contextMessages, memoryMessages, userPrompt: input.prompt })`

### Step 5 — GENERATING

- [ ] `stateMachine.transition('GENERATING')`
- [ ] Run `beforeGenerate` hooks — context: `{ messages, input, runId }`
- [ ] `emit: generate.started { runId, messageCount: messages.length }`
- [ ] Build `PromptRequest` — attach `AbortSignal` from `generateTimeoutMs` (ADR-014)
- [ ] `stream: false` → `provider.generate(request)`
- [ ] `stream: true` → `provider.generateStream(request)` (streaming execution path — M3)
- [ ] Provider error → `isRetryable` → `RETRYING`; otherwise → `FAILED`
- [ ] `finishReason === 'tool_calls'` → `TOOL_EXECUTING`
- [ ] `finishReason === 'stop' | 'length'` → run `afterGenerate` hooks → `COMPLETING`
- [ ] `emit: generate.completed { runId, durationMs, finishReason }`
- [ ] `tempMessages[1] = { role: 'assistant', content: response.text, toolCalls: response.toolCalls }`

### Step 6 — TOOL_EXECUTING

- [ ] `roundCounter++`
- [ ] `roundCounter > config.toolPolicy.maxToolRounds` → throw `MaxToolRoundsExceededError(roundCounter, maxToolRounds)` → `FAILED` (D-M2-4)
  - Counter is cumulative — never resets on retry (ADR-016)
- [ ] Run `beforeTool` hooks for each tool call
- [ ] `toolController.executeRound(response.toolCalls)` — fail-fast (D-M2-2/A)
- [ ] Success → run `afterTool` hooks; `emit: tool.completed { runId, toolName, durationMs }`
- [ ] `ToolValidationError` or `ToolNotFoundError` → `FAILED`
- [ ] `ToolExecutionError` → `emit: tool.failed { runId, toolName, error: toEventErrorPayload(e) }`; → `RETRYING`
- [ ] Append tool result messages → return to `GENERATING`

### Step 7 — RETRYING

- [ ] `stateMachine.transition('RETRYING')`
- [ ] `emit: retry.attempt { runId, attempt, reason: error.code, delayMs }`
- [ ] `log: warn 'Retrying' { runId, attempt, reason, delayMs }`
- [ ] `await sleep(delayMs)`
- [ ] Context error → `CONTEXT_INJECTING`; all others → `GENERATING`

### Step 8 — FALLBACKING

- [ ] `stateMachine.transition('FALLBACKING')`
- [ ] `emit: fallback.triggered { runId, reason: error.code }`
- [ ] `log: warn 'Fallback triggered' { runId, reason }`
- [ ] Set `activeProvider = config.fallbackProvider` → `GENERATING`
- [ ] Fallback also fails → throw `FallbackExhaustedError` → `FAILED`

### Step 9 — COMPLETING

- [ ] `stateMachine.transition('COMPLETING')`
- [ ] When `sessionId` present: `await memoryAdapter.save(sessionId, [userMsg, assistantMsg])`
  - On error → throw `ContextLoadError(...)` → transition to **`FAILED`** (D-M2-1/A)
  - `isRetryable()` check is **bypassed** at this step — D-M2-1 locks the behavior
  - `emit: run.failed`, throw — run output is not returned
- [ ] Run `afterRun` hooks — context: `{ input, runId, output }`

### Step 10 — COMPLETED (terminal)

- [ ] `stateMachine.transition('COMPLETED')`
- [ ] `emit: run.completed { runId, durationMs, usage }`
- [ ] `log: info 'Run completed' { runId, durationMs, totalTokens: usage.total }`
- [ ] Return `RunOutput` — includes `runId`

### FAILED path (reachable from any step)

- [ ] `stateMachine.transition('FAILED')`
- [ ] `emit: run.failed { runId, error }` — `OrchestratorError` instance
- [ ] `log: error 'Run failed' { runId, error.message, code: error.code }`
- [ ] Rethrow error

---

## 12. Phase 8 — `packages/core/src/orchestrator.ts`

Layer 4. Public surface. Delegates execution to `pipeline.ts`. Delegates config resolution
to `profile.ts`.

### Implementation Checklist

**Constructor — Eager Validation (throws `ConfigValidationError`):**

- [ ] `config.provider` absent → error
- [ ] `profiles[key].name !== key` for any key → error
- [ ] `config.toolPolicy?.allowParallelTools === true` → error
- [ ] `config.toolPolicy?.maxToolRounds < 1` → error
- [ ] Any timeout value `<= 0` or `=== Infinity` → error
- [ ] Duplicate tool name in `config.tools` → error
- [ ] `this.tools = new Map(config.tools?.map(t => [t.name, t]) ?? [])`
- [ ] `this.eventBus = createEventBus()`
- [ ] `this.logger = config.logger ?? noOpLogger()`

**`run()` — Two Overloads + Implementation Signature:**

```typescript
run(input: RunInput & { stream?: false }): Promise<RunOutput>;
run(input: RunInput & { stream: true }): Promise<AsyncIterable<StreamChunk>>;
```

**`run()` entry validation (throws `ConfigValidationError`):**

- [ ] `stream: true` + `fallbackProvider` configured → error (ADR-017)
- [ ] `stream: true` + `provider.capabilities.streaming === false` → error
- [ ] `stream: true` + `provider.generateStream === undefined` → error
- [ ] `input.profile` set but not found in `config.profiles` → error

**Profile resolution — delegates to `profile.ts`:**

- [ ] `const resolved = resolveConfig(this.config, input.profile, this.tools)`
- [ ] `emit: profile.resolved { runId, profileName, overrides bitmap, hookCount }` (when profile used)

**Delegation:**

- [ ] `return executePipeline(input, resolved, this.eventBus, this.logger)`

**`on()` method:**

- [ ] `this.eventBus.on(type, listener)` — return unsubscribe `() => void`

**`noOpLogger()` internal factory:**

```typescript
function noOpLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}
```

---

## 13. Phase 9 — `packages/memory-inmemory/src/index.ts`

Full `InMemoryAdapter` implementation. Replaces the M1 skeleton.

### Implementation Checklist

- [ ] `InMemoryAdapter implements MemoryAdapter`
- [ ] `private store: Map<string, Message[]>`
- [ ] `load(sessionId)` → `this.store.get(sessionId) ?? []` — never throws
- [ ] `save(sessionId, messages)` → append: `[...existing, ...messages]`
- [ ] `clear(sessionId)` → `this.store.delete(sessionId)` — idempotent
- [ ] JSDoc on all public methods
- [ ] Class JSDoc: "Reference implementation only — not for production use"

---

## 14. Phase 10 — Unit Tests + Integration Tests

Per `.opencode/workflows/testing-standards.md`. All tests use `MockProvider` — no real API calls.

### Unit Tests

**`tests/unit/policies.test.ts`**

- [ ] `calculateDelay` — jitter `true`/`false`, `maxDelayMs` cap, `retryAfterMs` override
- [ ] `rejectAfter(ms)` — rejects with `TimeoutExceededError` after given ms (fake timers)
- [ ] `executeWithRetry` — retryable error retries, fatal throws immediately, max retries → `MaxRetriesExceededError`
- [ ] `executeWithFallback` — primary succeeds; primary fails + fallback succeeds; both fail → `FallbackExhaustedError`
- [ ] Fake timers: `vi.useFakeTimers()` per-test

**`tests/unit/profile.test.ts`**

- [ ] No profile → `ResolvedConfig` built from base with all defaults applied
- [ ] Profile `provider` replaces base
- [ ] Profile `systemPrompt` replaces base (not appended)
- [ ] Profile `tools: []` replaces base tools Map (empty Map result)
- [ ] Profile `tools: undefined` preserves base tools Map unchanged
- [ ] Profile `retry` deep-merges — only overridden keys change
- [ ] Profile `hooks` concatenated — base hooks before profile hooks
- [ ] `mergeHookRegistries` — base first, profile second, all six arrays

**`tests/unit/prompt-composer.test.ts`**

- [ ] Assembly order: system → context → memory → user
- [ ] Memory trim: oldest dropped first when `maxTokens` exceeded
- [ ] Context messages never trimmed
- [ ] Empty `systemPrompt` → no system message
- [ ] `userPrompt` always `role: 'user'` — never `role: 'system'`

**`tests/unit/tool-controller.test.ts`**

- [ ] Tool not found → `ToolNotFoundError` (FATAL)
- [ ] Schema validation failure → `ToolValidationError` (FATAL, no `cause`)
- [ ] `execute` throws → `ToolExecutionError` (retryable, `cause` preserved)
- [ ] Execution timeout via `rejectAfter` → `ToolExecutionError`
- [ ] Fail-fast: first tool fails, second tool NOT called (D-M2-2/A)
- [ ] Successful round → all `ToolResult[]` entries use `output` arm

**`tests/unit/hooks.test.ts`**

- [ ] Serial order: hook1 output is hook2 input
- [ ] Hook throw → propagates, subsequent hooks not called
- [ ] Hook returns `undefined` → internal error thrown
- [ ] `normalizeHookRegistry` → all six arrays initialized as `[]`

**`tests/unit/events.test.ts`**

- [ ] `emit` → listener called with correct payload
- [ ] Unsubscribe → listener no longer fires
- [ ] Sync listener throw → swallowed, other listeners still fire
- [ ] Async listener rejection → swallowed
- [ ] Multiple listeners same type → all receive event

### Integration Tests

**`tests/integration/orchestrator.test.ts`**

Core run scenarios:

- [ ] Simple run → `RunOutput.text` correct
- [ ] `RunOutput.runId` present and is a valid UUID
- [ ] `RunOutput.metadata` passes through from `RunInput.metadata`
- [ ] With `sessionId` → memory loaded before generation, saved atomically at COMPLETING
- [ ] Memory `save` failure → run transitions to `FAILED`, throws `ContextLoadError` (D-M2-1/A)

Retry + Fallback:

- [ ] Rate limit → retry → success; provider called N times
- [ ] Auth error → no retry, immediate failure
- [ ] Max retries + fallback → fallback called exactly once
- [ ] Max retries + no fallback → `MaxRetriesExceededError`
- [ ] Both providers fail → `FallbackExhaustedError`

Tool execution:

- [ ] Tool call → execute → second generate → final text
- [ ] `MaxToolRoundsExceededError` thrown when round limit exceeded cumulatively (ADR-016, D-M2-4)
- [ ] `ToolValidationError` → `FAILED`, provider not called again
- [ ] `ToolExecutionError` → `RETRYING` → second attempt succeeds

Hooks:

- [ ] `beforeRun` throw → provider never called
- [ ] `beforeGenerate` modifies messages → modified messages sent to provider
- [ ] `afterGenerate` throws → run aborts
- [ ] `afterRun` receives completed `RunOutput`

Constructor validation:

- [ ] Missing `provider` → `ConfigValidationError`
- [ ] `profiles[key].name !== key` → `ConfigValidationError`
- [ ] `allowParallelTools: true` → `ConfigValidationError`
- [ ] `maxToolRounds: 0` → `ConfigValidationError`
- [ ] Duplicate tool names → `ConfigValidationError`
- [ ] `stream: true` + `fallbackProvider` → `ConfigValidationError` at `run()` entry

Events:

- [ ] `run.started` emitted with `runId`
- [ ] `run.completed` emitted with `usage` and `durationMs`
- [ ] `run.failed` carries `OrchestratorError` instance (not `EventErrorPayload`)
- [ ] `retry.attempt` emitted per retry
- [ ] `fallback.triggered` emitted when fallback activates
- [ ] `tool.called` + `tool.completed` emitted per tool
- [ ] `tool.failed` carries `EventErrorPayload` (not `OrchestratorError` instance)
- [ ] Listener without unsubscribe accumulates (memory leak count assertion)
- [ ] `orchestrator.on()` unsubscribe stops listener firing

**`tests/integration/profiles.test.ts`**

- [ ] `resolveConfig` wired through `orchestrator.run()` — all merge rules exercised end-to-end
- [ ] Unknown profile key → `ConfigValidationError`
- [ ] `profile.resolved` event emitted with correct `overrides` bitmap and `hookCount`

**`tests/integration/memory.test.ts`**

- [ ] Cross-session isolation: `load('session-A')` never returns session-B data
- [ ] Append semantics: second run adds to history, not replaces
- [ ] No `sessionId` → memory neither loaded nor saved

---

## 15. Layer Compliance

Per `.opencode/rules/architecture.md` §Internal Layer Architecture:

| File                 | Layer | May import from        |
| -------------------- | ----- | ---------------------- |
| `policies.ts`        | L1    | L0 only                |
| `profile.ts`         | L1    | L0, L1 (`policies.ts`) |
| `prompt-composer.ts` | L1    | L0 only                |
| `tool-controller.ts` | L2    | L0, L1                 |
| `hooks.ts`           | L2    | L0 only                |
| `events.ts`          | L2    | L0 only                |
| `pipeline.ts`        | L3    | L0, L1, L2             |
| `orchestrator.ts`    | L4    | L0, L1, L2, L3         |

Upward imports are **FORBIDDEN**. Runtime circular imports are **FORBIDDEN**.

---

## 16. Constraint Verification Checklist

Per `.opencode/rules/constraints.md` — applied to every M2 file before PR:

- [ ] No `any` type anywhere
- [ ] No `!` non-null assertion unless provably safe
- [ ] No `var` — `prefer-const` only
- [ ] No `console.log` in production code — always use the `logger` interface
- [ ] No Node.js-specific APIs in `core/src/` except `crypto.randomUUID()`
- [ ] `run()` stores NO state on `this` — all execution state is local to the call
- [ ] Tool round counter is a local variable in `pipeline.ts` — never inside `ToolController`
- [ ] All async operations use `async/await` — no `.then()/.catch()` chains
- [ ] `run.input.prompt` is NEVER mapped to `role: 'system'`
- [ ] `rejectAfter()` is the single timeout utility — no aliases or duplicates

---

## 17. Security Checklist

Per `.opencode/rules/security.md`:

- [ ] No secrets in log statements or error messages (S-1)
- [ ] `userPrompt` always produces `role: 'user'` in `PromptComposer` (S-2)
- [ ] Profile factory arguments are initialized adapter instances only — never user strings (S-2a)
- [ ] Tool `inputSchema` non-empty — validated inside `ToolController` (S-3a)
- [ ] `ContextProvider.provide()` does NOT receive `stream` or `profile` fields (S-6)
- [ ] Error messages contain no internal paths, line numbers, or stack frame details (S-7)
- [ ] `pnpm audit --audit-level=high` passes clean (S-8)

---

## 18. Exit Criteria

Per `.opencode/rules/roadmap.md` §M2 Exit Criteria — M2 is complete when ALL of the following pass:

- [ ] `.opencode/rules/interfaces-core.md` and `.opencode/rules/error-taxonomy.md` updated with `MaxToolRoundsExceededError` (pre-implementation)
- [ ] `ResolvedConfig` defined in `types.ts`
- [ ] `orchestrator.run()` passes full integration test suite with `MockProvider` + `InMemoryAdapter`
- [ ] Retry + fallback: FATAL vs RETRYABLE classification, backoff, and fallback trigger tested
- [ ] Tool round limit enforced cumulatively; `MaxToolRoundsExceededError` thrown at correct count
- [ ] `ToolResultError` correctly populated — `code`, `message`, `retryable` verified
- [ ] Hook serial execution order and event listener isolation verified
- [ ] `orchestrator.on()` unsubscribe works; listener stops firing after call
- [ ] Listener accumulation without unsubscribing verified via count assertion
- [ ] `ConfigValidationError` on `stream: true` + `fallbackProvider`
- [ ] `pnpm --recursive lint` exits 0
- [ ] `pnpm --recursive typecheck` exits 0
- [ ] `pnpm --recursive test` exits 0
- [ ] CI pipeline green on a clean checkout

---

## 19. What M2 Does NOT Include

Per `.opencode/rules/roadmap.md` §M2+ and `.opencode/rules/constraints.md`:

- Streaming execution path (`stream: true` in `pipeline.ts`) → M3
- `OpenAIProvider` / `AnthropicProvider` → M3 / M4
- `RedisMemoryAdapter` → M4
- Parallel tool execution → FORBIDDEN in v1
- Agent planning, workflow DAG, multi-agent communication → FORBIDDEN in v1
