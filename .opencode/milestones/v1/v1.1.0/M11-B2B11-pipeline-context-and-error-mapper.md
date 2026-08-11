# B2–B11 — Pipeline Enhancements: Context Object + Error Mapper

**Status:** Ready for SPBED implementation (after B1A–B1E)
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

### Phase 1 (B2): `PipelineRoundContext` Object

1. Create `packages/core/src/pipeline/types.ts` (NEW) defining an internal `PipelineRoundContext` interface.
2. Group stable execution fields: `config`, `hooks`, `eventBus`, `logger`, `runId`, `stateMachine`, `trackDuration`, `input`, `messages`, `activeProvider`.
3. Keep round-specific mutable state (`toolAttempt`, `roundCounter`) as a separate parameter — NOT part of the context object.
4. Refactor all pipeline internal functions from 12–15 positional parameters down to 2 parameters: `(ctx: PipelineRoundContext, mutable: RoundMutableState)`.

### Phase 2 (B11): `ProviderErrorMapper` Utility

1. Create `packages/core/src/pipeline/error-mapper.ts` (NEW) with a `ProviderErrorMapper` class.
2. Centralize error classification logic: HTTP status code → `OrchestratorError` subtype mapping, `retry-after` header parsing, rate-limit detection.
3. Export from `@atisse/core` so provider adapters (`provider-openai`, `provider-anthropic`) can import and use it.
4. Provider adapters call `errorMapper.mapProviderError(response)` instead of writing inline `if/else` chains.

---

## 2. Context (Why This Exists)

### Phase 1 (B2) — Long Parameter Lists

After B1 decomposition, functions like `executeGenerationRound()`, `executeStreamingGenerationRound()`, `executeToolRound()`, and `finalizePipeline()` in `pipeline/shared.ts`, `non-streaming.ts`, and `streaming.ts` still have 12–15 positional parameters. Two adjacent `string` parameters can be swapped without the compiler catching it. Adding a new parameter (e.g., `trackDuration`) requires updating every call site.

This violates **Principle 1 (Explicit Over Magical)** — parameters are explicit but unmanageably numerous, making the code fragile rather than clear. A single context object makes the data flow explicit and type-safe.

### Phase 2 (B11) — Distributed Error Mapping

Error mapping logic is duplicated across `provider-openai`, `provider-anthropic`, and any future provider adapter. Each adapter independently:

- Maps HTTP status codes to `OrchestratorError` subtypes
- Parses `retry-after` headers for `ProviderRateLimitError.retryAfterMs`
- Detects rate-limit responses (429) vs auth failures (401) vs server errors (500)
- Classifies errors as retryable or non-retryable

This distribution causes error classification drift over time. A centralized `ProviderErrorMapper` reduces duplication and ensures consistent error classification across all provider adapters. This builds on the `ProviderErrorInput` contract (from M012 fix) which standardized the input shape.

---

## 3. Issues/Changes

### Phase 1 — Issue B2: Excessive Positional Parameters

| Field       | Value                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline/` (shared.ts, non-streaming.ts, streaming.ts — after B1 split)                                                                                              |
| Lines       | All function signatures with 5+ parameters                                                                                                                                              |
| Severity    | MEDIUM                                                                                                                                                                                  |
| Description | Pipeline internal functions have 12–15 positional parameters. Adding parameters requires updating all call sites. TypeScript cannot catch swapped adjacent parameters of the same type. |
| Fix         | Introduce `PipelineRoundContext` and `RoundMutableState` objects. Reduce all function signatures to 2-3 parameters.                                                                     |

### Phase 2 — Issue B11: Duplicated Error Mapping Across Adapters

| Field       | Value                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/provider-openai/src/index.ts`, `packages/provider-anthropic/src/index.ts`                                                                                                         |
| Lines       | Error handling sections (status code mapping, retry-after parsing, rate-limit detection)                                                                                                    |
| Severity    | MEDIUM                                                                                                                                                                                      |
| Description | Error mapping logic is duplicated across provider adapters. Each independently maps HTTP status codes, parses retry-after headers, and classifies error types. Drift accumulates over time. |
| Fix         | Create `ProviderErrorMapper` in `packages/core/src/pipeline/error-mapper.ts`. Export from `@atisse/core`. Migrate adapters to use it.                                                       |

| Field       | Value                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline/error-mapper.ts` (NEW)                                                                                                             |
| Lines       | N/A — new file                                                                                                                                                 |
| Severity    | MEDIUM                                                                                                                                                         |
| Description | No centralized error mapping exists in core. `ProviderErrorMapper` centralizes status code → error subtype mapping, retry-after parsing, rate-limit detection. |
| Fix         | Create `ProviderErrorMapper` class. Export from `pipeline/index.ts` and from `packages/core/src/index.ts`.                                                     |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**B2 — PipelineRoundContext:**

- `PipelineRoundContext` is an **internal type** — NOT exported from `@atisse/core`. Defined in `pipeline/types.ts`.
- Fields are typed as `readonly` where possible to prevent accidental mutation.
- `RoundMutableState` holds mutable per-round data: `toolAttempt`, `roundCounter`, `messages` (the working message array that grows with each round).
- The mutable state is passed as a separate parameter to clearly distinguish stable context from mutating state.
- This is a purely internal refactoring — no public API changes.

````typescript
// pipeline/types.ts — internal, NOT exported from index.ts
export interface PipelineRoundContext {
  readonly config: ResolvedConfig;
  readonly hooks: HookRegistry;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly runId: string;
  readonly stateMachine: LifecycleStateMachine;
  readonly trackDuration: (step: string) => void;
  readonly input: RunInput;
}

export interface RoundMutableState {
  messages: Message[];
  toolAttempt: number;
  roundCounter: number;
}

> **V2_EVOLUTION_PATH:** This milestone creates `PipelineContext` as v1.1.0 delivery. When v2 adds fields (requestId, timeoutPolicy, retryPolicy, metadata), every addition must be additive (optional new fields only) — no breaking changes. Design the v1 interface with this in mind.

**B11 — ProviderErrorMapper:**

- `ProviderErrorMapper` is a class in `pipeline/error-mapper.ts`.
- It is exported from `@atisse/core` via `packages/core/src/index.ts`.
- Single primary method: `mapProviderError(response: ProviderErrorInput): OrchestratorError`.
- `ProviderErrorInput` is an interface defined alongside the mapper:
  ```typescript
  export interface ProviderErrorInput {
    statusCode: number;
    headers?: Record<string, string>;
    body?: string;
    providerId: string;
  }
````

- The mapper handles:
  - Status code map: `401` → `ProviderAuthError`, `429` → `ProviderRateLimitError`, `5xx` → `ProviderUnavailableError`, timeout → `ProviderTimeoutError`
  - `retry-after` header parsing (HTTP date string or seconds)
  - Rate-limit detection (429 with body inspection for known patterns)
  - Non-retryable classification for auth errors (401, 403)
  - Retryable classification for rate-limit and server errors
- Provider adapters are migrated one at a time. Existing adapter error-handling code is NOT removed until all adapters are migrated.

> **V2_EVOLUTION_PATH:** This milestone delivers `ProviderErrorMapper` in v1.1.0 with a minimal-surface API. v2 will extend it into a system-wide `ErrorClassificationLayer` (classifier / mapper / retryability / categories). The v1 API shape must stay narrow and focused.

### 4.2 What NOT to Do

- **B2:** Do NOT add `PipelineRoundContext` or `RoundMutableState` to `packages/core/src/interfaces.ts` — they are internal types.
- **B2:** Do NOT include mutable round state in the context object — keep it separate.
- **B2:** Do NOT change any public function signatures or exports.
- **B11:** Do NOT change the error taxonomy or `isRetryable()` classification in `errors.ts`.
- **B11:** Do NOT remove existing adapter error-handling code until ALL adapters are migrated to use `ProviderErrorMapper`.
- **B11:** Do NOT add new error codes to `OrchestratorErrorCode` — existing codes cover all standard cases.
- **B11:** Do NOT make `ProviderErrorMapper` require any dependencies from adapter packages — it lives in core and uses only core types.

---

## 5. Files to Modify

### Phase 1 (B2)

| File                                          | Action | Notes                                                                     |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------- |
| `packages/core/src/pipeline/types.ts`         | NEW    | `PipelineRoundContext` + `RoundMutableState` interfaces                   |
| `packages/core/src/pipeline/shared.ts`        | MODIFY | Refactor functions to accept `ctx + mutable` instead of positional params |
| `packages/core/src/pipeline/non-streaming.ts` | MODIFY | Refactor to use context object                                            |
| `packages/core/src/pipeline/streaming.ts`     | MODIFY | Refactor to use context object                                            |

### Phase 2 (B11)

| File                                         | Action | Notes                                                                              |
| -------------------------------------------- | ------ | ---------------------------------------------------------------------------------- |
| `packages/core/src/pipeline/error-mapper.ts` | NEW    | `ProviderErrorMapper` class + `ProviderErrorInput` interface                       |
| `packages/core/src/pipeline/index.ts`        | MODIFY | Export `ProviderErrorMapper` and `ProviderErrorInput` if re-exported from pipeline |
| `packages/core/src/index.ts`                 | MODIFY | Export `ProviderErrorMapper` and `ProviderErrorInput` from `@atisse/core`          |
| `packages/provider-openai/src/index.ts`      | MODIFY | Use `ProviderErrorMapper` instead of inline error handling                         |
| `packages/provider-anthropic/src/index.ts`   | MODIFY | Use `ProviderErrorMapper` instead of inline error handling                         |

---

## 6. Implementation Strategy

### Phase 1 — Step 1: Define `PipelineRoundContext` and `RoundMutableState`

- Create `packages/core/src/pipeline/types.ts`.
- Define `PipelineRoundContext` with readonly fields (see Section 4.1 for type shape).
- Define `RoundMutableState` with mutable round-specific fields.
- Both types are **internal** — do NOT export from `pipeline/index.ts`.

### Phase 1 — Step 2: Refactor `shared.ts` Functions

- Identify all functions in `shared.ts` with 5+ positional parameters.
- Convert each to accept `(ctx: PipelineRoundContext, mutable: RoundMutableState, ...additionalParams?)`.
- For functions that don't need mutable state, accept only `ctx` plus additional params.
- Example refactoring:

  ```typescript
  // Before:
  export async function executeToolRound(
    config: ResolvedConfig,
    hooks: HookRegistry,
    eventBus: EventBus,
    logger: Logger,
    runId: string,
    stateMachine: LifecycleStateMachine,
    trackDuration: (step: string) => void,
    messages: Message[],
    toolCalls: ToolCall[],
    input: RunInput,
    roundCounter: number,
    toolAttempt: number,
  ): Promise<{ messages: Message[]; roundCounter: number; toolAttempt: number }>;

  // After:
  export async function executeToolRound(
    ctx: PipelineRoundContext,
    mutable: RoundMutableState,
    toolCalls: ToolCall[],
  ): Promise<RoundMutableState>;
  ```

- Update all call sites in `non-streaming.ts` and `streaming.ts`.

### Phase 1 — Step 3: Verify B2

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`.
- All tests pass without modification — this is a purely internal refactoring.
- Verify that no function signature exceeds 4 parameters (ctx + mutable + 2 additional max).

### Phase 2 — Step 4: Create `ProviderErrorMapper`

- Create `packages/core/src/pipeline/error-mapper.ts`.
- Define `ProviderErrorInput` interface:
  ```typescript
  export interface ProviderErrorInput {
    statusCode: number;
    headers?: Record<string, string>;
    body?: string;
    providerId: string;
  }
  ```
- Implement `ProviderErrorMapper` class:

  ```typescript
  export class ProviderErrorMapper {
    mapProviderError(response: ProviderErrorInput): OrchestratorError {
      // Status code routing
      switch (response.statusCode) {
        case 401:
        case 403:
          return new ProviderAuthError(response.body ?? 'Authentication failed');
        case 429:
          const retryAfterMs = this.parseRetryAfter(response.headers);
          return new ProviderRateLimitError('Rate limit exceeded', retryAfterMs);
        case 408:
        case 504:
          return new ProviderTimeoutError('Provider timed out');
        case 500:
        case 502:
        case 503:
          return new ProviderUnavailableError('Provider unavailable');
        default:
          return new ProviderUnavailableError(`Unexpected status ${response.statusCode}`);
      }
    }

    private parseRetryAfter(headers?: Record<string, string>): number | undefined {
      // Parse Retry-After header (seconds or HTTP-date)
      // ... implementation ...
    }
  }
  ```

- Export the class from `pipeline/index.ts` if it's part of the pipeline sub-module.
- Export from `packages/core/src/index.ts` as part of the public API.

### Phase 2 — Step 5: Migrate Provider Adapters

- In `packages/provider-openai/src/index.ts`:
  - Import `ProviderErrorMapper` from `@atisse/core`.
  - In the error handler (where HTTP responses are converted to `OrchestratorError`):
    ```typescript
    const errorMapper = new ProviderErrorMapper();
    const error = errorMapper.mapProviderError({
      statusCode: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text(),
      providerId: 'openai',
    });
    throw error;
    ```
  - Remove the inline `if/else if/else` status code chains.
  - Keep any provider-specific error handling (e.g., OpenAI-specific error body parsing) that supplements the base mapping.

- In `packages/provider-anthropic/src/index.ts`:
  - Apply the same migration pattern.

### Phase 2 — Step 6: Verify B11

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage` for all packages.
- Verify that `ProviderErrorMapper` correctly maps known HTTP status codes:
  - `401` → `ProviderAuthError`
  - `429` → `ProviderRateLimitError` (with `retryAfterMs` when `Retry-After` header present)
  - `500` → `ProviderUnavailableError`
- Verify that provider adapters produce identical error output for the same inputs (before and after migration).
- All existing adapter tests pass without modification.

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

Specific assertions to verify:

- **B2:**
  - All pipeline internal functions have 4 or fewer parameters.
  - `PipelineRoundContext` fields are all `readonly`.
  - `RoundMutableState` contains only mutable round-specific state.
  - No `PipelineRoundContext` type appears in any public API export.
  - All existing tests pass without modification.

- **B11:**
  - `ProviderErrorMapper.mapProviderError()` is exported from `@atisse/core`.
  - `ProviderErrorMapper` correctly maps `401` → `ProviderAuthError` (non-retryable).
  - `ProviderErrorMapper` correctly maps `429` → `ProviderRateLimitError` (retryable).
  - `ProviderErrorMapper` correctly maps `500` → `ProviderUnavailableError` (retryable).
  - `ProviderErrorMapper.parseRetryAfter()` correctly parses both `Retry-After: 120` (seconds) and `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` (HTTP-date).
  - Provider adapters produce identical error outputs for the same HTTP responses (before vs after migration).
  - All existing tests pass without modification.

---

## 8. Risk Assessment

| Risk                                                       | Likelihood | Impact | Mitigation                                                                                             |
| ---------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------ |
| B2: Refactoring introduces parameter mismatch bugs         | Medium     | Medium | Strict TypeScript types on `PipelineRoundContext` prevent field errors. All tests pass without change. |
| B2: `RoundMutableState` accidentally exported              | Low        | Low    | Defined in internal `types.ts` — no export from `pipeline/index.ts` or `core/src/index.ts`.            |
| B11: Adapter-specific error handling lost in migration     | Medium     | Medium | Keep provider-specific error handling that supplements base mapping. Do NOT blindly replace all logic. |
| B11: `ProviderErrorMapper` misses a provider-specific code | Medium     | Low    | Adapters can still add custom mapping AFTER calling the base mapper (fallback pattern).                |
| B11: `retry-after` parsing fails on non-standard headers   | Low        | Low    | Return undefined on parse failure — existing fallback in `calculateDelay` handles undefined correctly. |

---

## 9. References

- `.opencode/skill/interfaces/SKILL.md` — Frozen contracts (no breaking changes to public API)
- `.opencode/skill/interfaces/SKILL.md` — `EventBus`, `Logger`, `HookRegistry`, `RunInput` types
- `.opencode/skill/architecture/SKILL.md` — Layer architecture, pipeline execution flow
- `.opencode/skill/errors/SKILL.md` — Error hierarchy, `isRetryable()` classification
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines, defensive programming
- `.opencode/skill/adapter-pattern/SKILL.md` — Provider adapter checklist, error mapping requirements
- `packages/core/src/pipeline/types.ts` — NEW (B2 target)
- `packages/core/src/pipeline/shared.ts` — MODIFY (B2 refactoring target)
- `packages/core/src/pipeline/error-mapper.ts` — NEW (B11 target)
- `packages/core/src/pipeline/index.ts` — MODIFY (B11 exports)
- `packages/core/src/index.ts` — MODIFY (B11 exports)
- `packages/provider-openai/src/index.ts` — MODIFY (B11 adapter migration)
- `packages/provider-anthropic/src/index.ts` — MODIFY (B11 adapter migration)
- `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M002-pipeline-consolidation-implementation-plan.md` — Prior pipeline consolidation
- `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M012-ratelimit-error-remapping-fix.md` — Prior error mapping standardization
