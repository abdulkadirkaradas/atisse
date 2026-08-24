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

`jitterFactor` follows AWS 'partial jitter factor' literature; `jitterRatio` was considered but `factor` is more common for 0-1 delay fraction.

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

| Field       | Value                                                                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/policies.ts`                                                                                                                                                                                                                      |
| Lines       | 7–12 (`DEFAULT_RETRY` object)                                                                                                                                                                                                                        |
| Severity    | LOW                                                                                                                                                                                                                                                  |
| Description | The default retry policy object defines only `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `jitter`. `jitterFactor` is absent.                                                                                                                         |
| Fix         | Required: add `jitterFactor: 0.3` to `DEFAULT_RETRY` in `packages/core/src/policies.ts:7-12` for single source of truth. Remove 'optional' qualifier. `calculateDelay` fallback `?? 0.3` remains as defense-in-depth but is not the primary default. |

### Issue B8-4: `mergeRetryPolicy` spread will include `jitterFactor` automatically

| Field       | Value                                                                                                                                                                                                                                                |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/policies.ts`                                                                                                                                                                                                                      |
| Lines       | 32–40 (`mergeRetryPolicy` function)                                                                                                                                                                                                                  |
| Severity    | LOW                                                                                                                                                                                                                                                  |
| Description | The spread operator `...override` will naturally propagate `jitterFactor` if present in the override. No explicit merge logic needed.                                                                                                                |
| Fix         | No action needed — TypeScript structural typing handles this automatically. Verify at review time that the spread correctly picks up the optional field. Spread `...override` preserves `0` (falsy-safe); `??` must be used for default, not `\|\|`. |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

The `jitterFactor` field is additive and optional. No existing interface contracts, function signatures, or test expectations are broken. `api-design` says adding optional field = NOT breaking → MINOR. No ADR needed, but changeset required per `git-workflow` skill.

`jitterFactor` follows AWS 'partial jitter factor' literature; `jitterRatio` was considered but `factor` is more common for 0-1 delay fraction.

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

**Required single source of truth — `DEFAULT_RETRY`:**

```typescript
const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30000,
  jitter: true,
  jitterFactor: 0.3,
};
```

`calculateDelay` fallback `?? 0.3` remains as defense-in-depth but is not the primary default; `DEFAULT_RETRY.jitterFactor` is the single source of truth. `mergeRetryPolicy` spread `...override` preserves `0` (falsy-safe).

**Implementation change in `calculateDelay`:**

```typescript
if (policy.jitter) {
  const factor = policy.jitterFactor ?? 0.3; // DO NOT use || — 0 is valid, use ??
  if (!Number.isFinite(factor))
    throw new ConfigValidationError('jitterFactor must be a finite number in [0, 1]');
  // clamp is defense-in-depth, authoritative validation is in orchestrator.ts
  const clampedFactor = Math.max(0, Math.min(1, factor));
  return capped + Math.random() * clampedFactor * capped;
}
```

Note: `Math.max(0, Math.min(1, NaN))` → `NaN` would propagate a NaN delay; the `isFinite` guard above prevents this bug.

**Clamp vs ConfigValidationError fail-fast:** `calculateDelay` keeps clamping as defense-in-depth, but `packages/core/src/orchestrator.ts` constructor must validate `retry.jitterFactor` when present: `!Number.isFinite(factor) || factor<0 || factor>1` → throw `ConfigValidationError`. When B12 Zod schema (`z.number().min(0).max(1).optional()`) lands, remove the manual clamp and delegate validation to Zod.

**When `jitter: false`**: `jitterFactor` is ignored entirely, regardless of its value. This preserves the semantics: `jitter: false` means deterministic backoff.

**No Zod schema update needed in this task** — the optional field flows through spread operators naturally. The B12 task (boundary schema validation) may add Zod schemas for `RetryPolicy`; if so, `jitterFactor` should be added as `z.number().min(0).max(1).optional()` at that point.

### 4.2 What NOT to Do

- Do NOT change the type of `jitter: boolean` — this would be a breaking change.
- Do NOT remove `jitter: boolean` in favor of `jitterFactor: number | false` or a union type — backward compatibility requires keeping the boolean.
- Do NOT change the default behavior — when `jitter: true` and `jitterFactor` is absent, the existing 30% partial jitter must be preserved.
- Do NOT add Zod validation in this task beyond the `orchestrator.ts` fail-fast check — full validation boundary hardening is B12's responsibility.
- Do NOT change `DEFAULT_RETRY.jitter` from `true` — the production-ready default for jitter-enabled retry stays.
- Do NOT use `||` for `jitterFactor` default — `0` is valid; use `??`.

---

## 5. Files to Modify

| File                                  | Action | Notes                                                                                                                |
| ------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`     | Modify | Add `jitterFactor?: number` to `RetryPolicy`                                                                         |
| `packages/core/src/policies.ts`       | Modify | Update `calculateDelay` to read and use `jitterFactor` (with `??` + `isFinite` guard + clamp)                        |
| `packages/core/src/policies.ts`       | Modify | Required: add `jitterFactor: 0.3` to `DEFAULT_RETRY` (`packages/core/src/policies.ts:7-12`) — single source of truth |
| `packages/core/src/orchestrator.ts`   | Modify | Validate `retry.jitterFactor` 0–1 + `isFinite` → `ConfigValidationError` (lines 84–99, 102–110)                      |
| `.changeset/<id>.md`                  | NEW    | MINOR bump for `RetryPolicy.jitterFactor` (required per `git-workflow` skill)                                        |
| `.opencode/skill/interfaces/SKILL.md` | Modify | Update `RetryPolicy` snippet (or mark as docs follow-up)                                                             |
| `docs/getting-started.md`             | Modify | Update policy table (or mark as docs follow-up)                                                                      |
| `packages/core/README.md`             | Modify | Update policy table (or mark as docs follow-up)                                                                      |

No changes needed to `types.ts` (`ResolvedConfig` `packages/core/src/types.ts:34`) — it uses `RetryPolicy` directly, and the optional field propagates automatically. `profiles.ts:119,143` profile merge preserves the field via spread.

---

## 6. Implementation Strategy

### Step 1: Add `jitterFactor` to the `RetryPolicy` interface

Add the optional field to `packages/core/src/interfaces.ts:220-229` after the `jitter` field:

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

### Step 2: Update `calculateDelay` in `policies.ts` and add validation in `orchestrator.ts`

Modify the jitter calculation block in `packages/core/src/policies.ts:76-90`:

```typescript
if (policy.jitter) {
  const factor = policy.jitterFactor ?? 0.3; // DO NOT use || — 0 is valid, use ??
  if (!Number.isFinite(factor))
    throw new ConfigValidationError('jitterFactor must be a finite number in [0, 1]');
  // clamp is defense-in-depth, authoritative validation is in orchestrator.ts
  const clampedFactor = Math.max(0, Math.min(1, factor));
  return capped + Math.random() * clampedFactor * capped;
}
```

Add fail-fast validation in `packages/core/src/orchestrator.ts` constructor (around lines 84–99, 102–110):

```typescript
if (config.retry?.jitterFactor !== undefined) {
  const factor = config.retry.jitterFactor;
  if (!Number.isFinite(factor) || factor < 0 || factor > 1) {
    throw new ConfigValidationError('retry.jitterFactor must be a finite number in [0, 1]');
  }
}
```

When B12 Zod schema (`z.number().min(0).max(1).optional()`) lands, remove the manual clamp and delegate validation to Zod.

### Step 3: Update DEFAULT_RETRY (required)

Add `jitterFactor: 0.3` to `DEFAULT_RETRY` in `packages/core/src/policies.ts:7-12` — required for single source of truth:

```typescript
const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: true,
  jitterFactor: 0.3,
};
```

`calculateDelay` fallback `policy.jitterFactor ?? 0.3` remains as defense-in-depth but is not the primary default. Update the TSDoc on the `DEFAULT_RETRY` export to reference it.

### Step 4: Create changeset (required)

Create `.changeset/<id>.md` with MINOR bump per `api-design` (adding optional field = NOT breaking) and `git-workflow` skill:

```markdown
---
'@atisse/core': minor
---

Add optional `jitterFactor` to `RetryPolicy` for configurable partial jitter magnitude
```

---

## 7. Verification Requirements

After implementation, run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

Specific assertions to verify (14 assertions):

1. All existing retry and backoff tests pass without modification (backward compatibility preserved).
2. `calculateDelay` with `jitter: true` and no `jitterFactor` produces jitter within the 0–0.3× range (existing behavior unchanged).
3. `calculateDelay` with `jitter: true` and `jitterFactor: 0` produces ZERO jitter (deterministic).
4. `calculateDelay` with `jitter: true` and `jitterFactor: 0.5` produces jitter within the 0–0.5× range.
5. `calculateDelay` with `jitter: true` and `jitterFactor: 1` produces jitter within the 0–1× range (full jitter).
6. `calculateDelay` with `jitter: true` and `jitterFactor: 1.5` clamps to 1.0 (full jitter) — defense-in-depth path; orchestrator validation should throw `ConfigValidationError` before reaching this.
7. `calculateDelay` with `jitter: true` and `jitterFactor: -0.5` clamps to 0 (no jitter) — defense-in-depth path; orchestrator validation should throw `ConfigValidationError` before reaching this.
8. `calculateDelay` with `jitter: false` and `jitterFactor: 0.5` ignores `jitterFactor` entirely (deterministic backoff).
9. TypeScript compilation does not produce any errors on existing code that constructs `RetryPolicy` without `jitterFactor`.
10. `DEFAULT_RETRY.jitterFactor === 0.3` (single source of truth).
11. `mergeRetryPolicy(base, { jitterFactor: 0 })` preserves `0` (falsy-safe) — including via profile merge paths `profiles.ts:119,143`.
12. `jitterFactor: NaN/Infinity/-0.5/1.5 → ConfigValidationError` via `orchestrator.ts` validation; `calculateDelay` `isFinite` guard prevents `NaN` delay bug (`Math.max(0,Math.min(1,NaN)) → NaN`).
13. `pnpm changeset` MINOR created, `interfaces` skill + docs tables updated or N/A reason documented.
14. `isRetryable` unaffected, existing `policies.test.ts:34-157` jitter tests pass as regression.

Note: `Math.random` must be mocked for deterministic jitter range tests (existing `policies.test.ts:62-76` pattern).

---

## 8. Risk Assessment

| Risk                                                                         | Likelihood | Impact | Mitigation                                                                                                                                                                                            |
| ---------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Breaking existing code that constructs `RetryPolicy` without the new field   | LOW        | HIGH   | The field is optional (`?`). TypeScript structural typing accepts objects with fewer fields than the interface requires when all required fields are present. No existing code breaks.                |
| Backward compatibility: existing `jitter: true` users get different behavior | LOW        | MEDIUM | `jitterFactor` defaults to `0.3` via `DEFAULT_RETRY` (single source of truth) + `calculateDelay` defense-in-depth fallback `?? 0.3` — identical to the current hardcoded value. No behavioral change. |
| Clamping is unexpected for valid values like `0.5`                           | LOW        | LOW    | Clamping only affects out-of-range values (negative or >1). Normal usage within 0–1 is unaffected. Authoritative validation is `ConfigValidationError` in `orchestrator.ts` fail-fast.                |
| `jitterFactor: NaN/Infinity → NaN delay`                                     | MEDIUM     | MEDIUM | `isFinite` validation (C3) in `orchestrator.ts` + `calculateDelay` guard prevents `Math.max(0,Math.min(1,NaN)) → NaN` propagation.                                                                    |
| Merge utility silently drops `jitterFactor`                                  | LOW        | LOW    | The spread `...override` in `mergeRetryPolicy` propagates all enumerable own properties and preserves `0` (falsy-safe). Verified via assertion 11 including profile merge paths.                      |

Optional field is non-breaking; strict `'jitterFactor' in policy` checks are edge-case LOW — no existing code does this, and new code should use `??` default.

---

## 9. References

- `.opencode/skill/interfaces/SKILL.md` — `RetryPolicy` interface declaration (§Policy Contracts)
- `.opencode/skill/interfaces/SKILL.md` — Interface modification rules (optional fields only)
- `.opencode/skill/principles/SKILL.md` — Principle 5 (Config Over Code)
- `packages/core/src/interfaces.ts:220-229` — Source of truth for `RetryPolicy`
- `packages/core/src/policies.ts:7-12,32-40,76-90` — `calculateDelay`, `DEFAULT_RETRY`, `mergeRetryPolicy`
- `packages/core/src/orchestrator.ts:84-99,102-110` — Constructor validation for `retry.jitterFactor`
- `packages/core/src/types.ts:34` — `ResolvedConfig` type (consumes `RetryPolicy`)
- `packages/core/src/profiles.ts:119,143` — Profile merge paths preserving `jitterFactor`
