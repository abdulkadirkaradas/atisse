---
name: code-standards
description: Day-to-day coding rules for @atisse/core — defensive programming, complexity/size limits, async/concurrency safety, and TypeScript conventions (naming, tsconfig, ESLint, Prettier). Load when writing any implementation code.
license: MIT
compatibility: opencode
---

# Code standards

## Defensive programming

Validate at the boundary (`run()` entry, adapter returns, tool input/output); trust
nothing crossing it.

- **Guard clauses fail at the top**, not buried mid-function — reject invalid state before
  calling into anything else.
- **Config validates in the constructor**, not at first `run()` — `new Orchestrator(bad
config)` throws `ConfigValidationError` immediately, it never waits for the first call.
- **Trust nothing from adapters** — an adapter can be third-party code; check its return
  shape (`Array.isArray(raw) ? raw : []`), don't assume it honored the contract.
- Internal functions that require a specific state assert it explicitly
  (`stateMachine.assertNotTerminal()` before `transition()`).

## Complexity & size limits

| Unit                             | Limit     | If exceeded                    |
| -------------------------------- | --------- | ------------------------------ |
| Cyclomatic complexity / function | 7         | extract named helper functions |
| Nesting depth                    | 3         | early return or extract        |
| Function body                    | 40 lines  | extract a helper               |
| Class                            | 200 lines | split by responsibility        |
| Public methods / class           | 7         | reconsider responsibilities    |
| Parameters / function            | 3         | use an options object          |

Early return + extraction beats nested conditionals every time — prefer
`if (!hasSession) return []` over wrapping the rest of the function in an `if`.

## Concurrency & the stateless contract

Node is single-threaded; "concurrency" here means multiple `run()` calls on the same
`Orchestrator` instance, not threads.

- `run()` never reads or writes instance-level mutable state — no `private activeRunId`,
  no `private currentMessages`. Everything is a local variable scoped to the call.
- Config/tools/policies are set once at construction and never mutated — concurrent reads
  of them are safe.
- Event listeners must not block: fire-and-forget (`db.save(e).catch(...)`), never
  `await` inside a listener.
- No shared mutable collections on the instance (`private toolResults: ToolResult[] = []`
  is forbidden) — always local to the call.

## Code quality

- Functions: ≤40 lines, ≤3 params (else an options object), one verb-named responsibility.
- Classes: ≤200 lines, ≤7 public methods, constructor does validation/assignment only —
  no business logic.
- Naming: intention-revealing (`retryableError` not `err2`), no cryptic abbreviations
  (`sessionId` fine, `sid` not), booleans prefixed `is/has/should`, collections plural.
- Immutability: `const` over `let`, never `var`; never mutate parameters — return new
  objects; `readonly` on interface fields that shouldn't be mutated externally.
- Async: always `async/await`, never `.then()/.catch()` chains; `Promise.all()` only for
  genuinely independent operations (context-loading and memory-loading are sequential by
  design — not candidates).
- Never catch and ignore silently; catch only what you intend to handle — see `errors`.
- One responsibility per file; public API exported from `index.ts` only; no circular
  imports (ESLint-enforced).

## TypeScript conventions

`tsconfig.base.json` (root, all packages extend it): `strict: true`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`,
`noUnusedLocals/Parameters`, target ES2022, NodeNext modules.

- `interface` for object shapes; `type` for unions/primitives/computed types.
- `import type` for type-only imports (enables type erasure) — plain `import` only when
  the value is needed at runtime.
- Never `any` — use `unknown` and narrow, or generics.
- `readonly` on fields / `ReadonlyArray` on collections that shouldn't mutate externally.

| Element                  | Convention           | Example                               |
| ------------------------ | -------------------- | ------------------------------------- |
| Class / Interface / Type | PascalCase           | `LifecycleStateMachine`, `AIProvider` |
| Function / method        | camelCase verb       | `executeWithRetry()`, `.generate()`   |
| Variable                 | camelCase noun       | `retryPolicy`                         |
| Constant                 | SCREAMING_SNAKE      | `VALID_TRANSITIONS`                   |
| File                     | kebab-case           | `mock-provider.ts`                    |
| Boolean                  | is/has/should prefix | `isRetryable`                         |

Import order (ESLint-enforced): node built-ins → external packages (type-only preferred) →
internal contracts (`interfaces.ts`, `errors.ts`) → same-layer internal → relative imports.

ESLint: `no-explicit-any`, `no-non-null-assertion`, `consistent-type-imports`,
`no-floating-promises`, `no-misused-promises` all `error`; `no-console` `warn`.
Prettier: single quotes, trailing commas, 100-char width, 2-space tabs.
