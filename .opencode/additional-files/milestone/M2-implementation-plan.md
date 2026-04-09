# M2 Implementation Plan

## Core Kernel — `run()` End-to-End

**Status:** Ready to implement </br>
**Blocker:** M1 complete </br>
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
**Rationale:** A partial save (only user message or only assistant message persisted) corrupts
the next session. Consistency takes priority over convenience. The run output is lost but data
integrity is preserved. `run.failed` is emitted and the caller decides whether to retry.

### D-M2-2: Tool execution failure within a round → fail-fast, partial results discarded
**Rationale:** Consistent with ADR-015 (context fail-fast). Sending partial tool results to
the LLM forces it to reason over incomplete context — a worse outcome than a clean retry.
`ToolExecutionError` → `RETRYING`, `ToolValidationError` → `FAILED`.

---

## 3. Implementation Order

```
Phase 1  — policies.ts          (L1 primitive)
Phase 2  — prompt-composer.ts   (L1 primitive)
Phase 3  — tool-controller.ts   (L2 controller)
Phase 4  — hooks.ts             (L2 controller)
Phase 5  — events.ts            (L2 controller)
Phase 6  — pipeline.ts          (L3 — wires all steps together)
Phase 7  — orchestrator.ts      (L4 — public surface)
Phase 8  — memory-inmemory      (full implementation)
Phase 9  — integration tests
Phase 10 — CI update
```

Compile and typecheck after each phase before proceeding:
`pnpm --filter @atisse/core typecheck`

---

## 4. Phase 1 — `packages/core/src/policies.ts`

Layer 1 primitive. Consumed by `pipeline.ts` and `profile.ts` via injection. Default constants
are internal and must not be exported.

### Implementation Checklist

**Default Constants (internal — not exported):**
- [ ] `DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true }`
- [ ] `DEFAULT_TIMEOUT: TimeoutPolicy = { generateTimeoutMs: 30_000, toolTimeoutMs: 10_000, totalTimeoutMs: 60_000 }`
- [ ] `DEFAULT_TOOL_POLICY: ToolPolicy = { maxToolRounds: 5, allowParallelTools: false }`

**Merge Utilities (internal — not exported):**
- [ ] `mergeRetryPolicy(base: RetryPolicy, override?: Partial<RetryPolicy>): RetryPolicy`
- [ ] `mergeTimeoutPolicy(base: TimeoutPolicy, override?: Partial<TimeoutPolicy>): TimeoutPolicy`
- [ ] `mergeToolPolicy(base: ToolPolicy, override?: Partial<ToolPolicy>): ToolPolicy`

**Delay Calculation:**
- [ ] `calculateDelay(attempt: number, policy: RetryPolicy): number`
  - `exponential = baseDelayMs * Math.pow(2, attempt)`
  - `capped = Math.min(exponential, maxDelayMs)`
  - When `policy.jitter === true`: `capped + Math.random() * 0.3 * capped`
- [ ] When `ProviderRateLimitError.retryAfterMs` is present, use it instead of the exponential value

**Core Retry Logic:**
- [ ] `executeWithRetry<T>(fn: () => Promise<T>, policy: RetryPolicy, onRetry?: (attempt: number, error: OrchestratorError) => void): Promise<T>`
  - First call is attempt 0; first retry is attempt 1
  - `isRetryable(error) === false` → rethrow immediately (no delay, no counter increment)
  - `attempt === policy.maxAttempts` → throw `MaxRetriesExceededError(attempts, lastError)`
  - Call `onRetry?.(attempt, error)` before each retry delay
  - `await sleep(delay)` — must be compatible with `vi.useFakeTimers()`
- [ ] `executeWithFallback<T>(primary: () => Promise<T>, fallback: (() => Promise<T>) | undefined, policy: RetryPolicy, onRetry?: ...): Promise<T>`
  - When primary throws `MaxRetriesExceededError` and `fallback` is defined → call fallback once (no retry on fallback)
  - When fallback also fails → throw `FallbackExhaustedError(primaryError, fallbackError)`
- [ ] `sleep(ms: number): Promise<void>` — internal utility, not exported

**Layer constraint:** `policies.ts` must not import from any L2, L3, or L4 file.

---

## 5. Phase 2 — `packages/core/src/prompt-composer.ts`

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
- `userPrompt` is always mapped to `role: 'user'` — never `role: 'system'`
- `composeParams.userPrompt` must never appear as system message content

---

## 6. Phase 3 — `packages/core/src/tool-controller.ts`

Layer 2 controller.

### Implementation Checklist

- [ ] `ToolController` constructor: `(tools: Map<string, Tool>, policy: ToolPolicy, logger: Logger)`
- [ ] `executeRound(toolCalls: ToolCall[]): Promise<ToolResult[]>`
  - **Fail-fast (D-M2-2/A):** Stop on the first tool failure — do not return partial results
  - For each tool call in order:
    1. `tools.get(call.name)` — not found → `ToolNotFoundError` (FATAL)
    2. Zod `safeParse` schema validation — failure → `ToolValidationError` (FATAL)
    3. `Promise.race([tool.execute(validInput), timeoutPromise(policy.toolTimeoutMs)])` — error → `ToolExecutionError` (retryable)
    4. Success → push `{ id, name, output }` to results
  - Returns `ToolResult[]` only when all tools succeed

- [ ] `private validateInput(toolName: string, input: unknown, schema: Record<string, unknown>): unknown`
  - Zod `z.object(...)` runtime schema parse using `safeParse`
  - Failure → `ToolValidationError(toolName, errors)` — no `cause` (Zod `safeParse` does not throw)

- [ ] `private executeWithTimeout(tool: Tool, input: unknown): Promise<unknown>`
  - `Promise.race([tool.execute(input), rejectAfter(policy.toolTimeoutMs)])`
  - Timeout → `ToolExecutionError(tool.name, new Error('Tool execution timed out'))`
  - Thrown error from `execute` → `ToolExecutionError(tool.name, cause)`

**Layer constraint:** `tool-controller.ts` imports from L0 only. Must not import from `pipeline.ts`.

---

## 7. Phase 4 — `packages/core/src/hooks.ts`

Layer 2 controller.

### Implementation Checklist

- [ ] `runHooks<T>(hooks: ReadonlyArray<LifecycleHook<T>>, context: T): Promise<T>`
  - Serial execution — each hook receives the output of the previous hook as its input
  - When a hook returns `undefined` or `null` → throw `Error('Hook returned null/undefined — hooks must always return context')`
  - When a hook throws → propagate to pipeline (no catch, no swallow)

- [ ] `normalizeHookRegistry(partial?: Partial<HookRegistry>): HookRegistry`
  - For each field: `partial?.field ?? []`
  - Called by `pipeline.ts` once per run — eliminates null-checks at every hook call site

- [ ] `mergeHookRegistries(base: HookRegistry, override?: Partial<HookRegistry>): HookRegistry`
  - For each field: `[...base.field, ...(override?.field ?? [])]`
  - Base hooks always execute first (required for profile merge)

---

## 8. Phase 5 — `packages/core/src/events.ts`

Layer 2 controller.

### Implementation Checklist

- [ ] `EventBusImpl` class (internal — only the `EventBus` interface is exported as a type)
  - `private listeners: Map<string, Set<Function>>`

- [ ] `emit<T extends OrchestratorEvent>(event: T): void`
  - Iterate over the `Set<Function>` for the event type
  - Synchronous listeners: call directly
  - Async listeners (`result instanceof Promise`): wrap in async IIFE with try/catch — errors silently swallowed

```typescript
// Required async listener pattern per `.opencode/rules/implementation-standards.md` §Async
const result = listener(event);
if (result instanceof Promise) {
  void (async () => {
    try { await result; } catch { /* swallow — listener errors must never affect pipeline */ }
  })();
}
```

- [ ] `on<T extends OrchestratorEvent['type']>(type: T, listener: ...): () => void`
  - `Map.get(type)` — create `new Set()` when absent
  - Add listener to the Set
  - Return unsubscribe closure: `() => set.delete(listener)`

- [ ] `createEventBus(): EventBus` — exported factory function
  - `orchestrator.ts` uses this factory to construct the `EventBus` instance

---

## 9. Phase 6 — `packages/core/src/pipeline.ts`

Layer 3. Owns all 10 execution steps. `LifecycleStateMachine`, `runId`, `tempMessages`,
and `roundCounter` are local variables scoped to each call — never stored on `this`.

### Function Signature

```typescript
export async function executePipeline(
  input: RunInput,
  config: ResolvedConfig,   // post-profile-merge
  eventBus: EventBus,
  logger: Logger,
): Promise<RunOutput | AsyncIterable<StreamChunk>>
```

### Top-Level Timeout

- [ ] `Promise.race([_execute(...), rejectAfter(config.timeout.totalTimeoutMs)])` — ADR-026
  - Timeout → throw `TimeoutExceededError(config.timeout.totalTimeoutMs)`

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
  - `isRetryable(e)` → transition to `RETRYING`; otherwise → `FAILED`
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
- [ ] `finishReason === 'tool_calls'` → transition to `TOOL_EXECUTING`
- [ ] `finishReason === 'stop' | 'length'` → run `afterGenerate` hooks → `COMPLETING`
- [ ] `emit: generate.completed { runId, durationMs, finishReason }`
- [ ] `tempMessages[1] = { role: 'assistant', content: response.text, toolCalls: response.toolCalls }`

### Step 6 — TOOL_EXECUTING

- [ ] `roundCounter++` (local variable in `pipeline.ts` — never inside `ToolController`)
- [ ] `roundCounter > config.toolPolicy.maxToolRounds` → throw `PolicyError` → `FAILED`
  - Counter is cumulative across the entire `run()` call — never resets on retry (ADR-016)
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
- [ ] Context error → transition to `CONTEXT_INJECTING`; all other errors → `GENERATING`

### Step 8 — FALLBACKING

- [ ] `stateMachine.transition('FALLBACKING')`
- [ ] `emit: fallback.triggered { runId, reason: error.code }`
- [ ] `log: warn 'Fallback triggered' { runId, reason }`
- [ ] Set `activeProvider = config.fallbackProvider` → transition to `GENERATING`
- [ ] Fallback also fails → throw `FallbackExhaustedError` → `FAILED`

### Step 9 — COMPLETING

- [ ] `stateMachine.transition('COMPLETING')`
- [ ] When `sessionId` present: `await memoryAdapter.save(sessionId, [userMsg, assistantMsg])` — atomic batch
  - On error → transition to **`FAILED`** (D-M2-1/A): emit `run.failed`, throw — run output is not returned
- [ ] Run `afterRun` hooks — context: `{ input, runId, output }`

### Step 10 — COMPLETED (terminal)

- [ ] `stateMachine.transition('COMPLETED')`
- [ ] `emit: run.completed { runId, durationMs, usage }`
- [ ] `log: info 'Run completed' { runId, durationMs, totalTokens: usage.total }`
- [ ] Return `RunOutput` — includes `runId`

### FAILED path (reachable from any step)

- [ ] `stateMachine.transition('FAILED')`
- [ ] `emit: run.failed { runId, error }` — `OrchestratorError` instance (not `EventErrorPayload`)
- [ ] `log: error 'Run failed' { runId, error.message, code: error.code }`
- [ ] Rethrow error

---

## 10. Phase 7 — `packages/core/src/orchestrator.ts`

Layer 4. Public surface. Delegates all execution to `pipeline.ts`.

### Implementation Checklist

**Constructor — Eager Validation (throws `ConfigValidationError`):**
- [ ] `config.provider` is absent → error
- [ ] `profiles[key].name !== key` for any key → error
- [ ] `config.toolPolicy?.allowParallelTools === true` → error
- [ ] `config.toolPolicy?.maxToolRounds < 1` → error
- [ ] Any timeout value `<= 0` or `=== Infinity` → error
- [ ] Duplicate tool name in `config.tools` → error
- [ ] `this.tools = new Map(config.tools?.map(t => [t.name, t]) ?? [])` — conversion at construction time
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
- [ ] `input.profile` is set but not found in `config.profiles` → error

**Profile resolution:**
- [ ] `resolveConfig(this.config, input.profile)` → `ResolvedConfig` (local to this call)
  - `provider`: profile value replaces base (`??`)
  - `systemPrompt`: profile value replaces base (`??`)
  - `retry` / `timeout` / `toolPolicy`: deep merge — profile keys override matching base keys
  - `tools` / `contextProviders`: full replace when profile defines either (`[]` also replaces)
  - `hooks`: concatenate — base hooks first, profile hooks second
- [ ] `emit: profile.resolved { runId, profileName, overrides bitmap, hookCount }`

**Delegation:**
- [ ] `return executePipeline(input, resolvedConfig, this.eventBus, this.logger)`

**`on()` method:**
- [ ] `this.eventBus.on(type, listener)` — return unsubscribe `() => void`

**`noOpLogger()` internal factory:**
```typescript
function noOpLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}
```

---

## 11. Phase 8 — `packages/memory-inmemory/src/index.ts`

Full `InMemoryAdapter` implementation. Replaces the M1 skeleton.

### Implementation Checklist

- [ ] `InMemoryAdapter implements MemoryAdapter`
- [ ] `private store: Map<string, Message[]>`
- [ ] `load(sessionId)` → `this.store.get(sessionId) ?? []` — never throws
- [ ] `save(sessionId, messages)` → append semantics: `[...existing, ...messages]`
- [ ] `clear(sessionId)` → `this.store.delete(sessionId)` — idempotent, no-op for unknown session
- [ ] JSDoc on all public methods
- [ ] Class JSDoc: "Reference implementation only — not for production use"

---

## 12. Phase 9 — Unit Tests + Integration Tests

Per `.opencode/workflows/testing-standards.md`. All tests use `MockProvider` — no real API calls.

### Unit Tests

**`tests/unit/policies.test.ts`**
- [ ] `calculateDelay` — jitter `true`/`false`, `maxDelayMs` cap, `retryAfterMs` override
- [ ] `executeWithRetry` — retryable error retries, fatal throws immediately, max retries → `MaxRetriesExceededError`
- [ ] `executeWithFallback` — primary succeeds; primary fails + fallback succeeds; both fail → `FallbackExhaustedError`
- [ ] Fake timers: `vi.useFakeTimers()` per-test, `vi.useRealTimers()` in cleanup

**`tests/unit/prompt-composer.test.ts`**
- [ ] Assembly order: system → context → memory → user
- [ ] Memory trim: oldest messages dropped first when `maxTokens` exceeded
- [ ] Context messages are never trimmed regardless of `maxTokens`
- [ ] Empty `systemPrompt` → no system message in output
- [ ] `userPrompt` always produces `role: 'user'` — never `role: 'system'`

**`tests/unit/tool-controller.test.ts`**
- [ ] Tool not found → `ToolNotFoundError` (FATAL)
- [ ] Schema validation failure → `ToolValidationError` (FATAL, no `cause`)
- [ ] `execute` throws → `ToolExecutionError` (retryable, `cause` preserved)
- [ ] Execution timeout → `ToolExecutionError`
- [ ] Fail-fast: first tool fails, second tool is NOT called (D-M2-2/A)
- [ ] Successful round → `ToolResult[]` — all entries use `output` arm (never `error` arm)

**`tests/unit/hooks.test.ts`**
- [ ] Serial order: hook1 output is hook2 input
- [ ] Hook throw → propagates up, subsequent hooks are not called
- [ ] Hook returns `undefined` → internal error thrown
- [ ] `normalizeHookRegistry` → all six arrays initialized as `[]`
- [ ] `mergeHookRegistries` → base hooks appear before profile hooks

**`tests/unit/events.test.ts`**
- [ ] `emit` → listener called with correct payload
- [ ] Unsubscribe → listener no longer fires on subsequent `emit`
- [ ] Synchronous listener throw → swallowed, other listeners still fire
- [ ] Async listener rejection → swallowed, pipeline unaffected
- [ ] Multiple listeners on same event type → all receive the event

### Integration Tests

**`tests/integration/orchestrator.test.ts`**

Core run scenarios:
- [ ] Simple run — `MockProvider` returns text → `RunOutput.text` matches
- [ ] `RunOutput.runId` is present and is a valid UUID
- [ ] `RunOutput.metadata` passes through unchanged from `RunInput.metadata`
- [ ] With `sessionId` → memory is loaded before generation and saved atomically at COMPLETING
- [ ] Memory `save` failure → run transitions to `FAILED` and throws (D-M2-1/A)

Retry + Fallback:
- [ ] Rate limit error → retry → success; provider called N times
- [ ] Auth error → no retry, immediate failure
- [ ] Max retries exceeded + fallback configured → fallback called exactly once
- [ ] Max retries exceeded + no fallback → `MaxRetriesExceededError`
- [ ] Both primary and fallback fail → `FallbackExhaustedError`

Tool execution:
- [ ] Tool call → execute → second `generate` → final text in `RunOutput`
- [ ] Tool round counter enforced cumulatively across retries (ADR-016)
- [ ] `ToolValidationError` → `FAILED` — provider is not called again
- [ ] `ToolExecutionError` → `RETRYING` → second attempt succeeds

Hooks:
- [ ] `beforeRun` throw → provider is never called
- [ ] `beforeGenerate` modifies `messages` → modified messages are sent to provider
- [ ] `afterGenerate` throws on invalid response → run aborts
- [ ] `afterRun` context includes completed `RunOutput`

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
- [ ] `retry.attempt` emitted on each retry attempt
- [ ] `fallback.triggered` emitted when fallback activates
- [ ] `tool.called` + `tool.completed` emitted per tool execution
- [ ] `tool.failed` carries `EventErrorPayload` (not `OrchestratorError` instance)
- [ ] Listener registered inside a per-request handler without unsubscribing → accumulates (memory leak assertion)
- [ ] `orchestrator.on()` unsubscribe function stops listener from firing

**`tests/integration/profiles.test.ts`**
- [ ] Profile `provider` replaces base provider entirely
- [ ] Profile `systemPrompt` replaces (does not append to) base system prompt
- [ ] Profile `tools: []` replaces base tools — no tools active for this run
- [ ] Profile `tools: undefined` preserves base tools unchanged
- [ ] Profile `retry` deep-merges — only overridden keys differ from base
- [ ] Profile `hooks` are concatenated — base hooks execute before profile hooks
- [ ] Unknown profile key → `ConfigValidationError`
- [ ] `profile.resolved` event emitted with correct `overrides` bitmap and `hookCount`

**`tests/integration/memory.test.ts`**
- [ ] Cross-session isolation: `load('session-A')` never returns session-B data
- [ ] Append semantics: second run appends to history, does not replace it
- [ ] No `sessionId` provided → memory is neither loaded nor saved

---

## 13. Layer Compliance

Per `.opencode/rules/architecture.md` §Internal Layer Architecture:

| File                 | Layer | May import from |
|----------------------|-------|-----------------|
| `policies.ts`        | L1    | L0 only         |
| `prompt-composer.ts` | L1    | L0 only         |
| `tool-controller.ts` | L2    | L0, L1          |
| `hooks.ts`           | L2    | L0 only         |
| `events.ts`          | L2    | L0 only         |
| `pipeline.ts`        | L3    | L0, L1, L2      |
| `orchestrator.ts`    | L4    | L0, L1, L2, L3  |

Upward imports are **FORBIDDEN**. Runtime circular imports are **FORBIDDEN**.

---

## 14. Constraint Verification Checklist

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

---

## 15. Security Checklist

Per `.opencode/rules/security.md`:

- [ ] No secrets in log statements or error messages (S-1)
- [ ] `userPrompt` always produces `role: 'user'` in `PromptComposer` (S-2)
- [ ] Profile factory arguments are initialized adapter instances only — never user-controlled strings (S-2a)
- [ ] Tool `inputSchema` is non-empty — validated inside `ToolController` (S-3a)
- [ ] `ContextProvider.provide()` does NOT receive `stream` or `profile` fields (S-6)
- [ ] Error messages contain no internal file paths, line numbers, or stack frame details (S-7)
- [ ] `pnpm audit --audit-level=high` passes clean (S-8)

---

## 16. Exit Criteria

Per `.opencode/rules/roadmap.md` §M2 Exit Criteria — M2 is complete when ALL of the following pass:

- [ ] `orchestrator.run()` passes full integration test suite with `MockProvider` + `InMemoryAdapter`
- [ ] Retry + fallback: FATAL vs RETRYABLE classification, backoff timing, and fallback trigger tested
- [ ] Tool round limit is enforced cumulatively across retry paths
- [ ] `ToolResultError` is correctly populated — `code`, `message`, and `retryable` fields verified
- [ ] Hook serial execution order and event listener isolation verified
- [ ] `orchestrator.on()` returns a working unsubscribe function; listener stops firing after it is called
- [ ] Listener accumulation without unsubscribing is verified via listener count assertion
- [ ] `ConfigValidationError` thrown on `stream: true` + `fallbackProvider` combination
- [ ] `pnpm --recursive lint` exits 0
- [ ] `pnpm --recursive typecheck` exits 0
- [ ] `pnpm --recursive test` exits 0
- [ ] CI pipeline green on a clean checkout

---

## 17. What M2 Does NOT Include

Per `.opencode/rules/roadmap.md` §M2+ and `.opencode/rules/constraints.md`:

- Streaming execution path (`stream: true` in `pipeline.ts`) → M3
- `OrchestratorProfile` full merge logic → M3
- `OpenAIProvider` / `AnthropicProvider` → M3 / M4
- `RedisMemoryAdapter` → M4
- Parallel tool execution → FORBIDDEN in v1
- Agent planning, workflow DAG, multi-agent communication → FORBIDDEN in v1