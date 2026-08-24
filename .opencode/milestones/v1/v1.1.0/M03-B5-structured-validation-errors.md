# B5 — Structured ToolValidationError Details

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

Add a `ValidationErrorDetail[]` type and a `details` field to `ToolValidationError`. Keep the existing `validationErrors: string[]` as a deprecated computed getter that derives its value from the structured `details` array. This is NOT a breaking change — the public API surface grows but nothing is removed.

**Scope:** `ToolValidationError` only — `ConfigValidationError` (`errors.ts:274-281`) remains `string[]` and is NOT modified here (out of scope). Title and content are intentionally scoped to `ToolValidationError`; `ConfigValidationError` details, if needed, will be tracked as a separate issue.

M14-B12-boundary-schema-validation.md:264-270 requires M03-B5 before Step 4 — this plan satisfies that ordering.

---

## 2. Context (Why This Exists)

`ToolValidationError` currently carries `validationErrors: string[]` — an array of human-readable strings. Callers that need to know _which_ field failed and _why_ must string-parse these messages. For example, `"query: Required"` has to be split on `:` to extract `fieldPath: 'query'` and `constraint: 'Required'`. This violates Principle 1 (Explicit Over Magical) — structured data is replaced by encoded strings.

Adding a parallel `details: ValidationErrorDetail[]` array with explicit `fieldPath`, `constraint`, and `received` fields makes the error self-describing. The old `validationErrors` property is kept as a deprecated getter that computes strings from the structured data, ensuring no existing consumer breaks.

M14-B12-boundary-schema-validation.md:264-270 requires M03-B5 before Step 4 — this plan satisfies that ordering (see also §1).

---

## 3. Issues/Changes

### Issue B5: `validationErrors` Is Too Primitive

| Field       | Value                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts`                                                                                |
| Lines       | N/A — new interface needed                                                                                       |
| Severity    | LOW                                                                                                              |
| Description | No `ValidationErrorDetail` type exists. Consumers cannot programmatically inspect which field failed validation. |
| Fix         | Add `ValidationErrorDetail` interface with `fieldPath`, `constraint`, `received`.                                |

| Field       | Value                                                                                                                                                                                                                               |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/errors.ts`                                                                                                                                                                                                       |
| Lines       | 111–121 (`ToolValidationError` class)                                                                                                                                                                                               |
| Severity    | LOW                                                                                                                                                                                                                                 |
| Description | `ToolValidationError` stores `validationErrors: string[]` as a constructor parameter and exposes it directly.                                                                                                                       |
| Fix         | Add `details: ValidationErrorDetail[]` field. Make `validationErrors` a getter that computes from `details`. Add a constructor overload accepting `ValidationErrorDetail[]` but maintaining backward compatibility with `string[]`. |

**Out-of-scope note:** `ConfigValidationError` at `errors.ts:274-281` is explicitly NOT changed in this milestone. If structured details are later needed there, file a separate issue — do not expand scope here.

---

## 4. Architectural Directives

### 4.1 Chosen Approach

Add to `packages/core/src/interfaces.ts`:

```typescript
export interface ValidationErrorDetail {
  readonly fieldPath: string;
  readonly constraint: string;
  /** Raw value that failed validation — NEVER log or emit in events (S-1). Inspect only in catch block. */
  readonly received: unknown;
}
```

Update `ToolValidationError` in `errors.ts`:

```typescript
export class ToolValidationError extends OrchestratorError {
  readonly code = 'TOOL_VALIDATION_FAILED' as const;
  readonly retryable = false;

  public readonly details: ValidationErrorDetail[];

  constructor(
    public readonly toolName: string,
    validationErrors: string[] | ValidationErrorDetail[],
  ) {
    super(`Tool input validation failed: ${toolName}`);

    const isDetailArray =
      validationErrors.length > 0 &&
      validationErrors.every(
        (v): v is ValidationErrorDetail =>
          typeof v === 'object' && v !== null && 'fieldPath' in v && 'constraint' in v,
      );
    if (isDetailArray) {
      this.details = validationErrors as ValidationErrorDetail[];
    } else {
      this.details = (validationErrors as string[]).map((msg) => {
        const [fieldPath = '', constraint = msg] = msg.includes(':')
          ? msg.split(':').map((s) => s.trim())
          : ['', msg];
        return { fieldPath, constraint, received: undefined };
      });
    }
  }

  /** @deprecated Use `details` — structured replacement for string parsing. */
  get validationErrors(): string[] {
    return this.details.map((d) => `${d.fieldPath ? d.fieldPath + ': ' : ''}${d.constraint}`);
  }
}
```

> **Note on the duplicated accessor above:** The authoritative shape is:
>
> ```typescript
> /** @deprecated Use `details` — structured replacement for string parsing. */
> get validationErrors(): string[];
> readonly details: ValidationErrorDetail[];
> ```
>
> `validationErrors` is a prototype accessor, not an own property — `hasOwnProperty`/`Object.keys`/`JSON.stringify`/`structuredClone` will not include it by default. This is a MINOR behavioral note, not transparent. See §7/§8 for regression tests.

**Constructor guard rationale:** The previous `typeof validationErrors[0] === 'object'` accessed `validationErrors[0]` unchecked (violates `noUncheckedIndexedAccess`) and is fragile for empty arrays. The robust guard above uses `validationErrors.every(...)` with a type predicate; empty array yields `[]` for both branches but guard is now explicit and type-safe (no direct index access). Single source of truth remains `tool-controller` producing `ValidationErrorDetail[]` — the string-parse fallback in `errors.ts` is only for backward compat.

**Layering / import clarification:** `errors.ts:1` already `import type {LifecycleState,OrchestratorErrorCode}` — new import must be `import type {ValidationErrorDetail} from './interfaces.js'` (type-only, no runtime), permitted L0→L0 per ADR-030.

### 4.2 What NOT to Do

- Do NOT change `ToolValidationError` constructor signature in a way that breaks existing consumers. The union type `string[] | ValidationErrorDetail[]` is additive.
- Do NOT remove `validationErrors: string[]` — mark it `@deprecated` with a getter, but keep the property accessible.
- Do NOT change the `code` or `retryable` properties of `ToolValidationError`.
- Do NOT log `details[].received` via logger.warn/error, and do NOT include it in `EventErrorPayload`/`ToolResultError` event bus payloads — S-1 secret risk. Only inspect in consumer catch block. (received must never appear in logger/event output — S-1)

---

## 5. Files to Modify

> **Hard Stop:** Edit to `interfaces.ts` (protected, FROZEN) — requires SPSA review + user approval per handoff-protocol; no bash bypass. Changeset MINOR per api-design (adding optional field/type).

| File                                   | Action | Notes                                                                                                                                                                                       |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`      | Modify | Add `ValidationErrorDetail` interface                                                                                                                                                       |
| `packages/core/src/errors.ts`          | Modify | Update `ToolValidationError` with `details` field and backward-compatible `validationErrors` getter                                                                                         |
| `packages/core/src/tool-controller.ts` | Modify | validateInput: map Zod issues → ValidationErrorDetail[] and throw ToolValidationError with details (tool-controller.ts:92-116, currently 98-103 produces string[] via issue.path.join('.')) |
| `packages/core/src/index.ts`           | Modify | export type { ValidationErrorDetail } barrel export (if public)                                                                                                                             |
| `.changeset/<id>.md`                   | NEW    | MINOR bump: "feat(core): add ValidationErrorDetail + ToolValidationError.details (backward compat getter)"                                                                                  |

---

## 6. Implementation Strategy

### Step 1: Add `ValidationErrorDetail` interface

Add to `packages/core/src/interfaces.ts`:

```typescript
export interface ValidationErrorDetail {
  readonly fieldPath: string;
  readonly constraint: string;
  /** Raw value that failed validation — NEVER log or emit in events (S-1). Inspect only in catch block. */
  readonly received: unknown;
}
```

### Step 2: Update `ToolValidationError`

Modify `packages/core/src/errors.ts`:

- Add `import type { ValidationErrorDetail } from './interfaces.js'` (type-only, no runtime — L0→L0 per ADR-030; `errors.ts:1` already imports type-only from interfaces).
- Update `ToolValidationError` to accept `string[] | ValidationErrorDetail[]` in constructor
- Store `details: ValidationErrorDetail[]` as a public readonly field
- Convert `validationErrors` from a constructor parameter to a getter that derives from `details` (prototype accessor — see hasOwnProperty/JSON.stringify note in §4.1)
- Use robust guard `validationErrors.every((v): v is ValidationErrorDetail => typeof v === 'object' && v !== null && 'fieldPath' in v && 'constraint' in v)` — no direct `validationErrors[0]` access (satisfies `noUncheckedIndexedAccess`)

Modify `packages/core/src/tool-controller.ts:92-116` (currently `98-103` produces `string[]` via `issue.path.join('.')`):

- In `validateInput`, replace:
  ```typescript
  const errors = result.error.issues.map((issue) => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  throw new ToolValidationError(toolName, errors);
  ```
  with structured mapping:
  ```typescript
  const details: ValidationErrorDetail[] = result.error.issues.map((i) => ({
    fieldPath: i.path.join('.'),
    constraint: i.message,
    received: getNestedValue(input, i.path),
  }));
  // Do NOT include details[].received in logger payload — S-1
  this.logger.warn('Tool input validation failed', {
    toolName,
    errors: details.map((d) => `${d.fieldPath ? d.fieldPath + ': ' : ''}${d.constraint}`),
  });
  throw new ToolValidationError(toolName, details);
  ```
  Explicit form required by review:
  ```typescript
  issues.map((i) => ({
    fieldPath: i.path.join('.'),
    constraint: i.message,
    received: getNestedValue(input, i.path),
  }));
  ```
  Helper `getNestedValue(input, path)` traverses `input` by `i.path` (array of string|number) to capture the raw value that failed. Single source of truth: `tool-controller` produces structured `ValidationErrorDetail[]`; `errors.ts` constructor's string-parse fallback remains only for backward compat.

Modify `packages/core/src/index.ts`:

- Add `export type { ValidationErrorDetail } from './interfaces.js'` barrel export.

Add `.changeset/<id>.md`:

- MINOR bump: `feat(core): add ValidationErrorDetail + ToolValidationError.details (backward compat getter)` — per `api-design` adding optional field/type is MINOR, not MAJOR, while `interfaces.ts` edit still requires SPSA + user approval (FROZEN).

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

Specific assertions to verify (at least 10):

1. `ToolValidationError` can be constructed with `string[]` (backward compat).
2. `ToolValidationError` can be constructed with `ValidationErrorDetail[]`.
3. `instance.validationErrors` returns `string[]` regardless of which constructor overload was used.
4. `instance.details` returns `ValidationErrorDetail[]` with correct `fieldPath`, `constraint`, `received`.
5. Empty array case: `new ToolValidationError('t', [])` yields `details: []` and `validationErrors: []` (guard handles empty without index access).
6. `hasOwnProperty`/`Object.keys`/`JSON.stringify`/`structuredClone` regression for getter vs own property — `validationErrors` is prototype accessor, so `hasOwnProperty('validationErrors') === false`, `Object.keys(instance)` does not include it, `JSON.stringify(instance)` omits it unless explicitly included; `structuredClone` also omits getter. Document as MINOR and add JSON test.
7. `received` preserved from nested input via `getNestedValue` — e.g., input `{ a: { b: 123 } }` with path `['a','b']` yields `received === 123`; deep path `['arr', 0, 'x']` correctly traverses.
8. `received` never appears in logger/event output (S-1 test) — spy on `logger.warn`/`logger.error` and assert `details[].received` / `received` not in logged args; assert `EventErrorPayload`/`ToolResultError` payloads do not contain `received` (received must never appear in logger/event output — S-1).
9. `tool-controller.test.ts:42-53` still passes (existing tool-controller validation tests).
10. `pnpm test:coverage` threshold 70% still passes (`packages/core` global threshold).
11. `index.ts` barrel export check for `ValidationErrorDetail` — `import type { ValidationErrorDetail } from '@atisse/core'` compiles and `ValidationErrorDetail` is exported type.
12. `noUncheckedIndexedAccess` compiles — no `validationErrors[0]` direct access; `tsc --noEmit` passes with `noUncheckedIndexedAccess: true`.

---

## 8. Risk Assessment

| Risk                                                                                                 | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backward compatibility break if `validationErrors` is a getter instead of constructor param property | LOW        | HIGH   | Keep `validationErrors` as a getter. The property was `public readonly validationErrors: string[]` — changing to a getter is NOT transparent: `hasOwnProperty` returns false, `JSON.stringify` omits it. Document as MINOR, add JSON/hasOwnProperty regression test. Impact HIGH if consumers serialize errors. |
| received logs secret                                                                                 | LOW        | HIGH   | never include received in logger/event (S-1) — Do NOT log details[].received via logger.warn/error and do NOT include it in EventErrorPayload/ToolResultError; inspect only in catch block                                                                                                                      |
| getter serialization break (hasOwnProperty/JSON.stringify)                                           | LOW        | MEDIUM | document as MINOR, add JSON test — assert JSON.stringify/structuredClone behavior and document in changeset/README that validationErrors is now accessor                                                                                                                                                        |

---

## 9. References

- `.opencode/skill/errors/SKILL.md` — `ToolValidationError` definition
- `.opencode/skill/interfaces/SKILL.md` — Error Code Registry
- `.opencode/skill/principles/SKILL.md` — Principle 1 (Explicit Over Magical)
- `.opencode/skill/security/SKILL.md` — S-1 (secrets never in logs/events; received is sensitive)
- `.opencode/skill/api-design/SKILL.md` — breaking test; adding optional field/type is MINOR (not MAJOR)
- `.opencode/skill/constraints/SKILL.md` — no breaking changes to interfaces.ts (FROZEN, requires SPSA + user approval)
- `.opencode/skill/architecture/SKILL.md` — ADR-030 (L0→L0 type-only import permitted)
- `.opencode/skill/git-workflow/SKILL.md` — changeset (MINOR bump required)
- `DECISION-LOG.md:22,30,35-36` — relevant ADRs for error taxonomy, layering, and FROZEN interfaces
- `packages/core/src/errors.ts` — `ToolValidationError` current implementation
- `packages/core/src/errors.ts:111-121` — ToolValidationError class to be updated
- `packages/core/src/errors.ts:274-281` — ConfigValidationError (out of scope, separate issue if needed)
- `packages/core/src/interfaces.ts` — Existing public interfaces (FROZEN)
- `packages/core/src/tool-controller.ts:92-116` — validateInput (98-103 currently string[] via issue.path.join('.'))
- `packages/core/src/tool-controller.test.ts:42-53` — must still pass
- `packages/core/src/index.ts` — barrel export for ValidationErrorDetail
- `security: S-1` — never log received or emit in events
- `api-design: breaking test` — getter change is MINOR behavioral note
- `constraints: no breaking changes to interfaces.ts`
- `architecture: ADR-030` — type-only import L0→L0
- `git-workflow: changeset` — .changeset/<id>.md MINOR required
