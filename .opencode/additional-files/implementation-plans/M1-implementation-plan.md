# M1 Implementation Plan

## Toolchain, Contracts, Errors, Lifecycle

**Status:** Ready to implement </br>
**Blocker:** None </br>

---

## 1. Mandatory/Conditional Reading Before Writing Any Code

### Mandatory Reading

Per `@.opencode/rules/task-context.md` §"Before Starting Any Task":

1. `@.opencode/rules/interfaces-core.md` — core type contracts
2. `@.opencode/rules/interfaces-runtime.md` — runtime contracts
3. `@.opencode/rules/error-taxonomy.md` — error hierarchy and `isRetryable()` rules
4. `@.opencode/rules/state-machine.md` — `LifecycleStateMachine` contract and transition table
5. `@.opencode/rules/constraints.md` — forbidden patterns
6. `@.opencode/rules/typescript-style.md` — naming, typing, async conventions
7. `@.opencode/rules/implementation-standards.md` — defensive programming, size limits
8. `@.opencode/workflows/testing-standards.md` — MockProvider API, test structure

### Conditional Reading

Optional but highly recommended for deeper context and rationale behind the implementation patterns and decisions in this plan:

1. `@.opencode/rules/decision-log.md` — key decisions and ADRs that affect implementation; not required but provides helpful context and rationale for certain patterns
2. `(ADR-0*)` references in the checklists link to specific ADRs in the decision log for deeper context on those decisions. For reference see `1.`
3. IF you seen like a expression `(B1)`, `(A1 -> Decision 1)`, `(B2 -> Decision 2)`, etc. in the tables, texts, that references a specific decision in the `@.opencode/additional-files/decision-records/M1-decision-record.md` file. These are mandatory reading when you are implementing the related checklist item, as they contain the rationale and context behind those decisions. For example, if you see `(A2 -> Decision 2)` next to "No project references", you would look up `(A2 -> Decision 2)` in the decision record to understand why that choice was made and any relevant discussion points.

---

## 2. Phase 1 — Monorepo Toolchain

### Files to Create

| File                                        | Purpose                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm-workspace.yaml`                       | Declare `packages/*`                                                                           |
| `package.json` (root)                       | Workspace scripts: `lint`, `typecheck`, `test`, `build`                                        |
| `tsconfig.base.json`                        | Root TS config — all packages extend this                                                      |
| `eslint.config.mjs`                         | Flat config — single file at root covering all packages                                        |
| `.prettierrc`                               | Formatting rules per `typescript_style.md`                                                     |
| `.prettierignore`                           | Excludes: `dist/`, `node_modules/`, `coverage/`, `*.md`                                        |
| `vitest.base.config.ts`                     | Shared Vitest config — each package extends                                                    |
| `packages/core/package.json`                | `@atisse/core` — exports field with two entry points; includes `"engines": { "node": ">=20" }` |
| `packages/core/tsconfig.json`               | Extends `../../tsconfig.base.json`                                                             |
| `packages/core/tsup.config.ts`              | ESM + CJS dual output                                                                          |
| `packages/core/vitest.config.ts`            | Extends `../../vitest.base.config.ts`                                                          |
| `packages/memory-inmemory/package.json`     | `@atisse/memory-inmemory` skeleton; includes `"engines": { "node": ">=20" }`                   |
| `packages/memory-inmemory/tsconfig.json`    | Extends root base                                                                              |
| `packages/memory-inmemory/tsup.config.ts`   | Same tsup pattern as core                                                                      |
| `packages/memory-inmemory/vitest.config.ts` | Extends root base                                                                              |

### Key Decisions Applied

- **Module resolution:** `NodeNext` — per `typescript_style.md` §TypeScript Configuration. All internal imports use `.js` extension.
- **`lib: ["ES2022"]`** — runtime-agnostic base; `@types/node` as devDependency per package, never in base (A2 -> Decision 1).
- **No project references** — simple `extends` only (A2 -> Decision 2).
- **ESLint flat config** — `eslint.config.mjs`, single root file (A3 -> Decision 3).
- **`*.md` excluded from Prettier** (A3 -> Decision 5).
- **Coverage reporters:** `['text', 'html', 'json-summary']` (A3 -> Decision 6).
- **Root scripts:** `--recursive` (A3 -> Decision 1).
- **tsup:** `splitting: false`, `clean: true` (A3 -> Decision 2).
- **`@atisse/core` exports field** — two subpath entries per A1 decision(A1 -> Decision 3):
  - `"."` → `./dist/index.js` / `./dist/index.cjs`
  - `"./testing"` → `./dist/testing/mock-provider.js` / `./dist/testing/mock-provider.cjs`
- **`engines` field:** Root `package.json` and every adapter `package.json` must declare `"engines": { "node": ">=20" }`. This is complementary to CI `node-version` — it warns downstream consumers at install time. Not redundant.

---

## 3. Phase 2 — `packages/core/src/interfaces.ts`

**STATUS: FROZEN upon creation.** Per `interfaces-core.md` and `interfaces-runtime.md`.
No runtime code — type declarations only. Every exported symbol gets JSDoc — per `api_design.md` §Documentation Requirements.

### Types to Define — From `interfaces-core.md`

| Symbol                        | Key Decision                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `LifecycleState`              | Exported — consumers type-check `InvalidStateTransitionError.from/.to` (D1 -> Decision 2/ADR)                                       |
| `OrchestratorErrorCode`       | 16-value union; `errors.ts` imports via `import type` (C2/ADR-022)                                                                  |
| `EventErrorPayload`           | `code: OrchestratorErrorCode`; DTO only — never thrown (B10 -> Decision 3)                                                          |
| `AIProvider`                  | `generateStream?` returns `Promise<AsyncIterable<StreamChunk>>` (B1 -> Decision 2/ADR-019)                                          |
| `ProviderCapabilities`        | `vision` is documentation-only — no pipeline effect (B1 -> Decision 3)                                                              |
| `PromptRequest`               | Includes `providerOptions?: Record<string, unknown>` and `signal?: AbortSignal` (B1 -> Decision 5)                                  |
| `PromptResponse`              | `finishReason`: `'stop' \| 'tool_calls' \| 'length'` — `'error'` absent (B1 -> Decision 6)                                          |
| `Message`                     | 4-arm discriminated union; `tool` arm: `toolCallId` and `name` required; `assistant` arm: `toolCalls?` (B2 -> Decision 2/ADR-018)   |
| `MessageContent`              | `text` and `image` discriminated union; `url` accepts data URIs (B2 -> Decision 5)                                                  |
| `SystemMessage`               | `Extract<Message, { role: 'system' }>` — derived from union, not standalone (B4 -> Decision 6)                                      |
| `ToolDefinition`              | `inputSchema: Record<string, unknown>` — empty `{}` forbidden per `constraints.md`                                                  |
| `Tool extends ToolDefinition` | `execute(input: unknown): Promise<unknown>` — typed generics V2 (B3 -> Decision 2)                                                  |
| `ToolCall`                    | `id` required — adapter must generate via `randomUUID()` if provider omits (B3 -> Decision 3)                                       |
| `ToolResult`                  | Discriminated union — `output` and `error` mutually exclusive (B3 -> Decision 4/ADR-020)                                            |
| `ToolResultError`             | `code` is 3-value union literal; DTO only — never thrown; semantically distinct from `EventErrorPayload` (B3 -> Decision 5/ADR-023) |
| `MemoryAdapter`               | `load()` returns `[]` not throws; `clear()` idempotent (B4 -> Decision 1)                                                           |
| `ContextProviderInput`        | `Omit<RunInput, 'stream' \| 'profile'>` — named type (B4 -> Decision 7/ADR-024)                                                     |
| `ContextProvider`             | `provide()` returns `Promise<SystemMessage[]>` (B4 -> Decision 6)                                                                   |
| `TokenUsage`                  | `prompt`, `completion`, `total`                                                                                                     |

### Types to Define — From `interfaces-runtime.md`

| Symbol                    | Key Decision                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `RetryPolicy`             | `maxAttempts` = total attempts (B5 -> Decision 1&2); `jitter: boolean`                                                            |
| `TimeoutPolicy`           | `generateTimeoutMs`, `toolTimeoutMs`, `totalTimeoutMs`                                                                            |
| `ToolPolicy`              | `allowParallelTools` must be `false`; `maxToolRounds` min 1                                                                       |
| `RunInput`                | `stream?: boolean` (undefined = false); `metadata` pass-through (B6 -> Decision 2&3)                                              |
| `RunOutput`               | Includes `runId: string`; `metadata` pass-through (B6 -> Decision 3/4)                                                            |
| `StreamChunk`             | Discriminated union; `done.usage?: TokenUsage` — optional (B6 -> Decision 6-7/ADR-021)                                            |
| `LifecycleHook<TContext>` | Generic hook type                                                                                                                 |
| `HookRegistry`            | All arrays `ReadonlyArray<LifecycleHook<T>>` (E2 -> Decision 2)                                                                   |
| `RunContext`              | `{ input: RunInput; runId: string }`                                                                                              |
| `AfterRunContext`         | `RunContext & { output: RunOutput }` — named type (B7 -> Decision 1)                                                              |
| `BeforeGenerateContext`   | `{ messages, input: RunInput, runId }` — `input` added (B7 -> Decision 2)                                                         |
| `AfterGenerateContext`    | `{ messages, response, input: RunInput, runId }` — `input` added (B7 -> Decision 2)                                               |
| `ToolContext`             | `{ toolCall, input: RunInput, runId }` — `input` added (B7 -> Decision 2)                                                         |
| `AfterToolContext`        | `ToolContext & { toolResult }` — named type (B7 -> Decision 1)                                                                    |
| `Logger`                  | No-op if not provided; built-in logger V2 candidate                                                                               |
| `OrchestratorConfig`      | Includes `systemPrompt?: string` (B8 -> Decision 5/ADR-025)                                                                       |
| `OrchestratorProfile`     | `tools: []` replaces base; `tools: undefined` preserves base                                                                      |
| `Orchestrator` class      | Constructor + two `run()` overloads + implementation signature + `on()`                                                           |
| `EventBus`                | Internal; `on()` returns `() => void` unsubscribe                                                                                 |
| `OrchestratorEvent`       | Full union; `tool.failed` and `context.failed` use `EventErrorPayload`; `run.failed` uses `OrchestratorError` (B10 -> Decision 1) |

---

## 4. Phase 3 — `packages/core/src/errors.ts`

Per `error_taxonomy.md`.

**Import pattern:**

```typescript
import type { LifecycleState, OrchestratorErrorCode } from "./interfaces.js";
```

`import type` only — no runtime circular dependency. Per `typescript_style.md` §Type Declarations.

### Implementation Checklist

- [ ] `OrchestratorError` abstract base — `code: OrchestratorErrorCode`, `retryable: boolean`, `cause?: unknown`; `fatal` field absent (C1 -> 1-2/ADR-028)
- [ ] `Error.captureStackTrace` guarded: `if (Error.captureStackTrace) { ... }` — edge runtime compat
- [ ] All 14 concrete classes per `error_taxonomy.md` §Full TypeScript Definitions — exact constructors
- [ ] `ProviderRateLimitError` — `retryAfterMs?: number` parameter
- [ ] `InvalidStateTransitionError` — `from: LifecycleState, to: LifecycleState | 'any'` (C2 -> Decision 3)
- [ ] `TokenLimitExceededError` — kernel does NOT throw this; for `beforeRun` hooks only (C2 -> Decision 4)
- [ ] `isRetryable(error: unknown): boolean` — returns `boolean`, no type predicate (C3 -> Decision 1)
- [ ] `isRetryable` safe defaults: unknown/plain errors return `false`

---

## 5. Phase 4 — `packages/core/src/lifecycle.ts`

Per `state_machine.md`.

### Implementation Checklist

- [ ] `VALID_TRANSITIONS: Record<LifecycleState, LifecycleState[]>` — NOT exported (D1 -> Decision 1); per `api_design.md` §Export Surface Rules
- [ ] All 11 states covered; terminal states (`COMPLETED`, `FAILED`) have empty arrays
- [ ] `LifecycleStateMachine` class — `private current: LifecycleState = 'INITIALIZED'`
- [ ] `transition(to: LifecycleState): LifecycleState` — returns previous state (D1 -> Decision 5/ADR-029)
- [ ] `get state(): LifecycleState`
- [ ] `isTerminal(): boolean` — checks `COMPLETED` or `FAILED`
- [ ] `assertNotTerminal(): void` — throws `InvalidStateTransitionError(this.current, 'any')`
- [ ] No `runId` or `Logger` held on instance — per `state_machine.md` Rule 9
- [ ] State does not change when `transition()` throws

---

## 6. Implementation Order

```
Phase 1 — Monorepo toolchain
          │
          ▼
Phase 2 — interfaces.ts ─────────────────────────────┐
          │                                          │
          ▼                                          │
Phase 3 — errors.ts                                  │
   (import type ← interfaces.ts)                     │
          │                                          │
          ▼                                          │
Phase 4 — lifecycle.ts                               │
   (import type ← interfaces.ts)                     │
   (import ← errors.ts)                              │
          │                                          ▼
          └───────────────────────────────── Phases 5-8
```

Compile and typecheck after each phase before proceeding.
Command: `pnpm --filter @atisse/core typecheck`

---

## 7. Layer Compliance

Per `architecture.md` §Internal Layer Architecture — enforced by ESLint import plugin:

| File            | Layer           | May import from                        |
| --------------- | --------------- | -------------------------------------- |
| `interfaces.ts` | L0 — contracts  | Nothing (type declarations only)       |
| `errors.ts`     | L0 — contracts  | `interfaces.ts` via `import type` only |
| `types.ts`      | L0 — contracts  | `interfaces.ts` via `import type` only |
| `lifecycle.ts`  | L1 — primitives | L0 only                                |

Upward imports are **FORBIDDEN**. Runtime circular imports are **FORBIDDEN**.
`import type` between L0 files is permitted per `architecture.md`.

## 8. Phase 5 — Test Infrastructure

Per `testing_standards.md` §MockProvider API Contract and §Mock Infrastructure.
All test files live under `packages/core/tests/`.

### `packages/core/src/testing/mock-provider.ts`

`MockProvider` is test infrastructure — not an adapter. Exported via `@atisse/core/testing` subpath.

**Implementation checklist:**

- [ ] `MockProviderEntry` discriminated union:
      `| { text: string; toolCalls?: ToolCall[]; finishReason?: PromptResponse['finishReason'] }`
      `| { error: OrchestratorError }`
- [ ] `MockProvider implements AIProvider`
- [ ] `readonly id: string` — constructor param, default `'mock-test'`
- [ ] `readonly capabilities: ProviderCapabilities` — defaults: `streaming: true`, `toolCalling: true`, `vision: false`, `maxContextTokens: 128_000`
- [ ] `private queue: MockProviderEntry[]`
- [ ] `private _callCount: number` — underscore prefix avoids collision with `callCount()` method
- [ ] `private _history: PromptRequest[]` — underscore prefix avoids collision with `calls()` method
- [ ] `enqueue(entry: MockProviderEntry): this` — returns `this` for chaining
- [ ] `callCount(): number`
- [ ] `wasCalledTimes(n: number): boolean`
- [ ] `lastRequest(): PromptRequest | undefined`
- [ ] `calls(): PromptRequest[]` — returns copy: `[...this._history]`
- [ ] `reset(): void` — clears queue, `_callCount`, `_history`
- [ ] `generate(request)` — increments `_callCount`, pushes to `_history`; throws `ProviderUnavailableError` if queue empty; throws entry.error if error entry; returns `PromptResponse` with default usage `{ prompt: 0, completion: 0, total: 0 }`
- [ ] `generateStream(request)` — returns `Promise<AsyncIterable<StreamChunk>>`; character-level `{ type: 'text', delta: char }` chunks; `{ type: 'done' }` terminator; `{ type: 'error' }` for error entry; `ProviderUnavailableError` as error chunk if queue empty
- [ ] Async IIFE pattern for streaming generator — no `.then()/.catch()` chains per `implementation_standards.md` §Async

### `packages/core/src/testing/index.ts`

```typescript
export { MockProvider } from "./mock-provider.js";
export type { MockProviderEntry } from "./mock-provider.js";
```

Enables `import { MockProvider } from '@atisse/core/testing'`.

### `packages/core/tests/fixtures/mock-memory.ts`

Per updated `testing_standards.md` §MockMemoryAdapter:

- [ ] `MockMemoryAdapter implements MemoryAdapter`
- [ ] `private store: Map<string, Message[]>`
- [ ] `public loadError?: OrchestratorError`
- [ ] `public saveError?: OrchestratorError`
- [ ] `load()` — throws `loadError` if set; returns `[]` for unknown session
- [ ] `save()` — throws `saveError` if set; append semantics per `interfaces-core.md` Rule 3
- [ ] `clear()` — idempotent; no-op for unknown session per `interfaces-core.md` Rule 4

### `packages/core/tests/fixtures/mock-tools.ts`

Per updated `testing_standards.md` §Standard Mock Tools. All tools must have non-empty `inputSchema` with `additionalProperties: false` — per `constraints.md` and `security.md` S-3a.

- [ ] `echoTool` — returns input unchanged; `inputSchema` accepts `{ value: string }`
- [ ] `failingTool` — throws `ToolExecutionError('failing-tool', new Error('simulated failure'))`
- [ ] `validationFailTool` — throws `ToolValidationError('validation-fail-tool', ['schema mismatch'])`
- [ ] `slowTool` — configurable `delayMs`; resolves after delay; use with `vi.useFakeTimers()` per `testing_standards.md`

### `packages/core/tests/fixtures/builders.ts`

Per updated `testing_standards.md` §Test Object Builders:

- [ ] `buildConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig` — includes fresh `MockProvider`; retry defaults: `{ maxAttempts: 1, baseDelayMs: 0, jitter: false }`
- [ ] `buildTool(overrides?: Partial<Tool>): Tool` — valid `inputSchema` with `additionalProperties: false`
- [ ] `buildProfile(overrides?: Partial<OrchestratorProfile>): OrchestratorProfile` — named profile; `name` equals its expected Record key

---

## 9. Phase 6 — Entry Points

### `packages/core/src/types.ts`

Internal cross-cutting types not exported from `interfaces.ts`. May be minimal at M1 — created now to establish Layer 0 before M2 begins.

### `packages/core/src/index.ts`

Public API surface. Per `api_design.md` §Export Surface Rules — export only what users need.

**Exports:**

```typescript
// Public contracts
export type {
  AIProvider,
  ProviderCapabilities,
  PromptRequest,
  PromptResponse,
  Message,
  MessageContent,
  SystemMessage,
  Tool,
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolResultError,
  MemoryAdapter,
  ContextProvider,
  ContextProviderInput,
  TokenUsage,
  RetryPolicy,
  TimeoutPolicy,
  ToolPolicy,
  RunInput,
  RunOutput,
  StreamChunk,
  LifecycleHook,
  HookRegistry,
  RunContext,
  AfterRunContext,
  BeforeGenerateContext,
  AfterGenerateContext,
  ToolContext,
  AfterToolContext,
  Logger,
  OrchestratorConfig,
  OrchestratorProfile,
  EventBus,
  OrchestratorEvent,
  EventErrorPayload,
  LifecycleState,
  OrchestratorErrorCode,
} from "./interfaces.js";

// Error classes — users must be able to catch by type
export {
  OrchestratorError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
  ProviderAuthError,
  ProviderMalformedResponse,
  ToolExecutionError,
  ToolValidationError,
  ToolNotFoundError,
  ContextLoadError,
  ContextProviderError,
  MaxRetriesExceededError,
  TokenLimitExceededError,
  TimeoutExceededError,
  FallbackExhaustedError,
  InvalidStateTransitionError,
  ConfigValidationError,
  isRetryable,
} from "./errors.js";

// State machine — exported for consumer type-checking of error fields
export { LifecycleStateMachine } from "./lifecycle.js";
```

**Does NOT export** (per `api_design.md`): `VALID_TRANSITIONS`, `types.ts` internals, M2+ implementation files.

### `packages/memory-inmemory/src/index.ts`

Skeleton only in M1 — compiles but throws `Error('Not implemented — M2 deliverable')`. Full implementation in M2.

---

## 10. Phase 7 — Unit Tests

Per `testing_standards.md` §What MUST be Tested. M1 tests cover only M1 files.
All tests use `vi.useFakeTimers()` per-test when delays are involved — never globally.

### `packages/core/tests/unit/errors.test.ts`

- [ ] Every error subtype: correct `code` literal value and correct `retryable` boolean
- [ ] `isRetryable()` → `true` for: `ProviderRateLimitError`, `ProviderTimeoutError`, `ProviderUnavailableError`, `ToolExecutionError`, `ContextLoadError`, `ContextProviderError`
- [ ] `isRetryable()` → `false` for: `ProviderAuthError`, `ProviderMalformedResponse`, `ToolValidationError`, `ToolNotFoundError`, `MaxRetriesExceededError`, `TokenLimitExceededError`, `TimeoutExceededError`, `FallbackExhaustedError`, `InvalidStateTransitionError`, `ConfigValidationError`
- [ ] `isRetryable(new Error('plain'))` → `false`
- [ ] `isRetryable(null)` → `false`
- [ ] `isRetryable(undefined)` → `false`
- [ ] `ProviderRateLimitError` preserves `retryAfterMs`
- [ ] `InvalidStateTransitionError` preserves `from` and `to` fields
- [ ] `MaxRetriesExceededError` preserves `attempts` and `lastError`
- [ ] `FallbackExhaustedError` preserves `primaryError` and `fallbackError`
- [ ] `ToolValidationError` preserves `validationErrors: string[]`
- [ ] All errors: `error.name === error.constructor.name`
- [ ] `cause` preserved through error chain

### `packages/core/tests/unit/lifecycle.test.ts`

Per `state_machine.md` §Rules and §Valid Transitions Table:

- [ ] Initial state is `INITIALIZED`
- [ ] `transition()` returns previous state (D1 -> Decision 5/ADR-029)
- [ ] `isTerminal()` → `false` for all non-terminal states
- [ ] `isTerminal()` → `true` for `COMPLETED` and `FAILED`
- [ ] Every valid transition in `VALID_TRANSITIONS` succeeds and reaches the target state
- [ ] Every invalid transition throws `InvalidStateTransitionError`
- [ ] State does not change when `transition()` throws
- [ ] `assertNotTerminal()` does not throw when non-terminal
- [ ] `assertNotTerminal()` throws `InvalidStateTransitionError` with `to: 'any'` when terminal

### `packages/core/tests/unit/mock-provider.test.ts`

- [ ] `enqueue()` supports method chaining
- [ ] `generate()` dequeues entries in FIFO order
- [ ] `generate()` throws `ProviderUnavailableError` when queue empty
- [ ] `generate()` throws enqueued `OrchestratorError` directly
- [ ] `generate()` returns correct `PromptResponse` shape for text entry
- [ ] `callCount()` increments correctly; `wasCalledTimes(n)` returns correct boolean
- [ ] `lastRequest()` returns most recent `PromptRequest`
- [ ] `calls()` returns all requests in order
- [ ] `reset()` clears queue, call count, and history
- [ ] `generateStream()` returns `Promise<AsyncIterable<StreamChunk>>`
- [ ] Streaming: text entry produces character-level `{ type: 'text', delta }` chunks
- [ ] Streaming: text stream terminates with `{ type: 'done' }`
- [ ] Streaming: error entry produces `{ type: 'error' }` chunk
- [ ] Streaming: empty queue produces `{ type: 'error' }` with `ProviderUnavailableError`

---

## 11. Phase 8 — CI Pipeline

Per `sdlc.md` §CI/CD Pipeline.

**`.github/workflows/ci.yml`** — runs on every PR and push to `main`:

- `pnpm install --frozen-lockfile`
- `pnpm --recursive lint`
- `pnpm --recursive typecheck`
- `pnpm --recursive test`
- `pnpm --recursive test:coverage`

Node.js version: 20. Package manager: pnpm (latest stable).

**TypeDoc:** Added in M1 in soft-fail mode. Script: `typedoc --out docs/api src/index.ts || true` — the `|| true` ensures a non-zero TypeDoc exit code does not fail the CI step. The `|| true` suffix is removed in M5 when TypeDoc errors become blocking.

---

## 12. Constraint Verification Checklist

Per `constraints.md` and `typescript_style.md` — applied to every M1 file before PR:

- [ ] No `any` type anywhere
- [ ] No `!` non-null assertion unless provably safe
- [ ] No `var` — `prefer-const` only
- [ ] No `console.log` in production code
- [ ] No Node.js-specific APIs in `core/src/` (runtime-agnostic — A2 -> Decision 3)
- [ ] `interfaces.ts` contains zero runtime code
- [ ] `VALID_TRANSITIONS` not exported from `lifecycle.ts`
- [ ] `LifecycleStateMachine` holds no `runId` or `Logger` reference
- [ ] All imports use `.js` extension (NodeNext module resolution)
- [ ] No `.then()/.catch()` chains — `async/await` only per `implementation_standards.md` §Async

---

## 13. Security Checklist

Per `security.md` §Security Review Checklist, applied to M1 scope:

- [ ] No secrets in any file (S-1)
- [ ] `provider.id` used in logs is safe — configuration metadata, not a secret (S-1 note per `security.md`)
- [ ] `ContextProvider.provide()` typed to return `SystemMessage[]` — `role: 'system'` trust boundary at compile time (S-2, S-6)
- [ ] `ToolResultError` and `EventErrorPayload` kept separate interfaces — no accidental interchange (B10 -> Decision 2/ADR-023)
- [ ] `pnpm audit --audit-level=high` clean (S-8)

---

## 14. Exit Criteria

Per `roadmap.md` §M1 Exit Criteria — M1 is complete when ALL pass:

- [ ] `interfaces.ts` compiles without TypeScript errors
- [ ] All types in `interfaces-core.md` and `interfaces-runtime.md` are represented exactly
- [ ] `pnpm --recursive lint` exits 0
- [ ] `pnpm --recursive typecheck` exits 0
- [ ] `pnpm --recursive test` exits 0 — `MockProvider` suite passes without a working kernel
- [ ] `isRetryable()` correctly classifies every error subtype (`errors.test.ts` green)
- [ ] `LifecycleStateMachine` throws `InvalidStateTransitionError` on every illegal transition (`lifecycle.test.ts` green)
- [ ] CI pipeline green on a clean checkout

---

## 15. What M1 Does NOT Include

Per `roadmap.md` §M2+ and `constraints.md` §v1 Scope Hard Limits.
Do not implement or scaffold: `policies.ts`, `prompt-composer.ts`, `tool-controller.ts`, `hooks.ts`, `events.ts`, `profile.ts`, `pipeline.ts`, `orchestrator.ts`, full `InMemoryAdapter`, any provider adapter, streaming implementation, or any agent/workflow/parallel-tool feature.
