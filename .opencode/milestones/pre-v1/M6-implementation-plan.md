# M6 Implementation Plan

## First Release — `1.0.0`

**Status:** Ready to implement
**Blocker:** M5 complete
**Prerequisite Decisions:** All M1–M5 decisions + D-M6-1 through D-M6-5 (autonomous)

---

## 1. Mandatory Reading Before Starting

1. `rules/roadmap.md` — M6 deliverables and exit criteria (primary reference)
2. `rules/constraints.md` — v1 scope; nothing outside it ships
3. `rules/philosophy.md` — README and docs must reflect the 7 principles
4. `rules/interfaces-core.md` + `rules/interfaces-runtime.md` — public API surface to document
5. `workflows/sdlc.md` — versioning, publish protocol, branch strategy
6. `rules/api-design.md` — documentation requirements for all exported symbols

---

## 2. Approved Decisions (Autonomous — SPSA Authority)

### D-M6-1: README Structure

Single root `README.md`. Sections: one-liner → problem/solution → comparison table → quick-start (< 20 lines) → package list → links. No marketing language. Tone matches `philosophy.md` Principle 1 (explicit, direct).

### D-M6-2: Examples Are Runnable TypeScript Files

Each example under `examples/{N}-{name}/index.ts`. Every example has its own `package.json` with `@atisse/core` + relevant adapter as dependencies. Examples use `tsx` for execution (`npx tsx index.ts`). No build step required for examples — they are developer-facing, not published.

### D-M6-3: `docs/writing-adapters.md` Scope

Covers four adapter types: provider, memory, context, tool. References `workflows/adapter-pattern.md` for the checklist. Does NOT duplicate the checklist — links to it. Includes one minimal concrete example per type showing the error-mapping pattern.

### D-M6-4: Version Bump Strategy

All packages bump from `0.1.0` → `1.0.0` via a single Changeset marked MAJOR. Rationale: the public API is frozen, the quality gate is passed, the kernel is production-ready. All packages version together for the first release (cohesion). After `1.0.0`, packages version independently per `sdlc.md`.

### D-M6-5: TypeDoc Site Hosting

TypeDoc output (`docs/api/`) is committed to the repository and served via GitHub Pages from the `docs/` folder on `main`. No external CI step for GH Pages in M6 — manual activation by the user after the first release merge.

---

## 3. Implementation Order

```
Phase 1 — README.md
Phase 2 — examples/ (5 working examples)
Phase 3 — docs/getting-started.md
Phase 4 — docs/writing-adapters.md
Phase 5 — Version bump (1.0.0 Changeset)
Phase 6 — Pre-publish checklist
Phase 7 — Publish
Phase 8 — Post-publish (GitHub Discussions)
```

---

## 4. Phase 1 — `README.md`

### File Location

Repository root: `README.md`

### Structure

```
1. Badge row (npm version, CI status, license)
2. One-liner headline
3. Problem / Solution (2 short paragraphs)
4. Comparison table
5. Quick-start (< 20 lines, OpenAI + run())
6. Package ecosystem table
7. Links (docs, examples, contributing)
```

### Comparison Table

|                           | LangChain | Vercel AI SDK | **@atisse/core** |
| ------------------------- | --------- | ------------- | ---------------- |
| Weight                    | Heavy     | Light         | Minimal          |
| Focus                     | Framework | Frontend      | Backend kernel   |
| Hidden behavior           | High      | Medium        | None             |
| Vendor lock-in            | Yes       | Partial       | No               |
| Production retry/fallback | Complex   | None          | First-class      |
| Tool lifecycle            | Opaque    | Limited       | Explicit         |
| Streaming                 | Yes       | First-class   | First-class      |
| Testability               | Hard      | Medium        | MockProvider     |

### Quick-Start Block

```typescript
import { Orchestrator } from '@atisse/core';
import { OpenAIProvider } from '@atisse/provider-openai';

const apiKey = process.env.OPENAI_KEY ?? '';
if (!apiKey) throw new Error('OPENAI_KEY environment variable is required');

const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({ apiKey }),
  retry: { maxAttempts: 3 },
});

const result = await orchestrator.run({ prompt: 'Hello' });
console.log(result.text);
```

### Implementation Checklist

- [ ] Badge row: npm + CI + MIT license
- [ ] One-liner matches `project-description.md` identity
- [ ] Problem/solution: 2 paragraphs max; no bullet points in prose sections
- [ ] Comparison table: 8 rows as above
- [ ] Quick-start: single provider, no tools, compiles and runs
- [ ] Package table: all 6 packages with one-line description each
- [ ] Links section: docs/, examples/, GitHub Discussions URL

---

## 5. Phase 2 — `examples/`

### Directory Layout

```
examples/
├── 01-basic-run/
│   ├── index.ts
│   └── package.json
├── 02-retry-and-fallback/
│   ├── index.ts
│   └── package.json
├── 03-tool-execution/
│   ├── index.ts
│   └── package.json
├── 04-orchestrator-profile/
│   ├── index.ts
│   └── package.json
└── 05-streaming-with-tools/
    ├── index.ts
    └── package.json
```

### Example `package.json` Pattern

```json
{
  "name": "@atisse-example/01-basic-run",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "npx tsx index.ts"
  },
  "dependencies": {
    "@atisse/core": "workspace:*",
    "@atisse/provider-openai": "workspace:*"
  },
  "devDependencies": {
    "tsx": "^4.0.0"
  }
}
```

> **Note:** All example `package.json` files use `"workspace:*"` during development. Phase 5 (version bump) includes a step to replace these with `"^1.0.0"` after the Changeset version command runs.

### Example Specifications

**01-basic-run:** `Orchestrator` + `OpenAIProvider`. Single `run()`. Print `result.text`, `result.durationMs`, `result.usage.total`. Shows minimal viable setup.

**02-retry-and-fallback:** Primary provider `gpt-4o`, fallback `gpt-4o-mini`. Event listeners on `retry.attempted` and `fallback.triggered`. Demonstrates `orchestrator.on()` unsubscribe pattern.

**03-tool-execution:** Two tools: `calculatorTool` and `weatherTool`. `inputSchema` with `additionalProperties: false`. Print `result.toolResults`. Shows tool round in action.

**04-orchestrator-profile:** Three profiles: `editor`, `analyzer`, `support`. `RAGContextProvider` scaffold (mock `VectorStore`). `InMemoryAdapter` for session. Shows profile switching on same instance.

**05-streaming-with-tools:** `run({ stream: true })`. SSE-style `for await` loop printing each chunk type. One tool mid-stream. Shows `tool_call` → pause → `tool_result` → resume pattern.

### Implementation Checklist

- [ ] Each example runs with `npx tsx index.ts` (no build step)
- [ ] No hardcoded API keys — all use `process.env.*` with a check that prints usage if missing
- [ ] Each example has a top-of-file comment explaining what it demonstrates (3 lines max)
- [ ] `examples/` root has an `README.md` listing all 5 examples with one-line descriptions
- [ ] Example 04 uses `@atisse/context-rag` + `@atisse/memory-inmemory`
- [ ] Example 05 must not configure `fallbackProvider` (ADR-017)

---

## 6. Phase 3 — `docs/getting-started.md`

### Sections

1. **Installation** — `pnpm add @atisse/core @atisse/provider-openai`
2. **First run** — minimal config, single `run()`, output shape
3. **Configuration reference** — table of every `OrchestratorConfig` field with type, default, description
4. **Adding tools** — `Tool` interface, schema requirement, `execute()` pattern
5. **Memory** — `sessionId` + `InMemoryAdapter` / `RedisMemoryAdapter`
6. **Streaming** — `stream: true`, `for await`, chunk types
7. **Profiles** — `OrchestratorProfile`, merge rules, `orchestrator.run({ profile })`
8. **Observability** — `orchestrator.on()`, event types, unsubscribe

### Implementation Checklist

- [ ] Every `OrchestratorConfig` field in the configuration reference table
- [ ] Streaming section explicitly notes: `stream: true` + `fallbackProvider` is forbidden (ADR-017)
- [ ] Memory section notes: `save()` appends — never replaces (ADR-012)
- [ ] Profile section documents `tools: []` vs `tools: undefined` distinction
- [ ] No duplicate content from README — link to README quick-start instead of repeating

---

## 7. Phase 4 — `docs/writing-adapters.md`

### Sections

1. **Overview** — 4 adapter types, which interface each implements
2. **Provider adapter** — `AIProvider` contract, `generate()`, `generateStream()`, error mapping table (HTTP → OrchestratorError), minimal skeleton
3. **Memory adapter** — `MemoryAdapter` contract, append semantics, session isolation, `ContextLoadError` mapping
4. **Context provider** — `ContextProvider` contract, `provide()` returns `SystemMessage[]`, `input.prompt` retrieval-only rule (S-6)
5. **Tool** — `Tool` interface, `inputSchema` requirements (`additionalProperties: false`), `ToolValidationError` vs `ToolExecutionError`
6. **Package structure** — directory template, `package.json` with peerDep pattern
7. **Publishing convention** — `@atisse/provider-*`, `@atisse/memory-*`, `@atisse/context-*`, `@atisse/tool-*`

### Implementation Checklist

- [ ] Each adapter type section includes one concrete error-mapping code snippet
- [ ] Security rules (S-1, S-2, S-3a, S-4, S-6, S-7) called out inline — not as a separate section
  - S-1 in Provider adapter section: API key must never appear in logs or error messages
  - S-7 in Overview section: no `eval()`, `new Function()`, `vm` usage; error messages must not expose internal paths
- [ ] References `workflows/adapter-pattern.md` for the full checklist — does NOT duplicate it
- [ ] `@atisse/tool-{name}` packaging convention documented

---

## 8. Phase 5 — Version Bump to `1.0.0`

### Steps

- [ ] `pnpm changeset` — create a new changeset file selecting ALL packages, type: MAJOR
- [ ] Changeset description: `"First stable release — v1.0.0. Public API is frozen per interfaces-core.md and interfaces-runtime.md. All M1–M5 exit criteria satisfied."`
- [ ] `pnpm changeset version` — verify all packages bump to `1.0.0`
- [ ] Replace `"workspace:*"` with `"^1.0.0"` in all `examples/*/package.json` dependency entries
- [ ] Review updated `CHANGELOG.md` files per package — ensure no incorrect entries
- [ ] Commit: `chore(release): version packages 1.0.0`

---

## 9. Phase 6 — Pre-Publish Checklist

**Must pass before `pnpm changeset publish`:**

- [ ] `pnpm install --frozen-lockfile` — clean install
- [ ] `pnpm -r build` — all packages build without error
- [ ] `pnpm -r lint` — exits 0
- [ ] `pnpm -r typecheck` — exits 0
- [ ] `pnpm -r test` — exits 0
- [ ] `pnpm -r test:coverage` — all thresholds met
- [ ] `pnpm run docs` — TypeDoc exits 0
- [ ] `pnpm audit` — exits 0 (bare audit; ALL severity levels must be clean per S-8)
- [ ] `npm install @atisse/core` on a clean temp directory + run example 01 — works
- [ ] All 5 examples: `npx tsx index.ts` exits 0 (requires real API key for full validation)
- [ ] `package.json` `"main"`, `"module"`, `"exports"`, `"types"` fields correct for each package
- [ ] No `"private": true` on packages intended for publish
- [ ] npm registry login confirmed: `npm whoami`

---

## 10. Phase 7 — Publish

```bash
# From repo root, on main branch, after pre-publish checklist passes:
pnpm changeset publish
```

### Publish Order (automatic via Changesets, but verify):

1. `@atisse/core` — must publish first (others depend on it)
2. `@atisse/memory-inmemory`
3. `@atisse/provider-openai`
4. `@atisse/provider-anthropic`
5. `@atisse/memory-redis`
6. `@atisse/context-rag`

### Post-Publish Verification

- [ ] `npm info @atisse/core version` returns `1.0.0`
- [ ] `npm info @atisse/provider-openai version` returns `1.0.0`
- [ ] All 6 packages visible on npmjs.com
- [ ] TypeDoc site accessible (GitHub Pages URL)
- [ ] Git tag `v1.0.0` created and pushed: `git tag v1.0.0 && git push origin v1.0.0`

---

## 11. Phase 8 — Post-Publish

- [ ] Enable GitHub Discussions on the repository
- [ ] Create initial Discussion category: `Q&A`, `Show and Tell`, `Ideas`
- [ ] Pin a "Welcome" discussion linking to `docs/getting-started.md` and examples
- [ ] Create GitHub Release for `v1.0.0` — attach CHANGELOG summary

---

## 12. File Inventory

| File                                            | Action | Notes                              |
| ----------------------------------------------- | ------ | ---------------------------------- |
| `README.md`                                     | CREATE | Repository root                    |
| `examples/01-basic-run/index.ts`                | CREATE |                                    |
| `examples/01-basic-run/package.json`            | CREATE |                                    |
| `examples/02-retry-and-fallback/index.ts`       | CREATE |                                    |
| `examples/02-retry-and-fallback/package.json`   | CREATE |                                    |
| `examples/03-tool-execution/index.ts`           | CREATE |                                    |
| `examples/03-tool-execution/package.json`       | CREATE |                                    |
| `examples/04-orchestrator-profile/index.ts`     | CREATE |                                    |
| `examples/04-orchestrator-profile/package.json` | CREATE |                                    |
| `examples/05-streaming-with-tools/index.ts`     | CREATE |                                    |
| `examples/05-streaming-with-tools/package.json` | CREATE |                                    |
| `examples/README.md`                            | CREATE | Index of all examples              |
| `docs/getting-started.md`                       | CREATE |                                    |
| `docs/writing-adapters.md`                      | CREATE |                                    |
| `.changeset/*.md`                               | CREATE | Auto-generated by `pnpm changeset` |

---

## 13. Constraint Verification Checklist

- [ ] No v2 features referenced or scaffolded in examples or docs
- [ ] `stream: true` + `fallbackProvider` prohibition documented in getting-started (ADR-017)
- [ ] `allowParallelTools: true` prohibition not mentioned as a future feature — v2 boundary
- [ ] All examples use `process.env.*` for API keys — no hardcoded credentials (S-1)
- [ ] `docs/writing-adapters.md` does not imply new interface fields (frozen contract)
- [ ] README comparison table is factual — no claims beyond what the codebase delivers

---

## 14. Exit Criteria

M6 is complete when ALL pass:

- [ ] `npm install @atisse/core` + Example 01 runs on a clean machine
- [ ] All 5 examples execute without errors
- [ ] TypeDoc site live (GitHub Pages)
- [ ] All 6 packages at `1.0.0` on npm
- [ ] `README.md` in place with comparison table and quick-start
- [ ] `docs/getting-started.md` covers all 8 configuration areas
- [ ] `docs/writing-adapters.md` covers all 4 adapter types
- [ ] GitHub Discussions enabled with welcome post
- [ ] `v1.0.0` git tag pushed

---

## 15. What M6 Does NOT Include

- v2 feature documentation or roadmap hints (defer — user decides)
- Contributor guide / `CONTRIBUTING.md` (deferred — interfaces not stable enough for community contributions until v1 is in the wild)
- Additional adapter packages beyond the official 4 (scope boundary)
- CI step for automatic npm publish (manual publish for first release; automate in v1.x maintenance)
