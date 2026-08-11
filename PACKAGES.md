# Packages

`@atisse/core` — MIT, Node.js 24+, TypeScript 5.4+ (`strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`). The gap it fills: raw SDK calls have no retry/fallback/memory/
observability; heavy frameworks (LangChain-style) hide behavior and lock you to a vendor.
This is the minimal layer in between.

```
@atisse/core               kernel, frozen interfaces, MockProvider
@atisse/provider-openai    OpenAI adapter
@atisse/provider-anthropic Anthropic adapter
@atisse/memory-inmemory    reference memory adapter
@atisse/memory-redis       Redis memory adapter
@atisse/context-rag        RAG context provider
```

## Stack

pnpm workspaces (monorepo) · tsup (ESM+CJS+`.d.ts` build) · Vitest + `@vitest/coverage-v8`
(all tests via `MockProvider`, no real API calls) · Zod (the only runtime dependency in
`@atisse/core`) · ESLint + `@typescript-eslint` (`no-explicit-any`, `no-floating-promises`)
· Prettier (`singleQuote`, `trailingComma: all`, `printWidth: 100`) · TypeDoc (JSDoc
required on all public exports) · Changesets + SemVer (no MAJOR bumps in v1) · GitHub
Actions (lint → typecheck → test → coverage per PR).

`tsconfig.base.json` at the monorepo root is the compiler-flag source of truth — every
package extends it; don't duplicate its contents elsewhere. Adapter packages declare their
provider SDK as a `peerDependency`, never a direct dependency.

## Non-goals — never implement in v1

Agent frameworks (autonomous planning, self-directed loops), workflow engines (DAG
execution, step chaining), multi-agent systems, visual editors / no-code builders, SaaS
dashboards, prompt-template DSLs. A requested feature matching one of these belongs in
user-land or a separate project. See the `constraints` skill for the enforceable version of
this list (with the "why" per row) and for code-level forbidden patterns.
