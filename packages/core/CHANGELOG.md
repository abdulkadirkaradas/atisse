# @atisse/core

## 1.1.0

### Minor Changes

- d1d9e31: v1.0.2 — core minor (additive features), memory-redis patch

  ### @atisse/core — minor (1.0.1 → 1.1.0)

  Additive, backward-compatible — no breaking change to `interfaces.ts` (frozen v1, optional fields only per `constraints`/`interfaces` skills and ADR-022):

  - **feat(core): add configurable contextPolicy (#11, 7acea30, P04-A5)** — adds `ContextPolicy` (`maxMessagesPerProvider=50`, `maxContentLengthChars=50000`), `OrchestratorConfig.contextPolicy?: Partial<ContextPolicy>` and `OrchestratorProfile` support via `mergeContextPolicy()`/`DEFAULT_CONTEXT_POLICY` in `policies.ts`; validated eagerly in `orchestrator.ts`. **MINOR** — new optional fields, default preserves existing behavior; `interfaces.ts:262-391` additive only per v1 commitment (no MAJOR).
  - **fix(core): throw ToolDefinitionError for unsupported JSON Schema keywords (#10, 3735f87, P02-A3)** — adds `ToolDefinitionError` (`code='TOOL_DEFINITION_ERROR'`, `retryable=false`) and widens `OrchestratorErrorCode` union in `interfaces.ts:45` with `'TOOL_DEFINITION_ERROR'`; fail-fast validation in `tool-controller.ts`/`pipeline.ts`. **MINOR** — union widening is additive per ADR-022 (adding a code is MINOR, removing is MAJOR); no removed/narrowed required field, no `run()` return shape change.
  - **feat(core): inject logger into InternalEventBus for listener errors (#12, 1a49809, P03-A4)** — `InternalEventBus` now accepts `{ logger?: Logger, onListenerError? }` options (`events.ts`), wired from `orchestrator.ts` via `createEventBus({ logger })`; listener rejections log `warn` with `runId/eventType/error` per `observability` skill (ADR-004 fire-and-forget preserved). Internal wiring only, no public `interfaces.ts` shape change — absorbed into the **minor** ceiling (feat but internal).

  Combined `core` bump is **minor** (highest of minor/patch per Changesets — `feat` additive wins over `fix`/`chore`).

  ### @atisse/memory-redis — patch (1.1.0 → 1.1.1)
  - **fix(memory-redis): atomic WATCH/MULTI/EXEC saves with pooled isolation (#8, b740282, P01-A1A2)** — replaces read-modify-write with `RedisClientPool` optimistic locking, `WatchError` retry (max 3, no delay), pooled connection isolation per ADR-041; remaps `save()`/`clear()` failures to `MemorySaveError` (`MEMORY_SAVE_FAILED`, `retryable=false`) per ADR-007 taxonomy. No `MemoryAdapter` interface change (`interfaces.ts:165` unchanged). **PATCH** — bug fix, backward-compatible.

  ### Not versioned
  - **docs: add Known v1 Limitations section (#13, fc44e37, P05-A6)** — `docs/getting-started.md` only, no runtime code.
  - **docs(skills): codify delivery lifecycle (0-7) and skill loading policy (#9, f5423cc)** — `.opencode/skill/*` / `AGENTS.md` governance docs only, `ignore` per Changesets policy for docs-only changes.

  SemVer via Changesets (`git-workflow` versioning): breaking `interfaces.ts` = MAJOR (forbidden in v1 — all changes additive optional), backward-compatible feature = MINOR, fix = PATCH. No `pnpm changeset version` / `publish` / `main` push executed per user authority.

## 1.0.1

### Patch Changes

- ### `@atisse/core`
  - Context provider outputs are now capped at 50 messages and 50,000 characters per provider. When either limit is exceeded, the output is truncated and a warning is logged.
  - The `context.loaded` event's `messageCount` field now reflects the truncated message count (after limits are applied).

  ### `@atisse/memory-redis`
  - `RedisMemoryAdapter` constructor now accepts an optional `keyPrefix` parameter in both config shapes:
    - `{ client, keyPrefix? }` — when passing an existing Redis client
    - `{ url, ttlSeconds?, keyPrefix? }` — when passing connection details
  - Default key prefix remains `'atisse:session:'`, so existing usage is fully backward-compatible.

  ### `@atisse/core`, `@atisse/memory-inmemory`, `@atisse/provider-openai`, `@atisse/provider-anthropic`, `@atisse/memory-redis`, `@atisse/context-rag`
  - Added `author`, `repository`, `bugs`, `homepage`, and `keywords` sections to each package's `package.json` file, improving package metadata and discoverability.
  - `README.md` files have been added to each package, providing a brief overview and usage instructions.

## 1.0.0

### Major Changes

- First stable release — v1.0.0. Public API is frozen per interfaces-core.md and interfaces-runtime.md. All M1–M5 exit criteria satisfied.

## 0.1.0

### Minor Changes

- Initial package versions set to 0.1.0
