# B3–B4 — Quality Infrastructure: Conformance Tests + Coverage Gates

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

Create a shared conformance test suite at `packages/core/src/testing/conformance-memory-adapter.ts` that exports `runMemoryAdapterConformanceTests(label: string, adapterFactory: () => MemoryAdapter)`. Both `memory-inmemory` and `memory-redis` packages must import and run it in their test suites to verify contract compliance.

Extend the same conformance pattern to the other two adapter families:

- `runProviderConformanceTests(label: string, providerFactory: () => AIProvider)` in `packages/core/src/testing/conformance-provider.ts` — run by `provider-openai` and `provider-anthropic` to verify `AIProvider` contract compliance (generate, capabilities, error mapping).
- `runContextProviderConformanceTests(label: string, contextProviderFactory: () => ContextProvider)` in `packages/core/src/testing/conformance-context-provider.ts` — run by `context-rag` to verify `ContextProvider` contract compliance (provide, input shape, role safety).

Raise `provider-openai` and `provider-anthropic` vitest coverage thresholds to match core: 70% lines, 70% branches (from the current 60% baselines inherited from `vitest.base.config.ts`). Config-only change.

> **Note on `testing/SKILL.md` alignment (M3):** `testing/SKILL.md` currently says providers 60% — M01 updates the skill coverage table to 70/70 for `provider-openai`/`provider-anthropic` upon completion; the PR must include the skill update or document the M5 exit note. See §4.2 footnote.

---

## 2. Context (Why This Exists)

### B3 — Missing Conformance Tests

Each memory adapter is tested in isolation within its own package. There is no shared conformance test that verifies all implementations behave identically against the `MemoryAdapter` interface contract. This creates risk of behavioral drift between `memory-inmemory` and `memory-redis` (e.g., one appends but the other replaces on `save()`). This violates Principle 2 (Interface-First) — interface guarantees are not verified to match across implementations.

The existing `MockMemoryAdapter` in `packages/core/tests/fixtures/mock-memory.ts` serves a different purpose (error injection for unit tests). The new conformance suite tests contract compliance, not failure scenarios.

### B4 — Coverage Threshold Inconsistency

The baseline `vitest.base.config.ts` sets `lines: 60`. Core overrides this to `lines: 70, branches: 70` in its own `vitest.config.ts`. Provider packages (`provider-openai`, `provider-anthropic`) have fragile API-mapping code that is critical to get right, yet they inherit the 60% baseline without branch coverage enforcement. M5 exit criteria demand 70% coverage across the board.

> **Footnote (M3 — Skill alignment):** `testing/SKILL.md` currently documents providers at 60% lines (`Coverage minimums` table). Upon M01 completion, update `testing/SKILL.md` coverage table to reflect `provider-openai`/`provider-anthropic` at 70% lines/branches. The PR must include this skill update, or the M5 exit-criteria note must explicitly track the deferred skill sync. See also §4.2.

---

## 3. Issues/Changes

### Issue B3: Missing MemoryAdapter Conformance Tests

| Field       | Value                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File        | `packages/core/src/testing/conformance-memory-adapter.ts` (NEW)                                                                                                    |
| Lines       | N/A — new file                                                                                                                                                     |
| Severity    | MEDIUM                                                                                                                                                             |
| Description | No shared conformance test suite verifies MemoryAdapter contract compliance across implementations. Each adapter is tested in isolation, risking behavioral drift. |
| Fix         | Create `runMemoryAdapterConformanceTests(label: string, adapterFactory: () => MemoryAdapter)` in core/testing/. Both memory packages import and invoke it.         |

### Issue B3 Implementation Detail

| Field       | Value                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/testing/index.ts`                                                                                                                                                   |
| Lines       | 1–2 (existing)                                                                                                                                                                         |
| Severity    | MEDIUM                                                                                                                                                                                 |
| Description | `testing/index.ts` currently exports only `MockProvider` and `MockProviderEntry`. The conformance suite must be exported from here.                                                    |
| Fix         | Add re-exports of `runMemoryAdapterConformanceTests`, `runProviderConformanceTests`, `runContextProviderConformanceTests` from the new conformance files (see §5 C1 for build wiring). |

### Issue B3 Adapter Integration

| Field       | Value                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/memory-inmemory/src/index.ts`                                                                                             |
| Lines       | N/A — test file needed                                                                                                              |
| Severity    | MEDIUM                                                                                                                              |
| Description | `memory-inmemory` must run the conformance test suite to verify compliance.                                                         |
| Fix         | Create or add to existing test: import and call `runMemoryAdapterConformanceTests('InMemoryAdapter', () => new InMemoryAdapter())`. |

| Field       | Value                                                                                                                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/memory-redis/src/index.ts`                                                                                                                                                                                                                                                                                               |
| Lines       | N/A — test file needed                                                                                                                                                                                                                                                                                                             |
| Severity    | MEDIUM                                                                                                                                                                                                                                                                                                                             |
| Description | `memory-redis` must run the conformance test suite to verify compliance.                                                                                                                                                                                                                                                           |
| Fix         | Create or add to existing test: import and call `runMemoryAdapterConformanceTests('RedisMemoryAdapter', () => new RedisMemoryAdapter({ url: 'redis://localhost:6379' }))`. Note: Redis conformance tests require a running Redis instance — see §4.1 B3 TTL branching note for `createClientPool` vs `createClient` mock strategy. |

### Issue B3 Provider Conformance

| Field       | Value                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/testing/conformance-provider.ts` (NEW)                                                                                                                          |
| Lines       | N/A — new file                                                                                                                                                                     |
| Severity    | MEDIUM                                                                                                                                                                             |
| Description | No shared conformance test verifies `AIProvider` contract compliance (`generate()`, `generateStream?()`, `capabilities`, error mapping) across provider implementations.           |
| Fix         | Create `runProviderConformanceTests(label: string, providerFactory: () => AIProvider)` in core/testing/. Both provider packages import and invoke it with their adapter factories. |

| Field       | Value                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/provider-openai/tests/unit/conformance.test.ts` (NEW)                                                                                                                 |
| Lines       | N/A — test file needed                                                                                                                                                          |
| Severity    | MEDIUM                                                                                                                                                                          |
| Description | `provider-openai` must run the provider conformance suite to verify contract compliance.                                                                                        |
| Fix         | Create test file: import and call `runProviderConformanceTests('OpenAIProvider', () => new OpenAIProvider({ apiKey: 'test-key' }))` — no real API calls (per test constraints). |

| Field       | Value                                                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/provider-anthropic/tests/unit/conformance.test.ts` (NEW)                                                                                                                    |
| Lines       | N/A — test file needed                                                                                                                                                                |
| Severity    | MEDIUM                                                                                                                                                                                |
| Description | `provider-anthropic` must run the provider conformance suite to verify contract compliance.                                                                                           |
| Fix         | Create test file: import and call `runProviderConformanceTests('AnthropicProvider', () => new AnthropicProvider({ apiKey: 'test-key' }))` — no real API calls (per test constraints). |

### Issue B3 Context Provider Conformance

| Field       | Value                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/testing/conformance-context-provider.ts` (NEW)                                                                                                       |
| Lines       | N/A — new file                                                                                                                                                          |
| Severity    | MEDIUM                                                                                                                                                                  |
| Description | No shared conformance test verifies `ContextProvider` contract compliance (`provide()`, `ContextProviderInput` shape, `SystemMessage[]` output) across implementations. |
| Fix         | Create `runContextProviderConformanceTests(label: string, contextProviderFactory: () => ContextProvider)` in core/testing/. `context-rag` imports and invokes it.       |

| Field       | Value                                                                                                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File        | `packages/context-rag/tests/unit/conformance.test.ts` (NEW)                                                                                                                                            |
| Lines       | N/A — test file needed                                                                                                                                                                                 |
| Severity    | MEDIUM                                                                                                                                                                                                 |
| Description | `context-rag` must run the context provider conformance suite to verify contract compliance.                                                                                                           |
| Fix         | Create test file: import and call `runContextProviderConformanceTests('RAGContextProvider', () => new RAGContextProvider({ ... }))` with an in-memory vector store — no external RAG backend required. |

### Issue B4: Coverage Threshold Too Low for Provider Packages

| Field       | Value                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/provider-openai/vitest.config.ts`                                                                                         |
| Lines       | 3–10 (entire file)                                                                                                                  |
| Severity    | MEDIUM                                                                                                                              |
| Description | Inherits 60% lines from base config. Provider packages with critical SDK-mapping code should match core's 70% lines + 70% branches. |
| Fix         | Add coverage thresholds block with `lines: 70, branches: 70`.                                                                       |

| Field       | Value                                                                             |
| ----------- | --------------------------------------------------------------------------------- |
| File        | `packages/provider-anthropic/vitest.config.ts`                                    |
| Lines       | 3–10 (entire file)                                                                |
| Severity    | MEDIUM                                                                            |
| Description | Same as provider-openai — 60% baseline is insufficient for critical adapter code. |
| Fix         | Add coverage thresholds block with `lines: 70, branches: 70`.                     |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

#### B3 — Conformance Test Design

The conformance suite must test these behaviors:

1. **`save()` + `load()` round-trip**: Save a `Message[]`, load it back, verify exact content match. Must cover `Message` union shapes: `MessageContent[]` array content, `role: 'assistant'` + `toolCalls`, `role: 'tool'` with `toolCallId` + `name`.
2. **`clear()` empties storage**: After clearing, `load()` returns `[]`.
3. **Concurrent `save()` isolation**: Two saves in sequence produce append behavior (not replace). Verify message count grows.
4. **TTL expiry behavior (Redis — branching on ADR-041):** If ADR-041 is merged (`createClientPool` path): mock `@redis/client` `createClientPool` + `pool.execute(cb)` and assert `isolatedClient.setEx` TTL argument inside the callback; `_executeMulti` throws `WatchError` (`@redis/client@6.2.1` `lib/client/index.js:1318`) as the retry signal (not `null` check). Else legacy `redis` `createClient` + `client.setEx` path. TTL check belongs in `packages/memory-redis/tests/unit/ttl.test.ts` (not in the shared conformance suite — conformance tests remain transport-agnostic).
5. **Unknown sessionId returns `[]`**: `load('nonexistent')` returns `[]`, never throws.
6. **Cross-session isolation**: `save('A', [...])` then `load('B')` returns `[]` — session A's data never leaks to session B.

> **ADR-041 note:** `DECISION-LOG.md:387-471` records ADR-041 as `Proposed`. The plan supports both branches until approval: pool-based (`createClientPool` + `pool.execute`) when ADR-041 lands, otherwise legacy `createClient` + `setEx`. Both branches must preserve the server-side WATCH state isolation guarantee (see §8 Redis risk).

Follow the existing `MockProvider` pattern in `packages/core/src/testing/mock-provider.ts` for test infrastructure placement. The conformance suite lives in `core/testing/` so both memory packages can depend on it without circular dependency.

Function signature (unified across all suites — C3):

```typescript
function runMemoryAdapterConformanceTests(label: string, adapterFactory: () => MemoryAdapter): void;
function runProviderConformanceTests(label: string, providerFactory: () => AIProvider): void;
function runContextProviderConformanceTests(
  label: string,
  contextProviderFactory: () => ContextProvider,
): void;
```

All three suites use the consistent `(label: string, factory: () => Adapter)` signature. `testing/index.ts:1-2` re-export note covers all 3 conformance files (see §5 C1).

Implementation pattern — use `describe` + `it` directly via a shared `describe` call:

```typescript
// packages/core/src/testing/conformance-memory-adapter.ts
import { describe, it, expect } from 'vitest';
import type { MemoryAdapter, Message } from '../interfaces.js';

export function runMemoryAdapterConformanceTests(
  label: string,
  adapterFactory: () => MemoryAdapter,
): void {
  describe(`MemoryAdapter conformance: ${label}`, () => {
    it('load() returns [] for unknown sessionId', async () => {
      const adapter = adapterFactory();
      const result = await adapter.load('nonexistent');
      expect(result).toEqual([]);
    });

    it('save() + load() round-trip preserves messages', async () => {
      const adapter = adapterFactory();
      const sessionId = 'test-session-1';
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there', toolCalls: [] },
        { role: 'assistant', content: [{ type: 'text', text: 'array content' }] },
        { role: 'tool', content: 'tool result', toolCallId: 'call-1', name: 'myTool' },
      ];
      await adapter.save(sessionId, messages);
      const loaded = await adapter.load(sessionId);
      expect(loaded).toEqual(messages);
    });

    it('save() appends to existing history', async () => {
      const adapter = adapterFactory();
      const sessionId = 'test-session-2';
      await adapter.save(sessionId, [{ role: 'user', content: 'First' }]);
      await adapter.save(sessionId, [{ role: 'user', content: 'Second' }]);
      const loaded = await adapter.load(sessionId);
      expect(loaded).toHaveLength(2);
      expect(loaded[0]).toMatchObject({ content: 'First' });
      expect(loaded[1]).toMatchObject({ content: 'Second' });
    });

    it('clear() empties storage', async () => {
      const adapter = adapterFactory();
      const sessionId = 'test-session-3';
      await adapter.save(sessionId, [{ role: 'user', content: 'Hello' }]);
      await adapter.clear(sessionId);
      const loaded = await adapter.load(sessionId);
      expect(loaded).toEqual([]);
    });

    it('clear() is idempotent for non-existent sessionId', async () => {
      const adapter = adapterFactory();
      await expect(adapter.clear('nonexistent')).resolves.toBeUndefined();
    });

    it('cross-session isolation: save(A) does not affect load(B)', async () => {
      const adapter = adapterFactory();
      await adapter.save('session-A', [{ role: 'user', content: 'Hello A' }]);
      const loadedB = await adapter.load('session-B');
      expect(loadedB).toEqual([]);
      const loadedA = await adapter.load('session-A');
      expect(loadedA).toHaveLength(1);
      expect(loadedA[0]).toMatchObject({ content: 'Hello A' });
    });
  });
}
```

> **M1 completeness:** The round-trip test covers the `Message` discriminated union shapes (`MessageContent[]` array, `assistant` + `toolCalls`, `tool` + `toolCallId`/`name`). Cross-session isolation is a dedicated test case.

#### B3 — Provider Conformance Test Design

The provider conformance suite verifies `AIProvider` contract behavior common to all provider adapters, using mocked HTTP transports (never real API calls):

1. **`generate()` returns `PromptResponse`**: well-formed `PromptRequest` produces a `PromptResponse` with `text` and `usage` fields.
2. **Error mapping (M2 — full taxonomy):** provider errors map to `OrchestratorError` subtypes — `401|403 → ProviderAuthError`, `429 → ProviderRateLimitError` (with `retryAfterMs` when `Retry-After` header present), `408 → ProviderTimeoutError`, `5xx → ProviderUnavailableError`, malformed/empty choice → `ProviderMalformedResponseError`. Ref `provider-openai/src/index.ts:341,347` and `provider-anthropic/src/index.ts:542`.
3. **`capabilities` truthfulness**: `capabilities.streaming === true` implies `generateStream` is defined and returns `Promise<AsyncIterable<StreamChunk>>`.
4. **Request shape**: `generate()` receives a `PromptRequest` whose `messages` preserve role order and `role: 'user'` for `input.prompt` (S-2 — never `role: 'system'`).
5. **No secrets in errors**: error messages never embed API keys (S-1).
6. **`providerOptions` reserved keys → `ConfigValidationError`**: passing a reserved key (e.g., `model`, `messages`) in `providerOptions` throws `ConfigValidationError` (see `provider-openai/src/index.ts:41-59`).
7. **`AbortSignal` passthrough**: `PromptRequest.signal` is forwarded to the underlying fetch/SDK client (`provider-openai/src/index.ts:161,225`).
8. **`finishReason` mapping**: `stop` / `tool_calls` / `length` are correctly mapped from provider-specific strings (`provider-openai/src/index.ts:535`).
9. **`maxTokens` / `temperature` forwarding**: optional `PromptRequest` fields are forwarded to provider params (`provider-openai/src/index.ts:143-147`).
10. **Streaming termination**: stream yields `done xor error` as the terminal chunk — never both, never neither.
11. **`capabilities.streaming === false ⇒ generateStream === undefined` (bidirectional):** if streaming is not advertised, the method must be absent; if streaming is advertised, it must be present.

Function signature:

```typescript
function runProviderConformanceTests(label: string, providerFactory: () => AIProvider): void;
```

#### B3 — Context Provider Conformance Test Design

The context provider conformance suite verifies `ContextProvider` contract behavior:

1. **`provide()` returns `SystemMessage[]`**: for a valid `ContextProviderInput`, output is an array of `{ role: 'system', content: string }` messages.
2. **Input shape (ADR-024)**: `provide()` receives `ContextProviderInput` — `stream` and `profile` fields are absent from the input object.
3. **Role safety (S-2)**: returned messages are always `role: 'system'` — never `role: 'user'`.
4. **Determinism**: same input produces the same output for a fixed backing store (no hidden state).
5. **`VectorStore.search` throw → `ContextLoadError`**: when the underlying vector store throws, the provider wraps it as `ContextLoadError` (`context-rag/src/index.ts:31-59` — `try { search } catch → ContextLoadError`).
6. **`non-array` / `doc.content` missing → `ContextProviderError`**: `!Array.isArray(docs)` or `typeof doc.content !== 'string'` throws `ContextProviderError` (`context-rag/src/index.ts:31-59`).
7. **Empty docs → `[]`**: when the vector store returns `[]`, `provide()` returns `[]` (no error).
8. **Prompt forwarding**: `provide()` forwards `input.prompt` to `vectorStore.search(query, topK)`.
9. **`SystemMessage[]` shape**: every returned element satisfies `{ role: 'system', content: string }` — no extra fields, no missing `content`.

Function signature:

```typescript
function runContextProviderConformanceTests(
  label: string,
  contextProviderFactory: () => ContextProvider,
): void;
```

#### B4 — Coverage Threshold Configuration

Both provider packages add a `coverage.thresholds` block identical to core's:

```typescript
import { baseConfig, baseCoverage } from '../../vitest.base.config.js';

coverage: {
  ...baseCoverage,
  thresholds: {
    lines: 70,
    branches: 70,
  },
}
```

Note: `...baseConfig.test` already contains `coverage: baseCoverage`, so `coverage: { ...baseCoverage, thresholds: {...} }` re-states the base — redundant but valid. Import `baseConfig, baseCoverage` together (see §6 Step 4).

No code changes — only vitest config.

### 4.2 What NOT to Do

- **B3**: Do NOT add network-dependent tests (e.g., actual TTL expiry waiting) to the conformance suite. TTL verification belongs in `packages/memory-redis/tests/unit/ttl.test.ts` with the branching mock strategy described in §4.1. Do NOT create a separate package for test infrastructure — keep everything in `core/testing/`. Conformance files in `core/src/testing/` are test infrastructure, so `import { describe, it, expect } from 'vitest'` is allowed despite `vitest` being a `devDependency`; consumers use it in test context only; `core/package.json` `vitest` remains dev-only and `tsup` external preserves it (M4).
- **B4**: Do NOT raise thresholds beyond 70% — M5 exit criteria define 70% as the target. The aspirational 90% goal from earlier discussions is deferred. Do NOT change `vitest.base.config.ts` — each package sets its own override. Threshold bump is config-only and must be atomic with the coverage lift (C4) — see §7 Step 0: measure first, add missing tests atomically in the same PR before bumping thresholds, otherwise CI fails.
- **M3 skill alignment:** `testing/SKILL.md` currently says providers 60% — M01 updates the skill coverage table to 70/70 for `provider-openai`/`provider-anthropic` upon completion; the PR must include the skill update or document the M5 exit note explaining the deferral.

---

## 5. Files to Modify

### B3 — Conformance Tests

| File                                                            | Action | Notes                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/testing/index.ts`                            | Modify | Add re-exports of all 3 conformance suites (see C1)                                                                                                                                   |
| `packages/core/src/testing/conformance-memory-adapter.ts`       | NEW    | The memory conformance test suite                                                                                                                                                     |
| `packages/core/src/testing/conformance-provider.ts`             | NEW    | The AIProvider conformance test suite                                                                                                                                                 |
| `packages/core/src/testing/conformance-context-provider.ts`     | NEW    | The ContextProvider conformance test suite                                                                                                                                            |
| `packages/core/package.json`                                    | Modify | C1: `exports["./testing"]` from `dist/testing/mock-provider.js` → `dist/testing/index.js` (with `types: ./dist/testing/index.d.ts`, `require: ./dist/testing/index.cjs`, no wildcard) |
| `packages/core/tsup.config.ts`                                  | Modify | C1: add entry `'testing/index': 'src/testing/index.ts'` so 3 new `conformance-*.ts` are bundled via re-export; `dist/testing/conformance-*.js` pulled via `testing/index.ts`          |
| `packages/memory-inmemory/tests/unit/conformance.test.ts`       | NEW    | Imports and invokes `runMemoryAdapterConformanceTests` (path: `tests/unit/` per `testing/SKILL.md` layout)                                                                            |
| `packages/memory-redis/tests/unit/conformance.test.ts`          | NEW    | Imports and invokes `runMemoryAdapterConformanceTests` (path: `tests/unit/`)                                                                                                          |
| `packages/memory-redis/tests/unit/ttl.test.ts`                  | NEW    | TTL branch coverage: `createClientPool` + `pool.execute(cb)` vs legacy `createClient` + `client.setEx` (see §4.1)                                                                     |
| `packages/provider-openai/tests/unit/conformance.test.ts`       | NEW    | Imports and invokes `runProviderConformanceTests` (path: `tests/unit/`)                                                                                                               |
| `packages/provider-anthropic/tests/unit/conformance.test.ts`    | NEW    | Imports and invokes `runProviderConformanceTests` (path: `tests/unit/`)                                                                                                               |
| `packages/context-rag/tests/unit/conformance.test.ts`           | NEW    | Imports and invokes `runContextProviderConformanceTests` (path: `tests/unit/`)                                                                                                        |
| `packages/context-rag/tests/fixtures/in-memory-vector-store.ts` | NEW    | In-memory `VectorStore` fixture for context conformance (new fixture)                                                                                                                 |

### B4 — Coverage Thresholds

| File                                           | Action | Notes                                                    |
| ---------------------------------------------- | ------ | -------------------------------------------------------- |
| `packages/provider-openai/vitest.config.ts`    | Modify | Add `lines: 70, branches: 70` thresholds                 |
| `packages/provider-anthropic/vitest.config.ts` | Modify | Add `lines: 70, branches: 70` thresholds                 |
| `.opencode/skill/testing/SKILL.md`             | Modify | M3: update coverage table from 60% → 70/70 for providers |

---

## 6. Implementation Strategy

### Step 0: Verify build artifacts (C1)

Before any conformance code, ensure the build pipeline will emit the correct artifacts:

- `packages/core/package.json` — change `exports["./testing"]`:

  ```json
  "./testing": {
    "import": "./dist/testing/index.js",
    "types": "./dist/testing/index.d.ts",
    "require": "./dist/testing/index.cjs"
  }
  ```

  Previously pointed at `dist/testing/mock-provider.js`; now points at `dist/testing/index.js` (which re-exports `MockProvider` + all 3 conformance suites). No wildcard export.

- `packages/core/tsup.config.ts` — add entry:
  ```typescript
  entry: {
    index: 'src/index.ts',
    'testing/index': 'src/testing/index.ts',
  }
  ```
  The 3 new `conformance-*.ts` files need not be listed individually — they are pulled via `testing/index.ts` re-exports and bundled as `dist/testing/conformance-*.js`.

Verify with `pnpm build` that `dist/testing/index.js` and `dist/testing/conformance-*.js` exist (see §7).

### Step 1: Create conformance test suite file

Create `packages/core/src/testing/conformance-memory-adapter.ts` with the `runMemoryAdapterConformanceTests` function. Follow the implementation pattern in §4.1. Use `import { describe, it, expect } from 'vitest'` — Vitest is already a devDependency in core. See §4.2 M4 for why this import is allowed in `core/src/testing/` (test infrastructure, `tsup` external preserves `vitest`).

### Step 2: Export from testing index

Add to `packages/core/src/testing/index.ts`:

```typescript
export { runMemoryAdapterConformanceTests } from './conformance-memory-adapter.js';
export { runProviderConformanceTests } from './conformance-provider.js';
export { runContextProviderConformanceTests } from './conformance-context-provider.js';
```

Re-exports `MockProvider` + all 3 suites via the single `testing/index` entry (C1 + C3).

### Step 3: Add conformance tests to memory adapter packages

Create `packages/memory-inmemory/tests/unit/conformance.test.ts`:

```typescript
import { describe } from 'vitest';
import { runMemoryAdapterConformanceTests } from '@atisse/core/testing';
import { InMemoryAdapter } from '../src/index.js';

runMemoryAdapterConformanceTests('InMemoryAdapter', () => new InMemoryAdapter());
```

Create `packages/memory-redis/tests/unit/conformance.test.ts`:

```typescript
import { describe } from 'vitest';
import { runMemoryAdapterConformanceTests } from '@atisse/core/testing';
import { RedisMemoryAdapter } from '../src/index.js';

runMemoryAdapterConformanceTests(
  'RedisMemoryAdapter',
  () => new RedisMemoryAdapter({ url: 'redis://localhost:6379' }),
);
```

Note for `memory-redis`: TTL-specific assertions belong in `packages/memory-redis/tests/unit/ttl.test.ts`, not in the shared conformance suite. Branching strategy (C2): if ADR-041 is merged (`createClientPool` path), mock `@redis/client` `createClientPool` + stub `pool.execute(cb)` and assert `isolatedClient.setEx` TTL argument inside the callback; `_executeMulti` throws `WatchError` (`@redis/client@6.2.1` `lib/client/index.js:1318`) as the retry signal (not a `null` check). Else the legacy `redis` `createClient` + `client.setEx` path.

### Step 3b: Add provider conformance tests

Create `packages/core/src/testing/conformance-provider.ts` with the `runProviderConformanceTests` function. Follow the implementation pattern in §4.1 (B3 Provider Conformance Test Design). Use `import { describe, it, expect } from 'vitest'` (M4 — allowed in `core/src/testing/`). Cover all M2 items: `401|403 → ProviderAuthError`, `429 → ProviderRateLimitError (retryAfterMs)`, `408 → ProviderTimeoutError`, `5xx → ProviderUnavailableError`, malformed → `ProviderMalformedResponseError` ref `provider-openai/src/index.ts:341,347` and `provider-anthropic/src/index.ts:542`; plus `providerOptions` reserved key → `ConfigValidationError`, `AbortSignal` passthrough, `finishReason` mapping, `maxTokens`/`temperature` forwarding, streaming termination `done xor error`, `capabilities.streaming false ⇒ generateStream undefined` bidirectional.

Create `packages/provider-openai/tests/unit/conformance.test.ts`:

```typescript
import { runProviderConformanceTests } from '@atisse/core/testing';
import { OpenAIProvider } from '../src/index.js';

runProviderConformanceTests('OpenAIProvider', () => new OpenAIProvider({ apiKey: 'test-key' }));
```

Create `packages/provider-anthropic/tests/unit/conformance.test.ts`:

```typescript
import { runProviderConformanceTests } from '@atisse/core/testing';
import { AnthropicProvider } from '../src/index.js';

runProviderConformanceTests(
  'AnthropicProvider',
  () => new AnthropicProvider({ apiKey: 'test-key' }),
);
```

Note for providers: mock the HTTP transport (`vi.mock` on the underlying fetch/SDK client) so `generate()` and `generateStream?()` run without network access. No real API calls in CI.

### Step 3c: Add context provider conformance tests

Create `packages/core/src/testing/conformance-context-provider.ts` with the `runContextProviderConformanceTests` function. Follow the implementation pattern in §4.1 (B3 Context Provider Conformance Test Design). Cover all M5 items: `VectorStore.search` throw → `ContextLoadError`, `non-array`/`doc.content` missing → `ContextProviderError` (`context-rag/src/index.ts:31-59`), empty docs → `[]`, prompt forwarding, `SystemMessage[]` shape.

Create `packages/context-rag/tests/unit/conformance.test.ts`:

```typescript
import { runContextProviderConformanceTests } from '@atisse/core/testing';
import { RAGContextProvider } from '../src/index.js';
import { InMemoryVectorStore } from '../fixtures/in-memory-vector-store.js';

runContextProviderConformanceTests(
  'RAGContextProvider',
  () => new RAGContextProvider({ vectorStore: new InMemoryVectorStore() }),
);
```

Create the in-memory fixture at `packages/context-rag/tests/fixtures/in-memory-vector-store.ts` (not `./fixtures/in-memory-vector-store.js`):

```typescript
import type { VectorStore, VectorDocument } from '../src/index.js';

export class InMemoryVectorStore implements VectorStore {
  readonly id = 'test-in-memory';
  constructor(private docs: VectorDocument[] = []) {}
  async search(query: string, _topK?: number): Promise<VectorDocument[]> {
    return this.docs;
  }
}
```

Note for `context-rag`: use the in-memory vector store fixture — no external RAG backend or network required.

### Step 4: Raise coverage thresholds

Edit `packages/provider-openai/vitest.config.ts` and `packages/provider-anthropic/vitest.config.ts` to add coverage thresholds matching core:

```typescript
import { defineConfig } from 'vitest/config';
import { baseConfig, baseCoverage } from '../../vitest.base.config.js';

export default defineConfig({
  ...baseConfig,
  test: {
    ...baseConfig.test,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      ...baseCoverage,
      thresholds: {
        lines: 70,
        branches: 70,
      },
    },
  },
});
```

Note: `...baseConfig.test` already contains `coverage: baseCoverage` (from `vitest.base.config.ts`), so `coverage: { ...baseCoverage, thresholds: {...} }` is redundant but valid — it re-states the base thresholds and adds the `70/70` override.

> **C4 pre-measurement (MUST do before bumping):** Run `pnpm test:coverage -r` in both provider packages _before_ changing thresholds. If either reports `lines < 70` or `branches < 70`, add the missing tests atomically in the same PR as the threshold bump — otherwise CI will fail on the next run. Threshold bump is config-only and must be atomic with the coverage lift.

---

## 7. Verification Requirements

### Step 0 — Pre-measurement and build artifact check (C1 + C4)

```bash
# C1: build artifact verification
pnpm build
ls dist/testing/index.js dist/testing/conformance-*.js  # must exist
# verify exports field
grep -q 'dist/testing/index.js' packages/core/package.json

# C4: pre-measurement — run BEFORE bumping thresholds
pnpm test:coverage -r  # in provider-openai and provider-anthropic
# if lines<70 or branches<70, add missing tests atomically in same PR before bumping
```

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test -r
pnpm test:coverage -r
```

Specific assertions to verify:

1. **B3**: `pnpm test` succeeds for both `memory-inmemory` and `memory-redis` with conformance tests passing. Conformance test output shows `MemoryAdapter conformance: InMemoryAdapter` and `MemoryAdapter conformance: RedisMemoryAdapter` test blocks. Cross-session isolation test passes (`cross-session isolation: save('A') then load('B') returns []`). Round-trip covers `Message` union shapes (`MessageContent[]`, `assistant` + `toolCalls`, `tool` + `toolCallId`/`name`).
2. **B3 (providers)**: Conformance output shows `AIProvider conformance: OpenAIProvider` and `AIProvider conformance: AnthropicProvider` test blocks. `generate()` returns a `PromptResponse`; error mapping produces `ProviderAuthError` for 401|403, `ProviderRateLimitError` for 429 (with `retryAfterMs`), `ProviderTimeoutError` for 408, `ProviderUnavailableError` for 5xx, `ProviderMalformedResponseError` for malformed; `providerOptions` reserved key → `ConfigValidationError`; `AbortSignal` passthrough verified; `finishReason` mapping verified; `maxTokens`/`temperature` forwarding verified; streaming termination `done xor error` verified; `capabilities.streaming false ⇒ generateStream undefined` bidirectional verified.
3. **B3 (context)**: Conformance output shows `ContextProvider conformance: RAGContextProvider` test block. `provide()` returns `SystemMessage[]`; `stream`/`profile` absent from received input (ADR-024); output roles are always `system` (S-2); `VectorStore.search` throw → `ContextLoadError`; `non-array`/`doc.content` missing → `ContextProviderError` (`context-rag/src/index.ts:31-59`); empty docs → `[]`; prompt forwarding verified; `SystemMessage[]` shape verified.
4. **B4**: Coverage reports for `provider-openai` and `provider-anthropic` show `lines ≥ 70%` and `branches ≥ 70%`. Run `pnpm test:coverage` in each provider package and inspect the output. `testing/SKILL.md` coverage table updated to 70/70 or M5 exit note tracks the deferral (M3). Threshold bump was atomic with the coverage lift (C4).
5. **C1**: `pnpm build` emits `dist/testing/index.js` (re-export barrel) and `dist/testing/conformance-*.js` (via `testing/index.ts` re-exports); `packages/core/package.json` `exports["./testing"]` points to `dist/testing/index.js` with `types` and `require` fields, no wildcard. `tsup.config.ts` has `testing/index` entry.

---

## 8. Risk Assessment

| Risk                                                                      | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B3: Redis conformance test needs live Redis                               | MEDIUM     | LOW    | Use `vi.mock()` to mock `redis` client per branching note: pool path mocks `createClientPool` + `pool.execute(cb)` + `isolatedClient.setEx` TTL arg; legacy path mocks `createClient` + `client.setEx`. TTL assertions live in `tests/unit/ttl.test.ts`, not in shared conformance.                   |
| B3: Circular dependency if conformance suite imports from memory packages | LOW        | MEDIUM | Conformance suite lives in `core/testing/` which does NOT import from adapters. Memory packages import from core, not vice versa.                                                                                                                                                                     |
| B4: Test coverage drops below 70% after threshold change                  | MEDIUM     | MEDIUM | Add missing tests in the provider packages to bring coverage up. This is the intent of the change. Measure first (C4 Step 0) and add tests atomically in same PR.                                                                                                                                     |
| C1: Build artifact mismatch                                               | LOW        | HIGH   | Fix `exports["./testing"]` to `dist/testing/index.js` and add `testing/index` entry in `tsup.config.ts`; verify with `pnpm build` that `dist/testing/index.js` and `dist/testing/conformance-*.js` exist.                                                                                             |
| C4: Pre-existing coverage <70%                                            | MEDIUM     | MEDIUM | Measure first with `pnpm test:coverage -r` in both providers; if under 70%, add missing tests atomically in same PR before bumping thresholds, otherwise CI fails.                                                                                                                                    |
| Redis: pool vs shared-client WATCH reset                                  | MEDIUM     | HIGH   | Pool path (`createClientPool` + `pool.execute`) gives each `save()` a dedicated connection, so server-side WATCH state reset on EXEC (per `DECISION-LOG.md:387-471` ADR-041) cannot leak across concurrent saves. Legacy shared-client path is vulnerable — migrate to pool when ADR-041 is approved. |

---

## 9. References

- `.opencode/skill/testing/SKILL.md` — Coverage requirements table, MockProvider pattern, `tests/unit/` layout convention
- `.opencode/skill/git-workflow/SKILL.md` — CI/CD Pipeline section, Dependency Policy
- `.opencode/skill/interfaces/SKILL.md` — MemoryAdapter interface contract (§Memory & Context Contracts)
- `.opencode/skill/security/SKILL.md` — S-8 Dependency Security requirements
- `packages/core/src/testing/mock-provider.ts` — Existing test infrastructure pattern
- `packages/core/src/testing/index.ts` — Current testing module exports (re-exports all 3 suites via `testing/index`)
- `packages/core/package.json` — `exports["./testing"]` → `dist/testing/index.js` (C1)
- `packages/core/tsup.config.ts` — `testing/index` entry for bundling conformance suites (C1)
- `packages/core/vitest.config.ts` — Core's coverage threshold pattern
- `vitest.base.config.ts` — Base coverage configuration (lines: 60)
- `packages/memory-inmemory/src/index.ts` — Reference MemoryAdapter implementation
- `packages/memory-redis/src/index.ts` — Redis MemoryAdapter implementation
- `packages/provider-openai/src/index.ts:41-59,143-147,161,225,341,347,535` — Reserved keys, forwarding, signal, error mapping, finishReason
- `packages/provider-anthropic/src/index.ts:542` — Error mapping (401|403/429/408/5xx/malformed)
- `packages/context-rag/src/index.ts:31-59` — `VectorStore.search` throw → `ContextLoadError`, non-array/content-missing → `ContextProviderError`, empty docs → `[]`
- `DECISION-LOG.md:387-471` — ADR-041 `Proposed` — pool vs shared-client WATCH isolation; plan supports both branches until approval
- `@redis/client@6.2.1` `lib/client/index.js:1318` — `_executeMulti` throws `WatchError` on WATCH abort
