# M1 Decision Record

## All Agreed Decisions — Discussion → Suggestion → Decision

Grouped by planning session topic. Every entry follows the format:

- **Discussion:** The question or tradeoff raised
- **Suggestion:** The proposed approach with rationale
- **Decision:** The agreed outcome

---

## Group A — Structural Decisions

### A1 — Package Structure and Naming

---

**Decision 1:**

- **Discussion:** Should we publish frozen interface types as a separate `@atisse/types` package so third-party adapter authors can depend on just the types?
- **Suggestion:** No separate types package. Adapter authors use `import type { AIProvider } from '@atisse/core'` at zero runtime cost. A separate package creates versioning sync risk and split import sources.
- **Decision:** Types remain in `@atisse/core`. Adapter authors use `import type`. Documented in adapter authoring guide.

---

**Decision 2:**

- **Discussion:** Should the namespace be `@atisse` or flat prefixed packages like `atisse-core`?
- **Suggestion:** Scoped namespace `@atisse/*`. More professional, clearer ecosystem relationship, better npm discoverability.
- **Decision:** `@atisse` namespace confirmed.

---

**Decision 3:**

- **Discussion:** Should the public API use a single `src/index.ts` entry point, and how should `MockProvider` be accessible as `@atisse/core/testing`?
- **Suggestion:** `src/index.ts` as main entry. Two subpath exports in `package.json`:
  - `"."` → main index
  - `"./testing"` → `testing/mock-provider`
- **Decision:** `src/index.ts` + `package.json` exports field with subpath strategy.

---

**Decision 4:**

- **Discussion:** Should internal cross-cutting types live in a separate `types.ts` file or stay in their respective implementation files?
- **Suggestion:** Dedicated `types.ts` for cross-cutting internal types only. Module-specific internal types stay in their own file.
- **Decision:** `types.ts` as a separate file for cross-cutting internals, not exported.

---

**Decision 5:**

- **Discussion:** Should each package have its own `vitest.config.ts`, or should there be a shared base?
- **Suggestion:** Root-level `vitest.base.config.ts`. Each package extends it. Avoids repetition and drift.
- **Decision:** Shared vitest base config at root.

---

**Decision 6:**

- **Discussion:** Which packages are created in M1?
- **Suggestion:** Only `packages/core/` (full M1 deliverable) and `packages/memory-inmemory/` skeleton (required for M2 integration tests). All other adapters deferred.
- **Decision:** M1 creates `core/` and `memory-inmemory/` skeleton only.

---

### A2 — TypeScript Configuration Strategy

---

**Decision 1:**

- **Discussion:** Should module resolution be `NodeNext` (requires `.js` extensions) or `Bundler` (extension-free imports)?
- **Suggestion:** `NodeNext`. This is a library targeting Node.js 20+ with edge/browser runtime-agnostic ambition. Strict ESM semantics are correct.
- **Decision:** `NodeNext` module resolution. `.js` extension required in all internal imports.

---

**Decision 2:**

- **Discussion:** Should the monorepo use TypeScript project references (`composite: true`) for incremental builds?
- **Suggestion:** No project references. Simple `extends` from root `tsconfig.base.json`. tsup handles builds; `tsc` is typecheck-only. Project references add complexity without benefit at this scale.
- **Decision:** Option B — simple extend, no project references.

---

**Decision 3:**

- **Discussion:** Should `lib` be defined in the base config (Node.js only) or per-package (runtime-agnostic)?
- **Suggestion:** `lib: ["ES2022"]` in base — no Node.js-specific types. Community may want Edge/browser adapters. Environment-specific types (`@types/node`) added as devDependency per package.
- **Decision:** `lib: ["ES2022"]` in base. Per-package devDependencies for environment-specific types. `core/src/` must use only Web/ES APIs.

---

**Decision 4:**

- **Discussion:** Should path aliases (e.g. `@/interfaces`) be configured?
- **Suggestion:** No path aliases. Package depth is shallow, aliases add tsup complexity, relative imports are already short.
- **Decision:** No path aliases.

---

**Decision 5:**

- **Discussion:** Should `declaration` and `declarationMap` both be enabled?
- **Suggestion:** Both `true`. Required for `.d.ts` generation (adapters need it) and IDE "Go to Definition" on source files.
- **Decision:** Both enabled, unchanged.

---

### A3 — Toolchain Configuration

---

**Decision 1:**

- **Discussion:** Should root-level pnpm scripts use `--recursive` or `--filter` targeting?
- **Suggestion:** `--recursive` for simplicity. `--filter` is useful when ecosystem grows larger; premature at M1/M2 scale.
- **Decision:** `--recursive` approach.

---

**Decision 2:**

- **Discussion:** Should tsup use `splitting: true` or `splitting: false`?
- **Suggestion:** `splitting: false`. This is a library; consumer's bundler handles tree-shaking.
- **Decision:** `splitting: false`.

---

**Decision 3:**

- **Discussion:** Should ESLint use legacy `.eslintrc.cjs` or flat config `eslint.config.mjs`?
- **Suggestion:** Flat config (`eslint.config.mjs`). ESLint 9+ default. `@typescript-eslint` v8 fully supports it. No technical debt.
- **Decision:** Flat config.

---

**Decision 4:**

- **Discussion:** Should there be one ESLint config at root or per-package configs?
- **Suggestion:** Single root config. Prevents adapter packages from diverging on rules. `files` patterns can handle per-package overrides if needed.
- **Decision:** Single root ESLint config.

---

**Decision 5:**

- **Discussion:** Should Prettier format `*.md` files?
- **Suggestion:** Exclude `*.md` from Prettier. Markdown files are agent instruction sets — auto-format can corrupt content structure.
- **Decision:** `*.md` added to `.prettierignore`.

---

**Decision 6:**

- **Discussion:** Which coverage reporters should be used?
- **Suggestion:** `['text', 'html', 'json-summary']` — terminal output, CI artifact, future Codecov integration.
- **Decision:** `['text', 'html', 'json-summary']`.

---

**Decision 7:**

- **Discussion:** Should fake timers be enabled globally or per-test?
- **Suggestion:** Per-test only with `vi.useFakeTimers()`. Global activation breaks async operations in unexpected ways.
- **Decision:** Fake timers per-test, never global.

---

**Decision 8:**

- **Discussion:** Should there be a global test setup file?
- **Suggestion:** No global setup needed. `MockProvider` is constructed fresh per test. Test isolation is by design.
- **Decision:** No global test setup.

---

## Group B — Interface Contracts

### B1 — Provider Contracts

---

**Decision 1:**

- **Discussion:** What semantic convention should `AIProvider.id` follow? Is it safe to include in event payloads?
- **Suggestion:** `id` is configuration metadata (e.g. `"openai-gpt-4o"`), not a secret. Safe in logs and events. Format convention `"{provider}-{model}"` documented.
- **Decision:** `id: readonly string` unchanged. Convention documented. Clarification added to `security.md` S-1.

---

**Decision 2:**

- **Discussion:** Should `generateStream?` return `AsyncIterable<StreamChunk>` or `Promise<AsyncIterable<StreamChunk>>`?
- **Suggestion:** `Promise<AsyncIterable<StreamChunk>>`. Connection errors surface as Promise rejection before streaming begins, not deferred to first chunk read.
- **Decision:** `generateStream?(request: PromptRequest): Promise<AsyncIterable<StreamChunk>>` (ADR-019).

---

**Decision 3:**

- **Discussion:** Should `ProviderCapabilities.vision` remain in the interface if it has no pipeline effect?
- **Suggestion:** Keep it. Documentation-only flag — adapter authors use it to communicate capability. Removing it later would be a breaking change.
- **Decision:** `vision: boolean` retained. Documented as pipeline-agnostic in `interfaces-core.md`.

---

**Decision 4:**

- **Discussion:** Is `maxContextTokens` sufficient or do we need `maxOutputTokens` too?
- **Suggestion:** `maxContextTokens` sufficient for v1. Output token limit is handled via `PromptRequest.maxTokens`. Adapter clips or errors internally.
- **Decision:** `maxOutputTokens` not added.

---

**Decision 5:**

- **Discussion:** Should `PromptRequest` have an escape hatch for provider-specific parameters?
- **Suggestion:** `providerOptions?: Record<string, unknown>`. Core is agnostic; adapter casts this internally. Avoids freezing a growing list of provider-specific fields.
- **Decision:** `providerOptions?: Record<string, unknown>` added.

---

**Decision 6:**

- **Discussion:** Is `temperature` the only generation parameter needed, or do we need `topP`, `topK`, etc.?
- **Suggestion:** `temperature` only in the standard interface. Provider-specific parameters go via `providerOptions`.
- **Decision:** `temperature?: number` only. Other params via `providerOptions`.

---

**Decision 7:**

- **Discussion:** Should `PromptResponse.finishReason` include `'error'`?
- **Suggestion:** Remove `'error'`. Provider errors must be thrown as `OrchestratorError` subtypes, not returned in the response shape. Mixing error state with response is an anti-pattern.
- **Decision:** `finishReason: 'stop' | 'tool_calls' | 'length'` — `'error'` removed.

---

### B2 — Message Model

---

**Decision 1:**

- **Discussion:** Should `Message` remain a flat interface with optional fields, or become a discriminated union?
- **Suggestion:** Discriminated union — 4 arms. Role-specific fields become compile-time requirements rather than runtime assumptions. "Impossible states must be unrepresentable."
- **Decision:** `Message` is a 4-arm discriminated union (ADR-018).

---

**Decision 2:**

- **Discussion:** Should `toolCallId` and `name` be required on `role: 'tool'` messages?
- **Suggestion:** Yes — required on the `tool` arm. Without `toolCallId` the provider cannot link the result to its originating call.
- **Decision:** `role: 'tool'` arm requires `toolCallId: string` and `name: string`.

---

**Decision 3:**

- **Discussion:** Should `role: 'assistant'` carry `toolCalls?`?
- **Suggestion:** Yes. When LLM returns tool calls, the assistant message must carry them for multi-turn memory.
- **Decision:** `role: 'assistant'` arm carries `toolCalls?: ToolCall[]`.

---

**Decision 4:**

- **Discussion:** What is the semantic of the `name` field — ambiguous across roles.
- **Suggestion:** Disambiguate via discriminated union. `name` exists only on the `tool` arm where it is required. No `name` on other arms.
- **Decision:** `name` removed from other arms; required only on `role: 'tool'`.

---

**Decision 5:**

- **Discussion:** Should `MessageContent` `image` type remain in v1?
- **Suggestion:** Keep it. Removing it later is a breaking change. Pipeline doesn't process vision; adapter handles it. Brevity doesn't exempt this type from the contract.
- **Decision:** `image` content type retained.

---

**Decision 6:**

- **Discussion:** Is `url: string` sufficient for images, or do we need a `base64` source variant?
- **Suggestion:** `url: string` is sufficient. Data URIs (`data:image/jpeg;base64,...`) are valid URLs. Adapter parses as needed.
- **Decision:** `url: string` retained. Data URI support documented.

---

### B3 — Tool Contracts

---

**Decision 1:**

- **Discussion:** Why keep `ToolDefinition` and `Tool` as separate interfaces?
- **Suggestion:** `PromptRequest.tools` accepts `ToolDefinition[]` — sending `execute()` functions to the provider makes no sense. Separation enforces this cleanly.
- **Decision:** Separation retained. `PromptRequest.tools` is `ToolDefinition[]`.

---

**Decision 2:**

- **Discussion:** Should `Tool.execute()` use typed generics instead of `unknown`?
- **Suggestion:** `unknown` for v1. Zod `safeParse` inside `execute()` provides runtime safety. Typed generics require JSON Schema → TypeScript inference which isn't straightforward.
- **Decision:** `execute(input: unknown): Promise<unknown>` — typed generics V2 candidate.

---

**Decision 3:**

- **Discussion:** Should `ToolCall.id` be required or optional given some providers omit it?
- **Suggestion:** Required. Adapter is responsible for generating a `randomUUID()` if the provider omits it. Kernel must not handle null IDs throughout.
- **Decision:** `ToolCall.id: string` required. Adapter generates if provider omits.

---

**Decision 4:**

- **Discussion:** Should `ToolResult.output` and `ToolResult.error` be mutually exclusive?
- **Suggestion:** Yes — discriminated union. A result is either successful or failed; both fields populated simultaneously is an impossible state.
- **Decision:** `ToolResult` is a discriminated union (ADR-020).

---

**Decision 5:**

- **Discussion:** Should `ToolResultError.code` be `string` or a union literal?
- **Suggestion:** Union literal — 3 values: `'TOOL_EXECUTION_FAILED' | 'TOOL_VALIDATION_FAILED' | 'TOOL_NOT_FOUND'`. Consumer can switch exhaustively.
- **Decision:** `ToolResultError.code` is a 3-value union literal.

---

### B4 — Memory & Context Contracts

---

**Decision 1:**

- **Discussion:** Should `MemoryAdapter.load()` return `[]` or `null` for an unknown session?
- **Suggestion:** `[]`. Kernel always gets an array; no null-check needed. New session and empty history are semantically equivalent in the pipeline.
- **Decision:** `load()` returns `[]` for unknown sessionId, never throws.

---

**Decision 2:**

- **Discussion:** What are the append vs replace semantics for `save()`?
- **Suggestion:** Append. Called once per `run()` at COMPLETING with `[userMessage, assistantMessage]`. Atomicity prevents partial saves.
- **Decision:** `save()` always appends. Never replaces.

---

**Decision 3:**

- **Discussion:** Should `sessionId` have a format constraint?
- **Suggestion:** No. Kernel must not dictate session ID format — users may use UUID, email, numeric ID, etc.
- **Decision:** `sessionId: string` — no format constraint.

---

**Decision 4:**

- **Discussion:** What happens when `clear()` is called for a non-existent session?
- **Suggestion:** Idempotent no-op. Throwing on a non-existent key would force callers to check existence first, which is unnecessary complexity.
- **Decision:** `clear()` is idempotent — never throws for unknown session.

---

**Decision 5:**

- **Discussion:** Should `MemoryAdapter` have an `exists()` method?
- **Suggestion:** No. Not needed in the v1 pipeline. YAGNI.
- **Decision:** `exists()` not added.

---

**Decision 6:**

- **Discussion:** Should `ContextProvider.provide()` return `Message[]` or a narrower type?
- **Suggestion:** A narrower type enforces the trust boundary at compile time. `SystemMessage = Extract<Message, { role: 'system' }>` derived from the `Message` union ensures this tracks automatically.
- **Decision:** `provide()` returns `Promise<SystemMessage[]>`. `SystemMessage` is `Extract<Message, { role: 'system' }>` — not a standalone type.

---

**Decision 7:**

- **Discussion:** Should `provide()` accept the full `RunInput` or a narrower type?
- **Suggestion:** `Omit<RunInput, 'stream' | 'profile'>` as a named type. `stream` and `profile` are pipeline-internal routing fields — leaking them to context providers is an abstraction violation.
- **Decision:** `type ContextProviderInput = Omit<RunInput, 'stream' | 'profile'>`. `provide(input: ContextProviderInput)` (ADR-024).

---

### B5 — Policy Contracts

---

**Decision 1:**

- **Discussion:** Does `maxAttempts: 3` mean 3 retries (total 4 calls) or 3 total calls (1 initial + 2 retries)?
- **Suggestion:** Total calls. The name `maxAttempts` semantically means the total number of attempts made, not the retry count.
- **Decision:** `maxAttempts` = total attempt count. Documented explicitly in `interfaces-runtime.md`.

---

**Decision 2:**

- **Discussion:** Should `jitter: boolean` be replaced by `jitterFactor?: number` for more control?
- **Suggestion:** Keep `boolean`. The jitter algorithm (30% partial jitter) is an implementation detail in `policies.ts`, not a frozen contract.
- **Decision:** `jitter: boolean` retained.

---

**Decision 3:**

- **Discussion:** Should a `contextTimeoutMs` be added to `TimeoutPolicy`?
- **Suggestion:** Not needed for v1. `totalTimeoutMs` covers context loading as part of the overall ceiling. Granular context timeout is a V2 candidate.
- **Decision:** `contextTimeoutMs` not added.

---

**Decision 4:**

- **Discussion:** What happens when timeout values are `0` or `Infinity`?
- **Suggestion:** `ConfigValidationError` at constructor. Both are nonsensical values that should fail fast.
- **Decision:** Timeout values must be `> 0` and `< Infinity`. Validated at construction.

---

**Decision 5:**

- **Discussion:** What happens when `allowParallelTools: true` is configured?
- **Suggestion:** `ConfigValidationError` at constructor. Silent coercion to `false` would cause user confusion.
- **Decision:** `allowParallelTools: true` throws `ConfigValidationError` at construction.

---

**Decision 6:**

- **Discussion:** What happens when `maxToolRounds: 0` is configured?
- **Suggestion:** `ConfigValidationError` at constructor. Zero rounds with tools registered is meaningless.
- **Decision:** `maxToolRounds < 1` throws `ConfigValidationError` at construction.

---

### B6 — Run I/O Contracts

---

**Decision 1:**

- **Discussion:** Should `prompt: ""` be rejected at `run()` entry?
- **Suggestion:** No validation. An empty prompt may produce a valid (if useless) response. Kernel should not enforce content policy.
- **Decision:** No validation on `prompt`. Kernel does not reject empty string.

---

**Decision 2:**

- **Discussion:** Should `stream` default to `false` or be required?
- **Suggestion:** `stream?: boolean` — `undefined` treated as `false` (non-streaming path).
- **Decision:** `stream?: boolean`. Undefined → non-streaming.

---

**Decision 3:**

- **Discussion:** Should `RunInput.metadata` pass through to `RunOutput`?
- **Suggestion:** Yes. Pass-through unchanged. Useful for correlating HTTP request IDs and other caller context through the full lifecycle.
- **Decision:** `RunOutput.metadata` is `RunInput.metadata` pass-through. Kernel does not read or modify it.

---

**Decision 4:**

- **Discussion:** What should `RunOutput.text` be when LLM only makes tool calls with no text?
- **Suggestion:** Empty string `""`. Consumer always gets a `string`, never `undefined`. Avoids optional chain requirement.
- **Decision:** `text: string` — always a string, `""` when LLM produces only tool calls.

---

**Decision 5:**

- **Discussion:** Should `ToolResult` in `RunOutput` include round information?
- **Suggestion:** No. Round information is available via the `tool.called` event. Bloating `RunOutput` is unnecessary.
- **Decision:** `toolResults: ToolResult[]` — round info not included.

---

**Decision 6:**

- **Discussion:** Should `StreamChunk` be a flat interface or a discriminated union?
- **Suggestion:** Discriminated union. Each `type` carries exactly its required fields. `delta` on `text` chunks becomes `string`, not `string | undefined`. Compile-time guarantees per chunk type.
- **Decision:** `StreamChunk` is a discriminated union (ADR-021).

---

**Decision 7:**

- **Discussion:** Should `done` chunk's `usage` be required or optional?
- **Suggestion:** Optional. Some providers do not report usage in streaming mode. Zero values would be misleading.
- **Decision:** `{ type: 'done'; usage?: TokenUsage }`.

---

### B7 — Hook Contracts

---

**Decision 1:**

- **Discussion:** Should `AfterRunContext` and `AfterToolContext` be defined as inline intersections or named types?
- **Suggestion:** Named types. More readable in `HookRegistry`, importable by adapter authors, self-documenting.
- **Decision:** `type AfterRunContext = RunContext & { output: RunOutput }` and `type AfterToolContext = ToolContext & { toolResult: ToolResult }` — named types.

---

**Decision 2:**

- **Discussion:** Should hook context types include `input: RunInput`?
- **Suggestion:** Yes for `BeforeGenerateContext`, `AfterGenerateContext`, and `ToolContext`. Hook authors frequently need `input.metadata` for authorization and correlation. Requiring them to parse `messages` to find the user prompt is poor ergonomics.
- **Decision:** `input: RunInput` added to `BeforeGenerateContext`, `AfterGenerateContext`, and `ToolContext`.

---

**Decision 3:**

- **Discussion:** Should `LifecycleHook` allow `void` return for observer-only hooks?
- **Suggestion:** No. Observer hooks belong in the event bus. Hooks that don't return context create ambiguity about what the next hook receives.
- **Decision:** `LifecycleHook<TContext>` returns `Promise<TContext> | TContext` — void not permitted.

---

### B8 — `OrchestratorConfig`

---

**Decision 1:**

- **Discussion:** Should `EventBus` be injectable via config?
- **Suggestion:** No. Custom `EventBus` implementations are not a V1 use case. `orchestrator.on()` is sufficient for all observability needs.
- **Decision:** `EventBus` not exposed in config.

---

**Decision 2:**

- **Discussion:** Should `contextPolicy` limits be user-configurable?
- **Suggestion:** No. `contextPolicy` is a kernel-internal security default. Community feedback will determine if V2 needs override support.
- **Decision:** `contextPolicy` not exposed in `OrchestratorConfig`.

---

**Decision 3:**

- **Discussion:** Should `tools: []` and `tools: undefined` behave differently in profile merging?
- **Suggestion:** Yes — intentionally different. `tools: []` is an explicit "no tools for this profile" override. `tools: undefined` means "use base tools."
- **Decision:** Difference documented explicitly in `interfaces-runtime.md`.

---

**Decision 4:**

- **Discussion:** What should happen when no `logger` is provided?
- **Suggestion:** No-op logger — no output, no errors thrown. Production use should always inject a logger but kernel must not fail silently.
- **Decision:** No-op logger default. Built-in logger implementation is V2 candidate.

---

**Decision 5:**

- **Discussion:** Should `OrchestratorConfig` include a `systemPrompt` field?
- **Suggestion:** Yes. Global system prompt is a common use case. Requiring a `beforeGenerate` hook for this violates the "config over code" principle.
- **Decision:** `systemPrompt?: string` added to `OrchestratorConfig` (ADR-025). Profile `systemPrompt` replaces (not appends) the base value.

---

### B9 — `OrchestratorProfile`

---

**Decision 1:**

- **Discussion:** Should `OrchestratorProfile.description` be kept?
- **Suggestion:** Yes. Developer-facing documentation field. No pipeline effect, but useful for code readability.
- **Decision:** `description?: string` retained.

---

**Decision 2:**

- **Discussion:** Should `fallbackProvider` be configurable per-profile?
- **Suggestion:** Yes. A profile may legitimately use a different provider stack. Stream + fallback validation applies at `run()` entry, not at construction.
- **Decision:** `fallbackProvider?: AIProvider` retained on `OrchestratorProfile`.

---

### B10 — `EventBus` and `OrchestratorEvent`

---

**Decision 1:**

- **Discussion:** Are `tool.failed` and `context.failed` event payloads carrying the right error type?
- **Suggestion:** Neither `string` nor `OrchestratorError` instance is right for these events. A serialized DTO — `EventErrorPayload` — provides `code`, `message`, `retryable` without tight coupling to the error class hierarchy.
- **Decision:** `tool.failed` and `context.failed` use `EventErrorPayload`. `run.failed` retains `OrchestratorError` instance (consumer needs `instanceof` checks).

---

**Decision 2:**

- **Discussion:** Should `EventErrorPayload` and `ToolResultError` be merged since they have the same shape?
- **Suggestion:** Keep separate. Structural convergence is accidental — semantics differ. Each may diverge independently. Merging creates hidden coupling between event bus and tool result domains (ADR-023).
- **Decision:** Two separate interfaces retained.

---

**Decision 3:**

- **Discussion:** What type should `EventErrorPayload.code` use — `string` or a reference to `OrchestratorErrorCode`?
- **Suggestion:** Reference `OrchestratorErrorCode`. DRY — union defined once, referenced everywhere. Consumer gets exhaustive switch/case support.
- **Decision:** `EventErrorPayload.code: OrchestratorErrorCode`.

---

### B11 — `Orchestrator` Class Public API

---

**Decision 1**

- **Discussion:** Is the third `run()` overload (implementation signature) necessary and should it be documented?
- **Suggestion:** It is TypeScript-required for overload implementation. Not part of the public API surface. Should be documented in `interfaces-runtime.md` to prevent confusion.
- **Decision:** Third overload retained. Documented as implementation-only in `interfaces-runtime.md`.

---

**Decision 2**

- **Discussion:** Should `on()` use an unsubscribe function pattern or an `off(type, listener)` method?
- **Suggestion:** Unsubscribe function `() => void`. `off()` requires holding the same function reference, which fails with arrow functions. Unsubscribe closure captures the reference correctly.
- **Decision:** `on()` returns `() => void` unsubscribe function.

---

**Decision 3**

- **Discussion:** Should `Orchestrator` be a class or a factory function?
- **Suggestion:** Class. Better IDE autocomplete, `instanceof` check possible, more familiar convention for library consumers.
- **Decision:** Class retained.

---

**Decision 4**

- **Discussion:** Should `Orchestrator` have a `dispose()` or `destroy()` method?
- **Suggestion:** No. Core is stateless — GC handles cleanup. Listeners are managed by the caller via unsubscribe functions.
- **Decision:** No `dispose()` or `destroy()`.

---

## Group C — Error Taxonomy

### C1 — `OrchestratorError` Base Class

---

**Decision 1:**

- **Discussion:** Should `OrchestratorError` include both `retryable` and `fatal` fields?
- **Suggestion:** Remove `fatal`. It is always `!retryable` — redundant. Reduces frozen surface area.
- **Decision:** `fatal` removed. `retryable: false` communicates fatal intent (ADR-028).

---

**Decision 2:**

- **Discussion:** Should `OrchestratorError.code` be typed as `string` or `OrchestratorErrorCode`?
- **Suggestion:** `OrchestratorErrorCode` — the full union. Single source of truth, consumer exhaustive switch support, MINOR to widen.
- **Decision:** `abstract readonly code: OrchestratorErrorCode` (ADR-022).

---

**Decision 3:**

- **Discussion:** Should a single `OrchestratorErrorCode` union be defined?
- **Suggestion:** Yes — one union in `interfaces.ts`, imported via `import type` in `errors.ts`. Adding a code is MINOR (widening). Removing is MAJOR (breaking).
- **Decision:** `OrchestratorErrorCode` as a named union type in `interfaces-core.md`.

---

**Decision 4:**

- **Discussion:** Should `Error.captureStackTrace` be called unconditionally?
- **Suggestion:** Guard it: `if (Error.captureStackTrace) { ... }`. V8-specific API — not available in all edge runtimes.
- **Decision:** Guarded call retained.

---

### C2 — Error Classes

---

**Decision 1**

- **Discussion:** Should `ProviderMalformedResponse` include a `cause` parameter?
- **Suggestion:** Yes — all error classes should accept `cause` for debuggability and stack trace preservation.
- **Decision:** `ProviderMalformedResponse(message: string, cause?: unknown)` — `cause` added.

---

**Decision 2**

- **Discussion:** Should `ToolValidationError.validationErrors` be `string[]` or a structured `ValidationError[]`?
- **Suggestion:** `string[]` for V1. Structured errors are a V2 candidate.
- **Decision:** `validationErrors: string[]`.

---

**Decision 3**

- **Discussion:** Should `InvalidStateTransitionError` take `string` or `LifecycleState` parameters?
- **Suggestion:** `LifecycleState | 'any'`. Type-safe; `errors.ts` can import `LifecycleState` via `import type` from the same Layer 0 without circular dependency.
- **Decision:** `constructor(from: LifecycleState, to: LifecycleState | 'any')`.

---

**Decision 4**

- **Discussion:** Should `TokenLimitExceededError` be thrown by the kernel when token limit is exceeded?
- **Suggestion:** No. Kernel trims `memoryMessages` instead of throwing. This class exists for `beforeRun` hooks where user code enforces custom budgets.
- **Decision:** Kernel does NOT throw `TokenLimitExceededError` internally. User-land only. Documented in `error_taxonomy.md`.

---

### C3 — `isRetryable()` Helper

---

**Decision 1:**

- **Discussion:** Should `isRetryable()` use a TypeScript type predicate (`error is OrchestratorError`)?
- **Suggestion:** No. A predicate that returns `true` for `retryable: true` errors would narrow to `OrchestratorError` even for non-retryable ones — misleading. Plain `boolean` is correct.
- **Decision:** `isRetryable(error: unknown): boolean` — no type predicate.

---

**Decision 2:**

- **Discussion:** What should `isRetryable()` return for unknown or plain errors?
- **Suggestion:** `false`. Unknown errors are treated as fatal by default — safe conservative behavior.
- **Decision:** Unknown/plain errors return `false`.

---

### C4 — `ToolResultError` Semantics

---

**Decision 1:**

- **Discussion:** Is `ToolResultError` the right carrier for `tool.failed` event payloads?
- **Suggestion:** No. `ToolResultError` is a tool result DTO; using it in event payloads creates cross-domain coupling. A dedicated `EventErrorPayload` interface is cleaner.
- **Decision:** `EventErrorPayload` used for event payloads. `ToolResultError` stays in `ToolResult.error`. Both interfaces kept separate (ADR-023).

---

## Group D — Core Primitives

### D1 — `LifecycleStateMachine`

---

**Decision 1:**

- **Discussion:** Should `VALID_TRANSITIONS` be exported?
- **Suggestion:** No — internal implementation detail. Per `api_design.md` §Export Surface Rules.
- **Decision:** `VALID_TRANSITIONS` not exported.

---

**Decision 2:**

- **Discussion:** Where should `LifecycleState` type be defined — `lifecycle.ts`, `types.ts`, or `interfaces.ts`?
- **Suggestion:** `interfaces.ts` — exported. Consumer needs it to type-check `InvalidStateTransitionError.from` and `.to`. `errors.ts` imports it via `import type`, no circular dependency.
- **Decision:** `LifecycleState` defined and exported in `interfaces.ts`.

---

**Decision 3:**

- **Discussion:** Should `assertNotTerminal()` be public?
- **Suggestion:** Class-internal. Called by `pipeline.ts` but not part of the public API.
- **Decision:** `assertNotTerminal()` stays on class but is not part of the exported public API surface.

---

**Decision 4:**

- **Discussion:** Should `LifecycleStateMachine` hold `runId` or `Logger`?
- **Suggestion:** No. Pure state guard — no logging capability. All state transition logs written by `pipeline.ts`, which owns both the machine instance and the `runId`. Per `state_machine.md` Rule 9.
- **Decision:** `LifecycleStateMachine` holds no `runId` or `Logger`.

---

**Decision 5:**

- **Discussion:** Should `transition()` return `void` or the previous state?
- **Suggestion:** Return previous state (`LifecycleState`). `pipeline.ts` can log `from → to` in a single line without a separate variable.
- **Decision:** `transition(to: LifecycleState): LifecycleState` — returns previous state (ADR-029).

---

### D2 — `policies.ts`

---

**Decision 1:**

- **Discussion:** Should default policy constants (`DEFAULT_RETRY`, `DEFAULT_TIMEOUT`, `DEFAULT_TOOL_POLICY`) be exported?
- **Suggestion:** No — implementation detail. Default values are documented in `interfaces-runtime.md`. No need to expose raw constants.
- **Decision:** Default constants not exported.

---

**Decision 2:**

- **Discussion:** Should policy merge utilities be in `pipeline.ts` or `policies.ts`?
- **Suggestion:** `policies.ts` as internal utilities. DRY — both pipeline and profile merging use the same logic. `pipeline.ts` imports without knowing the merge algorithm.
- **Decision:** `mergePolicy()` utilities in `policies.ts`, internal, not exported.

---

**Decision 3:**

- **Discussion:** Is the `calculateDelay()` algorithm (30% partial jitter) sufficient?
- **Suggestion:** Yes. Jitter algorithm is implementation detail — not part of frozen interface. `Math.random() * 0.3 * capped` is a reasonable partial jitter.
- **Decision:** `calculateDelay()` algorithm unchanged.

---

**Decision 4:**

- **Discussion:** Should `executeWithRetry()` and `executeWithFallback()` live in `policies.ts` or `pipeline.ts`?
- **Suggestion:** `policies.ts` (Layer 1 primitives). Policy logic does not belong in the pipeline layer.
- **Decision:** Both functions in `policies.ts`, internal.

---

**Decision 5:**

- **Discussion:** Should `executeWithRetry()` have an `onRetry` callback?
- **Suggestion:** Yes. `pipeline.ts` uses it to emit events and write logs on retry. Dependency injection keeps policy logic decoupled from observability.
- **Decision:** `onRetry?: (attempt: number, error: OrchestratorError) => void` retained.

---

### D3 — `PromptComposer`

---

**Decision 1:**

- **Discussion:** Is the message assembly order frozen?
- **Suggestion:** Yes. `systemPrompt → contextMessages → memoryMessages (trimmed) → userMessage`. Tool definitions go separately in `PromptRequest.tools`. This order is a kernel contract.
- **Decision:** Composition order frozen per `architecture.md` Step 4.

---

**Decision 2:**

- **Discussion:** Where does `systemPrompt` resolution happen?
- **Suggestion:** `profile.ts` resolves (profile overrides base). `PromptComposer` receives the already-resolved `systemPrompt?: string`. Composer has no awareness of profiles.
- **Decision:** `PromptComposer` accepts a resolved `systemPrompt?: string` parameter.

---

**Decision 3:**

- **Discussion:** Should `estimateTokens()` use a real tokenizer or the `text.length / 4` approximation?
- **Suggestion:** Approximation for V1. Real tokenizers are external dependencies, incompatible with runtime-agnostic design. Limitation documented. Accurate tokenizer is a V2 candidate.
- **Decision:** `estimateTokens(text) ≈ Math.ceil(text.length / 4)`. Limitation documented.

---

**Decision 4:**

- **Discussion:** Should `PromptComposer` be a class or a pure function?
- **Suggestion:** Class. Dependency injection via constructor enables test mocking by `pipeline.ts`.
- **Decision:** Class retained.

---

**Decision 5:**

- **Discussion:** Does token trimming apply to context messages or only memory messages?
- **Suggestion:** Memory messages only. Context messages (`contextMessages`) and system prompt are never trimmed — they contain critical retrieval results and instructions.
- **Decision:** Token trimming applies to `memoryMessages` only. `contextMessages` and `systemPrompt` are never trimmed.

---

## Group E — Controllers

### E1 — `ToolController`

---

**Decision 1:**

- **Discussion:** Should the tool round counter live inside `ToolController` or in `pipeline.ts`?
- **Suggestion:** `pipeline.ts` as a local `let roundCounter = 0` variable. `ToolController` handles a single round's execution; it should not track cross-round state.
- **Decision:** Round counter is a local variable in `pipeline.ts`. `ToolController` has no round awareness.

---

**Decision 2:**

- **Discussion:** Should `executeRound()` accept a `round` parameter?
- **Suggestion:** No. Round tracking is `pipeline.ts`'s concern. Passing it to `ToolController` creates a leaky abstraction.
- **Decision:** `executeRound(toolCalls: ToolCall[]): Promise<ToolResult[]>` — no `round` parameter.

---

**Decision 3:**

- **Discussion:** Where should per-tool timeout (`toolTimeoutMs`) enforcement happen?
- **Suggestion:** Inside `ToolController`, wrapping each `Tool.execute()` in `Promise.race`. `ToolPolicy.toolTimeoutMs` is already injected via constructor.
- **Decision:** `Promise.race` timeout wrap in `ToolController.executeSingle()`.

---

**Decision 4:**

- **Discussion:** Should schema validation use Zod inside `ToolController`?
- **Suggestion:** Yes. Zod is the only runtime dependency in `@atisse/core`. `ToolValidationError` is FATAL — schema failures are programmer errors caught at development time.
- **Decision:** Zod `safeParse` inside `ToolController`. `ToolValidationError` on schema mismatch.

---

**Decision 5:**

- **Discussion:** LLM may request parallel tool calls — how does the kernel handle them in V1?
- **Suggestion:** Serial execution. Even if `toolCalls` array has multiple entries, `executeRound()` iterates sequentially. Documented behavior — LLM parallel request does not imply parallel kernel execution.
- **Decision:** Serial execution only in V1. Documented in `interfaces-runtime.md`.

---

### E2 — `hooks.ts`

---

**Decision 1:**

- **Discussion:** Should `runHooks()` check if a hook returns `undefined` or `null`?
- **Suggestion:** Yes — throw an internal error. Hook author may accidentally omit `return`. Early detection prevents subtle downstream bugs.
- **Decision:** `runHooks()` throws if a hook returns `undefined` or `null`.

---

**Decision 2:**

- **Discussion:** Should `HookRegistry` arrays be mutable or readonly?
- **Suggestion:** `ReadonlyArray<LifecycleHook<T>>`. Hooks are set at construction and should not be mutated at runtime.
- **Decision:** All `HookRegistry` arrays use `ReadonlyArray`.

---

**Decision 3:**

- **Discussion:** Should there be a utility to normalize `Partial<HookRegistry>` to a full `HookRegistry`?
- **Suggestion:** Yes — `normalizeHookRegistry()` internal utility in `hooks.ts`. Replaces `undefined` arrays with `[]`. Called by `pipeline.ts` before any hook execution. Avoids repeated null-coalescing at each hook point.
- **Decision:** `normalizeHookRegistry()` as internal utility in `hooks.ts`.

---

### E3 — `events.ts`

---

**Decision 1:**

- **Discussion:** What internal data structure should `EventBus` use for listeners?
- **Suggestion:** `Map<string, Set<Function>>`. `WeakMap` is inappropriate with string keys. `Set` prevents duplicate listener registration.
- **Decision:** `Map<string, Set<Function>>`.

---

**Decision 2:**

- **Discussion:** Should `EventBus` inject a `Logger` to log swallowed listener errors?
- **Suggestion:** This belongs in V2. V1's swallow-and-silence behavior is acceptable. Logger injection requires design decisions about interface, constraints, and delivery that are V2 scope.
- **Decision:** Listener errors silently swallowed in V1. `EventBus` Logger injection is V2 candidate.

---

**Decision 3:**

- **Discussion:** How should async event listeners be handled to avoid unhandled Promise rejections?
- **Suggestion:** Detect `Promise` return value and wrap in async IIFE with try/catch. Must not use `.then()/.catch()` chains — per `implementation_standards.md` §Async. The `void` operator marks intentional fire-and-forget.
- **Decision:** Async IIFE pattern:

```typescript
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

---

**Decision 4:**

- **Discussion:** How does unsubscribe work given `Set.delete()` requires reference equality?
- **Suggestion:** The returned unsubscribe closure captures the listener reference. Arrow functions create new references each call — documented as a memory leak risk.
- **Decision:** `on()` returns `() => set.delete(listener)`. Memory leak risk documented in `hooks_and_events.md`.

---

## Group F — Orchestration Layer

### F1 — `profile.ts`

---

**Decision 1:**

- **Discussion:** What happens when `profile: 'nonexistent'` is passed to `run()`?
- **Suggestion:** `ConfigValidationError` at `run()` entry. Silent fallback to base config would mask typos and misconfiguration.
- **Decision:** Missing profile key → `ConfigValidationError` at `run()` entry.

---

**Decision 2:**

- **Discussion:** Does profile merge resolution need to be stateful or can it be local to each `run()` call?
- **Suggestion:** Local — `ResolvedConfig` is a local variable in `pipeline.ts`. `Orchestrator` instance is stateless.
- **Decision:** Profile resolution is per-call local state. Never stored on `this`.

---

### F2 — `pipeline.ts`

---

**Decision 1:**

- **Discussion:** How should `totalTimeoutMs` be enforced?
- **Suggestion:** `Promise.race([executePipeline(...), timeoutPromise])` at `pipeline.ts` top level. `AbortSignal` is cooperative — non-compliant operations ignore it. `Promise.race` is an unconditional hard ceiling regardless of which step is currently active.
- **Decision:** `totalTimeoutMs` enforced via `Promise.race` at pipeline top level (ADR-026).

---

**Decision 2:**

- **Discussion:** When should `afterGenerate` hook fire in streaming mode?
- **Suggestion:** After the `done` chunk is received, with accumulated text and usage in `response`. Firing mid-stream would provide a partial and misleading `PromptResponse` to validation hooks.
- **Decision:** `afterGenerate` in streaming mode fires after `done` chunk (ADR-027).

---

**Decision 3:**

- **Discussion:** What is the `tempMessages` buffer pattern for?
- **Suggestion:** Atomic memory save. `tempMessages = [userMessage, assistantMessage]` built during execution. Saved as one batch at COMPLETING. Prevents partial saves where only the user message gets persisted.
- **Decision:** `tempMessages` local array, initialized at Step 1, saved atomically at Step 9 (COMPLETING).

---

**Decision 4:**

- **Discussion:** How should ContextProvider partial failure be handled?
- **Suggestion:** Fail-fast. First provider failure aborts all context loading. Partial context results from earlier providers are discarded. `context.failed` emitted. (ADR-015)
- **Decision:** First provider failure → discard partial results → `RETRYING` or `FAILED`. No partial context delivery.

---

### F3 — `orchestrator.ts`

---

**Decision 1:**

- **Discussion:** What is the constructor validation order?
- **Suggestion:** Validate in this sequence: provider present → `profiles[key].name === key` → `allowParallelTools !== true` → `maxToolRounds >= 1` → timeout values valid → no duplicate tool names.
- **Decision:** Validation order as above. All violations throw `ConfigValidationError`.

---

**Decision 2:**

- **Discussion:** Should `Tool[]` → `Map<string, Tool>` conversion happen in constructor or pipeline?
- **Suggestion:** Constructor. Detects duplicates at construction time — earlier feedback. `ToolController` receives `Map<string, Tool>`.
- **Decision:** Conversion in `orchestrator.ts` constructor. Duplicate names → `ConfigValidationError`.

---

## Group G — Test Infrastructure

### G1 — `MockProvider`

---

**Decision 1:**

- **Discussion:** What happens when `generate()` is called with an empty queue?
- **Suggestion:** Throw `ProviderUnavailableError`. Tests must enqueue enough entries — empty queue is a test setup error, not a silent no-op.
- **Decision:** Empty queue → `ProviderUnavailableError`.

---

**Decision 2:**

- **Discussion:** Should `generateStream()` yield word-level or character-level chunks?
- **Suggestion:** Character-level. More deterministic — predictable chunk count and content for assertion.
- **Decision:** Character-level chunks.

---

**Decision 3:**

- **Discussion:** What should `MockProvider`'s default `capabilities` be?
- **Suggestion:** `streaming: true`, `toolCalling: true`, `vision: false`, `maxContextTokens: 128_000`. Defaults enable full feature testing without extra configuration.
- **Decision:** Default capabilities as above.

---

### G2 — Test Fixture Builders

---

**Decision 1:**

- **Discussion:** Is a separate `MockMemoryAdapter` needed when `InMemoryAdapter` already exists?
- **Suggestion:** Yes. `InMemoryAdapter` cannot inject errors. Unit tests need to simulate `load()` and `save()` failures. `InMemoryAdapter` used in integration tests; `MockMemoryAdapter` in unit tests.
- **Decision:** `MockMemoryAdapter` with `loadError` and `saveError` injection points in `tests/fixtures/mock-memory.ts`.

---

**Decision 2:**

- **Discussion:** What standard mock tools should be provided?
- **Suggestion:** Four tools covering the most common test scenarios: `echoTool`, `failingTool`, `validationFailTool`, `slowTool`.
- **Decision:** All four tools in `tests/fixtures/mock-tools.ts`.

---

**Decision 3:**

- **Discussion:** Should `buildProfile()` be added to the fixture builders?
- **Suggestion:** Yes. `OrchestratorProfile` is a plain object but having a builder with sensible defaults reduces test boilerplate, especially the `name`/key invariant.
- **Decision:** `buildProfile(overrides?: Partial<OrchestratorProfile>): OrchestratorProfile` added to `builders.ts`.

---

## Group H — Reference Implementations

### H1 — `InMemoryAdapter`

---

**Decision 1:**

- **Discussion:** Should `InMemoryAdapter` have a max session size limit?
- **Suggestion:** No. Reference implementation and test fixture only. Production deployments use Redis. Size limits would add complexity without value at this layer.
- **Decision:** No size limit. "Not for production use" documented.

---

**Decision 2:**

- **Discussion:** Should `InMemoryAdapter` support TTL?
- **Suggestion:** No. TTL is a persistence concern — belongs in `RedisMemoryAdapter` (M4). Reference implementation is intentionally minimal.
- **Decision:** No TTL support.

---

**Decision 3:**

- **Discussion:** Are `InMemoryAdapter` and `MockMemoryAdapter` the same class?
- **Suggestion:** No. `InMemoryAdapter` is the production-quality reference implementation in `packages/memory-inmemory/`. `MockMemoryAdapter` is the error-injection-capable test fixture in `core/tests/fixtures/`. Two uses, two files.
- **Decision:** Two separate classes. `InMemoryAdapter` in integration tests; `MockMemoryAdapter` in unit tests.

---

## Structural Decisions (Cross-Cutting)

---

**Decision 1:**

- **Discussion:** Should `interfaces.md` remain as a single file or be split?
- **Suggestion:** Split into `interfaces-core.md` and `interfaces-runtime.md`. The single file would exceed 12,000 characters after all decisions are applied. Domain boundary is natural: core types (provider, message, tool, memory, context) vs runtime types (run I/O, hooks, events, config, profile, Orchestrator class).
- **Decision:** Split into two files. `interfaces-core.md` and `interfaces-runtime.md`.

---

**Decision 2:**

- **Discussion:** Should `decision_log.md` be split as it approaches and exceeds the 12,000 character limit?
- **Suggestion:** Do not split. ADRs are chronologically chained — splitting breaks referential integrity. Compress the format instead: each ADR to ~8-10 lines.
- **Decision:** `decision_log.md` stays single file. Format compressed.

---

**Decision 3:**

- **Discussion:** Should `architecture.md`, `error_taxonomy.md`, and `hooks_and_events.md` be split?
- **Suggestion:** No. Domain cohesion is more important than file size for these documents. Compress prose and non-essential examples instead.
- **Decision:** All three files compressed without splitting.
