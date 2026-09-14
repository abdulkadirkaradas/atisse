---
name: security
description: Trust boundaries, threat model, and the S-1 through S-8 security constraints for @atisse/core. Load for any change with a security dimension — secrets, message roles, tools, memory isolation, context providers, error exposure, or dependencies — and always before approving a PR.
license: MIT
compatibility: opencode
---

# Security

Protected: changes here require SPSA evaluation + explicit user approval (see
`handoff-protocol` for how that routes).

The kernel sits between user code and external systems. It **defines and enforces** trust
boundaries; it does not make security policy decisions (content moderation, authz,
sandboxing) — those stay the user's/adapter's responsibility.

```
[UNTRUSTED user prompt] → run() config validation
   ├─► ContextProvider.provide()  — output message limit
   ├─► MemoryAdapter.load()       — session isolation
   ├─► AIProvider.generate()      — timeout, token limit
   └─► Tool.execute()             — schema validation, round limit
```

## S-1 — Secret hygiene

Never in logs, errors, or events: API keys, tokens, hashes, passwords, connection strings.
Error messages describe _what_ went wrong, never _which value_ caused it.
`AIProvider.id` (e.g. `"openai-gpt-4o"`) is configuration metadata, not a secret — safe to
log.

## S-2 — Message role integrity (critical)

`run.input.prompt` is always `role: 'user'`. User input is never `role: 'system'` —
reject any code path that maps external input to system role, no exceptions.
`role: 'system'` is reserved for hardcoded hook instructions, `ContextProvider` output, and
`OrchestratorProfile.systemPrompt`.

**S-2a — profile factory contamination:** factory function parameters must be initialized
adapter instances or developer-controlled config, never a value (even via string
interpolation) derived from `run.input` or an external request.

## S-3 — Tool execution

Highest-risk surface — tools call external systems.

- **S-3a** (kernel-enforced): Zod schema validation runs before `execute()`; empty
  `inputSchema: {}` is forbidden; a validation failure is fatal, no retry.
- **S-3b** (adapter responsibility): any HTTP-calling tool must validate the target origin
  against an allowlist — the kernel cannot prevent outbound calls from tool code.
- **S-3c**: tool output must be `JSON.stringify`-serializable before it enters the message
  pipeline.

## S-4 — Cross-session memory isolation

`MemoryAdapter` implementations must guarantee session A's data never appears in session
B's `load()` — storage keys must be session-scoped (`session:${sessionId}:messages`, never
a shared key). The kernel checks the return _type_, not isolation — that's the adapter
author's job (see `adapter-pattern`).

## S-5 — ContextProvider output limits

Kernel-internal defaults (`maxMessagesPerProvider: 50`, `maxContentLengthChars: 50_000`),
**not user-configurable in v1** — protects against a malformed/malicious provider
exhausting the token budget. Over the limit: kernel logs a warning and truncates, doesn't
throw.

## S-6 — ContextProvider input scope

`provide()` receives `prompt`/`sessionId`/`metadata` (not `stream`/`profile`) and may read
any of them for retrieval. `input.prompt` must never be forwarded into `role: 'system'`
output — that's an S-2 violation via a different path. Return the provider's own content
(`doc.text`), not the echoed prompt.

## S-7 — Code execution & error exposure

No `eval()`, `new Function()`, or `vm.runInNewContext()` anywhere — no legitimate use case
requires it. Error messages visible to callers describe the problem in user-facing terms —
never a file path, line number, retry count, or other internal detail.

## S-8 — Dependency security

`pnpm audit --audit-level=high` clean on every PR (HIGH/CRITICAL blocks merge); fully clean
before release. New dependencies need PR-description justification. `@atisse/core` runtime
deps: zero except Zod — anything else needs an architecture discussion first.

## PR security checklist

No secrets in logs/errors (S-1) · `run.input.prompt` never → `role:'system'` (S-2) ·
profile factory args are adapter instances only (S-2a) · new tools have a specific
`inputSchema`, never `{}` (S-3a) · HTTP tools implement an allowlist (S-3b) · new
`MemoryAdapter` uses session-scoped keys (S-4) · `contextPolicy` limits not bypassed (S-5) ·
`ContextProvider` doesn't echo `input.prompt` as system content (S-6) · no dynamic code
execution (S-7) · errors carry no internal detail (S-7) · `pnpm audit` HIGH+ clean (S-8).

## Reporting vulnerabilities

Never via GitHub Issues — private disclosure only (contact to be defined before public
launch).
