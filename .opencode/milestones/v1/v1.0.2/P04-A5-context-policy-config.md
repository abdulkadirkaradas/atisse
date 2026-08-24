# A5 — Hardcoded Context Limits to contextPolicy Config

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

> **Rev 2 (2026-08-20):** Applied SPSA review — (1) resolved profile contradiction: v1.0.2 has no profile support for contextPolicy, §4.1 wiring and §6 Step 4 made consistent with §4.2/B6; (2) fixed profile.ts wiring spec to branching-correct form mirroring retry behavior; (3) added eager ConfigValidationError validation for contextPolicy fields in orchestrator.ts; (4) fixed policies.ts import/export staleness note.

---

## 1. Task Summary

1. Add an optional `contextPolicy: ContextPolicy` field to `OrchestratorConfig` in `packages/core/src/interfaces.ts`
2. Define a `ContextPolicy` interface with `maxMessagesPerProvider?: number` and `maxContentLengthChars?: number`
3. Create default constants and a merge utility in `packages/core/src/policies.ts` following the existing `DEFAULT_RETRY` / `mergeRetryPolicy` pattern
4. Add `contextPolicy` to `ResolvedConfig` in `packages/core/src/types.ts` with resolved (non-optional) values
5. Remove the module-level constants `CONTEXT_MAX_MESSAGES = 50` and `CONTEXT_MAX_CHARS = 50_000` from `packages/core/src/pipeline.ts`
6. Wire the resolved config values into `PromptComposer.compose()` and the context loading enforcement in `pipeline.ts`
7. Add eager validation for `contextPolicy` fields in `packages/core/src/orchestrator.ts` constructor

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

> **Note:** Verify line numbers at implementation time — ADR-039 pipeline split may have shifted `pipeline.ts` line numbers since this plan was drafted.

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
  /** Maximum system messages per context provider — cumulative cap across all providers in a single run. Default: 50 */
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

**Wiring** — `profile.ts:resolveConfig()` must merge `contextPolicy` only from base `OrchestratorConfig` — no profile support in v1.0.2 (deferred to B6 per §4.2). When no profile is active, the base `contextPolicy` partial is merged onto defaults; when a profile is active, defaults are kept as-is (mirrors the existing `retry`/`timeout`/`toolPolicy` branching pattern — see §6 Step 4). Then `pipeline.ts` reads `config.contextPolicy.maxMessagesPerProvider` and `config.contextPolicy.maxContentLengthChars` instead of the module-level constants. `profile.resolved` overrides are unchanged in v1.0.2.

**Defaults must match current values**: `maxMessagesPerProvider = 50`, `maxContentLengthChars = 50_000`. Backward compatibility is preserved — configs without `contextPolicy` get defaults.

### 4.2 What NOT to Do

- Do NOT make `contextPolicy` a required field — must be optional for backward compatibility
- Do NOT change the `ContextPolicy` default values from the current constants (50, 50000)
- Do NOT remove the `enforceCharLimit` function or change its signature — only the source of limit values changes
- Do NOT modify the `EventBus` interface, `Orchestrator` public API, or `run()` return type
- Do NOT add `contextPolicy` to `OrchestratorProfile` in this change — that is a separate enhancement (B6), deferred. No `profile.resolved` overrides change in v1.0.2.
- Do NOT add profile-level `contextPolicy` merge logic in `profile.ts` — v1.0.2 keeps defaults when a profile is active

---

## 5. Files to Modify

| File                                   | Action           | Notes                                                                        |
| -------------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`      | ADD interface    | `ContextPolicy` + optional field on `OrchestratorConfig`                     |
| `packages/core/src/policies.ts`        | ADD defaults     | `DEFAULT_CONTEXT_POLICY` + `mergeContextPolicy()` + fix stale export comment |
| `packages/core/src/types.ts`           | ADD field        | `contextPolicy: ContextPolicy` on `ResolvedConfig`                           |
| `packages/core/src/profile.ts`         | MODIFY wiring    | Branching-correct `contextPolicy` resolution (no profile support in v1.0.2)  |
| `packages/core/src/orchestrator.ts`    | ADD validation   | Eager `ConfigValidationError` for `contextPolicy` fields (constructor)       |
| `packages/core/src/pipeline.ts`        | REFACTOR         | Remove module constants, read from `config.contextPolicy` instead            |
| `packages/core/src/prompt-composer.ts` | No change needed | Limits are enforced in pipeline.ts, not composer                             |

No change to `profile.resolved` event — `contextPolicy` has no profile overrides in v1.0.2.

---

## 6. Implementation Strategy

### Step 1: Define `ContextPolicy` Interface

- Open `packages/core/src/interfaces.ts`
- Add the `ContextPolicy` interface near the other policy interfaces (after `ToolPolicy`, around line 255)
- Add optional `contextPolicy?: Partial<ContextPolicy>` field to `OrchestratorConfig` (after `toolPolicy`, around line 378)
- TSDoc for `maxMessagesPerProvider` must note it is a cumulative cap across all providers in a single run

### Step 2: Add Defaults and Merge Utility

- Open `packages/core/src/policies.ts`
- Add `ContextPolicy` to the type import at line 1 (currently `import type { RetryPolicy, TimeoutPolicy, ToolPolicy }` — extend to include `ContextPolicy`)
- Note: the comment at line 5 `// ── Default Constants (internal — NOT exported) ──` is stale — the block at lines 233–245 does export `DEFAULT_RETRY`/`DEFAULT_TIMEOUT`/`DEFAULT_TOOL_POLICY` and their merge utilities. Do not rely on the comment; add `DEFAULT_CONTEXT_POLICY` following the `DEFAULT_RETRY` pattern (around line 24)
- Add `mergeContextPolicy()` function following the `mergeRetryPolicy()` pattern (around line 68)
- Add `DEFAULT_CONTEXT_POLICY` and `mergeContextPolicy` to the export block (around line 233–245) explicitly

### Step 3: Add `contextPolicy` to `ResolvedConfig`

- Open `packages/core/src/types.ts`
- Import `ContextPolicy` from `./interfaces.js`
- Add `contextPolicy: ContextPolicy;` field to `ResolvedConfig`

### Step 4: Wire into `resolveConfig()` in `profile.ts` (branching-correct)

- Open `packages/core/src/profile.ts` (imported by `orchestrator.ts` line 23)
- Import `mergeContextPolicy` and `DEFAULT_CONTEXT_POLICY` from `./policies.js`
- Add the branching-correct resolution — do NOT use a single-line `mergeContextPolicy(DEFAULT_CONTEXT_POLICY, config.contextPolicy)` inside the `resolvedConfig` builder. The existing `profile.ts:85-153` pattern is:
  `let retry = DEFAULT_RETRY; if (profileName !== undefined) { merge profile } else { merge base }` — `contextPolicy` must follow this branching so that base overrides are not merged when a profile is active (mirrors existing `retry`/`timeout`/`toolPolicy` behavior):

  ```typescript
  let contextPolicy = DEFAULT_CONTEXT_POLICY;
  if (profileName !== undefined) {
    // v1.0.2: no profile contextPolicy — keep default, do not merge base
    // (mirrors existing retry/timeout/toolPolicy behavior where base is
    //  not merged when a profile is active; base contextPolicy is only
    //  applied in the else branch)
  } else {
    if (base.contextPolicy) {
      contextPolicy = mergeContextPolicy(contextPolicy, base.contextPolicy);
    }
  }
  ```

- Then include `contextPolicy` in the `resolvedConfig` object:

  ```typescript
  const resolvedConfig: ResolvedConfig = {
    provider,
    // ... existing fields ...
    contextPolicy,
    // ... remaining fields ...
  };
  ```

- Rationale for not merging base when profile is active: the existing `profile.ts:99-153` if/else intentionally isolates profile execution from base partial overrides — base `retry`/`timeout`/`toolPolicy` are only merged in the `else` branch. `contextPolicy` follows the same isolation in v1.0.2; profile-level overrides are deferred to B6.

### Step 5: Add Eager Validation in `orchestrator.ts`

- Open `packages/core/src/orchestrator.ts` (constructor validation at lines 73–110 validates `retry`/`timeout`/`toolPolicy` with `ConfigValidationError`)
- Add validation for `contextPolicy` fields alongside the existing checks, before the `if (validationErrors.length > 0) throw` at line 137:

  ```typescript
  if (config.contextPolicy?.maxMessagesPerProvider !== undefined) {
    const v = config.contextPolicy.maxMessagesPerProvider;
    if (!Number.isInteger(v) || v < 1 || !isFinite(v)) {
      validationErrors.push('contextPolicy.maxMessagesPerProvider must be integer >=1 and finite');
    }
  }
  if (config.contextPolicy?.maxContentLengthChars !== undefined) {
    const v = config.contextPolicy.maxContentLengthChars;
    if (!Number.isInteger(v) || v < 1 || !isFinite(v)) {
      validationErrors.push('contextPolicy.maxContentLengthChars must be integer >=1 and finite');
    }
  }
  ```

- This mirrors the `retry.maxAttempts` validation (`< 1 || !isFinite`) and adds `Number.isInteger` for the integer requirement. Zero, negative, NaN, Infinity, and float values must be rejected with `ConfigValidationError`.

### Step 6: Remove Module Constants and Wire into pipeline.ts

- Open `packages/core/src/pipeline.ts`
- Remove lines 255–256 (`const CONTEXT_MAX_MESSAGES = 50` and `const CONTEXT_MAX_CHARS = 50_000`) — verify line numbers at implementation time due to ADR-039 pipeline split
- Update line 377: `if (providerResults.length > CONTEXT_MAX_MESSAGES)` → `if (providerResults.length > config.contextPolicy.maxMessagesPerProvider)`
- Update lines 379, 382, 384: replace `CONTEXT_MAX_MESSAGES` references with `config.contextPolicy.maxMessagesPerProvider`
- Update line 387: `enforceCharLimit(providerResults, CONTEXT_MAX_CHARS, ...)` → `enforceCharLimit(providerResults, config.contextPolicy.maxContentLengthChars, ...)`
- The `enforceCharLimit` function signature does not change — it already receives `maxChars` as a parameter
- TODO (out of scope): `enforceCharLimit` currently handles `MessageContent[]` by treating non-string content as zero-length (`typeof content === 'string' ? content.length : 0`). Proper `MessageContent[]` char counting is out of scope for this change.

### Step 7: Verify

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
- Eager validation — `new Orchestrator({ provider, contextPolicy: { maxMessagesPerProvider: 0 } })` throws `ConfigValidationError` (zero rejected); same for negative, `NaN`, `Infinity`, and float (`1.5`) — each must push the exact message `'contextPolicy.maxMessagesPerProvider must be integer >=1 and finite'` (and analogously `'contextPolicy.maxContentLengthChars must be integer >=1 and finite'` for the other field)
- Valid `contextPolicy` values (e.g., `{ maxMessagesPerProvider: 10, maxContentLengthChars: 1000 }`) do not throw and are reflected in `ResolvedConfig`
- Profile isolation — when a profile is active, base `contextPolicy` is not merged (defaults kept), consistent with existing `retry`/`timeout` branching

---

## 8. Risk Assessment

| Risk                               | Likelihood | Impact | Mitigation                                                                                                                    |
| ---------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Backward compatibility break       | Low        | Medium | Field is optional with defaults matching current values — no existing config breaks                                           |
| `profile.ts` branching missed      | Low        | Medium | Follow branching-correct pattern from §6 Step 4; verify base is only merged in else branch; keep defaults when profile active |
| Merge utility omitted from exports | Low        | Low    | Add to export block at lines 233–245; linting catches unused exports; fix stale comment at line 5                             |
| profile.ts location unknown        | Low        | Low    | Imported by orchestrator.ts line 23; glob `profile.ts` in `packages/core/src/`                                                |
| Eager validation too strict        | Low        | Low    | Integer >=1 and finite check mirrors `retry.maxAttempts` validation; covered by explicit assertions in §7                     |
| No profile support confusion       | Low        | Low    | v1.0.2 has no `OrchestratorProfile.contextPolicy` — `profile.resolved` overrides unchanged; B6 defers profile support         |

---

## 9. References

- `.opencode/skill/interfaces/SKILL.md` — Frozen contracts (additive optional fields only)
- `.opencode/skill/interfaces/SKILL.md` — `OrchestratorConfig` definition
- `.opencode/skill/principles/SKILL.md` — Principle 5: Config Over Code
- `packages/core/src/interfaces.ts` — Target for `ContextPolicy` + `OrchestratorConfig.contextPolicy`
- `packages/core/src/policies.ts` — Target for defaults + merge utility (note stale comment at line 5, export block 233–245)
- `packages/core/src/types.ts` — Target for `ResolvedConfig.contextPolicy`
- `packages/core/src/profile.ts` — Target for resolveConfig wiring (branching-correct, lines 85–153)
- `packages/core/src/orchestrator.ts` — Eager validation (lines 73–110, 137) for `contextPolicy` fields
- `packages/core/src/pipeline.ts` — Lines 255–256 (constants to remove), lines 377–387 (references to update) — verify line numbers at implementation time due to ADR-039 pipeline split
- `DECISION-LOG.md` — ADR-039 (pipeline split line number note)

(End of file - total 229 lines)
