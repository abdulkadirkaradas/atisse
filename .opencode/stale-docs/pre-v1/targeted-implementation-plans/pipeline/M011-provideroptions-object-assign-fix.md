# M011 — `providerOptions` Object.assign Overwrite Fix

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA pipeline gaps analysis — TD-9 (LOW)

---

## 1. Task Summary

Fix `Object.assign` usage in provider adapters that can overwrite SDK-critical fields like `model`, `stream`, or `max_tokens` when users pass conflicting keys in `providerOptions`. Define a reserved keys set per adapter and validate or protect against conflicts at `PromptRequest` handling time.

---

## 2. Context (Why This Exists)

### Current Behavior

Both provider adapters build `createParams` as a `Record<string, unknown>` with explicitly set SDK fields (`model`, `messages`, `stream`, `max_tokens`, `tools`, etc.), then unconditionally merge user-provided `request.providerOptions` via `Object.assign`:

**OpenAI** (non-streaming, lines 129–131):
```typescript
if (request.providerOptions) {
  Object.assign(createParams, request.providerOptions);
}
```

**OpenAI** (streaming, lines 192–194): Same pattern.

**Anthropic** (non-streaming, line 164):
```typescript
if (request.providerOptions) Object.assign(createParams, request.providerOptions);
```

**Anthropic** (streaming, line 193): Same pattern.

If a user passes `{ model: 'gpt-3.5-turbo' }` in `providerOptions`, the `model` field set on line 113 is overwritten. Similarly, `stream: false` could be overwritten to `stream: true` or vice versa.

### Affected Code Locations

| File                              | Lines                    | Role                              |
| --------------------------------- | ------------------------ | --------------------------------- |
| `provider-openai/src/index.ts`    | 129–131, 192–194         | `Object.assign` in generate/generateStream |
| `provider-anthropic/src/index.ts` | 164, 193                 | `Object.assign` in generate/generateStream |

---

## 3. Issues/Changes

### Issue: User providerOptions can overwrite SDK-critical fields

| Field       | Value                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------- |
| Severity    | LOW                                                                                      |
| Description | `Object.assign` blindly merges user options, allowing overwrite of `model`, `stream`, etc. |
| Fix         | Validate or filter providerOptions for reserved key conflicts                             |

---

## 4. Architectural Directives

### 4.1 Reserved Keys Approach

Each adapter MUST define a set of reserved keys that are set by the adapter itself and MUST NOT be overwritten by user `providerOptions`. The approach: define `RESERVED_PROVIDER_OPTIONS` as a file-level constant in each adapter, and filter/validate providerOptions against it.

```typescript
// In provider-openai/src/index.ts:
const RESERVED_PROVIDER_OPTIONS = new Set([
  'model',
  'messages',
  'stream',
  'max_tokens',
  'tools',
  'tool_choice',  // OpenAI reserves this internally
]);

// In provider-anthropic/src/index.ts:
const RESERVED_PROVIDER_OPTIONS = new Set([
  'model',
  'messages',
  'stream',
  'max_tokens',
  'tools',
  'system',
  'tool_choice',
]);
```

### 4.2 Validation Strategy (Preferred)

At the point where `providerOptions` is merged (before `Object.assign`), validate that none of the user's `providerOptions` keys are in the reserved set:

```typescript
// PREFERRED APPROACH: Validate and throw on conflict
if (request.providerOptions) {
  for (const key of Object.keys(request.providerOptions)) {
    if (RESERVED_PROVIDER_OPTIONS.has(key)) {
      throw new ConfigValidationError([
        `providerOptions key '${key}' is reserved and cannot be overridden`,
      ]);
    }
  }
  Object.assign(createParams, request.providerOptions);
}
```

**Rationale for throwing over silent filtering:**
- Silent filtering hides bugs — user might not realize their option was discarded
- The user intended to set that key — they should know it's not possible
- `ConfigValidationError` at adapter level will surface to the consumer via `handleOrchestratorError` in the pipeline
- Consistent with the kernel's validation philosophy (fail fast, explicit over magical)
- The error happens at request time, not construction time — the user can fix and retry

### 4.3 Implementation Pattern

Both adapters MUST implement this identically. Create a shared helper pattern:

```typescript
/** Validate providerOptions against reserved keys. Throws if conflict found. */
function validateProviderOptions(
  providerOptions: Record<string, unknown>,
  reservedKeys: Set<string>,
): void {
  for (const key of Object.keys(providerOptions)) {
    if (reservedKeys.has(key)) {
      throw new ConfigValidationError([
        `providerOptions key '${key}' is reserved and cannot be overridden`,
      ]);
    }
  }
}
```

This helper is defined once per adapter (file-private). Both adapters MUST import `ConfigValidationError` from `@atisse/core`.

### 4.4 What NOT to Do

- Do NOT change `PromptRequest.providerOptions` — it remains `Record<string, unknown>`
- Do NOT change `AIProvider` interface — already stable
- Do NOT add runtime dependencies to adapters — `ConfigValidationError` is already imported
- Do NOT implement deep merging — simple reserved key check is sufficient for v1
- Do NOT use `Proxy` or getter/setter patterns — they add complexity for a low-value fix
- Do NOT validate at the kernel level — `providerOptions` is opaque to core
- Do NOT add this validation to `MockProvider` — it doesn't use providerOptions

---

## 5. Files to Modify

| File                                  | Action           | Notes                                                                      |
| ------------------------------------- | ---------------- | -------------------------------------------------------------------------- |
| `packages/provider-openai/src/index.ts` | MODIFY (additive) | Add reserved keys set + validation in both `generate` and `generateStream` |
| `packages/provider-anthropic/src/index.ts` | MODIFY (additive) | Add reserved keys set + validation in both `generate` and `generateStream` |

---

## 6. Implementation Strategy

### Step 1: OpenAI Adapter

- Add `RESERVED_PROVIDER_OPTIONS` constant
- Import `ConfigValidationError` (already imported from `@atisse/core` — verify)
- Add validation loop before both `Object.assign` calls (lines 129 and 192)

### Step 2: Anthropic Adapter

- Add `RESERVED_PROVIDER_OPTIONS` constant
- Import `ConfigValidationError` (verify import or add it)
- Add validation loop before both `Object.assign` calls (lines 164 and 193)

### Step 3: Verify

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

---

## 7. Verification Requirements

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:coverage
```

### Specific assertions:

1. **Valid providerOptions:** No reserved keys → adapter works normally
2. **Reserved key conflict:** `{ model: 'gpt-3.5-turbo' }` in providerOptions → `ConfigValidationError` thrown
3. **All reserved keys blocked:** Each key in `RESERVED_PROVIDER_OPTIONS` triggers validation error
4. **Reserved set correctness:** Reserved set contains exactly `model`, `messages`, `stream`, `max_tokens`, `tools` (OpenAI) + `system`, `tool_choice` (Anthropic)
5. **No regression:** All existing tests pass — tests that use valid `providerOptions` continue to work

---

## 8. Risk Assessment

| Risk                                       | Likelihood | Impact | Mitigation                                       |
| ------------------------------------------ | ---------- | ------ | ------------------------------------------------ |
| Reserved key set incomplete                | Low        | Low    | SDK-specific fields are well-documented; review on each SDK version bump |
| Validation throws during streaming setup   | Low        | Low    | Error is thrown before the API call — caught by existing try/catch in generate/generateStream |

---

## 9. References

- `packages/provider-openai/src/index.ts` — Lines 112–131 (non-streaming), 175–194 (streaming)
- `packages/provider-anthropic/src/index.ts` — Lines 155–164 (non-streaming), 183–193 (streaming)
- `packages/core/src/errors.ts` — `ConfigValidationError`
- `packages/core/src/interfaces.ts` — `PromptRequest.providerOptions`
- `.opencode/rules/constraints.md` — Interface modification rules (no change needed)
- `.opencode/rules/philosophy.md` — Principle 1: Explicit Over Magical (validation > silent filtering)
