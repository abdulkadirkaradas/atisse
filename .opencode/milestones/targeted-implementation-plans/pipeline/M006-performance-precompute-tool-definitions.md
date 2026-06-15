# M006 — Performance: Pre-Compute Tool Definitions Array

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA pipeline enterprise analysis — Performance (Moderate)

---

## 1. Task Summary

Pre-compute the `ToolDefinition[]` array once during profile resolution and store it on `ResolvedConfig`, eliminating duplicate `Array.from(config.tools.values()).map(...)` computations on every generation round in both streaming and non-streaming paths.

---

## 2. Context (Why This Exists)

In the current pipeline, both the non-streaming and streaming paths compute tool definitions for the `PromptRequest.tools` field on EVERY generation round. The duplicated code appears at:

- **Non-streaming path** (lines 454–461): Inside the generation `while(true)` loop, before each `activeProvider.generate()` call
- **Streaming path** (lines 735–742): Inside the generation `while(true)` loop, before each `activeProvider.generateStream()` call

Both do the same transformation:

```typescript
const promptTools =
  config.tools.size > 0
    ? Array.from(config.tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
    : undefined;
```

`config.tools` is a `Map<string, Tool>` — it never changes during a single run. The `Array.from(...)` + `map(...)` produces the same result every time. In tool-calling scenarios with multiple generation rounds (e.g., 3+ tool rounds), this wastes cycles on repeated iteration and object allocation.

The fix: compute the `ToolDefinition[]` array once during profile resolution (`resolveConfig` in `profile.ts`) and store it on `ResolvedConfig`. The pipelines read the pre-computed value instead of recomputing inline.

---

## 3. Issues/Changes

### Issue: Repeated Tool Definitions Computation

| Field       | Value                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                                             |
| Lines       | 454–461 (non-streaming), 735–742 (streaming)                                                                                                |
| Severity    | LOW (performance)                                                                                                                           |
| Description | `Array.from(config.tools.values()).map(...)` computed on every generation round. In tool-calling loops with 3+ rounds, this is wasted work. |
| Fix         | Pre-compute in `resolveConfig()` in `profile.ts`; store on `ResolvedConfig`; read from config in pipeline.                                  |

---

## 4. Architectural Directives

### 4.1 Add `toolDefinitions` to `ResolvedConfig`

In `packages/core/src/types.ts`, add an optional field to `ResolvedConfig`:

```typescript
export interface ResolvedConfig {
  provider: AIProvider;
  fallbackProvider?: AIProvider;
  systemPrompt?: string;
  tools: Map<string, Tool>;
  /** Pre-computed ToolDefinition[] for PromptRequest.tools.
   *  Computed once during profile resolution to avoid repeated
   *  Array.from().map() in the generation loop.
   *  Undefined when config.tools is empty. */
  toolDefinitions?: ToolDefinition[];
  contextProviders: ContextProvider[];
  // ... rest unchanged
}
```

This requires importing `ToolDefinition` — add it to the existing `import type` from `./interfaces.js` on line 4 of `types.ts`.

### 4.2 Compute in `resolveConfig()`

In `packages/core/src/profile.ts`, in the `resolveConfig()` function, after the `tools` map is finalized (after profile merge), compute `toolDefinitions`:

```typescript
// Inside resolveConfig(), before building resolvedConfig:
const toolDefinitions: ToolDefinition[] | undefined =
  tools.size > 0
    ? Array.from(tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
    : undefined;
```

Add it to the `resolvedConfig` object:

```typescript
const resolvedConfig: ResolvedConfig = {
  provider,
  ...(fallbackProvider !== undefined && { fallbackProvider }),
  ...(systemPrompt !== undefined && { systemPrompt }),
  tools,
  toolDefinitions, // NEW
  contextProviders,
  // ... rest
};
```

The existing `import type { ToolDefinition }` may not be present in `profile.ts` — add it to the imports on line 1.

### 4.3 Replace Inline Computation in Pipeline

In both the non-streaming and streaming paths, replace:

```typescript
const promptTools =
  config.tools.size > 0
    ? Array.from(config.tools.values()).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }))
    : undefined;
```

With:

```typescript
const promptTools = config.toolDefinitions;
```

This is a single variable reference instead of an `Array.from()` + `map()` call.

**Note:** The check `config.tools.size > 0` is no longer needed because `toolDefinitions` is already `undefined` when the tools map is empty. The `PromptRequest` spread handles `undefined` via the existing `...(promptTools ? { tools: promptTools } : {})` pattern.

### 4.4 What NOT to Do

- Do NOT remove the `tools: Map<string, Tool>` field from `ResolvedConfig` — it is still used for tool execution in `executeToolRound()` and `ToolController`
- Do NOT modify `ProfileResolver` or add new parameters to `resolveConfig()` — `toolDefinitions` is derived entirely from the already-finalized `tools` map
- Do NOT make `toolDefinitions` a required field — `undefined` is valid when tools are empty
- Do NOT compute `toolDefinitions` in the `Orchestrator` constructor — it must be profile-aware (tools can be replaced by profile)
- Do NOT export `toolDefinitions` from `@atisse/core` — it's an internal optimization
- Do NOT touch the `PromptRequest` or `ToolDefinition` interfaces — they are unchanged

---

## 5. Files to Modify

| File                            | Action                | Notes                                                                  |
| ------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `packages/core/src/types.ts`    | MODIFY (additive)     | Add `toolDefinitions?: ToolDefinition[]` to `ResolvedConfig`           |
| `packages/core/src/profile.ts`  | MODIFY (additive)     | Compute `toolDefinitions` in `resolveConfig()`                         |
| `packages/core/src/pipeline.ts` | MODIFY (optimization) | Replace inline computation with `config.toolDefinitions` in both paths |

---

## 6. Implementation Strategy

### Step 1: Update `types.ts`

- Import `ToolDefinition` in the existing `import type` on line 4
- Add `toolDefinitions?: ToolDefinition[]` to the `ResolvedConfig` interface

### Step 2: Update `profile.ts`

- Add `ToolDefinition` to the import from `./interfaces.js` on line 1
- After the tools map is finalized (after the if-else block that handles profile tools), compute `toolDefinitions`
- Add it to the `resolvedConfig` object

### Step 3: Update `pipeline.ts`

- In the non-streaming path (lines 454–461): replace the inline computation with `config.toolDefinitions`
- In the streaming path (lines 735–742): replace the inline computation with `config.toolDefinitions`
- Verify that `PromptRequest` construction still works — the existing spread `...(promptTools ? { tools: promptTools } : {})` handles `undefined` correctly

### Step 4: Verify

Run:

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage
```

All existing tests MUST pass without modification — this is a pure performance optimization with zero behavioral change.

---

## 7. Verification Requirements

After implementation, the SPBED MUST run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

### Specific assertions to verify:

1. Non-streaming pipeline with tools: `config.toolDefinitions` is an array, not `undefined`
2. Non-streaming pipeline without tools: `config.toolDefinitions` is `undefined`
3. `PromptRequest.tools` is correctly populated from `config.toolDefinitions` — same shape as before
4. Streaming pipeline with tools: same behavior
5. Profile that replaces tools: `config.toolDefinitions` reflects the profile's tools, not the base tools
6. All existing tests pass with no modifications

### If a Test Fails:

1. The test is likely asserting something about the internal computation that is no longer relevant
2. **Do NOT modify test assertions about behavior** — the optimization produces identical `PromptRequest.tools`
3. If a test was inspecting the intermediate computation (unlikely), update the test to inspect `config.toolDefinitions` instead
4. If uncertain, return to SPSA for guidance

---

## 8. Risk Assessment

| Risk                                                         | Likelihood | Impact | Mitigation                                                                                                                                                    |
| ------------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missed code path that also computes tool definitions         | Low        | Medium | Grep for `Array.from(config.tools.values()).map` and `Array.from(config.tools` in pipeline.ts                                                                 |
| `toolDefinitions` not updated when tools map changes mid-run | Low        | High   | Tools map is immutable during a run — set in `resolveConfig()`, never mutated. Verified by `const tools` usage pattern (no mutations except profile replace). |
| Import missing for `ToolDefinition` in types.ts              | Low        | Low    | TypeScript compilation error — caught by `pnpm typecheck`                                                                                                     |
| Profile tools array is empty (`[]`) replacing base tools     | Low        | Low    | `toolsArrayToMap([])` produces empty Map; `tools.size > 0` is false; `toolDefinitions` is `undefined` — correct                                               |
| Value is computed before tools merge completes               | Low        | Medium | Must compute AFTER the if-else block that finalizes the `tools` variable — ensure placement is correct                                                        |

---

## 9. References

- `.opencode/rules/architecture.md` — Profile Resolution table (tools merge strategy)
- `.opencode/rules/interfaces-core.md` — `ToolDefinition`, `PromptRequest`
- `.opencode/rules/constraints.md` — Interface modification rules
- `.opencode/rules/implementation-standards.md` — Performance considerations
- `packages/core/src/pipeline.ts` — Lines 454–461 (non-streaming), 735–742 (streaming)
- `packages/core/src/profile.ts` — `resolveConfig()` function, tools merge logic
- `packages/core/src/types.ts` — `ResolvedConfig` interface
- `packages/core/src/interfaces.ts` — `ToolDefinition` type
