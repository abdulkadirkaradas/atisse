# B12 — Runtime Schema Validation at External Boundaries

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

Create a new internal validation module at `packages/core/src/validation/` with a `validateOrThrow<T>()` utility that wraps Zod `safeParse`. Apply it at all external boundary entry points: tool input (already partially done in `tool-controller.ts`), provider configuration (adapter construction), and orchestrator config validation (some already done in `orchestrator.ts` constructor). The goal is systematic, consistent boundary validation using the existing Zod dependency.

Add a dedicated unit test file `packages/core/tests/unit/validation-schemas.test.ts` covering every schema with valid, invalid, boundary, and default-value cases — so schema behavior (including default application and boundary clamping) is locked down and documented by tests.

**Note:** This plan depends on B1 (pipeline decomposition) being complete first — the boundary definitions are cleaner after the pipeline module split. Also builds on A3 (v1.0.2) which fixed the `z.never()` issue in `jsonSchemaToZod`.

---

## 2. Context (Why This Exists)

Core uses Zod internally (in `tool-controller.ts`) for tool input validation, and `orchestrator.ts` does manual config validation. However:

- Provider adapter constructors receive raw config objects with no Zod validation at the boundary.
- Some config fields pass through without runtime type enforcement.
- Validation is applied inconsistently — some at construction time, some at `run()` entry, some never.

This is a reliability gap. A systematic approach adds a reusable `validateOrThrow` utility and applies it at all external boundaries. This builds on the existing Zod dependency (ADR-009) and the pattern from A3 (v1.0.2) which fixed the `z.never()` issue in `jsonSchemaToZod`.

---

## 3. Issues/Changes

### Issue B12: No Systematic Boundary Validation

| Field       | Value                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/validation/validator.ts` (NEW)                                                                                                                                                    |
| Lines       | N/A — new file                                                                                                                                                                                       |
| Severity    | MEDIUM                                                                                                                                                                                               |
| Description | No shared `validateOrThrow` utility exists. Each boundary implements ad-hoc validation (or none).                                                                                                    |
| Fix         | Create `validateOrThrow<T>(schema: ZodType<T>, data: unknown, errorFactory: (issues) => OrchestratorError): T` that wraps `safeParse`, formats Zod issues into structured error details, and throws. |

| Field       | Value                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/orchestrator.ts`                                                                                                                                 |
| Lines       | 55–80 (constructor validation)                                                                                                                                      |
| Severity    | MEDIUM                                                                                                                                                              |
| Description | Constructor uses manual if-else checks and pushes string messages. No Zod schema validation of the full `OrchestratorConfig` shape.                                 |
| Fix         | Optionally (stretch goal): create a Zod schema for `OrchestratorConfig` and use `validateOrThrow`. At minimum, ensure manual validation uses the new error pattern. |

| Field       | Value                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/policies.ts`                                                                                                       |
| Lines       | 7–24 (default policies)                                                                                                               |
| Severity    | MEDIUM                                                                                                                                |
| Description | Default policy objects are not validated against a Zod schema. Invalid values (e.g., `maxAttempts: -1`) are not caught until runtime. |
| Fix         | Add Zod schemas for `RetryPolicy`, `TimeoutPolicy`, `ToolPolicy`. Apply `validateOrThrow` at config merge points.                     |

| Field       | Value                                                                                                                   |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/tool-controller.ts`                                                                                  |
| Lines       | 87–116 (`validateInput` method)                                                                                         |
| Severity    | LOW                                                                                                                     |
| Description | `validateInput` already uses Zod (`safeParse`). Error construction path could use the new `ValidationErrorDetail` type. |
| Fix         | Update `validateInput` to construct `ValidationErrorDetail[]` instead of `string[]` for `ToolValidationError`.          |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

Create `packages/core/src/validation/validator.ts`:

```typescript
import { z, type ZodType, type ZodIssue } from 'zod';
import type { ValidationErrorDetail } from '../interfaces.js';
import { ConfigValidationError } from '../errors.js';

function validateOrThrow<T>(
  schema: ZodType<T>,
  data: unknown,
  errorFactory: (details: ValidationErrorDetail[]) => OrchestratorError,
): T {
  const result = schema.safeParse(data);
  if (result.success) {
    return result.data;
  }

  const details: ValidationErrorDetail[] = result.error.issues.map((issue: ZodIssue) => ({
    fieldPath: issue.path.join('.'),
    constraint: issue.message,
    received: issue.path.length > 0 ? getNestedValue(data, issue.path) : data,
  }));

  throw errorFactory(details);
}
```

Create `packages/core/src/validation/schemas.ts`:

```typescript
import { z } from 'zod';

export const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(3),
  baseDelayMs: z.number().min(0).default(500),
  maxDelayMs: z.number().min(0).default(30_000),
  jitter: z.boolean().default(true),
  jitterFactor: z.number().min(0).max(1).optional(),
});

export const timeoutPolicySchema = z.object({
  generateTimeoutMs: z.number().min(1).default(30_000),
  toolTimeoutMs: z.number().min(1).default(10_000),
  totalTimeoutMs: z.number().min(1).default(60_000),
});

export const toolPolicySchema = z.object({
  maxToolRounds: z.number().int().min(1).default(5),
  allowParallelTools: z.literal(false).default(false as const),
  toolTimeoutMs: z.number().min(1).default(10_000),
});
```

### 4.2 What NOT to Do

- Do NOT add a new runtime dependency — Zod is already in core.
- Do NOT validate inside adapter packages — validation is core's responsibility.
- Do NOT create a full Zod schema for `OrchestratorConfig` in the first pass — start with policy schemas.
- Do NOT wrap the entire `orchestrator.ts` constructor in Zod validation — manual if-else checks are more readable for business-logic invariants.
- Do NOT remove existing manual validation — Zod validation is additive.

---

## 5. Files to Modify

| File                                                  | Action | Notes                                                               |
| ----------------------------------------------------- | ------ | ------------------------------------------------------------------- |
| `packages/core/src/validation/validator.ts`           | NEW    | `validateOrThrow` utility + helper functions                        |
| `packages/core/src/validation/schemas.ts`             | NEW    | Zod schemas for `RetryPolicy`, `TimeoutPolicy`, `ToolPolicy`        |
| `packages/core/src/validation/index.ts`               | NEW    | Module barrel export                                                |
| `packages/core/tests/unit/validation-schemas.test.ts` | NEW    | Unit tests — every schema with valid/invalid/boundary/default cases |
| `packages/core/src/tool-controller.ts`                | Modify | Update `validateInput` to produce `ValidationErrorDetail[]`         |
| `packages/core/src/orchestrator.ts`                   | Modify | Optionally apply policy Zod schemas at construction time            |

---

## 6. Implementation Strategy

### Step 1: Create `validateOrThrow` utility

Create `packages/core/src/validation/validator.ts` with the `validateOrThrow<T>()` function and the `getNestedValue` helper.

### Step 2: Create policy Zod schemas

Create `packages/core/src/validation/schemas.ts` with Zod schemas for `RetryPolicy`, `TimeoutPolicy`, `ToolPolicy`.

### Step 3: Create barrel export

Create `packages/core/src/validation/index.ts` exporting `validateOrThrow`.

### Step 4: Update `tool-controller.ts`

In the `validateInput` method, change error construction from building `string[]` to building `ValidationErrorDetail[]`.

### Step 5: Apply validation at config boundaries (optional stretch)

In `packages/core/src/orchestrator.ts`, after the existing manual validation, optionally apply policy Zod schemas to their respective config fields. If validation fails, throw `ConfigValidationError` with structured details.

### Step 6: Add schema unit tests

Create `packages/core/tests/unit/validation-schemas.test.ts`. Every schema in `validation/schemas.ts` must be tested with **valid**, **invalid**, **boundary**, and **default** cases:

- `retryPolicySchema`:
  - valid: `{ maxAttempts: 3, baseDelayMs: 500, jitter: true }`
  - invalid: `maxAttempts: 0` (min 1), `baseDelayMs: -1` (min 0)
  - boundary: `maxAttempts: 1`, `jitterFactor: 0` and `jitterFactor: 1` (min/max inclusive)
  - clamp: `jitterFactor: 1.5` → invalid (exceeds `.max(1)`) — verify rejection, never a silent out-of-range value
  - default: `{}` parses to `{ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true }`
- `timeoutPolicySchema`:
  - valid: `{ generateTimeoutMs: 30_000, toolTimeoutMs: 10_000, totalTimeoutMs: 60_000 }`
  - invalid: `generateTimeoutMs: 0` (min 1)
  - boundary: `generateTimeoutMs: 1`
  - default: `{}` parses to the documented defaults
- `toolPolicySchema`:
  - valid: `{ maxToolRounds: 5, allowParallelTools: false }`
  - invalid: `maxToolRounds: 0` (min 1), `allowParallelTools: true` (must be `false` in v1)
  - boundary: `maxToolRounds: 1`
  - default: `{}` parses to `{ maxToolRounds: 5, allowParallelTools: false, toolTimeoutMs: 10_000 }`

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

Specific assertions to verify:

1. `validateOrThrow` returns typed data on success.
2. `validateOrThrow` throws the error from `errorFactory` on validation failure with correct `ValidationErrorDetail[]`.
3. `tool-controller.ts` produces `ValidationErrorDetail[]` when tool input validation fails.
4. Policy schemas correctly validate `maxAttempts: -1` as invalid, `maxToolRounds: 0` as invalid.
5. Every schema is tested with valid/invalid/boundary/default cases in `packages/core/tests/unit/validation-schemas.test.ts`:
   - `maxAttempts: 0` → invalid, `maxAttempts: 1` → valid (boundary)
   - `jitterFactor: 1.5` → invalid (clamped at `.max(1)` boundary — rejected, never silently accepted)
   - `allowParallelTools: true` → invalid, `allowParallelTools: false` → valid
   - Omitted fields resolve to documented defaults (`maxAttempts: 3`, `maxToolRounds: 5`, `jitter: true`)
6. All existing tests pass.

---

## 8. Risk Assessment

| Risk                                                                | Likelihood | Impact | Mitigation                                                                                  |
| ------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------- |
| Adding Zod schemas for policies changes validation behavior         | LOW        | MEDIUM | The schemas use defaults matching existing constants. Valid configs pass through unchanged. |
| `validateOrThrow` adds overhead to hot paths                        | LOW        | LOW    | Called once at construction time or config merge — not in the generation loop.              |
| `getNestedValue` helper may not match Zod path semantics for arrays | LOW        | LOW    | Tool input schemas rarely use arrays. Can be extended to handle numeric indices if needed.  |

---

## 9. References

- `.opencode/skill/errors/SKILL.md` — `ToolValidationError`, `ConfigValidationError`
- `.opencode/skill/interfaces/SKILL.md` — Error Code Registry, Tool Contracts
- `.opencode/skill/interfaces/SKILL.md` — Policy Contracts
- `DECISION-LOG.md` — ADR-009 (Zod for schema validation)
- `.opencode/skill/principles/SKILL.md` — Principle 1 (Explicit Over Magical)
- `packages/core/src/errors.ts` — `ToolValidationError` current implementation
- `packages/core/src/interfaces.ts` — Policy interfaces
- `packages/core/src/tool-controller.ts` — `validateInput` method
- `packages/core/src/orchestrator.ts` — Constructor validation
- `packages/core/src/policies.ts` — Default policies, merge utilities
