---
name: errors
description: Error taxonomy, retry classification, and throw/catch conventions for @atisse/core. Load when adding, throwing, catching, or mapping an OrchestratorError — writing a new error type, an adapter's error mapping, a hook, a tool's failure path, or a catch block in the kernel or user code.
license: MIT
compatibility: opencode
---

# Errors

Full class definitions live in `packages/core/src/errors.ts` — read that file for exact
signatures. This skill covers what the source alone doesn't tell you: retry semantics and
the rules for mapping external failures onto the taxonomy correctly.

## Hierarchy (retryable in parens)

```
OrchestratorError
├── ProviderError    RateLimit(✓) Timeout(✓) Unavailable(✓) AuthFailed(✗) MalformedResponse(✗)
├── ToolError        ExecutionFailed(✓) ValidationFailed(✗) NotFound(✗)
├── ContextError     LoadFailed(✓) ProviderFailed(✓)
├── PolicyError      MaxRetriesExceeded(✗) MaxToolRoundsExceeded(✗) TokenLimitExceeded(✗)
│                    TimeoutExceeded(✗) FallbackExhausted(✗)
└── LifecycleError   InvalidStateTransition(✗) ConfigValidationFailed(✗)
```

`isRetryable(error)` (exported from core) is the only sanctioned way to branch on this —
it returns `false` for anything that isn't an `OrchestratorError`, which is the correct,
safe default for unknown errors.

## The five rules

1. **Never throw plain `Error`.** The kernel's retry/fallback policy engine can only reason
   about `OrchestratorError` subtypes — a plain `Error` is always treated as fatal.
2. **Never catch and swallow.** Let the policy engine decide retry vs. fatal; don't
   pre-empt it in adapter or hook code. Exception: event listeners (see below).
3. **Always pass `cause`.** Wrapping an error without `cause` silently discards the
   original stack trace — this is the most common review rejection in this area.
4. **Type catches as `unknown`, then narrow** with `instanceof`.
5. **Retryable is a property of the error class, not the caller's judgment call.**
   If you're deciding retryability at the call site, you've picked the wrong error class —
   fix that instead of adding a conditional.

## Mapping external errors (adapter authors)

HTTP 429 → `ProviderRateLimitError` (carry `retryAfterMs` from the `Retry-After` header).
HTTP 401/403 → `ProviderAuthError`. HTTP 502/503 → `ProviderUnavailableError`. Network
timeout → `ProviderTimeoutError`. Anything else → `ProviderUnavailableError` as the safe
default, never a bare rethrow.

## Two things that aren't in the source

- **Event listeners must never throw.** A listener exception must not affect the kernel —
  wrap listener bodies in their own try/catch that silently discards (this is the one
  sanctioned "catch and swallow").
- **Error messages are user/log-facing surface area.** State what happened with relevant
  IDs (`toolName`, `sessionId`, attempt count) — never a file path, line number, secret, or
  raw HTTP body. This is a security boundary, not a style preference; see the `security`
  skill for the fuller rule (no secrets in logs, errors, or events).

## Adding a new error type

Add the code to `OrchestratorErrorCode` in `interfaces.ts` (MINOR — union widening) →
add the class in `errors.ts`, extending the right branch of the hierarchy above → confirm
retryability against the five rules → never a plain `Error` throw anywhere in the diff.
