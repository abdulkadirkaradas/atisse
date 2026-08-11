# B5 — Structured ToolValidationError Details

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

Add a `ValidationErrorDetail[]` type and a `details` field to `ToolValidationError`. Keep the existing `validationErrors: string[]` as a deprecated computed getter that derives its value from the structured `details` array. This is NOT a breaking change — the public API surface grows but nothing is removed.

---

## 2. Context (Why This Exists)

`ToolValidationError` currently carries `validationErrors: string[]` — an array of human-readable strings. Callers that need to know _which_ field failed and _why_ must string-parse these messages. For example, `"query: Required"` has to be split on `:` to extract `fieldPath: 'query'` and `constraint: 'Required'`. This violates Principle 1 (Explicit Over Magical) — structured data is replaced by encoded strings.

Adding a parallel `details: ValidationErrorDetail[]` array with explicit `fieldPath`, `constraint`, and `received` fields makes the error self-describing. The old `validationErrors` property is kept as a deprecated getter that computes strings from the structured data, ensuring no existing consumer breaks.

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

---

## 4. Architectural Directives

### 4.1 Chosen Approach

Add to `packages/core/src/interfaces.ts`:

```typescript
export interface ValidationErrorDetail {
  fieldPath: string;
  constraint: string;
  received: unknown;
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

    if (validationErrors.length > 0 && typeof validationErrors[0] === 'object') {
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

  get validationErrors(): string[] {
    return this.details.map((d) => `${d.fieldPath ? d.fieldPath + ': ' : ''}${d.constraint}`);
  }
}
```

**Note:** Import `ValidationErrorDetail` from `interfaces.ts` using `import type` in `errors.ts` (both are Layer 0 — this is permitted).

### 4.2 What NOT to Do

- Do NOT change `ToolValidationError` constructor signature in a way that breaks existing consumers. The union type `string[] | ValidationErrorDetail[]` is additive.
- Do NOT remove `validationErrors: string[]` — mark it `@deprecated` with a getter, but keep the property accessible.
- Do NOT change the `code` or `retryable` properties of `ToolValidationError`.

---

## 5. Files to Modify

| File                              | Action | Notes                                                                                               |
| --------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts` | Modify | Add `ValidationErrorDetail` interface                                                               |
| `packages/core/src/errors.ts`     | Modify | Update `ToolValidationError` with `details` field and backward-compatible `validationErrors` getter |

---

## 6. Implementation Strategy

### Step 1: Add `ValidationErrorDetail` interface

Add to `packages/core/src/interfaces.ts`:

```typescript
export interface ValidationErrorDetail {
  fieldPath: string;
  constraint: string;
  received: unknown;
}
```

### Step 2: Update `ToolValidationError`

Modify `packages/core/src/errors.ts`:

- Add `import type { ValidationErrorDetail } from './interfaces.js'`
- Update `ToolValidationError` to accept `string[] | ValidationErrorDetail[]` in constructor
- Store `details: ValidationErrorDetail[]` as a public readonly field
- Convert `validationErrors` from a constructor parameter to a getter that derives from `details`

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

1. `ToolValidationError` can be constructed with `string[]` (backward compat).
2. `ToolValidationError` can be constructed with `ValidationErrorDetail[]`.
3. `instance.validationErrors` returns `string[]` regardless of which constructor overload was used.
4. `instance.details` returns `ValidationErrorDetail[]` with correct `fieldPath`, `constraint`, `received`.
5. All existing tests that catch `ToolValidationError` and inspect `validationErrors` continue to pass.

---

## 8. Risk Assessment

| Risk                                                                                                 | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Backward compatibility break if `validationErrors` is a getter instead of constructor param property | MEDIUM     | HIGH   | Keep `validationErrors` as a getter. The property was `public readonly validationErrors: string[]` — changing to a getter is transparent to consumers who read it. Consumers who pass it as constructor argument or check `hasOwnProperty` are not affected. |

---

## 9. References

- `.opencode/skill/errors/SKILL.md` — `ToolValidationError` definition
- `.opencode/skill/interfaces/SKILL.md` — Error Code Registry
- `.opencode/skill/principles/SKILL.md` — Principle 1 (Explicit Over Magical)
- `packages/core/src/errors.ts` — `ToolValidationError` current implementation
- `packages/core/src/interfaces.ts` — Existing public interfaces
