# M5 Implementation Plan

## Quality Gate

**Status:** Ready to implement
**Blocker:** M2 + M3 + M4 complete
**Prerequisite Decisions:** All M1–M4 decisions + D-M5-1 through D-M5-6 (autonomous)

---

## 1. Mandatory Reading Before Writing Any Code

1. `.opencode/rules/interfaces-core.md` + `.opencode/rules/interfaces-runtime.md`
2. `.opencode/rules/security.md` — full read (security checklist sign-off)
3. `.opencode/workflows/testing-standards.md` — coverage thresholds
4. `.opencode/workflows/sdlc.md` — Changesets, CI/CD pipeline, versioning
5. `.opencode/rules/constraints.md`
6. `.opencode/rules/typescript-style.md` + `.opencode/rules/implementation-standards.md`

---

## 2. Approved Decisions (Autonomous — SPSA Authority)

### D-M5-1: Coverage Enforcement — Hard Fail in CI

Vitest `thresholds` block added to `vitest.base.config.ts`. CI step fails when any package drops below the per-package thresholds defined in `testing-standards.md`. The `|| true` bypass introduced in M1 for TypeDoc is NOT related to coverage; coverage is a separate `test:coverage` script.

**Thresholds (from `testing-standards.md`):**

| Package                      | Lines | Branches |
| ---------------------------- | ----- | -------- |
| `@atisse/core`               | 70%   | 70%      |
| `@atisse/provider-openai`    | 60%   | —        |
| `@atisse/provider-anthropic` | 60%   | —        |
| `@atisse/memory-redis`       | 60%   | —        |
| `@atisse/context-rag`        | 50%   | —        |
| `@atisse/memory-inmemory`    | 60%   | —        |

### D-M5-2: TypeDoc — Hard Fail in M5

The `|| true` suffix added in M1 CI step (`typedoc --out docs/api src/index.ts || true`) is removed. TypeDoc errors now block CI. Exit criterion: `typedoc` exits 0 on a clean run across all public exports in `@atisse/core`.

### D-M5-3: Benchmark Tooling — Zero-Dependency Custom Script

`performance.now()`-based custom benchmark script at `scripts/benchmark.ts`. No new runtime dependency. Measures p50 and p95 of `orchestrator.run()` overhead vs raw `MockProvider.generate()` call over 1000 iterations with warm-up. Threshold: overhead < 5ms at p95. Script is committed; result is manual sign-off (not CI-blocking in M5).

### D-M5-4: Stress Test — In-Process via Vitest + Promise.all

100 concurrent `orchestrator.run()` calls via `Promise.all()` in a Vitest integration test. No external load-testing tool. Verifies: no state leaks (runId uniqueness), no cross-run interference (session isolation), no memory growth (heap snapshot before/after within acceptable delta). Lives in `packages/core/tests/integration/stress.test.ts`.

### D-M5-5: Changesets — Initial Package Version `0.1.0`

Changesets initialized at root. All packages start at `0.1.0` pre-release. M6 introduces the `1.0.0` changeset bump. Config: `commonjs` changelog format, `linked: []` (packages version independently).

### D-M5-6: Security Checklist Sign-Off — SPSA PR Comment

Formal sign-off is a checklist comment in the M5 PR, authored by SPSA. No new file. Each item in `security.md` §Security Review Checklist verified across all M1–M4 deliverables. PR is blocked until all items are checked.

---

## 3. Implementation Order

```
Phase 1 — Coverage threshold enforcement (vitest config)
Phase 2 — TypeDoc hard-fail (CI update)
Phase 3 — Changeset setup
Phase 4 — Benchmark script
Phase 5 — Stress test
Phase 6 — Security checklist sign-off (SPSA)
Phase 7 — API naming consistency review (SPSA)
Phase 8 — Final CI pipeline update
```

---

## 4. Phase 1 — Coverage Threshold Enforcement

### `vitest.base.config.ts` — Update

Add `coverage.thresholds` block. Each package's `vitest.config.ts` inherits from base; package-specific overrides applied where thresholds differ.

**Implementation checklist:**

- [ ] Add to `vitest.base.config.ts`:

```typescript
coverage: {
  provider: 'v8',
  reporter: ['text', 'html', 'json-summary'],
  thresholds: {
    lines: 60,
    // branches intentionally omitted for adapter packages — unset means "not enforced"
    // core overrides this with branches: 70 explicitly
  },
},
```

- [ ] Override in `packages/core/vitest.config.ts`:

```typescript
coverage: {
  ...baseCoverage,
  thresholds: {
    lines: 70,
    branches: 70,
  },
},
```

- [ ] Override in `packages/context-rag/vitest.config.ts`:

```typescript
coverage: {
  ...baseCoverage,
  thresholds: { lines: 50 },
},
```

- [ ] Verify `pnpm --recursive test:coverage` exits non-zero when any threshold is violated
- [ ] Verify green on current codebase before finalizing thresholds

---

## 5. Phase 2 — TypeDoc Hard-Fail

### `.github/workflows/ci.yml` — Update

- [ ] Remove `|| true` from TypeDoc in **two places**:

```yaml
# 1. .github/workflows/ci.yml — Before (M1 soft-fail)
- run: typedoc --out docs/api src/index.ts || true

# After (M5 hard-fail)
- run: typedoc --out docs/api src/index.ts
```

```json
// 2. root package.json "docs" script — Before
"docs": "typedoc --out docs/api packages/core/src/index.ts || true"

// After
"docs": "typedoc --out docs/api packages/core/src/index.ts"
```

> **Critical:** Both locations must be fixed. CI calls `pnpm run docs` which inherits the `|| true` from `package.json` if only the CI step is patched.

- [ ] Add TypeDoc step to the `quality` job (runs on every PR)
- [ ] Ensure all exported symbols in `@atisse/core/src/index.ts` have JSDoc — verify by running TypeDoc locally first
- [ ] Fix any missing JSDoc on exported classes, interfaces, and functions before enabling hard-fail
- [ ] `tsconfig.typedoc.json` (if not present): extends `tsconfig.json`, sets `"declaration": false` for TypeDoc-only run

### JSDoc Audit — Required Before TypeDoc Hard-Fail

Scan all exports from `packages/core/src/index.ts`. Every exported symbol must have:

```typescript
/** Single-line description. */
export interface Foo { ... }

/**
 * Multi-line description for complex types.
 * @example
 * const x = new Foo();
 */
export class Bar { ... }
```

- [ ] `Orchestrator` class — verify `@example` present
- [ ] All `OrchestratorError` subclasses — description + `retryable` behavior documented
- [ ] All policy interfaces — default values documented on each field
- [ ] `LifecycleStateMachine` — document terminal state behavior
- [ ] `MockProvider` (via `./testing` subpath) — usage pattern documented

---

## 6. Phase 3 — Changeset Setup

### Files to Create

| File                     | Purpose                                |
| ------------------------ | -------------------------------------- |
| `.changeset/config.json` | Changeset configuration                |
| `.changeset/README.md`   | Auto-generated by init (do not modify) |

### `.changeset/config.json`

```json
{
  "$schema": "https://unpkg.com/@changesets/config/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": []
}
```

### `package.json` (root) — Add scripts

```json
{
  "scripts": {
    "changeset": "changeset",
    "version": "changeset version",
    "release": "pnpm build && changeset publish"
  }
}
```

### Implementation checklist

- [ ] `pnpm add -D @changesets/cli` (root devDependency)
- [ ] `pnpm changeset init` — generates `.changeset/config.json`
- [ ] Create initial changeset for all packages bumping from `0.0.1` → `0.1.0` (MINOR bump — adding new capabilities):
  - `packages/core/package.json` → `"version": "0.0.1"` → changeset bumps to `0.1.0`
  - Same for all adapter packages
- [ ] Verify `pnpm changeset status` shows correct pending versions
- [ ] Do NOT run `pnpm changeset publish` — deferred to M6

---

## 7. Phase 4 — Benchmark Script

### `scripts/benchmark.ts`

```typescript
/**
 * Benchmark: measures p50 and p95 overhead of orchestrator.run()
 * vs raw MockProvider.generate() call.
 *
 * Run: npx tsx scripts/benchmark.ts
 * Pass threshold: p95 overhead < 5ms
 */
import { Orchestrator } from '../packages/core/src/index.js';
import { MockProvider } from '../packages/core/src/testing/index.js';

const ITERATIONS = 1000;
const WARMUP = 100;
const THRESHOLD_P95_MS = 5;

async function run() {
  const provider = new MockProvider();
  const orchestrator = new Orchestrator({ provider });

  // Warm-up
  for (let i = 0; i < WARMUP; i++) {
    provider.enqueue({ text: 'ok' });
    await orchestrator.run({ prompt: 'bench' });
  }

  // Raw provider baseline
  const rawTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    provider.enqueue({ text: 'ok' });
    await provider.generate({ messages: [{ role: 'user', content: 'bench' }] });
    rawTimes.push(performance.now() - t0);
  }

  // Orchestrator
  const orchTimes: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    provider.enqueue({ text: 'ok' });
    const t0 = performance.now();
    await orchestrator.run({ prompt: 'bench' });
    orchTimes.push(performance.now() - t0);
  }

  const overhead = orchTimes.map((t, i) => t - (rawTimes[i] ?? 0));
  overhead.sort((a, b) => a - b);

  const p50Index = Math.floor(ITERATIONS * 0.5);
  const p95Index = Math.floor(ITERATIONS * 0.95);
  const p50 = overhead[p50Index] ?? 0;
  const p95 = overhead[p95Index] ?? 0;

  console.log(`p50 overhead: ${p50.toFixed(3)}ms`);
  console.log(`p95 overhead: ${p95.toFixed(3)}ms`);
  console.log(
    `Threshold (p95 < ${THRESHOLD_P95_MS}ms): ${p95 < THRESHOLD_P95_MS ? 'PASS' : 'FAIL'}`,
  );

  if (p95 >= THRESHOLD_P95_MS) process.exit(1);
}

run().catch(console.error);
```

### Implementation checklist

- [ ] `scripts/benchmark.ts` created at repo root
- [ ] Add to root `package.json` scripts: `"bench": "npx tsx scripts/benchmark.ts"`
- [ ] Run locally and verify PASS before M5 sign-off
- [ ] Result documented in M5 PR description (p50/p95 numbers)
- [ ] Benchmark is NOT a CI step — manual sign-off only

---

## 8. Phase 5 — Stress Test

### `packages/core/tests/integration/stress.test.ts`

**Implementation checklist:**

- [ ] 100 concurrent `orchestrator.run()` calls via `Promise.all()` with `MockProvider` queue pre-populated
- [ ] Each run uses a unique `sessionId` — verify cross-session isolation post-run
- [ ] Verify all 100 `RunOutput.runId` values are unique (no collision)
- [ ] Verify `provider.callCount() === 100` (no double-dispatch)
- [ ] Memory growth assertion: heap usage delta < 10MB between start and end
  - Use `process.memoryUsage().heapUsed` before/after
- [ ] With `InMemoryAdapter`: verify session-A load never returns session-B data after concurrent saves
- [ ] All 100 runs resolve `RunOutput` (no unhandled rejections)

```typescript
it('100 concurrent runs — no state leaks', async () => {
  const provider = new MockProvider();
  for (let i = 0; i < 100; i++) provider.enqueue({ text: `response-${i}` });

  const orchestrator = new Orchestrator({
    provider,
    memoryAdapter: new InMemoryAdapter(),
  });

  // Optional GC before measurement to reduce non-determinism
  if (typeof global.gc === 'function') global.gc();
  const heapBefore = process.memoryUsage().heapUsed;

  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      orchestrator.run({ prompt: `prompt-${i}`, sessionId: `session-${i}` }),
    ),
  );

  const heapAfter = process.memoryUsage().heapUsed;
  const heapDeltaMB = (heapAfter - heapBefore) / 1024 / 1024;

  expect(results).toHaveLength(100);
  const runIds = new Set(results.map((r) => r.runId));
  expect(runIds.size).toBe(100); // all unique
  expect(provider.callCount()).toBe(100);
  expect(heapDeltaMB).toBeLessThan(10);
});
```

---

## 9. Phase 6 — Security Checklist Sign-Off (SPSA)

SPSA reviews all M1–M4 deliverables against `security.md` §Security Review Checklist.
Sign-off is a PR comment with the following format:

```
## M5 Security Sign-Off

Reviewed against security.md §Security Review Checklist.
Scope: all packages delivered in M1–M4.

[x] S-1: No secrets in logs or error messages
[x] S-2: run.input.prompt never mapped to role: 'system'
[x] S-2a: Profile factory args are adapter instances only
[x] S-3a: Tool inputSchema non-empty, additionalProperties: false
[x] S-3b: (No HTTP-calling tools in core — N/A for core; documented in adapter guide)
[x] S-4: MemoryAdapter uses sessionId-scoped storage keys
[x] S-5: contextPolicy limits not bypassed
[x] S-6: ContextProvider.provide() does not map input.prompt to role: 'system'
[x] S-7: No eval(), new Function(), or vm usage
[x] S-7 (cont.): Error messages contain no internal paths, line numbers, or stack frame details
[x] S-8: pnpm audit HIGH+ clean

Signed: SPSA — M5 PR
```

- [ ] Run `pnpm audit --audit-level=high` — must exit 0
- [ ] Grep codebase for `eval(`, `new Function(`, `vm.runIn` — must return empty
- [ ] Grep for `role: 'system'` assignments — verify none originate from `input.prompt`
- [ ] Verify all tool `inputSchema` in fixtures have `additionalProperties: false`

---

## 10. Phase 7 — API Naming Consistency Review (SPSA)

Review all exported symbols from `packages/core/src/index.ts` against `api-design.md` naming conventions.

**Checklist:**

- [ ] All class names: PascalCase noun ✓
- [ ] All event type strings: `noun.verb` past tense ✓ (`run.completed`, `tool.failed`, etc.)
- [ ] All error class names: PascalCase ending in `Error` ✓
- [ ] All config fields: camelCase noun ✓
- [ ] `maxAttempts` semantics documented explicitly (total attempts, not retry count) ✓
- [ ] `ContextProviderInput` naming: consistent with `Omit<RunInput>` semantic ✓
- [ ] `ToolResultError` vs `EventErrorPayload` distinction: documented in JSDoc ✓

If any inconsistency found → flag as ADR candidate before M6. No interface changes permitted in M5 without SPSA + user approval.

---

## 11. Phase 8 — Final CI Pipeline Update

### `.github/workflows/ci.yml`

**Updated `quality` job (runs on every PR):**

```yaml
jobs:
  quality:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --recursive lint
      - run: pnpm --recursive typecheck
      - run: pnpm --recursive test
      - run: pnpm --recursive test:coverage # hard-fail on threshold violation (D-M5-1)
      - run: pnpm --filter @atisse/core typedoc --out docs/api src/index.ts # hard-fail (D-M5-2)
      - run: pnpm audit --audit-level=high
```

**Implementation checklist:**

- [ ] Remove `|| true` from TypeDoc step
- [ ] Add `test:coverage` as a separate blocking step
- [ ] Add `pnpm audit --audit-level=high` as a blocking step
- [ ] Verify CI green on clean checkout before M5 sign-off

---

## 12. Layer Compliance

M5 introduces no new source files to `packages/core/src/`. All changes are:

- Config files (`vitest.base.config.ts`, `.github/workflows/ci.yml`)
- Scripts (`scripts/benchmark.ts`) — not part of any package
- Test files (`stress.test.ts`) — Layer 0 consumer only

No layer violation risk.

---

## 13. Constraint Verification Checklist

- [ ] `scripts/benchmark.ts` uses no `any` types
- [ ] `stress.test.ts` uses `MockProvider` exclusively — no real API calls
- [ ] No new runtime dependency introduced to `@atisse/core`
- [ ] Changeset config does not introduce a version bump without explicit changeset file

---

## 14. Exit Criteria

Per `roadmap.md` §M5 Exit Criteria — M5 is complete when ALL pass:

- [ ] `pnpm --recursive test:coverage` exits 0 — all thresholds met
- [ ] `pnpm --filter @atisse/core typedoc` exits 0 — no missing JSDoc errors
- [ ] `scripts/benchmark.ts` runs and p95 overhead < 5ms — result documented in PR
- [ ] Stress test: 100 concurrent runs, all unique `runId`, no state leaks, heap delta < 10MB
- [ ] Security checklist signed off (SPSA PR comment)
- [ ] API naming consistency review complete — no regressions found
- [ ] Changesets initialized — `pnpm changeset status` shows packages at `0.1.0`
- [ ] `pnpm audit --audit-level=high` exits 0
- [ ] `pnpm --recursive lint` exits 0
- [ ] `pnpm --recursive typecheck` exits 0
- [ ] CI pipeline green on a clean checkout

---

## 15. What M5 Does NOT Include

Per `roadmap.md` §M6:

- `npm publish` / `changeset publish` → M6
- `README.md` (public-facing) → M6
- `examples/` directory → M6
- `docs/getting-started.md`, `docs/writing-adapters.md` → M6
- GitHub Discussions → M6
- `1.0.0` version bump → M6 via Changeset
