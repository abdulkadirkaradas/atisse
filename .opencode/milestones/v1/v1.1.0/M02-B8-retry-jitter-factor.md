# B8 — jitterFactor in RetryPolicy

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

1. Add optional `jitterFactor?: number` field to the `RetryPolicy` interface in `interfaces.ts`.
2. Update `calculateDelay` in `policies.ts` to use `jitterFactor` when present (range 0–1, default 0.3 matching current partial jitter algorithm).
3. Update `DEFAULT_RETRY` and merge utilities (`mergeRetryPolicy`) to propagate the new field.
4. Update `ResolvedConfig` in `types.ts` if needed (type-level propagation only — no structural change needed since `RetryPolicy` is the source type).

---

## 2. Context (Why This Exists)

The `RetryPolicy` interface currently exposes only a boolean `jitter: boolean` field. When `jitter` is `true`, the implementation in `policies.ts` applies a hardcoded 30% partial jitter (line 86: `capped + Math.random() * 0.3 * capped`). This is the "partial jitter" algorithm from the AWS exponential backoff literature.

This means:

- Users who want zero jitter can set `jitter: false`.
- Users who want jitter have **no control** over its magnitude — it is always 30%.
- Users who want a different magnitude (e.g., 10% for latency-sensitive paths, 50% for aggressive congestion avoidance) cannot express this.

This violates Principle 5 (Config Over Code) — the jitter magnitude is a configurable behavior hardcoded in implementation. Making it configurable via an additive optional field gives users control while preserving full backward compatibility.

The design follows option (a) from the M1 design discussion: additive `jitterFactor?: number` alongside the existing `jitter: boolean`, rather than a union type or replacing the boolean. This keeps the interface backward-compatible (no breaking change) and lets existing code continue working unchanged.

---

## 3. Issues/Changes

### Issue B8-1: Missing `jitterFactor` in RetryPolicy

| Field       | Value                                                                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts`                                                                                                                         |
| Lines       | 220–229 (`RetryPolicy` interface)                                                                                                                         |
| Severity    | LOW                                                                                                                                                       |
| Description | `jitter: boolean` controls whether jitter is applied, but the jitter magnitude (30%) is hardcoded in `policies.ts`. Users cannot control jitter strength. |
| Fix         | Add optional `jitterFactor?: number` field with TSDoc describing valid range 0–1 and default behavior.                                                    |

### Issue B8-2: `calculateDelay` ignores configurable jitter factor

| Field       | Value                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------ |
| File        | `packages/core/src/policies.ts`                                                                  |
| Lines       | 76–90 (`calculateDelay` function)                                                                |
| Severity    | LOW                                                                                              |
| Description | Line 86 hardcodes `0.3` as the jitter multiplier: `capped + Math.random() * 0.3 * capped`.       |
| Fix         | Read `jitterFactor` from `policy` (default `0.3` when absent). Use it in the jitter calculation. |

### Issue B8-3: `DEFAULT_RETRY` does not include `jitterFactor`

| Field       | Value                                                                                                                                                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/policies.ts`                                                                                                                                                                                                                                       |
| Lines       | 7–12 (`DEFAULT_RETRY` object)                                                                                                                                                                                                                                         |
| Severity    | LOW                                                                                                                                                                                                                                                                   |
| Description | The default retry policy object defines only `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `jitter`. `jitterFactor` is absent.                                                                                                                                          |
| Fix         | No action needed — `jitterFactor` is optional and defaults to `0.3` in `calculateDelay`. Explicitly adding it to `DEFAULT_RETRY` is not required since the default is applied at the calculation site. However, adding it with value `0.3` is acceptable for clarity. |

### Issue B8-4: `mergeRetryPolicy` spread will include `jitterFactor` automatically

| Field       | Value                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/policies.ts`                                                                                                                          |
| Lines       | 32–40 (`mergeRetryPolicy` function)                                                                                                                      |
| Severity    | LOW                                                                                                                                                      |
| Description | The spread operator `...override` will naturally propagate `jitterFactor` if present in the override. No explicit merge logic needed.                    |
| Fix         | No action needed — TypeScript structural typing handles this automatically. Verify at review time that the spread correctly picks up the optional field. |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

The `jitterFactor` field is additive and optional. No existing interface contracts, function signatures, or test expectations are broken.

**Interface change:**

```typescript
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  /** Jitter magnitude as a fraction of the delay (0–1). Default: 0.3.
   *  Only effective when jitter === true.
   *  0 = no jitter (deterministic backoff).
   *  1 = full jitter (random between 0 and capped delay).
   *  0.3 = partial jitter (30% of capped delay added randomly).
   */
  jitterFactor?: number;
}
```

**Implementation change in `calculateDelay`:**

```typescript
if (policy.jitter) {
  const factor = policy.jitterFactor ?? 0.3;
  const clampedFactor = Math.max(0, Math.min(1, factor));
  return capped + Math.random() * clampedFactor * capped;
}
```

**Clamping behavior:** Values outside 0–1 are clamped to the valid range. This is defensive — malformed config should not produce unexpected behavior.

**When `jitter: false`**: `jitterFactor` is ignored entirely, regardless of its value. This preserves the semantics: `jitter: false` means deterministic backoff.

**No Zod schema update needed** (if Zod validation of `RetryPolicy` exists at config boundaries) — the optional field flows through spread operators naturally. The B12 task (boundary schema validation) may add Zod schemas for `RetryPolicy`; if so, `jitterFactor` should be added as `z.number().min(0).max(1).optional()` at that point.

### 4.2 What NOT to Do

- Do NOT change the type of `jitter: boolean` — this would be a breaking change.
- Do NOT remove `jitter: boolean` in favor of `jitterFactor: number | false` or a union type — backward compatibility requires keeping the boolean.
- Do NOT change the default behavior — when `jitter: true` and `jitterFactor` is absent, the existing 30% partial jitter must be preserved.
- Do NOT add Zod validation in this task — validation boundary hardening is B12's responsibility.
- Do NOT change `DEFAULT_RETRY.jitter` from `true` — the production-ready default for jitter-enabled retry stays.

---

## 5. Files to Modify

| File                              | Action | Notes                                                  |
| --------------------------------- | ------ | ------------------------------------------------------ |
| `packages/core/src/interfaces.ts` | Modify | Add `jitterFactor?: number` to `RetryPolicy`           |
| `packages/core/src/policies.ts`   | Modify | Update `calculateDelay` to read and use `jitterFactor` |
| `packages/core/src/policies.ts`   | Modify | Optionally add `jitterFactor: 0.3` to `DEFAULT_RETRY`  |

No changes needed to `types.ts` (`ResolvedConfig`) — it uses `RetryPolicy` directly, and the optional field propagates automatically.

---

## 6. Implementation Strategy

### Step 1: Add `jitterFactor` to the `RetryPolicy` interface

Add the optional field to `packages/core/src/interfaces.ts` after the `jitter` field:

```typescript
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: boolean;
  /**
   * Jitter magnitude as a fraction of the delay (0–1).
   * Only effective when jitter === true.
   * 0 = no jitter (deterministic backoff).
   * 1 = full jitter (random between 0 and capped delay).
   * 0.3 = partial jitter (30% of capped delay added randomly).
   * When absent, defaults to 0.3 (preserving current behavior).
   */
  jitterFactor?: number;
}
```

### Step 2: Update `calculateDelay` in `policies.ts`

Modify the jitter calculation block (lines 85–87):

```typescript
if (policy.jitter) {
  const factor = policy.jitterFactor ?? 0.3;
  const clampedFactor = Math.max(0, Math.min(1, factor));
  return capped + Math.random() * clampedFactor * capped;
}
```

### Step 3: Update DEFAULT_RETRY (optional)

Optionally add `jitterFactor: 0.3` to `DEFAULT_RETRY` for explicitness:

```typescript
const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: true,
  jitterFactor: 0.3, // explicit default for clarity
};
```

If added, update the TSDoc on the `DEFAULT_RETRY` export to reference it.

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

1. All existing retry and backoff tests pass without modification (backward compatibility preserved).
2. `calculateDelay` with `jitter: true` and no `jitterFactor` produces jitter within the 0–0.3× range (existing behavior unchanged).
3. `calculateDelay` with `jitter: true` and `jitterFactor: 0` produces ZERO jitter (deterministic).
4. `calculateDelay` with `jitter: true` and `jitterFactor: 0.5` produces jitter within the 0–0.5× range.
5. `calculateDelay` with `jitter: true` and `jitterFactor: 1` produces jitter within the 0–1× range (full jitter).
6. `calculateDelay` with `jitter: true` and `jitterFactor: 1.5` clamps to 1.0 (full jitter).
7. `calculateDelay` with `jitter: true` and `jitterFactor: -0.5` clamps to 0 (no jitter).
8. `calculateDelay` with `jitter: false` and `jitterFactor: 0.5` ignores `jitterFactor` entirely (deterministic backoff).
9. TypeScript compilation does not produce any errors on existing code that constructs `RetryPolicy` without `jitterFactor`.

---

## 8. Risk Assessment

| Risk                                                                         | Likelihood | Impact | Mitigation                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | ---------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Breaking existing code that constructs `RetryPolicy` without the new field   | LOW        | HIGH   | The field is optional (`?`). TypeScript structural typing accepts objects with fewer fields than the interface requires when all required fields are present. No existing code breaks. |
| Backward compatibility: existing `jitter: true` users get different behavior | LOW        | MEDIUM | `jitterFactor` defaults to `0.3` when absent — identical to the current hardcoded value. No behavioral change.                                                                         |
| Clamping is unexpected for valid values like `0.5`                           | LOW        | LOW    | Clamping only affects out-of-range values (negative or >1). Normal usage within 0–1 is unaffected.                                                                                     |
| Merge utility silently drops `jitterFactor`                                  | LOW        | LOW    | The spread `...override` in `mergeRetryPolicy` propagates all enumerable own properties. Add a unit test verifying the field survives merging.                                         |

---

## 9. References

- `.opencode/skill/interfaces/SKILL.md` — `RetryPolicy` interface declaration (§Policy Contracts)
- `.opencode/skill/interfaces/SKILL.md` — Interface modification rules (optional fields only)
- `.opencode/skill/principles/SKILL.md` — Principle 5 (Config Over Code)
- `packages/core/src/interfaces.ts` — Source of truth for `RetryPolicy`
- `packages/core/src/policies.ts` — `calculateDelay`, `DEFAULT_RETRY`, `mergeRetryPolicy`
- `packages/core/src/types.ts` — `ResolvedConfig` type (consumes `RetryPolicy`)
