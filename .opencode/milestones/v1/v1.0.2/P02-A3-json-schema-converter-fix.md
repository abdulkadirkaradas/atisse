# A3 — JSON Schema Converter: Explicit ToolDefinitionError on Unsupported Keywords

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

> **Rev 2 (2026-08-20):** Decision 1 applied — `z.never()` retained for unrecognized/absent `type` (ADR-036); `ToolDefinitionError` throws ONLY for unsupported keywords (plus an explicit `type: array` check). Decision 2 = Option B — v1.0.2 keeps the minimal keyword set + fail-fast wiring; the extended keyword set moves to v1.1.0 M14-B12 Phase 2 (converter capability).

---

## 1. Task Summary

1. Detect when an unsupported JSON Schema keyword is encountered in `tool-controller.ts:jsonSchemaToZod()`
2. Instead of silently dropping unsupported keywords (which under-validates tool input), throw a new `ToolDefinitionError` at the first invocation of the offending tool during a `run()` (lazy validation); keep the `z.never()` fallback for unrecognized/absent `type` (ADR-036)
3. Define `ToolDefinitionError` class in `packages/core/src/errors.ts` (FATAL, non-retryable)
4. Add `'TOOL_DEFINITION_ERROR'` to the `OrchestratorErrorCode` union in `packages/core/src/interfaces.ts`
5. Update `jsonSchemaToZod()` to throw `ToolDefinitionError` when an unsupported keyword from the v1.0.2 minimal set is encountered (and for `type` arrays); unrecognized/absent `type` still falls through to `z.never()`
6. Export `ToolDefinitionError` from `packages/core/src/index.ts`
7. Add `checkUnsupportedKeywords(schema)` that catches the v1.0.2 minimal unsupported-keyword set on supported types (`$ref`, `const`, `default`, `minItems`/`maxItems`, `patternProperties`, `type: array`, and `additionalProperties` in its `true`/schema forms only) — not only unrecognized `type` values. `additionalProperties: false` remains allowed (already enforced by `z.strictObject`). This closes the silent under-validation gap: a `{ type: 'string', const: 'allowed' }` schema currently accepts any string.

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

This violates **Principle 1 (Explicit Over Magical)** — the error should surface explicitly at the first invocation of the offending tool with a clear message, not silently at execution time.

---

## 3. Issues/Changes

### Issue A3-1: Silent z.never() on unsupported JSON Schema keywords

| Field       | Value                                                                                                                                                                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/tool-controller.ts`                                                                                                                                                                                                  |
| Lines       | 288–292                                                                                                                                                                                                                                 |
| Severity    | HIGH                                                                                                                                                                                                                                    |
| Description | `jsonSchemaToZod()` returns `z.never()` for unrecognized `type` values. This silently rejects all input at execution time via a cryptic Zod error, rather than surfacing an informative error at the offending tool's first invocation. |
| Fix         | Throw `ToolDefinitionError` (new class) when an unsupported keyword from the v1.0.2 minimal set is detected (`z.never()` retained for unrecognized/absent `type`), with a message listing the unsupported keyword and the tool name.    |

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

**When to throw** — Per Decision 1, `z.never()` is NOT replaced: an unrecognized/absent `type` falls through to the existing `logger.warn` + `return z.never()` fallback (ADR-036 defense-in-depth). Only unsupported KEYWORDS throw. The detection logic should cover:

1. **Unrecognized/absent `type`** (line 288): Falls through to `z.never()` — NO throw. ADR-036 keeps this fallback; only unsupported keywords throw.
2. **`type` is an array** (e.g., `['string', 'number']`): Throw `ToolDefinitionError` with `unsupportedKeyword: 'type: array'` — checked BEFORE the `typeof schema.type === 'string'` coercion at `tool-controller.ts:278`, which would otherwise funnel an array `type` into `z.never()`.
3. **Unrecognized composition keyword**: Already handled by returning `null` from `zodFromComposition` — the check falls through to type dispatch. No change needed there.
4. **`$ref` presence**: If `schema.$ref` is defined, throw `ToolDefinitionError` with `unsupportedKeyword: '$ref'`
5. **`const` presence**: If `schema.const` is defined, throw `ToolDefinitionError` with `unsupportedKeyword: 'const'`

**`checkUnsupportedKeywords(schema)` helper** — NEW function that catches the v1.0.2 minimal unsupported-keyword set **on supported types**. This is the critical widening from the original plan (Finding 1.2 in the post-assessment review): a recognized `type` carrying an unsupported keyword (e.g. `{ type: 'string', const: 'allowed-value' }`) is silently dropped today — the schema under-validates at runtime with zero detection. The helper scans every schema node for the presence of unsupported keywords regardless of `type`:

```typescript
private checkUnsupportedKeywords(schema: Record<string, unknown>, toolName: string): void {
  const unsupported: readonly string[] = [
    '$ref',
    'const',
    'default',
    'minItems',
    'maxItems',
    'patternProperties',
  ];

  for (const keyword of unsupported) {
    if (schema[keyword] !== undefined) {
      throw new ToolDefinitionError(toolName, keyword);
    }
  }

  // additionalProperties is NOT a bare-presence check. Behavior matrix:
  // - false    -> allowed today (correct) — enforced by z.strictObject (tool-controller.ts:147); 21 test fixtures carry it, so it must NOT throw
  // - true     -> over-restrictive today (should throw)
  // - <schema> -> silently dropped today (should throw)
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new ToolDefinitionError(toolName, 'additionalProperties');
  }
}
```

**Call sites** — invoke the helper ONCE at the entry of `jsonSchemaToZod()` (passing `toolName` through, consistent with the explicit-parameter approach in Step 3):

1. **At the entry of `jsonSchemaToZod()`** — before the composition check and type dispatch, so every schema node is scanned. A single entry check is SUFFICIENT: all schema nodes — top-level, `properties[key]`, `items`, `anyOf`/`oneOf`/`allOf` branches, nested objects, arrays-of-arrays — recurse through `jsonSchemaToZod` (`tool-controller.ts:94, 139, 209, 246, 261`).

The recursive `zodFromArray()`/`zodFromObject()` call sites are REDUNDANT and must NOT be added: `minItems`/`maxItems` are ARRAY-NODE keywords caught at the entry check on the array node itself (the node carrying them is passed to `jsonSchemaToZod`), NOT items-node keywords. `properties[key]` and `items` element schemas are separate nodes scanned independently on recursion.

The helper reuses the same `ToolDefinitionError` class from §4.1 — only the detection surface widens. It subsumes detection items 4 and 5 above (`$ref` and `const` are in the list) and adds the remaining keywords (`default`, `minItems`/`maxItems`, `patternProperties`) that were previously invisible. `additionalProperties` is handled separately (see the behavior matrix above) so that `additionalProperties: false` — enforced by `z.strictObject` and present in 21 test fixtures — does NOT throw.

**Eager vs lazy** — The error is thrown at the FIRST INVOCATION of the offending tool during a `run()` (lazy validation: `pipeline.ts:506,513`; `tool-controller.ts:94`). An uncalled broken tool never triggers the error. ToolController construction does NOT validate — the constructor only stores references (`tool-controller.ts:22-26`), and the `ToolController` itself is created inside `pipeline.ts` at `run()` entry (not at `Orchestrator` construction time). A broken tool therefore surfaces at its first invocation during `run()` as a `ToolDefinitionError` rejection.

This is correct: tool schema validation is a `run()`-time concern (tools are loaded lazily). The error message should clearly tell the developer which tool and which keyword to fix.

**v1.0.2 keyword policy** — The minimal throw set for v1.0.2 is: `$ref`, `const`, `default`, `minItems`, `maxItems`, `patternProperties`, `type: array`, plus `additionalProperties` (in its `true`/schema forms only; `false` is allowed). `title`, `description`, `examples`, and `deprecated` remain allowed annotations (never thrown). The `default` throw is a deliberate stricter-than-spec posture: JSON Schema treats `default` as an annotation, but silently dropping it would under-validate tool inputs, so v1.0.2 rejects it until converter support lands.

The EXTENDED set (`pattern`, `multipleOf`, `minProperties`/`maxProperties`, `uniqueItems`, `if`/`then`/`else`, `not`, `contains`, `propertyNames`, `prefixItems`) is OUT OF SCOPE for v1.0.2. It is documented as a limitation (P05-A6) with runtime support scheduled for v1.1.0 (M14-B12 Phase 2 — converter capability) — see the handoff note below.

> **Handoff note — extended keywords out of scope (v1.0.2):** Extended JSON Schema keywords (`pattern`, `multipleOf`, `minProperties`/`maxProperties`, `uniqueItems`, `if`/`then`/`else`, `not`, `contains`, `propertyNames`, `prefixItems`) remain silently dropped in v1.0.2 — they are outside this plan's enumerated minimal throw set. This is a documented limitation (recorded in P05-A6 v1-limitations-docs) with runtime support scheduled for v1.1.0 (M14-B12 Phase 2 — converter capability). Do NOT extend `checkUnsupportedKeywords` with these keywords in v1.0.2.

**Error taxonomy placement:** `ToolDefinitionError` belongs in the `ToolError` group in the hierarchy (alongside `ToolExecutionError`, `ToolValidationError`, `ToolNotFoundError`), since it concerns tool definition validity.

### 4.2 What NOT to Do

- Do NOT change the `ToolDefinition` interface — it remains `inputSchema: Record<string, unknown>`
- Do NOT make `$ref` resolution a feature — this is a validation-only change
- Do NOT wrap the `ToolDefinitionError` in a `ConfigValidationError` — it has its own error code
- Do NOT remove the `z.never()` fallback entirely — keep it as defense-in-depth for any edge case that slips through validation. Only the explicit unsupported-keyword check paths should throw.
- Do NOT change the `validateInput()` method's return type or behavior for valid schemas
- Do NOT add validation at `Orchestrator` construction time — tool schema validation stays in `ToolController` and fires at the first invocation of the offending tool during `run()` (lazy validation)
- Do NOT add redundant `checkUnsupportedKeywords` call sites inside `zodFromArray()`/`zodFromObject()` — a single entry check in `jsonSchemaToZod` is sufficient; every schema node recurses through it
- Do NOT extend `checkUnsupportedKeywords` with the extended keyword set in v1.0.2 — see the handoff note in §4.1 (runtime support is scheduled for v1.1.0 M14-B12 Phase 2)

---

## 5. Files to Modify

| File                                   | Action       | Notes                                                                                                                                                                           |
| -------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/errors.ts`          | ADD class    | `ToolDefinitionError` — non-retryable, FATAL                                                                                                                                    |
| `packages/core/src/interfaces.ts`      | MODIFY union | Add `'TOOL_DEFINITION_ERROR'` to `OrchestratorErrorCode`                                                                                                                        |
| `packages/core/src/tool-controller.ts` | MODIFY       | Add `checkUnsupportedKeywords`, the `type: array` throw, and `toolName` propagation; keep the `z.never()` fallback; re-throw `ToolDefinitionError` in the `validateInput` catch |
| `packages/core/src/pipeline.ts`        | MODIFY       | Add `ToolDefinitionError` to the fail-fast re-throw lists (line 754 non-streaming; line 1289 streaming)                                                                         |
| `packages/core/src/index.ts`           | ADD export   | Export `ToolDefinitionError`                                                                                                                                                    |

---

## 6. Implementation Strategy

### Step 1: Add Error Code to Union

- Open `packages/core/src/interfaces.ts`
- The `OrchestratorErrorCode` union spans lines 23–44; `TOOL_EXECUTION_FAILED` is at line 29, `RUN_CANCELLED` closes the union at line 44.
- Add `'TOOL_DEFINITION_ERROR'` at the END of the union, after `'RUN_CANCELLED'` (line 44).
- ADR-022 (`DECISION-LOG.md:162`) classifies union widening as MINOR/additive; the `interfaces` file remains frozen — this is an additive literal, not a breaking change.

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
  // minItems/maxItems, patternProperties, and additionalProperties (true/schema forms) on ANY type
  this.checkUnsupportedKeywords(schema, toolName);

  // Check composition keywords first
  const compositionResult = this.zodFromComposition(schema, toolName);
  if (compositionResult) return compositionResult;

  // Explicit check BEFORE the string coercion — a type array would otherwise be
  // funneled into z.never() by the guard at tool-controller.ts:278
  if (Array.isArray(schema.type)) {
    throw new ToolDefinitionError(toolName, 'type: array');
  }

  const typeName = typeof schema.type === 'string' ? schema.type : '';

  if (typeName === 'object') return this.zodFromObject(schema, toolName);
  if (typeName === 'string') return this.zodFromString(schema, toolName);
  if (typeName === 'number') return this.zodFromNumber(schema, toolName);
  if (typeName === 'integer') return this.zodFromNumber(schema, toolName);
  if (typeName === 'boolean') return z.boolean();
  if (typeName === 'array') return this.zodFromArray(schema, toolName);
  if (typeName === 'null') return z.null();

  // Unrecognized or absent type — keep the z.never() fallback (ADR-036 defense-in-depth).
  // Only unsupported KEYWORDS throw; an unrecognized type string does not.
  this.logger.warn('Unsupported JSON Schema type — rejecting all input', {
    schemaType: schema.type,
  });
  return z.never();
}
```

- **Recursive detection:** A single entry check in `jsonSchemaToZod` is sufficient — all schema nodes (top-level, `properties[key]`, `items`, `anyOf`/`oneOf`/`allOf` branches, nested objects, arrays-of-arrays) recurse through `jsonSchemaToZod` (`tool-controller.ts:94, 139, 209, 246, 261`). Do NOT add redundant call sites inside `zodFromArray()`/`zodFromObject()`: `minItems`/`maxItems` are array-node keywords caught at the entry check, and `properties[key]`/`items` element schemas are scanned as separate nodes on recursion.

**Design note:** `jsonSchemaToZod` currently does not receive `toolName`. There are two approaches:

1. Add `toolName: string` as a parameter to `jsonSchemaToZod` and propagate it through `zodFromObject`, `zodFromArray`, `zodFromComposition`, `zodFromUnion`, `zodFromIntersection`.
2. Store `toolName` as a class field before calling `jsonSchemaToZod` in `validateInput()`.

**Recommended approach (1):** Add `toolName` parameter to `jsonSchemaToZod` and propagate it through `zodFromObject`, `zodFromArray`, `zodFromComposition`, `zodFromUnion`, `zodFromIntersection` (5 call sites of `jsonSchemaToZod` — `tool-controller.ts:94, 139, 209, 246, 261` — must supply `toolName`). This is the explicit parameter approach and preserves the stateless nature of the conversion methods. The `toolName` is only used for error messages, so it adds no behavioral dependency. Explicitly REMOVE `zodFromString`, `zodFromNumber`, `zodFromEnum` from the propagation list — they neither recurse into `jsonSchemaToZod` nor throw, so adding `toolName` to them is dead code.

Alternatively, **approach (2):** Store `toolName` on the class instance in `validateInput()` and reference it in `jsonSchemaToZod()` via `this.currentToolName`. This avoids parameter propagation but introduces temporary mutable state. SPBED should choose approach (1) unless it creates excessive churn.

### Step 4: Re-throw `ToolDefinitionError` from `validateInput`

- Open `packages/core/src/tool-controller.ts`
- The catch block at `tool-controller.ts:107-115` currently re-throws `ToolValidationError` as-is but wraps everything else in `ToolValidationError` (line 114).
- Extend the re-throw condition to pass any `OrchestratorError` (including `ToolDefinitionError`) through unchanged; only wrap genuinely unknown errors.
- Without this, the `ToolDefinitionError` thrown by `jsonSchemaToZod` is swallowed and re-wrapped as `ToolValidationError`.

### Step 5: Add `ToolDefinitionError` to the Fail-Fast Lists

- Open `packages/core/src/pipeline.ts`
- Non-streaming: add `ToolDefinitionError` to the fail-fast re-throw list at `pipeline.ts:754` (`if (err instanceof ToolValidationError || err instanceof ToolNotFoundError)` — extend with `|| err instanceof ToolDefinitionError`).
- Streaming: add it to the fail-fast re-throw list at `pipeline.ts:1289` (the streaming path must be verified too — see §7).
- Without this, a non-retryable definition error is retried and surfaces as `MaxRetriesExceededError`.

### Step 6: Export from Index

- Open `packages/core/src/index.ts`
- `ToolExecutionError` is at line 55, `ToolValidationError` at line 56, `ToolNotFoundError` at line 57.
- Add `ToolDefinitionError` to the error exports block after line 57 (`ToolNotFoundError`).

### Step 7: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`
- All existing tests must pass without modification
- Unsupported keywords now produce `ToolDefinitionError` at the first invocation of the offending tool instead of being silently dropped

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

- A tool with `$ref` in its `inputSchema` throws `ToolDefinitionError` at the FIRST INVOCATION of the offending tool during a `run()` (lazy validation: `pipeline.ts:506,513`; `tool-controller.ts:94`)
- An uncalled broken tool never triggers the error; `ToolController` construction does NOT validate (`pipeline.ts:506` — the constructor only stores refs at `tool-controller.ts:22-26`)
- An `inputSchema` with `type: 'string'` (supported) still works without error
- An array schema without `items` continues to validate via `z.array(z.unknown())` (no regression)
- **Per-keyword assertions** — each unsupported keyword throws `ToolDefinitionError` naming the exact keyword:
  - `$ref` → `ToolDefinitionError` with `unsupportedKeyword: '$ref'`
  - `const` on a supported type (e.g. `{ type: 'string', const: 'x' }`) → `unsupportedKeyword: 'const'`
  - `default` on a supported type → `unsupportedKeyword: 'default'`
  - `minItems` / `maxItems` on an array schema → `unsupportedKeyword: 'minItems'` / `'maxItems'`
  - `patternProperties` / `additionalProperties: true` (or schema form) on an object schema → `unsupportedKeyword: 'patternProperties'` / `'additionalProperties'`
  - `type: ['string', 'number']` → `unsupportedKeyword: 'type: array'`
  - Nested occurrence: keyword inside `properties[key]` (object) or `items` (array) → same error via the single entry check on recursion
  - **Regression:** `additionalProperties: false` does NOT throw (enforced by `z.strictObject`; 21 test fixtures carry it)
- **Fail-fast (non-streaming)** — a `ToolDefinitionError` propagates directly (fail-fast list at `pipeline.ts:754`), never retried, never surfaced as `MaxRetriesExceededError`
- **Fail-fast (streaming)** — the streaming path must be verified too: `ToolDefinitionError` propagates via the streaming fail-fast list at `pipeline.ts:1289` (not retried)
- All existing tests pass without modification
- `isRetryable(new ToolDefinitionError('test', '$ref'))` returns `false`
- `ToolDefinitionError` is exported from `@atisse/core` and can be caught by consumers

---

## 8. Risk Assessment

| Risk                                                        | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parameter propagation adds noise to recursive calls         | High       | Low    | Acceptable — explicit parameters are architecturally preferred over class state; the set is bounded (`jsonSchemaToZod` + 5 call sites) and `zodFromString`/`zodFromNumber`/`zodFromEnum` carry no dead `toolName`                                                                                                                                                                                               |
| Existing tools with unsupported keywords break at upgrade   | Medium     | Low    | This is the intended fix — tools using unsupported keywords were already broken (silent under-validation), now they get a clear error at the first invocation of the offending tool                                                                                                                                                                                                                             |
| Widened detection rejects previously accepted schemas       | Medium     | Medium | Expected — schemas carrying `const`/`default`/`minItems`/`maxItems`/`patternProperties`/`additionalProperties` (true/schema forms) were silently under-validating. `additionalProperties: false` is explicitly carved out (allowed today, enforced by `z.strictObject`; fixture blast analysis confirms the 21 fixtures carrying it are unaffected). The error names the exact keyword for one-line remediation |
| `z.never()` gap for unvalidated edge case                   | Low        | Medium | `z.never()` is NOT removed for the type-fallback path — it remains as defense-in-depth (ADR-036). Only the explicit keyword-throw paths fire                                                                                                                                                                                                                                                                    |
| `ToolDefinitionError` not caught by existing error handlers | Low        | Medium | The real handlers are `pipeline.ts:749-756` (non-streaming) / `1284-1297` (streaming), which currently RETRY any non-fail-fast error. The existing `OrchestratorError` instanceof check only normalizes the error type — it does NOT prevent retry. The mitigation is the fail-fast list addition (Step 5)                                                                                                      |

---

## 9. References

- `.opencode/skill/errors/SKILL.md` — Error hierarchy, retryable classification, rules for adapter authors
- `.opencode/skill/interfaces/SKILL.md` — `OrchestratorErrorCode` union (frozen, additive only)
- `.opencode/skill/principles/SKILL.md` — Principle 1: Explicit Over Magical
- `packages/core/src/tool-controller.ts` — Lines 273–293: `jsonSchemaToZod()` with `z.never()` fallback
- `packages/core/src/pipeline.ts` — Fail-fast re-throw lists (lines 754, 1289)
- `packages/core/src/errors.ts` — Existing error hierarchy (ToolErrors section)
- `packages/core/src/interfaces.ts` — `OrchestratorErrorCode` union
- `packages/core/src/index.ts` — Exports
- `DECISION-LOG.md` — ADR-036 (z.never() defense-in-depth), ADR-022 (union widening is MINOR), ADR-007 (retry classification), ADR-009 (Zod for tool validation)
- `P05-A6-v1-limitations-docs.md` — v1.0.2 limitations documentation (extended keywords out of scope)
- `M14-B12-boundary-schema-validation.md` (v1.1.0) — Extended-keyword destination: Phase 2 — converter capability
