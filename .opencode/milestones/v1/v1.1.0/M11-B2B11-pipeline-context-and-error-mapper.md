# B2–B11 — Pipeline Enhancements: Context Object + Error Mapper

**Status:** Ready for SPBED implementation (after B1A–B1E)
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

> **Precondition:** P04-A5 + M05 (ADR-042) + M06-B1A..M10-B1E merged, `pipeline/*` skeleton exists, `pnpm typecheck && pnpm build` green. Monolith `pipeline.ts:1547` refs post-B1C re-verify. Repo currently has no `pipeline/` directory (only doc commits up to `6d33ce0`) — verify skeleton first. B2 extracts from `pipeline/*` shell, not monolithic `pipeline.ts:1547`.

### Phase 1 (B2): `PipelineRoundContext` Object

1. Create `packages/core/src/pipeline/round-context.ts` (NEW) defining an internal `PipelineRoundContext` interface and `RoundMutableState` type.
2. Group stable execution fields: `config`, `hooks`, `eventBus`, `logger`, `runId`, `stateMachine`, `trackDuration`, `input`, `activeProvider`. `messages` is NOT in `PipelineRoundContext` — it is in `RoundMutableState`.
3. Keep round-specific mutable state (`messages`, `toolAttempt`, `roundCounter`) in `RoundMutableState` — NOT part of the context object.
4. Refactor all pipeline internal functions from 12–15 positional parameters down to 2 parameters: `(ctx: PipelineRoundContext, mutable: RoundMutableState)`.
5. **Context loading preservation (ADR-042/M05, ADR-013):** `initializePipeline` context loading is **preserved, not deleted** during the B2 param-object refactor: `enforceCharLimit:262-288`, `CONTEXT_MAX_*` at `pipeline.ts:255-256` (post-M05 via `config.contextPolicy` per ADR-042, not hard-coded), sequential loading per ADR-013, skip/fail per ADR-042 with `context.skipped` carrying `EventErrorPayload` via `toEventErrorPayload()`, signal forwarding `provider.provide({ ...contextProviderInput, signal: input.signal })`, and `withTimeout` re-wrap `TimeoutExceededError → ContextLoadError` (`retryable=true`) before skip/fail branching. B2 must not remove `enforceCharLimit`, `config.contextPolicy` wiring, signal forwarding, or `withTimeout` re-wrap.

### Phase 2 (B11): `ProviderErrorMapper` Utility

1. Create `packages/core/src/pipeline/error-mapper.ts` (NEW) with a `ProviderErrorMapper` class (internal L3, ADR-030).
2. Centralize error classification logic: HTTP status code → `OrchestratorError` subtype mapping, `retry-after` header parsing (case-insensitive), rate-limit detection.
3. Export from `@atisse/core` via `packages/core/src/index.ts:1-73` (public surface) so provider adapters (`provider-openai`, `provider-anthropic`) can import via `import { ProviderErrorMapper } from '@atisse/core'`. Do NOT touch `pipeline/index.ts` — it remains sole barrel for `executePipeline()` per `architecture/SKILL.md:40-52`.
4. Provider adapters call `errorMapper.mapProviderError(response)` instead of writing inline `if/else` chains.
5. `pipeline/error-mapper.ts` is internal L3; public re-export is only from `core/src/index.ts:1-73`. M09 `error-normalizer.ts` (internal, NOT exported) vs B11 `error-mapper.ts` (public, adapter-facing) boundary per M09 §1.

---

## 2. Context (Why This Exists)

### Phase 1 (B2) — Long Parameter Lists

After B1 decomposition, functions like `executeGenerationRound()`, `executeStreamingGenerationRound()`, `executeToolRound()`, and `finalizePipeline()` in `pipeline/shared.ts`, `non-streaming.ts`, and `streaming.ts` (after B1 split — verify skeleton first) still have 12–15 positional parameters. Two adjacent `string` parameters can be swapped without the compiler catching it. Adding a new parameter (e.g., `trackDuration`) requires updating every call site.

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

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline/` (shared.ts, non-streaming.ts, streaming.ts — after B1 split; verify skeleton first)                                                                                                                                                                                                                                                         |
| Lines       | All function signatures with 5+ parameters                                                                                                                                                                                                                                                                                                                                |
| Severity    | MEDIUM                                                                                                                                                                                                                                                                                                                                                                    |
| Description | Pipeline internal functions have 12–15 positional parameters. Adding parameters requires updating all call sites. TypeScript cannot catch swapped adjacent parameters of the same type.                                                                                                                                                                                   |
| Fix         | Introduce `PipelineRoundContext` and `RoundMutableState` objects in `pipeline/round-context.ts`. Reduce all function signatures to 2-3 parameters. Preserve `initializePipeline` context loading (`enforceCharLimit:262-288`, `config.contextPolicy`, ADR-013 sequential, ADR-042 skip/fail + signal forwarding + `withTimeout` re-wrap) — do not delete during refactor. |

### Phase 2 — Issue B11: Duplicated Error Mapping Across Adapters

| Field       | Value                                                                                                                                                                                                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/provider-openai/src/index.ts`, `packages/provider-anthropic/src/index.ts`                                                                                                                                  |
| Lines       | Error handling sections (status code mapping, retry-after parsing, rate-limit detection)                                                                                                                             |
| Severity    | MEDIUM                                                                                                                                                                                                               |
| Description | Error mapping logic is duplicated across provider adapters. Each independently maps HTTP status codes, parses retry-after headers, and classifies error types. Drift accumulates over time.                          |
| Fix         | Create `ProviderErrorMapper` in `packages/core/src/pipeline/error-mapper.ts` (internal L3). Export from `packages/core/src/index.ts:1-73` (public surface, NOT via `pipeline/index.ts`). Migrate adapters to use it. |

| Field       | Value                                                                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline/error-mapper.ts` (NEW)                                                                                                                        |
| Lines       | N/A — new file                                                                                                                                                            |
| Severity    | MEDIUM                                                                                                                                                                    |
| Description | No centralized error mapping exists in core. `ProviderErrorMapper` centralizes status code → error subtype mapping, retry-after parsing, rate-limit detection.            |
| Fix         | Create `ProviderErrorMapper` class in `pipeline/error-mapper.ts` (internal L3). Export from `packages/core/src/index.ts:1-73` (public). Do NOT touch `pipeline/index.ts`. |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

> **Precondition:** P04-A5 + M05 (ADR-042) + M06-B1A..M10-B1E merged, `pipeline/*` skeleton exists, `pnpm typecheck && pnpm build` green. Monolith `pipeline.ts:1547` refs post-B1C re-verify. Repo currently has no `pipeline/` directory (only doc commits up to `6d33ce0`), verify skeleton first. B2 extracts from `pipeline/*` shell, not monolithic `pipeline.ts:1547`.

**B2 — PipelineRoundContext:**

- `PipelineRoundContext` is an **internal type** — NOT exported from `@atisse/core`. Defined in `pipeline/round-context.ts` (not `pipeline/types.ts` — `src/types.ts:22` already defines `ResolvedConfig` (L0); avoid collision).
- Fields are typed as `readonly` where possible to prevent accidental mutation.
- `RoundMutableState` holds mutable per-round data: `messages` (the working message array that grows with each round), `toolAttempt`, `roundCounter`.
- `messages` is NOT in `PipelineRoundContext` — it belongs in `RoundMutableState` only.
- `trackDuration: () => number` returns `number` (elapsed ms), not `void` — fix per `pipeline.ts:309`.
- The mutable state is passed as a separate parameter to clearly distinguish stable context from mutating state.
- This is a purely internal refactoring — no public API changes.
- **Context loading preservation (ADR-042/M05, ADR-013):** `initializePipeline` context loading (`enforceCharLimit:262-288`, `CONTEXT_MAX_*` at `pipeline.ts:255-256` now via `config.contextPolicy` per ADR-042, sequential loading per ADR-013, `context.skipped` with `EventErrorPayload`, signal forwarding `provider.provide({ ...contextProviderInput, signal: input.signal })`, `withTimeout` re-wrap `TimeoutExceededError → ContextLoadError`) is preserved during the B2 param-object refactor — these paths are NOT deleted or consolidated away.
- **Layering (ADR-030):** `pipeline/round-context.ts` is L3 internal; may import L0–L3 (`interfaces.ts`, `types.ts:ResolvedConfig`, `lifecycle.ts`, `events.ts` types). Verify `madge --circular` no circular. NOT exported from `src/index.ts`.

```typescript
// pipeline/round-context.ts — internal, NOT exported from src/index.ts
export interface PipelineRoundContext {
  readonly config: ResolvedConfig;
  readonly hooks: HookRegistry;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly runId: string;
  readonly stateMachine: LifecycleStateMachine;
  readonly trackDuration: () => number;
  readonly input: RunInput;
  readonly activeProvider: AIProvider;
}

export interface RoundMutableState {
  messages: Message[];
  toolAttempt: number;
  roundCounter: number;
}
```

> **Note:** `PipelineRoundContext` is v1.1.0 internal; future v2 fields must be additive optional only.

**B11 — ProviderErrorMapper:**

- `ProviderErrorMapper` is a class in `pipeline/error-mapper.ts` (internal L3 per ADR-030 — may import L0–L3, no L3↔L3 circular; not exported via `pipeline/index.ts`).
- It is exported from `@atisse/core` **directly via `packages/core/src/index.ts:1-73`** (public surface) — NOT via `pipeline/index.ts` which remains sole barrel for `executePipeline()` per `architecture/SKILL.md:40-52`. M09 `error-normalizer.ts` (internal) vs B11 `error-mapper.ts` (public, adapter-facing) boundary per M09 §1.
- Single primary method: `mapProviderError(response: ProviderErrorInput): OrchestratorError`.
- `ProviderErrorInput` is an interface defined alongside the mapper (single source — see note below):

  ```typescript
  // Single source: keep ProviderErrorInput in error-mapper.ts only; stale-docs M012-ratelimit reference is stale, do not re-define elsewhere, avoid duplicate export.
  export interface ProviderErrorInput {
    statusCode: number;
    headers?: Record<string, string>;
    body?: string;
    providerId: string;
  }
  ```

- The mapper handles:
  - Status code map: `401` → `ProviderAuthError`, `429` → `ProviderRateLimitError`, `5xx` → `ProviderUnavailableError`, timeout → `ProviderTimeoutError`
  - `retry-after` header parsing (HTTP date string or seconds) — case-insensitive lookup via lower-casing `headers` record; `retryAfterMs` fallback when header missing/undefined handled explicitly (see §6 Step 4)
  - Rate-limit detection (429 with body inspection for known patterns)
  - Non-retryable classification for auth errors (401, 403)
  - Retryable classification for rate-limit and server errors
- Provider adapters are migrated one at a time. Existing adapter error-handling code is NOT removed until all adapters are migrated.
- **Adapter import direction (constraints):** `provider-openai/src/index.ts` `import { ProviderErrorMapper } from '@atisse/core'` is allowed — core has zero adapter imports, not vice versa. `error-mapper` `providerId: string` is safe to log per S-1 (metadata, not secret).

> **Note:** `ProviderErrorMapper` is v1.1.0 minimal surface; keep API narrow.

### 4.2 What NOT to Do

- **B2:** Do NOT add `PipelineRoundContext` or `RoundMutableState` to `packages/core/src/interfaces.ts` — they are internal types.
- **B2:** Do NOT include mutable round state in the context object — keep it separate (`messages` belongs in `RoundMutableState` only).
- **B2:** Do NOT change any public function signatures or exports.
- **B2:** Do NOT delete `initializePipeline` context loading paths during the param-object refactor — preserve `enforceCharLimit:262-288`, `config.contextPolicy` wiring (`pipeline.ts:255-256` post-M05), ADR-013 sequential loading, ADR-042 skip/fail with `context.skipped` `EventErrorPayload`, signal forwarding, and `withTimeout` re-wrap.
- **B11:** Do NOT change the error taxonomy or `isRetryable()` classification in `errors.ts` — `errors.ts:331` `isRetryable` is L0; `error-mapper.ts` only sets the `retryable` flag on the created error, not call `isRetryable`.
- **B11:** Do NOT remove existing adapter error-handling code until ALL adapters are migrated to use `ProviderErrorMapper`.
- **B11:** Do NOT add new error codes to `OrchestratorErrorCode` — existing codes cover all standard cases.
- **B11:** Do NOT make `ProviderErrorMapper` require any dependencies from adapter packages — it lives in core and uses only core types.
- **B11:** Do NOT duplicate `ProviderErrorInput` — single source in `error-mapper.ts` only (M012-ratelimit is stale-docs).

---

## 5. Files to Modify

### Phase 1 (B2)

| File                                          | Action | Notes                                                                                                                                                             |
| --------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/pipeline/round-context.ts` | NEW    | `PipelineRoundContext` + `RoundMutableState` interfaces (renamed from `types.ts` — `src/types.ts:22` already defines `ResolvedConfig`)                            |
| `packages/core/src/pipeline/shared.ts`        | MODIFY | Refactor functions to accept `ctx + mutable` instead of positional params (after B1 split — verify skeleton first; preserve `initializePipeline` context loading) |
| `packages/core/src/pipeline/non-streaming.ts` | MODIFY | Refactor to use context object (after B1 split — verify skeleton first)                                                                                           |
| `packages/core/src/pipeline/streaming.ts`     | MODIFY | Refactor to use context object (after B1 split — verify skeleton first)                                                                                           |

### Phase 2 (B11)

| File                                         | Action | Notes                                                                                                                                |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/pipeline/error-mapper.ts` | NEW    | `ProviderErrorMapper` class + `ProviderErrorInput` interface (internal L3)                                                           |
| `packages/core/src/index.ts`                 | MODIFY | Export `ProviderErrorMapper` and `ProviderErrorInput` from `@atisse/core` (`:1-73` public surface; do NOT touch `pipeline/index.ts`) |
| `packages/provider-openai/src/index.ts`      | MODIFY | Use `ProviderErrorMapper` instead of inline error handling                                                                           |
| `packages/provider-anthropic/src/index.ts`   | MODIFY | Use `ProviderErrorMapper` instead of inline error handling                                                                           |

> **Layering note:** `pipeline/index.ts` is NOT modified in B11 — it remains sole barrel for `executePipeline()` per `architecture/SKILL.md:40-52`. `pipeline/error-mapper.ts` is internal L3; re-export is only via `core/src/index.ts:1-73`. M09 `error-normalizer.ts` (internal, not exported) vs B11 `error-mapper.ts` (public, adapter-facing) per M09 §1.

### 5b. Changeset / Versioning Classification

- **B2:** `patch|none` internal refactor, `api-extractor` diff empty, ADR-039 NOT breaking. No public type or runtime export changes. Verify with `pnpm changeset` (no changeset required if `none`, or `patch` if repo policy requires one for internal refactors) and `pnpm build && api-extractor diff` empty.
- **B11:** **MINOR** changeset (`.changeset/<id>.md`) — additive `ProviderErrorMapper` + `ProviderErrorInput` export, `pnpm changeset && pnpm build && api-extractor diff` verify. No removed/narrowed required field, no `run()` return shape change.

---

## 6. Implementation Strategy

### Phase 1 — Step 1: Define `PipelineRoundContext` and `RoundMutableState` — Precondition: P04-A5 + M05 (ADR-042) + M06-B1A..M10-B1E merged, pipeline/* skeleton exists, pnpm typecheck && pnpm build green. Monolith pipeline.ts:1547 refs post-B1C re-verify.

- Create `packages/core/src/pipeline/round-context.ts` (not `types.ts` — `src/types.ts:22` already defines `ResolvedConfig` (L0); use `round-context.ts` to avoid collision).
- Define `PipelineRoundContext` with readonly fields and `trackDuration: () => number` (see Section 4.1 for exact shape — `messages` NOT in context, only in `RoundMutableState`).
- Define `RoundMutableState` with mutable round-specific fields (`messages`, `toolAttempt`, `roundCounter`).
- Both types are **internal** — do NOT export from `pipeline/index.ts` and do NOT export from `packages/core/src/index.ts`. Verify `madge --circular` no circular.
- **Context loading preservation:** `initializePipeline` context loading (`enforceCharLimit:262-288`, `config.contextPolicy` at `pipeline.ts:255-256` post-M05, ADR-013 sequential, ADR-042 skip/fail, signal forwarding, `withTimeout` re-wrap) is preserved — B2 param-object refactor must not delete these paths.

### Phase 1 — Step 2: Refactor `shared.ts` Functions

- Identify all functions in `shared.ts` (after B1 split — verify skeleton first) with 5+ positional parameters.
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

- **Protection note:** `executeToolRound` `Promise<RoundMutableState>` change must preserve `pipeline.ts:505-559` messages mutation and `tool_result` flow; `enforceCharLimit`, signal forwarding (`provider.provide({ ...contextProviderInput, signal: input.signal })`), and `withTimeout` re-wrap (`TimeoutExceededError → ContextLoadError`) must NOT be removed during the refactor. Verify `pipeline/shared.ts:initializePipeline` still contains `enforceCharLimit:262-288` wiring and `config.contextPolicy` at `pipeline.ts:255-256` post-M05.
- Update all call sites in `non-streaming.ts` and `streaming.ts` (after B1 split — verify skeleton first).

### Phase 1 — Step 3: Verify B2

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage && pnpm build`.
- All tests pass without modification — this is a purely internal refactoring.
- Verify that no function signature exceeds 4 parameters (ctx + mutable + 2 additional max).
- Verify `pnpm build && api-extractor diff` empty (B2 patch|none) and `madge --circular packages/core/src/pipeline/round-context.ts` no circular.
- Verify `initializePipeline` context loading still green: `enforceCharLimit:262-288` present, `config.contextPolicy` wiring at `pipeline.ts:255-256` intact, sequential loading, skip/fail, signal forwarding, `withTimeout` re-wrap preserved.

### Phase 2 — Step 4: Create `ProviderErrorMapper`

- Create `packages/core/src/pipeline/error-mapper.ts` (internal L3).
- Define `ProviderErrorInput` interface (single source — do NOT duplicate elsewhere; M012-ratelimit reference is stale-docs):
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
      // Status code routing — retryable set via constructor, not via isRetryable() call (errors.ts:331 is L0)
      switch (response.statusCode) {
        case 401:
        case 403:
          return new ProviderAuthError(response.body ?? 'Authentication failed');
        case 429:
          const retryAfterMs = this.parseRetryAfter(response.headers);
          // Fallback when retryAfterMs undefined — caller uses calculateDelay fallback
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
      if (!headers) return undefined;
      // Case-insensitive lookup — adapter via Object.fromEntries(response.headers.entries()) not guaranteed lower-case
      const lower = Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
      );
      const raw = lower['retry-after'];
      if (!raw) return undefined;
      // Numeric seconds
      const secs = Number(raw);
      if (Number.isFinite(secs)) return secs * 1000;
      // HTTP-date
      const dateMs = Date.parse(raw);
      if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
      return undefined;
    }
  }
  ```

- **Retry-After semantics:** Handle case-insensitive header (`retry-after` vs `Retry-After`) via lower-casing `headers` record; adapter `Object.fromEntries(response.headers.entries())` not guaranteed lower-case. Fallback when `retryAfterMs` is `undefined` — return `undefined` and let `calculateDelay` handle undefined correctly. Include matrix test for `parseRetryAfter` case-insensitive (see §7).
- Export the class **directly from `packages/core/src/index.ts:1-73`** as part of the public API. Do NOT export via `pipeline/index.ts`.
- **Adapter import direction:** `provider-openai/src/index.ts` `import { ProviderErrorMapper } from '@atisse/core'` is allowed — core zero-adapter-import (constraints) not violated; `error-mapper` `providerId` string is safe to log per S-1 (metadata, not secret).

### Phase 2 — Step 5: Migrate Provider Adapters

- In `packages/provider-openai/src/index.ts`:
  - Import `ProviderErrorMapper` from `@atisse/core` (allowed — core zero-adapter-import not violated; `providerId` string safe per S-1).
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

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage && pnpm build` for all packages.
- Verify that `ProviderErrorMapper` correctly maps known HTTP status codes:
  - `401` → `ProviderAuthError`
  - `429` → `ProviderRateLimitError` (with `retryAfterMs` when `Retry-After`/`retry-after` header present; fallback `undefined` when absent)
  - `500` → `ProviderUnavailableError`
- Verify `parseRetryAfter` case-insensitive (`retry-after` vs `Retry-After` via lower-casing `headers` record).
- Verify that provider adapters produce identical error output for the same inputs (before and after migration).
- Verify `madge --circular packages/core/src/pipeline/error-mapper.ts` no circular (ADR-030), `pnpm build && api-extractor diff` shows MINOR additive (`ProviderErrorMapper` + `ProviderErrorInput`), and MINOR changeset exists.
- All existing adapter tests pass without modification.

> **Atomicity:** Phase 1 and Phase 2 are separate atomic commits; each must be green (`lint/typecheck/test:coverage/build`) independently; rollback of Phase 2 must not revert Phase 1.

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
madge --circular packages/core/src/pipeline/round-context.ts
madge --circular packages/core/src/pipeline/error-mapper.ts
pnpm changeset
api-extractor diff
```

Specific assertions to verify (expanded):

- **B2:**
  - All pipeline internal functions have 4 or fewer parameters.
  - `PipelineRoundContext` fields are all `readonly`; `trackDuration: () => number` (not `void`).
  - `RoundMutableState` contains `messages`, `toolAttempt`, `roundCounter`; `messages` NOT in `PipelineRoundContext`.
  - `PipelineRoundContext`/`RoundMutableState` are internal — NOT exported from `src/index.ts` or `pipeline/index.ts`; `pipeline/round-context.ts` not re-exported (internal). Verify `RoundMutableState` accidentally exported — add lint rule note: `pipeline/round-context.ts` internal, not re-exported from `src/index.ts`.
  - No `PipelineRoundContext` type appears in any public API export; `api-extractor` diff empty for B2; `pnpm build` produces `d.ts` — verify `pnpm build && api-extractor diff` (B2 empty).
  - All existing tests pass without modification — including `MockContextProvider` sequential + char-limit tests (`enforceCharLimit:262-288` S-5 truncation regression: 50 msg / 50k char warning+truncate preserved).
  - Context loading preservation: `initializePipeline` still contains `enforceCharLimit:262-288` via `config.contextPolicy` (`pipeline.ts:255-256` post-M05), sequential loading (ADR-013), skip/fail with `context.skipped` `EventErrorPayload` (ADR-042), signal forwarding (`provider.provide({ ...contextProviderInput, signal: input.signal })`) and `withTimeout` re-wrap (`TimeoutExceededError → ContextLoadError`) — not removed during param-object refactor.
  - Signal forwarding + `AbortSignal.any` composition (M05 §4.1) preserved; `madge --circular` for `round-context.ts` no circular (ADR-030).
  - All tests pass without modification — regression for `initializePipeline` context loading preserved.

- **B11:**
  - `ProviderErrorMapper.mapProviderError()` is exported from `@atisse/core` via `src/index.ts:1-73` (NOT via `pipeline/index.ts`); `ProviderErrorInput` single source in `error-mapper.ts` only.
  - `ProviderErrorMapper` correctly maps `401` → `ProviderAuthError` (non-retryable).
  - `ProviderErrorMapper` correctly maps `429` → `ProviderRateLimitError` (retryable) — with `retryAfterMs` when `Retry-After`/`retry-after` header present (case-insensitive), `undefined` fallback when absent.
  - `ProviderErrorMapper` correctly maps `500` → `ProviderUnavailableError` (retryable).
  - `ProviderErrorMapper.parseRetryAfter()` correctly parses both `Retry-After: 120` (seconds) and `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` (HTTP-date); case-insensitive test (`retry-after` vs `Retry-After` via lower-casing `headers` record; adapter `Object.fromEntries` not guaranteed lower-case).
  - Provider adapters produce identical error outputs for the same HTTP responses (before vs after migration).
  - `madge --circular packages/core/src/pipeline/error-mapper.ts` — no circular (ADR-030 L3↔L3 forbidden; `error-mapper.ts` may only import `errors.ts`, `interfaces.ts`).
  - `pnpm build && pnpm changeset` — MINOR changeset (`.changeset/<id>.md`) additive `ProviderErrorMapper` + `ProviderErrorInput`; `pnpm build && api-extractor diff` shows MINOR additive (new public export produces `d.ts`). Verify `tsup` build.
  - `errors.ts:331` `isRetryable` NOT changed — `error-mapper.ts` only sets `retryable` flag, not call `isRetryable`.
  - Provider import direction allowed: `provider-openai/src/index.ts` `import { ProviderErrorMapper } from '@atisse/core'` — core zero-adapter-import not violated; `providerId` string safe per S-1.
  - All existing tests pass without modification — plus `ProviderErrorMapper` matrix test + `parseRetryAfter` case-insensitive test.

---

## 8. Risk Assessment

| Risk                                                       | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B2: Refactoring introduces parameter mismatch bugs         | Medium     | Medium | Strict TypeScript types on `PipelineRoundContext` prevent field errors. All tests pass without change. Preserve `initializePipeline` context loading (`enforceCharLimit`, `config.contextPolicy`, signal forwarding, `withTimeout` re-wrap) — verify not deleted. |
| B2: `RoundMutableState` accidentally exported              | Low        | Low    | Defined in internal `round-context.ts` — no export from `pipeline/index.ts` or `core/src/index.ts`. Add lint rule note: `pipeline/round-context.ts` internal, not re-exported from `src/index.ts`.                                                                |
| B2: Context loading paths removed during param refactor    | Medium     | High   | Explicit preservation note in §1/§4.1/§6: `enforceCharLimit:262-288`, `CONTEXT_MAX_*` via `config.contextPolicy` (`pipeline.ts:255-256`), ADR-013 sequential, ADR-042 skip/fail + signal forwarding + `withTimeout` re-wrap — verify `madge` + tests after B2.    |
| B11: Adapter-specific error handling lost in migration     | Medium     | Medium | Keep provider-specific error handling that supplements base mapping. Do NOT blindly replace all logic.                                                                                                                                                            |
| B11: `ProviderErrorMapper` misses a provider-specific code | Medium     | Low    | Adapters can still add custom mapping AFTER calling the base mapper (fallback pattern).                                                                                                                                                                           |
| B11: `retry-after` parsing fails on non-standard headers   | Low        | Low    | Return undefined on parse failure — existing fallback in `calculateDelay` handles undefined correctly. Case-insensitive via lower-casing `headers` record; `undefined` fallback explicitly handled.                                                               |
| B11: Duplicate `ProviderErrorInput` export                 | Low        | Low    | Single source in `error-mapper.ts` only; M012-ratelimit reference is stale-docs — do not re-define elsewhere.                                                                                                                                                     |
| B11: Layering violation via `pipeline/index.ts`            | Low        | Medium | Do NOT touch `pipeline/index.ts` — re-export only via `core/src/index.ts:1-73`; `pipeline/index.ts` remains sole barrel for `executePipeline()`.                                                                                                                  |

---

## 9. References

- `.opencode/skill/interfaces/SKILL.md` — Frozen contracts (no breaking changes to public API)
- `.opencode/skill/interfaces/SKILL.md` — `EventBus`, `Logger`, `HookRegistry`, `RunInput` types
- `.opencode/skill/architecture/SKILL.md` — Layer architecture, pipeline execution flow, `pipeline/index.ts:40-52` sole barrel for `executePipeline()`
- `.opencode/skill/errors/SKILL.md` — Error hierarchy, `isRetryable()` classification (`errors.ts:331` L0)
- `.opencode/skill/code-standards/SKILL.md` — Function body max 40 lines, defensive programming
- `.opencode/skill/adapter-pattern/SKILL.md` — Provider adapter checklist, error mapping requirements
- `.opencode/skill/security/SKILL.md` — S-1 (no secrets in logs/errors/events; `providerId` string safe), S-5 truncation (`enforceCharLimit:262-288`, `CONTEXT_MAX_*` `pipeline.ts:255-256` via `config.contextPolicy` per ADR-042)
- `DECISION-LOG.md` — ADR-039 (pipeline internal architecture), ADR-030 (layering), ADR-013 (sequential context loading), ADR-042 (context skip/fail, `context.skipped` `EventErrorPayload`, `withTimeout` re-wrap, `config.contextPolicy`)
- `packages/core/src/pipeline/round-context.ts` — NEW (B2 target, renamed from `types.ts` — `src/types.ts:22` already defines `ResolvedConfig`)
- `packages/core/src/pipeline/shared.ts` — MODIFY (B2 refactoring target, after B1 split — verify skeleton first; preserve `initializePipeline` context loading)
- `packages/core/src/pipeline/non-streaming.ts` — MODIFY (B2 refactoring target, after B1 split — verify skeleton first)
- `packages/core/src/pipeline/streaming.ts` — MODIFY (B2 refactoring target, after B1 split — verify skeleton first)
- `packages/core/src/pipeline/error-mapper.ts` — NEW (B11 target, internal L3 — re-export via `core/src/index.ts:1-73`, NOT via `pipeline/index.ts`)
- `packages/core/src/index.ts:1-73` — MODIFY (B11 public export surface for `ProviderErrorMapper` + `ProviderErrorInput`)
- `packages/provider-openai/src/index.ts` — MODIFY (B11 adapter migration; `import { ProviderErrorMapper } from '@atisse/core'` allowed — core zero-adapter-import not violated)
- `packages/provider-anthropic/src/index.ts` — MODIFY (B11 adapter migration)
- `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M002-pipeline-consolidation-implementation-plan.md` — Prior pipeline consolidation (stale-docs — verify link freshness)
- `.opencode/stale-docs/pre-v1/targeted-implementation-plans/pipeline/M012-ratelimit-error-remapping-fix.md` — Prior error mapping standardization (stale-docs — `ProviderErrorInput` single source is now `error-mapper.ts`; stale reference — verify link freshness)
