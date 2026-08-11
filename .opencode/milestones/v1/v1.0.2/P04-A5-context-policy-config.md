# A5 — Hardcoded Context Limits to contextPolicy Config

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

1. Add an optional `contextPolicy: ContextPolicy` field to `OrchestratorConfig` in `packages/core/src/interfaces.ts`
2. Define a `ContextPolicy` interface with `maxMessagesPerProvider?: number` and `maxContentLengthChars?: number`
3. Create default constants and a merge utility in `packages/core/src/policies.ts` following the existing `DEFAULT_RETRY` / `mergeRetryPolicy` pattern
4. Add `contextPolicy` to `ResolvedConfig` in `packages/core/src/types.ts` with resolved (non-optional) values
5. Remove the module-level constants `CONTEXT_MAX_MESSAGES = 50` and `CONTEXT_MAX_CHARS = 50_000` from `packages/core/src/pipeline.ts`
6. Wire the resolved config values into `PromptComposer.compose()` and the context loading enforcement in `pipeline.ts`

---

## 2. Context (Why This Exists)

`packages/core/src/pipeline.ts` lines 255–256 define two module-level constants:

```typescript
const CONTEXT_MAX_MESSAGES = 50;
const CONTEXT_MAX_CHARS = 50_000;
```

These constants control:

- **`CONTEXT_MAX_MESSAGES`** (line 377): Caps the number of system messages from context providers. When exceeded, the array is truncated.
- **`CONTEXT_MAX_CHARS`** (line 387 via `enforceCharLimit`): Caps the cumulative character length of context provider output.

These hardcoded values violate **Principle 5 (Config Over Code)** — system behaviour is defined through configuration objects, not module-level constants. Users cannot override these limits without modifying source code.

The existing pattern for similar configuration is well-established:

- `RetryPolicy` with `DEFAULT_RETRY` + `mergeRetryPolicy()` in `policies.ts`
- `TimeoutPolicy` with `DEFAULT_TIMEOUT` + `mergeTimeoutPolicy()`
- `ToolPolicy` with `DEFAULT_TOOL_POLICY` + `mergeToolPolicy()`

This change follows the same pattern: define a `ContextPolicy` interface, provide defaults, implement a merge utility, and wire into `ResolvedConfig` so `pipeline.ts` reads from config instead of module-level constants.

---

## 3. Issues/Changes

### Issue A5-1: Hardcoded context limits in pipeline.ts

| Field       | Value                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/pipeline.ts`                                                                                                                               |
| Lines       | 255–256, 377, 387                                                                                                                                             |
| Severity    | LOW                                                                                                                                                           |
| Description | `CONTEXT_MAX_MESSAGES = 50` and `CONTEXT_MAX_CHARS = 50_000` are module-level constants. Users cannot override them. Violates Principle 5 (Config Over Code). |
| Fix         | Move to optional `contextPolicy` config field with defaults, following the `RetryPolicy` / `TimeoutPolicy` pattern.                                           |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**Interface definition** — Add to `packages/core/src/interfaces.ts`:

```typescript
/**
 * Context policy configuration.
 * Defaults: maxMessagesPerProvider=50, maxContentLengthChars=50000
 */
export interface ContextPolicy {
  /** Maximum system messages per context provider. Default: 50 */
  maxMessagesPerProvider: number;
  /** Maximum cumulative character length from context providers. Default: 50000 */
  maxContentLengthChars: number;
}
```

**Config field** — Add to `OrchestratorConfig` (additive, optional, backward-compatible):

```typescript
export interface OrchestratorConfig {
  // ... existing fields ...
  contextPolicy?: Partial<ContextPolicy>;
}
```

**Default and merge utility** — Add to `policies.ts`:

```typescript
const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  maxMessagesPerProvider: 50,
  maxContentLengthChars: 50_000,
};

function mergeContextPolicy(base: ContextPolicy, override?: Partial<ContextPolicy>): ContextPolicy {
  if (!override) return base;
  return { ...base, ...override };
}
```

**ResolvedConfig** — Add field to `types.ts`:

```typescript
export interface ResolvedConfig {
  // ... existing fields ...
  contextPolicy: ContextPolicy;
}
```

**Wiring** — `profile.ts:resolveConfig()` must merge the contextPolicy from config (and profile if applicable). Then `pipeline.ts` reads `config.contextPolicy.maxMessagesPerProvider` and `config.contextPolicy.maxContentLengthChars` instead of the module-level constants.

**Defaults must match current values**: `maxMessagesPerProvider = 50`, `maxContentLengthChars = 50_000`. Backward compatibility is preserved — configs without `contextPolicy` get defaults.

### 4.2 What NOT to Do

- Do NOT make `contextPolicy` a required field — must be optional for backward compatibility
- Do NOT change the `ContextPolicy` default values from the current constants (50, 50000)
- Do NOT remove the `enforceCharLimit` function or change its signature — only the source of limit values changes
- Do NOT modify the `EventBus` interface, `Orchestrator` public API, or `run()` return type
- Do NOT add `contextPolicy` to `OrchestratorProfile` in this change — that is a separate enhancement (B6)

---

## 5. Files to Modify

| File                                   | Action           | Notes                                                    |
| -------------------------------------- | ---------------- | -------------------------------------------------------- |
| `packages/core/src/interfaces.ts`      | ADD interface    | `ContextPolicy` + optional field on `OrchestratorConfig` |
| `packages/core/src/policies.ts`        | ADD defaults     | `DEFAULT_CONTEXT_POLICY` + `mergeContextPolicy()`        |
| `packages/core/src/types.ts`           | ADD field        | `contextPolicy: ContextPolicy` on `ResolvedConfig`       |
| `packages/core/src/pipeline.ts`        | REFACTOR         | Remove module constants, read from config instead        |
| `packages/core/src/prompt-composer.ts` | No change needed | Limits are enforced in pipeline.ts, not composer         |

---

## 6. Implementation Strategy

### Step 1: Define `ContextPolicy` Interface

- Open `packages/core/src/interfaces.ts`
- Add the `ContextPolicy` interface near the other policy interfaces (after `ToolPolicy`, around line 255)
- Add optional `contextPolicy?: Partial<ContextPolicy>` field to `OrchestratorConfig` (after `toolPolicy`, around line 378)
- No TSDoc changes needed beyond the inline comment

### Step 2: Add Defaults and Merge Utility

- Open `packages/core/src/policies.ts`
- Import `ContextPolicy` from `./interfaces.js`
- Add `DEFAULT_CONTEXT_POLICY` constant following the `DEFAULT_RETRY` pattern (around line 24)
- Add `mergeContextPolicy()` function following the `mergeRetryPolicy()` pattern (around line 68)
- Add `DEFAULT_CONTEXT_POLICY` and `mergeContextPolicy` to the export block (around line 237)

### Step 3: Add `contextPolicy` to `ResolvedConfig`

- Open `packages/core/src/types.ts`
- Import `ContextPolicy` from `./interfaces.js`
- Add `contextPolicy: ContextPolicy;` field to `ResolvedConfig`

### Step 4: Wire into `resolveConfig()` in `profile.ts`

- Open `packages/core/src/profile.ts` (find it — it's imported by `orchestrator.ts` line 23)
- Import `mergeContextPolicy` and `DEFAULT_CONTEXT_POLICY` from `./policies.js`
- In the resolved config builder, add:
  ```typescript
  contextPolicy: mergeContextPolicy(DEFAULT_CONTEXT_POLICY, config.contextPolicy),
  ```
- If profile resolution also applies to `contextPolicy`, add the profile merge logic (profile overrides base)
  - Follow the existing pattern: for each profile field, merge with the base resolved value

### Step 5: Remove Module Constants and Wire into pipeline.ts

- Open `packages/core/src/pipeline.ts`
- Remove lines 255–256 (`const CONTEXT_MAX_MESSAGES = 50` and `const CONTEXT_MAX_CHARS = 50_000`)
- Update line 377: `if (providerResults.length > CONTEXT_MAX_MESSAGES)` → `if (providerResults.length > config.contextPolicy.maxMessagesPerProvider)`
- Update lines 379, 382, 384: replace `CONTEXT_MAX_MESSAGES` references with `config.contextPolicy.maxMessagesPerProvider`
- Update lines 387: `enforceCharLimit(providerResults, CONTEXT_MAX_CHARS, ...)` → `enforceCharLimit(providerResults, config.contextPolicy.maxContentLengthChars, ...)`
- The `enforceCharLimit` function signature does not change — it already receives `maxChars` as a parameter

### Step 6: Verify

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage`
- All existing tests must pass without modification — defaults match current constants

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

- `DEFAULT_CONTEXT_POLICY` has `maxMessagesPerProvider: 50` and `maxContentLengthChars: 50000`
- `mergeContextPolicy(DEFAULT_CONTEXT_POLICY, undefined)` returns defaults unchanged
- `mergeContextPolicy(DEFAULT_CONTEXT_POLICY, { maxMessagesPerProvider: 100 })` overrides only that field
- `ResolvedConfig.contextPolicy` is a fully resolved `ContextPolicy` (all fields non-optional)
- No references to `CONTEXT_MAX_MESSAGES` or `CONTEXT_MAX_CHARS` remain in `pipeline.ts`
- An orchestrator config without `contextPolicy` gets default values (verified via integration test or resolved config snapshot)

---

## 8. Risk Assessment

| Risk                               | Likelihood | Impact | Mitigation                                                                          |
| ---------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------- |
| Backward compatibility break       | Low        | Medium | Field is optional with defaults matching current values — no existing config breaks |
| `profile.ts` wiring missed         | Low        | Medium | Follow existing pattern for other policy merges; verify in ResolvedConfig output    |
| Merge utility omitted from exports | Low        | Low    | Add to export block; linting catches unused exports                                 |
| profile.ts location unknown        | Low        | Low    | Imported by orchestrator.ts line 23; glob `profile.ts` in `packages/core/src/`      |

---

## 9. References

- `.opencode/skill/interfaces/SKILL.md` — Frozen contracts (additive optional fields only)
- `.opencode/skill/interfaces/SKILL.md` — `OrchestratorConfig` definition
- `.opencode/skill/principles/SKILL.md` — Principle 5: Config Over Code
- `packages/core/src/interfaces.ts` — Target for `ContextPolicy` + `OrchestratorConfig.contextPolicy`
- `packages/core/src/policies.ts` — Target for defaults + merge utility
- `packages/core/src/types.ts` — Target for `ResolvedConfig.contextPolicy`
- `packages/core/src/pipeline.ts` — Lines 255–256 (constants to remove), lines 377–387 (references to update)
- `packages/core/src/profile.ts` — Target for resolveConfig wiring
