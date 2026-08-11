# B3–B4 — Quality Infrastructure: Conformance Tests + Coverage Gates

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

Create a shared conformance test suite at `packages/core/src/testing/conformance-memory-adapter.ts` that exports `runMemoryAdapterConformanceTests(adapterFactory: () => MemoryAdapter)`. Both `memory-inmemory` and `memory-redis` packages must import and run it in their test suites to verify contract compliance.

Extend the same conformance pattern to the other two adapter families:

- `runProviderConformanceTests()` in `packages/core/src/testing/conformance-provider.ts` — run by `provider-openai` and `provider-anthropic` to verify `AIProvider` contract compliance (generate, capabilities, error mapping).
- `runContextProviderConformanceTests()` in `packages/core/src/testing/conformance-context-provider.ts` — run by `context-rag` to verify `ContextProvider` contract compliance (provide, input shape, role safety).

Raise `provider-openai` and `provider-anthropic` vitest coverage thresholds to match core: 70% lines, 70% branches (from the current 60% baselines inherited from `vitest.base.config.ts`). Config-only change.

---

## 2. Context (Why This Exists)

### B3 — Missing Conformance Tests

Each memory adapter is tested in isolation within its own package. There is no shared conformance test that verifies all implementations behave identically against the `MemoryAdapter` interface contract. This creates risk of behavioral drift between `memory-inmemory` and `memory-redis` (e.g., one appends but the other replaces on `save()`). This violates Principle 2 (Interface-First) — interface guarantees are not verified to match across implementations.

The existing `MockMemoryAdapter` in `packages/core/tests/fixtures/mock-memory.ts` serves a different purpose (error injection for unit tests). The new conformance suite tests contract compliance, not failure scenarios.

### B4 — Coverage Threshold Inconsistency

The baseline `vitest.base.config.ts` sets `lines: 60`. Core overrides this to `lines: 70, branches: 70` in its own `vitest.config.ts`. Provider packages (`provider-openai`, `provider-anthropic`) have fragile API-mapping code that is critical to get right, yet they inherit the 60% baseline without branch coverage enforcement. M5 exit criteria demand 70% coverage across the board.

---

## 3. Issues/Changes

### Issue B3: Missing MemoryAdapter Conformance Tests

| Field       | Value                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File        | `packages/core/src/testing/conformance-memory-adapter.ts` (NEW)                                                                                                    |
| Lines       | N/A — new file                                                                                                                                                     |
| Severity    | MEDIUM                                                                                                                                                             |
| Description | No shared conformance test suite verifies MemoryAdapter contract compliance across implementations. Each adapter is tested in isolation, risking behavioral drift. |
| Fix         | Create `runMemoryAdapterConformanceTests()` in core/testing/. Both memory packages import and invoke it.                                                           |

### Issue B3 Implementation Detail

| Field       | Value                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/testing/index.ts`                                                                                                |
| Lines       | 1–2 (existing)                                                                                                                      |
| Severity    | MEDIUM                                                                                                                              |
| Description | `testing/index.ts` currently exports only `MockProvider` and `MockProviderEntry`. The conformance suite must be exported from here. |
| Fix         | Add re-export of `runMemoryAdapterConformanceTests` from the new conformance file.                                                  |

### Issue B3 Adapter Integration

| Field       | Value                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| File        | `packages/memory-inmemory/src/index.ts`                                                                          |
| Lines       | N/A — test file needed                                                                                           |
| Severity    | MEDIUM                                                                                                           |
| Description | `memory-inmemory` must run the conformance test suite to verify compliance.                                      |
| Fix         | Create or add to existing test: import and call `runMemoryAdapterConformanceTests(() => new InMemoryAdapter())`. |

| Field       | Value                                                                                                                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/memory-redis/src/index.ts`                                                                                                                                                                                                                                    |
| Lines       | N/A — test file needed                                                                                                                                                                                                                                                  |
| Severity    | MEDIUM                                                                                                                                                                                                                                                                  |
| Description | `memory-redis` must run the conformance test suite to verify compliance.                                                                                                                                                                                                |
| Fix         | Create or add to existing test: import and call `runMemoryAdapterConformanceTests(() => new RedisMemoryAdapter({ url: 'redis://localhost:6379' }))`. Note: Redis conformance tests require a running Redis instance — use `vi.mock()` or integration test skip pattern. |

### Issue B3 Provider Conformance

| Field       | Value                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File        | `packages/core/src/testing/conformance-provider.ts` (NEW)                                                                                                                |
| Lines       | N/A — new file                                                                                                                                                           |
| Severity    | MEDIUM                                                                                                                                                                   |
| Description | No shared conformance test verifies `AIProvider` contract compliance (`generate()`, `generateStream?()`, `capabilities`, error mapping) across provider implementations. |
| Fix         | Create `runProviderConformanceTests()` in core/testing/. Both provider packages import and invoke it with their adapter factories.                                       |

| Field       | Value                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/provider-openai/tests/conformance.test.ts` (NEW)                                                                                                    |
| Lines       | N/A — test file needed                                                                                                                                        |
| Severity    | MEDIUM                                                                                                                                                        |
| Description | `provider-openai` must run the provider conformance suite to verify contract compliance.                                                                      |
| Fix         | Create test file: import and call `runProviderConformanceTests(() => new OpenAIProvider({ apiKey: 'test-key' }))` — no real API calls (per test constraints). |

| Field       | Value                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/provider-anthropic/tests/conformance.test.ts` (NEW)                                                                                                    |
| Lines       | N/A — test file needed                                                                                                                                           |
| Severity    | MEDIUM                                                                                                                                                           |
| Description | `provider-anthropic` must run the provider conformance suite to verify contract compliance.                                                                      |
| Fix         | Create test file: import and call `runProviderConformanceTests(() => new AnthropicProvider({ apiKey: 'test-key' }))` — no real API calls (per test constraints). |

### Issue B3 Context Provider Conformance

| Field       | Value                                                                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/testing/conformance-context-provider.ts` (NEW)                                                                                                       |
| Lines       | N/A — new file                                                                                                                                                          |
| Severity    | MEDIUM                                                                                                                                                                  |
| Description | No shared conformance test verifies `ContextProvider` contract compliance (`provide()`, `ContextProviderInput` shape, `SystemMessage[]` output) across implementations. |
| Fix         | Create `runContextProviderConformanceTests()` in core/testing/. `context-rag` imports and invokes it.                                                                   |

| Field       | Value                                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/context-rag/tests/conformance.test.ts` (NEW)                                                                                                                           |
| Lines       | N/A — test file needed                                                                                                                                                           |
| Severity    | MEDIUM                                                                                                                                                                           |
| Description | `context-rag` must run the context provider conformance suite to verify contract compliance.                                                                                     |
| Fix         | Create test file: import and call `runContextProviderConformanceTests(() => new RAGContextProvider({ ... }))` with an in-memory vector store — no external RAG backend required. |

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

1. **`save()` + `load()` round-trip**: Save a `Message[]`, load it back, verify exact content match.
2. **`clear()` empties storage**: After clearing, `load()` returns `[]`.
3. **Concurrent `save()` isolation**: Two saves in sequence produce append behavior (not replace). Verify message count grows.
4. **TTL expiry behavior (Redis only)**: Verify that `setEx` is called with the configured TTL. Use `vi.spyOn` on the Redis client to inspect the TTL argument. Do not actually wait for TTL expiration.
5. **Unknown sessionId returns `[]`**: `load('nonexistent')` returns `[]`, never throws.

Follow the existing `MockProvider` pattern in `packages/core/src/testing/mock-provider.ts` for test infrastructure placement. The conformance suite lives in `core/testing/` so both memory packages can depend on it without circular dependency.

Function signature:

```typescript
function runMemoryAdapterConformanceTests(label: string, adapterFactory: () => MemoryAdapter): void;
```

The `label` parameter identifies which adapter is being tested in test output. The `adapterFactory` is called once per test (fresh instance for isolation).

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
  });
}
```

#### B3 — Provider Conformance Test Design

The provider conformance suite verifies `AIProvider` contract behavior common to all provider adapters, using mocked HTTP transports (never real API calls):

1. **`generate()` returns `PromptResponse`**: well-formed `PromptRequest` produces a `PromptResponse` with `text` and `usage` fields.
2. **Error mapping**: provider errors map to `OrchestratorError` subtypes — `401` → `ProviderAuthError`, `429` → `ProviderRateLimitError`, `5xx` → `ProviderUnavailableError` (contract with ADR-007).
3. **`capabilities` truthfulness**: `capabilities.streaming === true` implies `generateStream` is defined and returns `Promise<AsyncIterable<StreamChunk>>`.
4. **Request shape**: `generate()` receives a `PromptRequest` whose `messages` preserve role order and `role: 'user'` for `input.prompt` (S-2 — never `role: 'system'`).
5. **No secrets in errors**: error messages never embed API keys (S-1).

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
coverage: {
  ...baseCoverage,
  thresholds: {
    lines: 70,
    branches: 70,
  },
},
```

No code changes — only vitest config.

### 4.2 What NOT to Do

- **B3**: Do NOT add network-dependent tests (e.g., actual TTL expiry waiting) to the conformance suite. Use `vi.spyOn` for TTL verification. Do NOT create a separate package for test infrastructure — keep everything in `core/testing/`. Do NOT import `vitest` types in `core` non-test files — conformance tests are test infrastructure.
- **B4**: Do NOT raise thresholds beyond 70% — M5 exit criteria define 70% as the target. The aspirational 90% goal from earlier discussions is deferred. Do NOT change `vitest.base.config.ts` — each package sets its own override.

---

## 5. Files to Modify

### B3 — Conformance Tests

| File                                                        | Action | Notes                                                                                  |
| ----------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------- |
| `packages/core/src/testing/index.ts`                        | Modify | Add re-export of `runMemoryAdapterConformanceTests` + provider/context-provider suites |
| `packages/core/src/testing/conformance-memory-adapter.ts`   | NEW    | The memory conformance test suite                                                      |
| `packages/core/src/testing/conformance-provider.ts`         | NEW    | The AIProvider conformance test suite                                                  |
| `packages/core/src/testing/conformance-context-provider.ts` | NEW    | The ContextProvider conformance test suite                                             |
| `packages/memory-inmemory/tests/conformance.test.ts`        | NEW    | Imports and invokes `runMemoryAdapterConformanceTests`                                 |
| `packages/memory-redis/tests/conformance.test.ts`           | NEW    | Imports and invokes `runMemoryAdapterConformanceTests`                                 |
| `packages/provider-openai/tests/conformance.test.ts`        | NEW    | Imports and invokes `runProviderConformanceTests`                                      |
| `packages/provider-anthropic/tests/conformance.test.ts`     | NEW    | Imports and invokes `runProviderConformanceTests`                                      |
| `packages/context-rag/tests/conformance.test.ts`            | NEW    | Imports and invokes `runContextProviderConformanceTests`                               |

### B4 — Coverage Thresholds

| File                                           | Action | Notes                                    |
| ---------------------------------------------- | ------ | ---------------------------------------- |
| `packages/provider-openai/vitest.config.ts`    | Modify | Add `lines: 70, branches: 70` thresholds |
| `packages/provider-anthropic/vitest.config.ts` | Modify | Add `lines: 70, branches: 70` thresholds |

---

## 6. Implementation Strategy

### Step 1: Create conformance test suite file

Create `packages/core/src/testing/conformance-memory-adapter.ts` with the `runMemoryAdapterConformanceTests` function. Follow the implementation pattern in §4.1. Use `import { describe, it, expect } from 'vitest'` — Vitest is already a devDependency in core.

### Step 2: Export from testing index

Add to `packages/core/src/testing/index.ts`:

```typescript
export { runMemoryAdapterConformanceTests } from './conformance-memory-adapter.js';
export { runProviderConformanceTests } from './conformance-provider.js';
export { runContextProviderConformanceTests } from './conformance-context-provider.js';
```

### Step 3: Add conformance tests to memory adapter packages

Create `packages/memory-inmemory/tests/conformance.test.ts`:

```typescript
import { describe } from 'vitest';
import { runMemoryAdapterConformanceTests } from '@atisse/core/testing';
import { InMemoryAdapter } from '../src/index.js';

runMemoryAdapterConformanceTests('InMemoryAdapter', () => new InMemoryAdapter());
```

Create `packages/memory-redis/tests/conformance.test.ts`:

```typescript
import { describe } from 'vitest';
import { runMemoryAdapterConformanceTests } from '@atisse/core/testing';
import { RedisMemoryAdapter } from '../src/index.js';

runMemoryAdapterConformanceTests(
  'RedisMemoryAdapter',
  () => new RedisMemoryAdapter({ url: 'redis://localhost:6379' }),
);
```

Note for `memory-redis`: The conformance tests that do NOT require a live Redis connection (save/load/clear round-trip) can use a mocked client via `vi.mock('redis', ...)`. The TTL check can use `vi.spyOn(client, 'setEx')` to verify the TTL argument without connecting.

### Step 3b: Add provider conformance tests

Create `packages/core/src/testing/conformance-provider.ts` with the `runProviderConformanceTests` function. Follow the implementation pattern in §4.1 (B3 Provider Conformance Test Design). Use `import { describe, it, expect } from 'vitest'`.

Create `packages/provider-openai/tests/conformance.test.ts`:

```typescript
import { runProviderConformanceTests } from '@atisse/core/testing';
import { OpenAIProvider } from '../src/index.js';

runProviderConformanceTests('OpenAIProvider', () => new OpenAIProvider({ apiKey: 'test-key' }));
```

Create `packages/provider-anthropic/tests/conformance.test.ts`:

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

Create `packages/core/src/testing/conformance-context-provider.ts` with the `runContextProviderConformanceTests` function. Follow the implementation pattern in §4.1 (B3 Context Provider Conformance Test Design).

Create `packages/context-rag/tests/conformance.test.ts`:

```typescript
import { runContextProviderConformanceTests } from '@atisse/core/testing';
import { RAGContextProvider } from '../src/index.js';
import { InMemoryVectorStore } from './fixtures/in-memory-vector-store.js';

runContextProviderConformanceTests(
  'RAGContextProvider',
  () => new RAGContextProvider({ vectorStore: new InMemoryVectorStore() }),
);
```

Note for `context-rag`: use an in-memory vector store fixture — no external RAG backend or network required.

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

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test -r
pnpm test:coverage -r
```

Specific assertions to verify:

1. **B3**: `pnpm test` succeeds for both `memory-inmemory` and `memory-redis` with conformance tests passing. Conformance test output shows `MemoryAdapter conformance: InMemoryAdapter` and `MemoryAdapter conformance: RedisMemoryAdapter` test blocks.
2. **B3 (providers)**: Conformance output shows `AIProvider conformance: OpenAIProvider` and `AIProvider conformance: AnthropicProvider` test blocks. `generate()` returns a `PromptResponse`; error mapping produces `ProviderAuthError` for 401, `ProviderRateLimitError` for 429, `ProviderUnavailableError` for 5xx; `capabilities.streaming === true` implies `generateStream` is defined.
3. **B3 (context)**: Conformance output shows `ContextProvider conformance: RAGContextProvider` test block. `provide()` returns `SystemMessage[]`; `stream`/`profile` absent from received input (ADR-024); output roles are always `system` (S-2).
4. **B4**: Coverage reports for `provider-openai` and `provider-anthropic` show `lines ≥ 70%` and `branches ≥ 70%`. Run `pnpm test:coverage` in each provider package and inspect the output.

---

## 8. Risk Assessment

| Risk                                                                      | Likelihood | Impact | Mitigation                                                                                                                        |
| ------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| B3: Redis conformance test needs live Redis                               | MEDIUM     | LOW    | Use `vi.mock()` to mock `redis` client. Mock `setEx`, `get`, `del`. Only the TTL assertion needs `vi.spyOn` on the mock.          |
| B3: Circular dependency if conformance suite imports from memory packages | LOW        | MEDIUM | Conformance suite lives in `core/testing/` which does NOT import from adapters. Memory packages import from core, not vice versa. |
| B4: Test coverage drops below 70% after threshold change                  | MEDIUM     | MEDIUM | Add missing tests in the provider packages to bring coverage up. This is the intent of the change.                                |

---

## 9. References

- `.opencode/skill/testing/SKILL.md` — Coverage requirements table, MockProvider pattern
- `.opencode/skill/git-workflow/SKILL.md` — CI/CD Pipeline section, Dependency Policy
- `.opencode/skill/interfaces/SKILL.md` — MemoryAdapter interface contract (§Memory & Context Contracts)
- `.opencode/skill/security/SKILL.md` — S-8 Dependency Security requirements
- `packages/core/src/testing/mock-provider.ts` — Existing test infrastructure pattern
- `packages/core/src/testing/index.ts` — Current testing module exports
- `packages/core/vitest.config.ts` — Core's coverage threshold pattern
- `vitest.base.config.ts` — Base coverage configuration (lines: 60)
- `packages/memory-inmemory/src/index.ts` — Reference MemoryAdapter implementation
- `packages/memory-redis/src/index.ts` — Redis MemoryAdapter implementation
