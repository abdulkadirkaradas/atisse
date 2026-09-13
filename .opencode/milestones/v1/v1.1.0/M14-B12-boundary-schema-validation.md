# B12 — Runtime Schema Validation at External Boundaries

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

Create a new internal validation module at `packages/core/src/validation/` with a `validateOrThrow<T>()` utility that wraps Zod `safeParse`. Apply it at all external boundary entry points: tool input (already partially done in `tool-controller.ts`), provider configuration (adapter construction), and orchestrator config validation (some already done in `orchestrator.ts` constructor). The goal is systematic, consistent boundary validation using the existing Zod dependency.

Add a dedicated unit test file `packages/core/tests/unit/validation-schemas.test.ts` covering every schema with valid, invalid, boundary, and default-value cases — so schema behavior (including default application and boundary clamping) is locked down and documented by tests.

**Note:** This plan depends on B1 (pipeline decomposition) being complete first — the boundary definitions are cleaner after the pipeline module split. Also builds on A3 (v1.0.2), which addressed silent under-validation in `jsonSchemaToZod` (unsupported keywords in the minimal throw set now raise `ToolDefinitionError`; `z.never()` is retained as defense-in-depth). Phase 2 (converter capability — see §4.1) is NOT gated on B1 and may be sequenced independently of the B1A–B1E pipeline work.

---

## 2. Context (Why This Exists)

Core uses Zod internally (in `tool-controller.ts`) for tool input validation, and `orchestrator.ts` does manual config validation. However:

- Provider adapter constructors receive raw config objects with no Zod validation at the boundary.
- Some config fields pass through without runtime type enforcement.
- Validation is applied inconsistently — some at construction time, some at `run()` entry, some never.

This is a reliability gap. A systematic approach adds a reusable `validateOrThrow` utility and applies it at all external boundaries. This builds on the existing Zod dependency (ADR-009) and the pattern from A3 (v1.0.2), which introduced explicit `ToolDefinitionError` for unsupported keywords in `jsonSchemaToZod`.

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

| Field       | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/orchestrator.ts`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Lines       | 55–139 (constructor validation)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Severity    | MEDIUM                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Description | Constructor uses manual if-else checks and pushes string messages. No Zod schema validation of the full `OrchestratorConfig` shape.                                                                                                                                                                                                                                                                                                                        |
| Fix         | Do NOT wrap entire constructor in Zod. Single canonical validation point is construction-time at `orchestrator.ts:55-139` constructor for base + profile partial policies via `retryPolicySchema` etc.; `profile.ts:80-185` `resolveConfig` merge is only spread + `toolTimeoutMs` mirror (ADR-035), no re-validation. No validation at `run()` for profile retry/timeout/toolPolicy overrides (already validated at construction via profiles). See §4.2. |

| Field       | Value                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/policies.ts`                                                                                                       |
| Lines       | 7–24 (default policies)                                                                                                               |
| Severity    | MEDIUM                                                                                                                                |
| Description | Default policy objects are not validated against a Zod schema. Invalid values (e.g., `maxAttempts: -1`) are not caught until runtime. |
| Fix         | Add Zod schemas for `RetryPolicy`, `TimeoutPolicy`, `ToolPolicy`. Apply `validateOrThrow` at config merge points.                     |

| Field       | Value                                                                                                                                                                                         |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/tool-controller.ts`                                                                                                                                                        |
| Lines       | 87–116 (`validateInput` method)                                                                                                                                                               |
| Severity    | LOW                                                                                                                                                                                           |
| Description | `validateInput` already uses Zod (`safeParse`). Error construction path could use the new `ValidationErrorDetail` type.                                                                       |
| Fix         | Update `validateInput` to construct `ValidationErrorDetail[]` instead of `string[]` for `ToolValidationError`. Config path (`ConfigValidationError`) keeps `string[]` via mapping — see §4.1. |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

Create `packages/core/src/validation/validator.ts`:

```typescript
import { z, type ZodType, type ZodIssue } from 'zod';
import type { ValidationErrorDetail } from '../interfaces.js';
import type { OrchestratorError } from '../errors.js';

function getNestedValue(data: unknown, path: (string | number)[]): unknown {
  let cur: unknown = data;
  for (const seg of path) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

export function validateOrThrow<T>(
  schema: ZodType<T>,
  data: unknown,
  errorFactory: (details: ValidationErrorDetail[]) => OrchestratorError,
): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const details: ValidationErrorDetail[] = result.error.issues.map((issue: ZodIssue) => ({
    fieldPath: issue.path.join('.'),
    constraint: issue.message,
    received: issue.path.length > 0 ? getNestedValue(data, issue.path) : data,
  }));
  throw errorFactory(details);
}
```

> **Note (S-1):** `received` is never written to logger/event payload — `errorFactory` maps `details → string[]` for the config path (see below).

Error-factory mapping per boundary:

- **Tool input path** (`tool-controller.ts:validateInput`): `validateOrThrow` → `new ToolValidationError(details)` where `ToolValidationError` carries `ValidationErrorDetail[]` (M03-B5 prerequisite).
- **Config/policy path** (`orchestrator.ts:55-139`): `validateOrThrow` config path maps details → `string[]` via `details.map(d=>`${d.fieldPath}: ${d.constraint}`)` and throws `new ConfigValidationError(strings)` (`errors.ts:274-281` only carries `string[]`; `M03-B5:49` keeps `ToolValidationError` outside scope; `ConfigValidationError` does not yet carry `ValidationErrorDetail`, separate issue if needed).

Create `packages/core/src/validation/schemas.ts`:

```typescript
import { z } from 'zod';

export const retryPolicySchema = z
  .object({
    maxAttempts: z.number().int().finite().min(1).default(3),
    baseDelayMs: z.number().finite().min(0).default(500),
    maxDelayMs: z.number().finite().min(0).default(30_000),
    jitter: z.boolean().default(true),
    jitterFactor: z.number().finite().min(0).max(1).optional(),
  })
  .strict();

export const timeoutPolicySchema = z
  .object({
    generateTimeoutMs: z.number().finite().min(1).default(30_000),
    toolTimeoutMs: z.number().finite().min(1).default(10_000),
    totalTimeoutMs: z.number().finite().min(1).default(60_000),
  })
  .strict();

export const toolPolicySchema = z
  .object({
    maxToolRounds: z.number().int().finite().min(1).default(5),
    allowParallelTools: z.literal(false).default(false),
    toolTimeoutMs: z.number().finite().min(1).default(10_000),
  })
  .strict();
```

> **DRY / defaults:** `jitterFactor` added per `interfaces.ts:220-229`, `policies.ts:7-12`, `M02-B8:102-135` (no `.default`, `DEFAULT_RETRY` is single source per DRY). All numeric fields use `.finite()` — `z.number()` alone does not reject `Infinity`/`NaN` (see §8). All policy schemas are `.strict()` to catch typos like `maxAttepmts` → `ConfigValidationError`. Defaults via `.default()` must stay in sync with `DEFAULT_*` in `policies.ts:7-24`; add cross-check assertion in `validation-schemas.test.ts`: `expect(retryPolicySchema.parse({})).toEqual(DEFAULT_RETRY)` style (see §7).
>
> **TSDoc for `allowParallelTools`:** validated by Zod, rejects `true` (v1 `false` only).

### Phase 2 — Converter Capability — M14-B12-Phase2 (optional, not gated on B1) — separate changeset; do not start Phase 2 before Phase 1 merged

Implement runtime SUPPORT (conversion, not rejection) in `jsonSchemaToZod` for the extended keyword set:

- `pattern`
- `multipleOf`
- `minProperties` / `maxProperties`
- `uniqueItems`
- `if` / `then` / `else`
- `not`
- `contains`
- `propertyNames`
- `prefixItems`

Each keyword is converted (supported), never silently dropped, and covered by valid/invalid/boundary tests.

This consumes P02-A3's `checkUnsupportedKeywords` groundwork: these keywords move from 'silently dropped' straight to 'supported' — they were never added to P02's throw list, so no rejection behavior is removed or reverted.

**Optional future candidates** (rejected in v1.0.2, promoted in a later version if supported): the `additionalProperties` schema form and `type` arrays (nullable unions).

**Sequencing:** M03-B5 (`ValidationErrorDetail`) must land before this plan's Step 4 (`validateInput` → `ValidationErrorDetail[]`).

> **Handoff note — Phase 2 (converter capability — NOT gated on B1, may be sequenced independently of the B1A–B1E pipeline work):** implement runtime support in `jsonSchemaToZod` for `pattern`, `multipleOf`, `minProperties`/`maxProperties`, `uniqueItems`, `if`/`then`/`else`, `not`, `contains`, `propertyNames`, `prefixItems`. Each keyword is converted (supported), never silently dropped, and covered by valid/invalid/boundary tests. Consumes P02-A3's `checkUnsupportedKeywords` groundwork: keywords move from 'silently dropped' straight to 'supported' — they were never added to P02's throw list. Sequencing: M03-B5 (`ValidationErrorDetail`) must land before this plan's Step 4 (`validateInput` → `ValidationErrorDetail[]`). **Phase 2 files are labeled separately in §5 (Phase 2 rows).**

### 4.2 What NOT to Do

- Do NOT add a new runtime dependency — Zod is already in core (ADR-009 single runtime dep).
- Do NOT validate inside adapter packages — validation is core's responsibility (ADR-030 layering).
- Do NOT wrap entire `OrchestratorConfig` in a single Zod schema. Single canonical validation point is construction-time at `orchestrator.ts:55-139` constructor for base + profile partial policies via `retryPolicySchema` etc.; `profile.ts:80-185` `resolveConfig` merge is only spread + `toolTimeoutMs` mirror (ADR-035), no re-validation. No validation at `run()` for profile retry/timeout/toolPolicy overrides (already validated at construction via profiles).
- Do NOT remove existing manual validation — Zod validation is additive; manual checks remain for business-logic invariants not expressible as schema.
- Do NOT re-validate at `run()` for profile overrides — already validated at construction.

**Scope of B12:** policy schemas + tool `inputSchema` via `validateOrThrow`; `RunInput.prompt` empty/whitespace and `OrchestratorConfig.provider` null are already manual checks in `orchestrator.ts:55-80`, out-of-scope for Zod in this milestone.

---

## 5. Files to Modify

| File                                                  | Action           | Notes                                                                                                                                                                                                             |
| ----------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/validation/validator.ts`           | NEW              | `validateOrThrow` utility + `getNestedValue` helper                                                                                                                                                               |
| `packages/core/src/validation/schemas.ts`             | NEW              | Zod schemas for `RetryPolicy`, `TimeoutPolicy`, `ToolPolicy` (all `.strict()` + `.finite()` guards)                                                                                                               |
| `packages/core/src/validation/index.ts`               | NEW              | Module barrel export — `export * from './schemas.js'` and `export { validateOrThrow }` from `validator.ts` (+ re-export `getNestedValue` if needed for tests)                                                     |
| `packages/core/tests/unit/validation-schemas.test.ts` | NEW              | Unit tests — every schema with valid/invalid/boundary/default cases; choice of `validation-schemas.test.ts` (schema-focused) vs `tool-controller-converter.test.ts` (converter-focused Phase 2) — see §6 Phase 2  |
| `packages/core/src/tool-controller.ts`                | Modify           | Update `validateInput` to produce `ValidationErrorDetail[]`                                                                                                                                                       |
| `packages/core/src/tool-controller.ts`                | Modify (Phase 2) | Extend `jsonSchemaToZod` conversion for the extended keyword set (`pattern`, `multipleOf`, `minProperties`/`maxProperties`, `uniqueItems`, `if`/`then`/`else`, `not`, `contains`, `propertyNames`, `prefixItems`) |
| `packages/core/tests/unit/validation-schemas.test.ts` | Modify (Phase 2) | Add valid/invalid/boundary keyword-conversion tests (or a dedicated converter test file)                                                                                                                          |
| `packages/core/src/orchestrator.ts`                   | Modify           | Apply policy Zod schemas at construction time via `validateOrThrow` with `ConfigValidationError` string mapping                                                                                                   |
| `.changeset/<id>.md`                                  | NEW              | PATCH: strict boundary schema validation (policies) — fixing behavior violating contract → not breaking per `api-design` skill                                                                                    |
| `.changeset/<id>-phase2.md`                           | NEW (Phase 2)    | PATCH: jsonSchemaToZod extended keywords — separate changeset for M14-B12-Phase2                                                                                                                                  |

---

## 6. Implementation Strategy

### Step 1: Create `validateOrThrow` utility

Create `packages/core/src/validation/validator.ts` with the `validateOrThrow<T>()` function and the `getNestedValue` helper (see §4.1 full snippet). `getNestedValue` handles `issue.path: (string|number)[]` including numeric indices (e.g., `{ arr: [{x:1}] }` path `['arr',0,'x']` → `1`). Import `ValidationErrorDetail` as `import type { ValidationErrorDetail } from '../interfaces.js'` — L0→L0 per ADR-030 (no layering violation).

### Step 2: Create policy Zod schemas

Create `packages/core/src/validation/schemas.ts` with Zod schemas for `RetryPolicy`, `TimeoutPolicy`, `ToolPolicy` as in §4.1 (with `.finite()`, `.strict()`, `jitterFactor` optional).

### Step 3: Create barrel export

Create `packages/core/src/validation/index.ts` exporting `validateOrThrow` and schemas:

```typescript
export * from './schemas.js';
export { validateOrThrow } from './validator.js';
```

### Step 4: Update `tool-controller.ts`

In the `validateInput` method, change error construction from building `string[]` to building `ValidationErrorDetail[]` via `validateOrThrow` → `ToolValidationError(details)`.

### Step 5: Apply validation at config boundaries

In `packages/core/src/orchestrator.ts:55-139`, after the existing manual validation, apply policy Zod schemas to their respective config fields via `validateOrThrow`. If validation fails, map `ValidationErrorDetail[]` → `string[]` via `details.map(d=>`${d.fieldPath}: ${d.constraint}`)` and throw `new ConfigValidationError(strings)` (`errors.ts:274-281` only carries `string[]`; `M03-B5:49` keeps `ToolValidationError` outside scope; `ConfigValidationError` does not yet carry `ValidationErrorDetail`, separate issue if needed). This is the sole canonical validation point for retry/timeout/toolPolicy — `profile.ts:80-185` `resolveConfig` merge does not re-validate.

### Step 6: Add schema unit tests

Create `packages/core/tests/unit/validation-schemas.test.ts`. Every schema in `validation/schemas.ts` must be tested with **valid**, **invalid**, **boundary**, and **default** cases:

- `retryPolicySchema`:
  - valid: `{ maxAttempts: 3, baseDelayMs: 500, jitter: true }`
  - invalid: `maxAttempts: 0` (min 1), `baseDelayMs: -1` (min 0)
  - boundary: `maxAttempts: 1`, `jitterFactor: 0` and `jitterFactor: 1` (min/max inclusive)
  - clamp: `jitterFactor: 1.5` → invalid (exceeds `.max(1)`) — verify rejection, never a silent out-of-range value
  - default: `{}` parses to `{ maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true }`
  - drift cross-check: `expect(retryPolicySchema.parse({})).toEqual(DEFAULT_RETRY)` etc. (see §7)
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

Also see §7 for additional required assertions (jitterFactor finite, strict unknown key, S-1, getNestedValue array index).

### Phase 2 Steps — Converter Capability — M14-B12-Phase2 (NOT gated on B1) — separate changeset; do not start Phase 2 before Phase 1 merged

1. Extend the `jsonSchemaToZod` conversion in `packages/core/src/tool-controller.ts` to support each extended keyword (`pattern`, `multipleOf`, `minProperties`/`maxProperties`, `uniqueItems`, `if`/`then`/`else`, `not`, `contains`, `propertyNames`, `prefixItems`) — conversion, never silent drop.
2. Add keyword tests to `packages/core/tests/unit/validation-schemas.test.ts` (or a dedicated converter test file) — valid, invalid, and boundary cases per keyword.
3. Verify: `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`.

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
7. **jitterFactor finite guard (construction-time):** `jitterFactor: -0.1` → `ConfigValidationError`, `jitterFactor: 1.5` → `ConfigValidationError`, `jitterFactor: NaN` → `ConfigValidationError`, `jitterFactor: Infinity` → `ConfigValidationError` (all at `orchestrator.ts:55-139` construction-time via `retryPolicySchema`).
8. **strict() typo catch:** unknown key e.g. `{ maxAttepmts: 3 }` → `ConfigValidationError` (strict).
9. **S-1 received not leaked:** spy on `logger.warn` and inspect `EventErrorPayload` — neither contains `received` field; `received` stays in `ValidationErrorDetail` memory only, `errorFactory` for config path maps to `string[]`.
10. _*DEFAULT_* drift cross-check:_* `expect(retryPolicySchema.parse({})).toEqual(DEFAULT_RETRY)` style assertion for each policy schema; `expect(timeoutPolicySchema.parse({})).toEqual(DEFAULT_TIMEOUT)`; `expect(toolPolicySchema.parse({})).toEqual(DEFAULT_TOOL_POLICY)` — ensures schema `.default()` values never drift from `policies.ts:7-24` single source.
11. **getNestedValue array index semantics:** `getNestedValue({ arr: [{x:1}] }, ['arr', 0, 'x'])` → `1`; `issue.path` numeric segments handled; test with `retryPolicy`-irrelevant nested structure to isolate helper.

---

## 8. Risk Assessment

| Risk                                                                | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adding Zod schemas for policies changes validation behavior         | LOW        | MEDIUM | The schemas use defaults matching existing constants. Valid configs pass through unchanged.                                                                                                                                                   |
| `validateOrThrow` adds overhead to hot paths                        | LOW        | LOW    | Called once at construction time or config merge — not in the generation loop.                                                                                                                                                                |
| `getNestedValue` helper may not match Zod path semantics for arrays | LOW        | LOW    | Tool input schemas rarely use arrays. Can be extended to handle numeric indices if needed.                                                                                                                                                    |
| Schema defaults drift vs `DEFAULT_*` in `policies.ts:7-24`          | LOW        | MEDIUM | Cross-check test: `expect(schema.parse({})).toEqual(DEFAULT_*)` — fails fast on drift. Keep `DEFAULT_*` as single source; schema `.default()` mirrors it.                                                                                     |
| `ConfigValidationError` string vs `ValidationErrorDetail` mismatch  | MEDIUM     | LOW    | `errorFactory` maps `details → string[]` via `details.map(d=>`${d.fieldPath}: ${d.constraint}`)`; `ConfigValidationError` stays `string[]` per `errors.ts:274-281`. If detail-carrying config errors are needed later, open a separate issue. |
| `z.number()` without `.finite()` silently accepts `Infinity`/`NaN`  | LOW        | MEDIUM | All numeric fields now use `.finite()` — verified by `NaN`/`Infinity` → `ConfigValidationError` tests.                                                                                                                                        |
| `strict()` typo catch missed                                        | LOW        | LOW    | All policy schemas are `.strict()`; test unknown key → `ConfigValidationError`.                                                                                                                                                               |

---

## 9. References

- `.opencode/skill/errors/SKILL.md` — `ToolValidationError`, `ConfigValidationError`
- `.opencode/skill/interfaces/SKILL.md` — Error Code Registry, Tool Contracts, Policy Contracts
- `DECISION-LOG.md` — ADR-009 (Zod for schema validation)
- `DECISION-LOG.md` — ADR-022 (union widening is MINOR), ADR-036 (`z.never()` defense-in-depth)
- `DECISION-LOG.md` — ADR-030 (layering), ADR-035 (toolTimeoutMs mirror)
- `P02-A3-json-schema-converter-fix.md` (v1.0.2) — `checkUnsupportedKeywords` groundwork; minimal v1.0.2 throw set
- `M03-B5-structured-validation-errors.md` — `ValidationErrorDetail` prerequisite for Step 4
- `.opencode/skill/principles/SKILL.md` — Principle 1 (Explicit Over Magical)
- `packages/core/src/errors.ts` — `ToolValidationError` current implementation (`errors.ts:274-281`)
- `packages/core/src/interfaces.ts` — Policy interfaces (`interfaces.ts:220-229`)
- `packages/core/src/tool-controller.ts` — `validateInput` method
- `packages/core/src/orchestrator.ts` — Constructor validation (`orchestrator.ts:55-139`)
- `packages/core/src/policies.ts` — Default policies, merge utilities (`policies.ts:7-24`)
- `M02-B8-jitterFactor` — `jitterFactor: 102-135` reference for `retryPolicySchema`
