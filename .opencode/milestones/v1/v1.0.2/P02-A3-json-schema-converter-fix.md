# A3 — JSON Schema Converter: Explicit ToolDefinitionError on Unsupported Keywords

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

1. Detect when an unsupported JSON Schema keyword is encountered in `tool-controller.ts:jsonSchemaToZod()`
2. Instead of falling through to `z.never()` (which silently rejects all input), throw a new `ToolDefinitionError` at config time
3. Define `ToolDefinitionError` class in `packages/core/src/errors.ts` (FATAL, non-retryable)
4. Add `'TOOL_DEFINITION_ERROR'` to the `OrchestratorErrorCode` union in `packages/core/src/interfaces.ts`
5. Update `jsonSchemaToZod()` to throw `ToolDefinitionError` when an unsupported keyword is encountered
6. Export `ToolDefinitionError` from `packages/core/src/index.ts`
7. Add `checkUnsupportedKeywords(schema)` that catches ALL unsupported keywords on supported types (`$ref`, `const`, `default`, `minItems`/`maxItems`, `patternProperties`, `additionalProperties`) — not only unrecognized `type` values. This closes the silent under-validation gap: a `{ type: 'string', const: 'allowed' }` schema currently accepts any string.

---

## 2. Context (Why This Exists)

The `jsonSchemaToZod` function in `packages/core/src/tool-controller.ts` (lines 273–293) converts JSON Schema objects to Zod schemas for runtime tool input validation. It supports a subset of JSON Schema:

- Types: `object`, `string`, `number`, `integer`, `boolean`, `array`, `null`
- Composition: `anyOf`, `oneOf`, `allOf`
- Constraints: `required`, `minimum`/`maximum`, `minLength`/`maxLength`, `enum`
- Array: `items`

**It does NOT support:**

- `$ref` (references)
- `additionalProperties` (beyond `additionalProperties: false` implicit in `z.strictObject`)
- `patternProperties`
- Array `minItems` / `maxItems`
- `const`
- `default`
- `type` arrays (e.g. `type: ['string', 'number']`)

Currently, when an unrecognized `type` value is encountered (line 288–292), the function logs a warning and returns `z.never()`:

```typescript
this.logger.warn('Unsupported JSON Schema type — rejecting all input', {
  schemaType: schema.type,
});
return z.never();
```

`z.never()` silently rejects all input at runtime — the tool always fails validation with a cryptic Zod error. The developer sees a `ToolValidationError` at tool execution time but has no indication that the root cause is an unsupported JSON Schema keyword in the tool definition.

This violates **Principle 1 (Explicit Over Magical)** — the error should surface eagerly at configuration/definition time with a clear message, not silently at execution time.

---

## 3. Issues/Changes

### Issue A3-1: Silent z.never() on unsupported JSON Schema keywords

| Field       | Value                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/tool-controller.ts`                                                                                                                                                                           |
| Lines       | 288–292                                                                                                                                                                                                          |
| Severity    | HIGH                                                                                                                                                                                                             |
| Description | `jsonSchemaToZod()` returns `z.never()` for unrecognized `type` values. This silently rejects all input at execution time via a cryptic Zod error, rather than throwing an informative error at definition time. |
| Fix         | Throw `ToolDefinitionError` (new class) when an unsupported keyword is detected, with a message listing the unsupported keyword and the tool name.                                                               |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**New Error Class** — `ToolDefinitionError` extends `OrchestratorError`:

```typescript
/**
 * Tool definition error — unsupported JSON Schema keyword encountered.
 * FATAL, non-retryable. Schema is invalid at config time and cannot be retried.
 */
export class ToolDefinitionError extends OrchestratorError {
  readonly code = 'TOOL_DEFINITION_ERROR' as const;
  readonly retryable = false;

  constructor(
    public readonly toolName: string,
    public readonly unsupportedKeyword: string,
    cause?: unknown,
  ) {
    super(`Tool '${toolName}' uses unsupported JSON Schema keyword: ${unsupportedKeyword}`, cause);
  }
}
```

**Error Code** — Add to the `OrchestratorErrorCode` union:

```typescript
export type OrchestratorErrorCode =
  // ... existing codes ...
  'TOOL_DEFINITION_ERROR';
```

**When to throw** — The `z.never()` fallback (line 292) is replaced with a throw. The detection logic should cover:

1. **Unrecognized `type`** (line 288): If `type` is a string that is not in the supported set → `ToolDefinitionError` with `unsupportedKeyword: schema.type`
2. **Unrecognized composition keyword**: Already handled by returning `null` from `zodFromComposition` — the check falls through to type dispatch. No change needed there.
3. **`$ref` presence**: If `schema.$ref` is defined, throw `ToolDefinitionError` with `unsupportedKeyword: '$ref'`
4. **`const` presence**: If `schema.const` is defined and type is unsupported, throw
5. **`type` is an array** (e.g., `['string', 'number']`): Throw `ToolDefinitionError` with `unsupportedKeyword: 'type: array'`

**`checkUnsupportedKeywords(schema)` helper** — NEW function that catches ALL unsupported keywords **on supported types**. This is the critical widening from the original plan (Finding 1.2 in the post-assessment review): a recognized `type` carrying an unsupported keyword (e.g. `{ type: 'string', const: 'allowed-value' }`) is silently dropped today — the schema under-validates at runtime with zero detection. The helper scans every schema node for the presence of unsupported keywords regardless of `type`:

```typescript
private checkUnsupportedKeywords(schema: Record<string, unknown>, toolName: string): void {
  const unsupported: readonly string[] = [
    '$ref',
    'const',
    'default',
    'minItems',
    'maxItems',
    'patternProperties',
    'additionalProperties',
  ];

  for (const keyword of unsupported) {
    if (schema[keyword] !== undefined) {
      throw new ToolDefinitionError(toolName, keyword);
    }
  }
}
```

**Call sites** — invoke the helper (passing `toolName` through, consistent with the explicit-parameter approach in Step 3):

1. **At the entry of `jsonSchemaToZod()`** — before the composition check and type dispatch, so every top-level schema node is scanned.
2. **Recursively inside `zodFromArray(schema, toolName)`** — scans nested `items` nodes (catches `minItems`/`maxItems`, `const`, `default` on array element schemas).
3. **Recursively inside `zodFromObject(schema, toolName)`** — scans each `properties[key]` node (catches `const`, `default`, `patternProperties`, `additionalProperties` on property schemas).

The helper reuses the same `ToolDefinitionError` class from §4.1 — only the detection surface widens. This subsumes detection items 3 and 4 above (`$ref` and `const` are in the list) and adds the remaining keywords (`default`, `minItems`/`maxItems`, `patternProperties`, `additionalProperties`) that were previously invisible.

**Eager vs lazy** — The error is thrown during `ToolController` construction or `validateInput()` — specifically when `jsonSchemaToZod` is called for the first time. Since `ToolController` is created inside `pipeline.ts` at `run()` entry (not at `Orchestrator` construction time), the error surfaces at `run()` entry as a `ToolDefinitionError` rejection.

This is correct: tool schema validation is a `run()`-time concern (tools are loaded lazily). The error message should clearly tell the developer which tool and which keyword to fix.

**Error taxonomy placement:** `ToolDefinitionError` belongs in the `ToolError` group in the hierarchy (alongside `ToolExecutionError`, `ToolValidationError`, `ToolNotFoundError`), since it concerns tool definition validity.

### 4.2 What NOT to Do

- Do NOT change the `ToolDefinition` interface — it remains `inputSchema: Record<string, unknown>`
- Do NOT make `$ref` resolution a feature — this is a validation-only change
- Do NOT wrap the `ToolDefinitionError` in a `ConfigValidationError` — it has its own error code
- Do NOT remove the `z.never()` fallback entirely — keep it as defense-in-depth for any edge case that slips through validation. Only the explicit unsupported-keyword check paths should throw.
- Do NOT change the `validateInput()` method's return type or behavior for valid schemas
- Do NOT add validation at `Orchestrator` construction time — tool schema validation stays in `ToolController` at `run()` entry

---

## 5. Files to Modify

| File                                   | Action       | Notes                                                    |
| -------------------------------------- | ------------ | -------------------------------------------------------- |
| `packages/core/src/errors.ts`          | ADD class    | `ToolDefinitionError` — non-retryable, FATAL             |
| `packages/core/src/interfaces.ts`      | MODIFY union | Add `'TOOL_DEFINITION_ERROR'` to `OrchestratorErrorCode` |
| `packages/core/src/tool-controller.ts` | MODIFY       | Replace `z.never()` with `ToolDefinitionError` throw     |
| `packages/core/src/index.ts`           | ADD export   | Export `ToolDefinitionError`                             |

---

## 6. Implementation Strategy

### Step 1: Add Error Code to Union

- Open `packages/core/src/interfaces.ts`
- Add `'TOOL_DEFINITION_ERROR'` to the `OrchestratorErrorCode` union type (around line 44, after `TOOL_EXECUTION_FAILED`)

### Step 2: Define `ToolDefinitionError` Class

- Open `packages/core/src/errors.ts`
- Add the new class after `ToolNotFoundError` (around line 133), in the Tool Errors section:

```typescript
/**
 * Tool definition error — unsupported JSON Schema keyword.
 * FATAL — schema is invalid at config time, cannot be retried.
 */
export class ToolDefinitionError extends OrchestratorError {
  readonly code = 'TOOL_DEFINITION_ERROR' as const;
  readonly retryable = false;

  constructor(
    public readonly toolName: string,
    public readonly unsupportedKeyword: string,
    cause?: unknown,
  ) {
    super(`Tool '${toolName}' uses unsupported JSON Schema keyword: ${unsupportedKeyword}`, cause);
  }
}
```

### Step 3: Update `jsonSchemaToZod()` to Throw

- Open `packages/core/src/tool-controller.ts`
- Import `ToolDefinitionError` at the top (alongside existing ToolError imports)
- Add the `checkUnsupportedKeywords(schema, toolName)` private method from §4.1
- In the `jsonSchemaToZod()` method (line 273), before the composition check and type dispatch, call the helper and add the toolName parameter:

```typescript
private jsonSchemaToZod(schema: Record<string, unknown>, toolName: string): z.ZodType<unknown> {
  // Check for unsupported keywords first — catches $ref, const, default,
  // minItems/maxItems, patternProperties, additionalProperties on ANY type
  this.checkUnsupportedKeywords(schema, toolName);

  // Check composition keywords first
  const compositionResult = this.zodFromComposition(schema, toolName);
  if (compositionResult) return compositionResult;

  const typeName = typeof schema.type === 'string' ? schema.type : '';

  if (typeName === 'object') return this.zodFromObject(schema, toolName);
  if (typeName === 'string') return this.zodFromString(schema, toolName);
  if (typeName === 'number') return this.zodFromNumber(schema, toolName);
  if (typeName === 'integer') return this.zodFromNumber(schema, toolName);
  if (typeName === 'boolean') return z.boolean();
  if (typeName === 'array') return this.zodFromArray(schema, toolName);
  if (typeName === 'null') return z.null();

  // NEW: Throw ToolDefinitionError for unsupported type
  throw new ToolDefinitionError(toolName, String(schema.type));
}
```

- **Recursive detection:** Call `this.checkUnsupportedKeywords(schema, toolName)` at the entry of `zodFromArray()` (before processing `items`) and `zodFromObject()` (before processing `properties`). This expands detection to `minItems`/`maxItems` and `default` on supported array/object schemas, and `patternProperties`/`additionalProperties`/`const`/`default` on supported property schemas — closing the silent under-validation gap.

**Design note:** `jsonSchemaToZod` currently does not receive `toolName`. There are two approaches:

1. Add `toolName: string` as a parameter to `jsonSchemaToZod` and propagate it through `zodFromObject`, `zodFromString`, etc.
2. Store `toolName` as a class field before calling `jsonSchemaToZod` in `validateInput()`.

**Recommended approach (1):** Add `toolName` parameter to `jsonSchemaToZod` and all recursive callers (`zodFromObject`, `zodFromString`, `zodFromNumber`, `zodFromArray`, `zodFromComposition`, `zodFromUnion`, `zodFromIntersection`, `zodFromEnum`). This is the explicit parameter approach and preserves the stateless nature of the conversion methods. The `toolName` is only used for error messages, so it adds no behavioral dependency.

Alternatively, **approach (2):** Store `toolName` on the class instance in `validateInput()` and reference it in `jsonSchemaToZod()` via `this.currentToolName`. This avoids parameter propagation but introduces temporary mutable state. SPBED should choose approach (1) unless it creates excessive churn.

### Step 4: Export from Index

- Open `packages/core/src/index.ts`
- Add `ToolDefinitionError` to the error exports block (around line 55, after `ToolNotFoundError`)

### Step 5: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`
- All existing tests must pass without modification
- Unsupported keywords now produce `ToolDefinitionError` instead of silent `z.never()`

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

- A tool with `$ref` in its `inputSchema` throws `ToolDefinitionError` at `run()` entry
- An `inputSchema` with `type: 'string'` (supported) still works without error
- An array schema without `items` continues to validate via `z.array(z.unknown())` (no regression)
- **Per-keyword assertions** — each unsupported keyword throws `ToolDefinitionError` naming the exact keyword:
  - `$ref` → `ToolDefinitionError` with `unsupportedKeyword: '$ref'`
  - `const` on a supported type (e.g. `{ type: 'string', const: 'x' }`) → `unsupportedKeyword: 'const'`
  - `default` on a supported type → `unsupportedKeyword: 'default'`
  - `minItems` / `maxItems` on an array schema → `unsupportedKeyword: 'minItems'` / `'maxItems'`
  - `patternProperties` / `additionalProperties` on an object schema → `unsupportedKeyword: 'patternProperties'` / `'additionalProperties'`
  - Nested occurrence: keyword inside `properties[key]` (object) or `items` (array) → same error via recursive call sites
- All existing tests pass without modification
- `isRetryable(new ToolDefinitionError('test', '$ref'))` returns `false`
- `ToolDefinitionError` is exported from `@atisse/core` and can be caught by consumers

---

## 8. Risk Assessment

| Risk                                                      | Likelihood | Impact | Mitigation                                                                                                                                                                                                |
| --------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parameter propagation adds noise to recursive calls       | High       | Low    | Acceptable — explicit parameters are architecturally preferred over class state                                                                                                                           |
| Existing tools with unsupported keywords break at upgrade | Medium     | Low    | This is the intended fix — tools using unsupported keywords were already broken (silent under-validation), now they get a clear error at `run()` entry                                                    |
| Widened detection rejects previously accepted schemas     | Medium     | Medium | Expected — schemas carrying `const`/`default`/`minItems`/`maxItems`/`patternProperties`/`additionalProperties` were silently under-validating. The error names the exact keyword for one-line remediation |
| z.never() removal creates gap for unvalidated edge case   | Low        | Medium | Keep `z.never()` as final fallback after all explicit checks; only active keyword detection paths throw                                                                                                   |
| ToolDefinitionError not caught by existing error handlers | Low        | Low    | It extends `OrchestratorError` and is non-retryable — existing catch blocks in `executeRound()` handle it via the `OrchestratorError` instanceof check                                                    |

---

## 9. References

- `.opencode/skill/errors/SKILL.md` — Error hierarchy, retryable classification, rules for adapter authors
- `.opencode/skill/interfaces/SKILL.md` — `OrchestratorErrorCode` union (frozen, additive only)
- `.opencode/skill/principles/SKILL.md` — Principle 1: Explicit Over Magical
- `packages/core/src/tool-controller.ts` — Lines 273–293: `jsonSchemaToZod()` with `z.never()` fallback
- `packages/core/src/errors.ts` — Existing error hierarchy (ToolErrors section)
- `packages/core/src/interfaces.ts` — `OrchestratorErrorCode` union
- `packages/core/src/index.ts` — Exports
