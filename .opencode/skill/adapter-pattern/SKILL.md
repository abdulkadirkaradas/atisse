---
name: adapter-pattern
description: How to write a provider, memory, or context adapter for @atisse/core — checklists, error mapping, and package structure. Load when building or reviewing a new provider/memory/context adapter, or a new tool.
license: MIT
compatibility: opencode
---

# Adapter pattern

An adapter wraps an external system behind one of core's interfaces. Core knows nothing
about the external system — only the interface (see `interfaces` skill for exact shapes).

| Type     | Interface         | Wraps                                |
| -------- | ----------------- | ------------------------------------ |
| Provider | `AIProvider`      | LLM SDK (OpenAI, Anthropic)          |
| Memory   | `MemoryAdapter`   | Storage (Redis, Postgres, in-memory) |
| Context  | `ContextProvider` | Dynamic context source (RAG, DB)     |

## Provider adapters

- `id` follows `"{provider}-{model}"` (e.g. `"openai-gpt-4o"`), stable across instances
- `capabilities` accurately reflects what the provider actually supports
- `generateStream()` present only if `capabilities.streaming === true`
- Provider SDK is a `peerDependency`, never a direct dependency
- **Error mapping is the part reviewers check first:** 429 → `ProviderRateLimitError`
  (carry `retryAfterMs`), 401/403 → `ProviderAuthError`, 408 → `ProviderTimeoutError`,
  5xx → `ProviderUnavailableError`, anything else → `ProviderUnavailableError` as the safe
  default. Full rules in the `errors` skill — this is the adapter-specific application of
  the same taxonomy.

## Memory adapters

- `load()` returns `[]` — never throws — for an unknown `sessionId`
- `save()` **appends** the given batch to existing history, never replaces; called once
  per `run()` at `COMPLETING` with `[userMessage, assistantMessage]`
- `clear()` is idempotent — a non-existent `sessionId` silently succeeds
- Storage key always includes `sessionId` — a shared/global key is a cross-session data
  leak (see `security` skill S-4) — and the key namespace should be configurable for
  multi-tenant deployments
- Connectivity failures (store unreachable) throw `ContextLoadError`, not a raw error

## Context providers

- `provide()` takes `ContextProviderInput` (`prompt`/`sessionId`/`metadata` — `stream` and
  `profile` are excluded, they're pipeline-internal routing fields)
- Returns `Promise<SystemMessage[]>` — `[]`, never a throw, when nothing is found
- `input.prompt` may be used for retrieval but **must never** be forwarded verbatim as
  `role: 'system'` content — that's a trust-boundary violation (`security` skill S-2, S-6).
  Use it to query, then return the provider's own retrieved content.
- Content pulled from an untrusted source (web search results, third-party API responses)
  is sanitized before it's mapped to `role: 'system'` — the provider vouches for what it
  returns to the pipeline.
- Distinguish `ContextLoadError` (infrastructure — store unreachable) from
  `ContextProviderError` (business logic — e.g. embedding service returned an unexpected
  shape) — both retryable, but the distinction matters for alerting.

## Tools

- `inputSchema` is specific — an empty `{}` is forbidden (accepts anything, defeats
  validation) — set `additionalProperties: false` and type every field
- `execute()` throws `ToolValidationError` on schema mismatch (fatal, no retry) and
  `ToolExecutionError` on execution failure (retryable)
- HTTP-calling tools implement a URL allowlist — the kernel cannot prevent outbound calls,
  that's the tool author's responsibility (SSRF surface, see `security` skill S-3b)
- Output must be `JSON.stringify`-serializable before it enters the message pipeline

## Package structure

```
packages/provider-{name}/       (or memory-{name}, context-{name}, tool-{name})
├── src/index.ts
├── tests/index.test.ts
├── package.json                 peerDependency on @atisse/core + the SDK
└── tsconfig.json                 extends ../../tsconfig.base.json
```

`package.json` scripts: `typecheck`, `lint`, `test`, `test:watch`, `test:coverage`, `build`.
Application-specific tools don't need packaging — pass them directly to
`OrchestratorConfig.tools`. Only general-purpose, independently-published tools follow the
`@atisse/tool-{name}` package convention above.
