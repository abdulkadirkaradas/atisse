# B10–B13 — Provider Interface Extensions: Token Estimation + Capability Declarations

**Status:** Ready for SPBED implementation
**Type:** REVISION_REQUIRED.ARCHITECTURE (return to SPSA for review after implementation)
**Source:** SPSA final evaluation and roadmap

---

## 1. Task Summary

### Phase 1 (B10): `estimateTokens()` on `AIProvider`

1. Add optional `estimateTokens?(text: string): number` method to the `AIProvider` interface in `packages/core/src/interfaces.ts`.
2. Update `PromptComposer` to call `activeProvider.estimateTokens(text)` when available; fall back to `Math.ceil(text.length / 4)` when absent.
3. Update `MockProvider` to support `estimateTokens()` — expose a configurable estimator function (default `Math.ceil(text.length / 4)`).
4. Implement `estimateTokens()` in `provider-openai` (using `tiktoken` or a model-specific approximation table).
5. Implement `estimateTokens()` in `provider-anthropic` (using Anthropic's tokenizer or an approximation).

### Phase 2 (B13): Provider Capability Extensions

1. Add new **optional** boolean fields to `ProviderCapabilities`: `structuredOutput?: boolean` (default `false`), `functionCalling?: boolean` (default `false` — see C2 deduplication note below; preferred: drop and reuse existing `toolCalling`).
2. Update `ProviderCapabilities` interface with the new optional fields (default `false` via falsy check — see §4.1 C1).
3. Add pre-flight validation in `orchestrator.ts` `run()` entry **after `resolveConfig`**: when a user requests a feature whose required capability is falsy/`=== false`, throw `ConfigValidationError` (also check `fallbackProvider`).
4. Update `MockProvider` capabilities declaration to expose these optional fields.
5. Update `provider-openai` and `provider-anthropic` capability declarations to reflect actual feature support (remove duplication — do not set both `toolCalling` and `functionCalling` to `true` redundantly).

> **Hard Stop note (C4):** B13 as optional → MINOR, SPSA review + no user ADR needed; if were required → MAJOR + ADR + user approval required (rejected). This plan implements the MINOR optional path per SPSA REJECT verdict on breaking C1.

**Both phases are independent and can be implemented in parallel.**

---

## 2. Context (Why This Exists)

### Phase 1 (B10) — Token Estimation Is a Rough Approximation

The current token estimation in `PromptComposer.estimateTokens()` is `Math.ceil(text.length / 4)` — a rough approximation that can be 2–3× off from actual token counts. For OpenAI models, this can cause:

- **Over-estimation**: unnecessary memory trimming, reducing context utility.
- **Under-estimation**: context window overflow (silent truncation by provider).

The `AIProvider` interface is the natural place for each provider to provide accurate estimation, since each provider uses its own tokenizer (`tiktoken` for OpenAI, Anthropic's SDK-internal tokenizer for Claude). The `estimateTokens()` method is optional — providers that don't implement it still work with the fallback approximation.

### Phase 2 (B13) — Capabilities Need Extension

`ProviderCapabilities` currently has `streaming: boolean`, `toolCalling: boolean`, `vision: boolean` (documentation only), and `maxContextTokens: number`. As providers diverge in feature support, the orchestrator needs to know at config time what features are available.

Currently violations are caught at `run()` entry (e.g., the streaming guard `provider.capabilities.streaming === false` → `ConfigValidationError`). Explicit capability declarations shift more of these checks from runtime errors to configuration-time (or `run()`-entry) errors, improving the developer experience.

This follows **Principle 1 (Explicit Over Magical)** — providers explicitly declare what they support, rather than failing silently at runtime.

---

## 3. Issues/Changes

### Phase 1 — Issue B10: No Provider-Specific Token Estimation

| Field       | Value                                                                                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| File        | `packages/core/src/interfaces.ts`                                                                                                                                        |
| Lines       | `AIProvider` interface (lines 59–64)                                                                                                                                     |
| Severity    | MEDIUM                                                                                                                                                                   |
| Description | `AIProvider` has no `estimateTokens()` method. Token estimation uses `Math.ceil(text.length / 4)` — a rough approximation that can be 2–3× off from actual token counts. |
| Fix         | Add optional `estimateTokens?(text: string): number` method to `AIProvider`.                                                                                             |

| Field       | Value                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| File        | `packages/core/src/prompt-composer.ts`                                                                                         |
| Lines       | `estimateTokens()` method (lines 128–143), `estimateMessageTokens()` (lines 115–117), `calculateTotalTokens()` (lines 151–157) |
| Severity    | MEDIUM                                                                                                                         |
| Description | `PromptComposer` always uses `Math.ceil(content.length / 4)`. Has no way to delegate to a provider-specific estimator.         |
| Fix         | Pass `AIProvider` (or `estimateTokens` function) to `PromptComposer.compose()`. Use provider's estimator when available.       |

| Field       | Value                                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| File        | `packages/core/src/testing/mock-provider.ts`                                                                                               |
| Lines       | N/A — new method                                                                                                                           |
| Severity    | LOW                                                                                                                                        |
| Description | `MockProvider` does not support `estimateTokens()`. Tests cannot simulate provider-specific token estimation.                              |
| Fix         | Add `estimateTokens?(text: string): number` method. Expose as optional constructor/config option. Default to `Math.ceil(text.length / 4)`. |

### Phase 2 — Issue B13: Limited Provider Capability Declarations

| Field       | Value                                                                                                                                                                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts`                                                                                                                                                                                                                        |
| Lines       | `ProviderCapabilities` interface (lines 69–74)                                                                                                                                                                                                           |
| Severity    | LOW                                                                                                                                                                                                                                                      |
| Description | `ProviderCapabilities` has `streaming`, `toolCalling`, `vision`, `maxContextTokens`. Missing explicit capability flags for `structuredOutput`, `functionCalling`.                                                                                        |
| Fix         | Add `structuredOutput?: boolean` and `functionCalling?: boolean` as **optional** fields (default `false` via falsy/`=== false` check — see §4.1 C1/C2). `vision` already exists (lines 71–73) — ensure it's documented/used in validation, not re-added. |

| Field       | Value                                                                                                                                                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/orchestrator.ts`                                                                                                                                                                                    |
| Lines       | `run()` entry validation (streaming guard, fallback guard) — see `orchestrator.ts:160-201` and `types.ts:22` `ResolvedConfig.tools: Map<string,Tool>`                                                                  |
| Severity    | LOW                                                                                                                                                                                                                    |
| Description | Only streaming + fallback have pre-flight capability checks. `structuredOutput` and `functionCalling` have no config-time validation.                                                                                  |
| Fix         | Add pre-flight validation **after `resolveConfig`**: if user config implies a capability that the provider lacks (`=== false` or falsy), throw `ConfigValidationError` (check both `provider` and `fallbackProvider`). |

| Field       | Value                                                                                                                        |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/testing/mock-provider.ts`                                                                                 |
| Lines       | Constructor capabilities initialization (lines 60–65)                                                                        |
| Severity    | LOW                                                                                                                          |
| Description | `MockProvider` needs to declare the new capability fields.                                                                   |
| Fix         | Add `structuredOutput?: false` and `functionCalling?: true` (or omit and rely on `toolCalling` — see C2) as optional fields. |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**B10 — Token Estimation:**

- `AIProvider.estimateTokens?` is an **optional** method. When absent, core falls back to `Math.ceil(text.length / 4)`.
- `PromptComposer.compose()` gains an optional parameter `estimateTokenFn?: (text: string) => number`. When provided, the composer uses it for all token estimation. If absent, uses the existing `Math.ceil(text.length / 4)`.
- `PromptComposer.estimateTokens()` and `estimateMessageTokens()` are refactored to use the injected function when available.
- Pipeline passes `activeProvider.estimateTokens?.bind(activeProvider)` as the `estimateTokenFn` to `PromptComposer.compose()`.
- `MockProvider.estimateTokens?` is configurable via options object (see M2):
  ```typescript
  interface MockProviderOptions {
    estimateTokens?: (text: string) => number;
    capabilities?: Partial<ProviderCapabilities>;
  }
  // constructor(id = 'mock-test', options?: MockProviderOptions)
  // or constructor(options?: MockProviderOptions)
  ```
  Default estimator: `(text) => Math.ceil(text.length / 4)`. Method handling: if `estimateTokens` exists call it, else fallback to `Math.ceil/4`.
- Provider adapters implement `estimateTokens()`:
  - `provider-openai`: Use `tiktoken` package via lazy `import('tiktoken')` + `encoding_for_model(modelName)` → `.encode(text).length` (sync `number`). `tiktoken` is **NOT** currently in `provider-openai/package.json` `peerDependencies` (only `openai` is); grep shows only `prompt-composer.ts` V2 candidate. Make it an **optional peerDependency or devDependency** with lazy import + fallback `Math.ceil/4`, document `tsup` external handling, security S-8 audit. Model name extraction from `this.id` (e.g., `'openai-gpt-4o'` → `'gpt-4o'`).
  - `provider-anthropic`: Anthropic SDK has no token counter — use approximation table (sync `number`) for known Claude models. `estimateTokens` is sync `number` — `tiktoken.encode().length` is sync OK, Anthropic approximation is sync.
  - Both: Fall back to `Math.ceil(text.length / 4)` when the model-specific tokenizer is unavailable.

**B13 — Capability Extensions (C1 — REJECT breaking, implement optional):**

- New capability fields are **optional booleans defaulting to `false`** (falsy check).

  ```typescript
  export interface ProviderCapabilities {
    streaming: boolean;
    toolCalling: boolean;
    vision: boolean;
    maxContextTokens: number;
    structuredOutput?: boolean; // default false
    functionCalling?: boolean; // default false — or REMOVE and use existing toolCalling, see C2
  }
  ```

  > **C1 note:** `constraints:33` + `api-design:39` required field = MAJOR, rejected; optional keeps MINOR. Orchestrator/pipeline checks use `!capabilities.functionCalling` / `=== false` falsy default (undefined → false). Previous breaking proposal required all construction sites to add fields — now additive, existing code unaffected, TypeScript does not enforce. Approved as MINOR additive optional — no user ADR for breaking required.

- **C2 — functionCalling vs toolCalling deduplication:** Do NOT add `functionCalling` as required duplicating `toolCalling` (`interfaces.ts:69-74` already has `toolCalling: boolean`). Either **drop `functionCalling` and use `toolCalling`**, or document as optional alias with TSDoc `'alias of toolCalling for OpenAI function calling, default false'` and keep both optional. Plan currently sets both `true` in `provider-openai:120-125` and `provider-anthropic:164-169` — remove duplication. Alternative note referencing `final-evaluation-and-roadmap:66` which defines B13 as `structuredOutput`, `vision` (not `functionCalling`) — align scope, remove `functionCalling` if not needed. If `structuredOutput` not consumed, either drop from B13 scope or open ADR `'Geçici boolean → v2 Set<string> supports(feature)'` — do NOT scaffold for later per `constraints` (see M5).

- Pre-flight validation in `orchestrator.ts` `run()` entry **after `resolveConfig`** (see M4):
  - When `stream: true` and `!provider.capabilities.streaming`: existing guard.
  - When `resolvedConfig.tools.size > 0` (`types.ts:22` `ResolvedConfig.tools is Map<string,Tool>`, `orchestrator.ts:160-201` `run()` vs `this.config` distinction) and `resolvedConfig.provider.capabilities.functionCalling === false` (or `!capabilities.functionCalling` falsy default): new `ConfigValidationError`. Also check `fallbackProvider`.
  - `structuredOutput` validation is reserved for future use (no current consumer) — add optional field but no pre-flight check yet. If not consumed, drop per M5.
- The existing `vision` field is already `boolean` at `ProviderCapabilities:71-73` — no change needed, clarify not re-adding, ensure documented/used in validation (N1).

> **V2_EVOLUTION_PATH:** This milestone adds `structuredOutput` and `functionCalling` optional booleans to `ProviderCapabilities` (delivered in v1.1.0). These are a provisional v1 surface; v2 will replace the fixed-field boolean model with a `Set<string>` / `supports(feature)` extensible model. Treat the booleans as throwaway scaffolding. If `structuredOutput` not consumed, either drop from B13 scope or open ADR — do NOT scaffold for later per `constraints` (M5).

### 4.2 What NOT to Do

- **B10:** Do NOT add a tokenizer dependency to core (`tiktoken`, etc.) — tokenizer lives on provider adapters. Do NOT add `tiktoken` to `core` — adapter-only optional peer (S-8 audit).
- **B10:** Do NOT change the `PromptComposer` public API in a breaking way — `estimateTokenFn` is an optional parameter.
- **B10:** Do NOT make `estimateTokens` a required method — providers that don't implement it must still work.
- **B10:** Do NOT expose `estimateTokens` on `OrchestratorConfig` or `RunInput` — it's a provider-level feature.
- **B13:** Do NOT change the `streaming: boolean` field — it already exists and is used.
- **B13:** Do NOT add `functionCalling` as required field duplicating `toolCalling` — choose one; keep both optional if both kept, document alias. Do NOT add `functionCalling` as required duplicating `toolCalling` (`interfaces.ts:69-74` already has `toolCalling: boolean`). Either drop `functionCalling` and use `toolCalling`, or document as optional alias with TSDoc `'alias of toolCalling for OpenAI function calling, default false'` and keep both optional.
- **B13:** Do NOT make capability fields required via breaking change — keep optional (`structuredOutput?: boolean`, `functionCalling?: boolean`) with falsy default `false`; required = MAJOR rejected (C1).
- **B13:** Do NOT add capability negotiation logic (e.g., capability downgrading or feature negotiation) — just pre-flight validation.
- **B13:** Do NOT validate `structuredOutput` in v1.1.0 — field is additive with no consumer yet; if not consumed, drop or ADR per M5, do NOT scaffold.
- **B13:** Do NOT add `tiktoken` to `core` — adapter-only optional peer.

---

## 5. Files to Modify

### Phase 1 (B10)

| File                                         | Action    | Notes                                                                                                                                                                                                                  |
| -------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`            | MODIFY    | Add optional `estimateTokens?` to `AIProvider`                                                                                                                                                                         |
| `packages/core/src/prompt-composer.ts`       | MODIFY    | Add optional `estimateTokenFn` parameter to `compose()`; use it when provided (lines 128–143 `estimateTokens()`, 115–117 `estimateMessageTokens()`, 151–157 `calculateTotalTokens()` — update line numbers vs current) |
| `packages/core/src/pipeline.ts:300-476`      | MODIFY    | Pass `activeProvider.estimateTokens?.bind(activeProvider)` to composer (in `initializePipeline()`, Step 4 PROMPT_COMPOSED — `pipeline.ts:435-441` / `435-476`) — note: B1A sonrası `pipeline/shared.ts`'e taşınacak    |
| `packages/core/src/testing/mock-provider.ts` | MODIFY    | Add `estimateTokens?` method, configurable via `MockProviderOptions` options object (M2)                                                                                                                               |
| `packages/core/src/testing/index.ts`         | No change | MockProvider type exports unchanged                                                                                                                                                                                    |
| `packages/provider-openai/src/index.ts`      | MODIFY    | Implement `estimateTokens()` using `tiktoken` (optional peerDependency + lazy `import('tiktoken')` + fallback) or approximation                                                                                        |
| `packages/provider-anthropic/src/index.ts`   | MODIFY    | Implement `estimateTokens()` using approximation table (Anthropic SDK has no token counter — sync number)                                                                                                              |

### Phase 2 (B13)

| File                                         | Action | Notes                                                                                                                                                                                   |
| -------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`            | MODIFY | Add `structuredOutput?: boolean` (default false), `functionCalling?: boolean` (default false — or remove per C2) to `ProviderCapabilities` as optional                                  |
| `packages/core/src/orchestrator.ts`          | MODIFY | Add pre-flight validation for `functionCalling`/`toolCalling` capability **after `resolveConfig`** (`orchestrator.ts:160-201` `run()` vs `this.config`) — also check `fallbackProvider` |
| `packages/core/src/testing/mock-provider.ts` | MODIFY | Add new capability fields to constructor default as optional (`MockProviderOptions` `capabilities?: Partial<ProviderCapabilities>`)                                                     |
| `packages/provider-openai/src/index.ts`      | MODIFY | Declare actual capabilities (e.g., `structuredOutput: true` for GPT-4o if kept, `toolCalling` already true — do NOT duplicate `functionCalling: true` unless alias documented)          |
| `packages/provider-anthropic/src/index.ts`   | MODIFY | Declare actual capabilities (e.g., `structuredOutput: true` for Claude 3+ if kept — align with `final-evaluation-and-roadmap:66` scope; do NOT duplicate `functionCalling`)             |

---

## 6. Implementation Strategy

### Phase 1 — Step 1: Add `estimateTokens?` to `AIProvider`

- Open `packages/core/src/interfaces.ts`.
- Add to the `AIProvider` interface:
  ```typescript
  export interface AIProvider {
    readonly id: string;
    readonly capabilities: ProviderCapabilities;
    generate(request: PromptRequest): Promise<PromptResponse>;
    generateStream?(request: PromptRequest): Promise<AsyncIterable<StreamChunk>>;
    /** Optional provider-specific token estimator. When absent, core uses Math.ceil(text.length / 4). */
    estimateTokens?(text: string): number;
  }
  ```

### Phase 1 — Step 2: Update `PromptComposer` to Accept Estimator

- Open `packages/core/src/prompt-composer.ts`.
- Add an optional `estimateTokenFn` parameter to `compose()`:
  ```typescript
  export interface ComposeParams {
    systemPrompt?: string;
    contextMessages: SystemMessage[];
    memoryMessages: Message[];
    userPrompt: string;
    maxTokens?: number;
    /** Optional custom token estimator. Defaults to Math.ceil(text.length / 4). */
    estimateTokenFn?: (text: string) => number;
  }
  ```
- In `compose()`, store the estimator:
  ```typescript
  const estimate = params.estimateTokenFn ?? ((text: string) => Math.ceil(text.length / 4));
  ```
- Refactor `estimateTokens()` to accept and use the estimator, or pass it as a parameter through the private methods.
- Update `estimateMessageTokens()`, `estimateTokens()`, and `calculateTotalTokens()` to use the injected estimator function.

### Phase 1 — Step 3: Update `MockProvider` with `estimateTokens()` (M2)

- Open `packages/core/src/testing/mock-provider.ts`.
- Replace positional constructor with options object:
  ```typescript
  interface MockProviderOptions {
    estimateTokens?: (text: string) => number;
    capabilities?: Partial<ProviderCapabilities>;
  }

  // Preferred:
  constructor(id = 'mock-test', options?: MockProviderOptions)
  // Alternative: constructor(options?: MockProviderOptions) with id inside options
  ```
  Note: method `estimateTokens?(text: string): number` handling — if exists call it, else fallback `Math.ceil(text.length / 4)`.
- Add method:
  ```typescript
  estimateTokens(text: string): number {
    return this.options?.estimateTokens?.(text) ?? Math.ceil(text.length / 4);
  }
  ```
  Or if using `private estimateTokensFn`:
  ```typescript
  estimateTokens(text: string): number {
    return this.estimateTokensFn?.(text) ?? Math.ceil(text.length / 4);
  }
  ```

### Phase 1 — Step 4: Wire into Pipeline (M1 + C3)

- Open `packages/core/src/pipeline.ts:300-476` `initializePipeline()` (B1A sonrası `pipeline/shared.ts`'e taşınacak).
- In the `PROMPT_COMPOSED` step of `initializePipeline()` (`pipeline.ts:435-441` / `435-476`), pass the provider's estimator **and** use `estimateTokens` for memory budget calculation — single source, DRY:
  ```typescript
  const estimate =
    config.provider.estimateTokens?.bind(config.provider) ??
    ((t: string) => Math.ceil(t.length / 4));
  const messages = composer.compose({
    systemPrompt: config.systemPrompt,
    contextMessages,
    memoryMessages,
    userPrompt: input.prompt,
    maxTokens: config.provider.capabilities.maxContextTokens,
    estimateTokenFn: estimate,
  });
  // Memory budget calculation must also use estimateTokenFn:
  // budget = activeProvider.capabilities.maxContextTokens - estimate(systemPrompt) - ...
  ```
  Memory budget calculation must use `estimateTokenFn`: `const estimate = config.provider.estimateTokens?.bind(config.provider) ?? (t => Math.ceil(t.length/4))` and `composer.compose({...estimateTokenFn: estimate})` plus budget `activeProvider.capabilities.maxContextTokens - estimate(systemPrompt) - ...` single source (M1). Update all B10 Step 4 `pipeline.ts:435-476` refs accordingly (N2).

### Phase 1 — Step 5: Implement in Provider Adapters (M3)

- **`provider-openai`**: Add `estimateTokens()` that uses `tiktoken`'s `encoding_for_model(modelName)` to get the encoder and call `.encode(text).length` (sync `number` — N3).
  - Model name extraction from `this.id` (e.g., `'openai-gpt-4o'` → `'gpt-4o'`).
  - `tiktoken` is **NOT** in `provider-openai/package.json` `peerDependencies` (only `openai`); grep shows only `prompt-composer.ts` V2 candidate. Make it **optional peerDependency or devDependency + lazy `import('tiktoken')` + fallback `Math.ceil/4`**, document `tsup` external handling, security S-8 audit. `tiktoken.encode().length` is sync OK.
  - Fall back to `Math.ceil(text.length / 4)` when `tiktoken` is unavailable or model unknown.
- **`provider-anthropic`**: Add `estimateTokens()` using approximation table (sync `number` — N3).
  - Anthropic SDK has no token counter — use approximation table (sync `number`) for known Claude models (M3).
  - Fall back to `Math.ceil(text.length / 4)` when unavailable.

### Phase 1 — Step 6: Verify B10

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage` for all packages.

### Phase 2 — Step 7: Add Capability Fields to `ProviderCapabilities` (C1)

- Open `packages/core/src/interfaces.ts`.
- Update `ProviderCapabilities` (non-breaking optional):
  ```typescript
  export interface ProviderCapabilities {
    streaming: boolean;
    toolCalling: boolean;
    vision: boolean;
    maxContextTokens: number;
    structuredOutput?: boolean; // default false
    functionCalling?: boolean; // default false — or REMOVE and use existing toolCalling, see C2
  }
  ```
  > C1 note: `constraints:33` + `api-design:39` required field = MAJOR, rejected; optional keeps MINOR. Orchestrator/pipeline checks use `!capabilities.functionCalling` / `=== false` falsy default (undefined → false).

### Phase 2 — Step 8: Update Provider Capability Declarations (C2)

- **`MockProvider`**: Update constructor defaults (optional fields):
  ```typescript
  this.capabilities = {
    streaming: true,
    toolCalling: true,
    vision: false,
    maxContextTokens: 128_000,
    structuredOutput: false, // optional — may omit
    functionCalling: true, // optional alias — or omit and use toolCalling per C2
  };
  // With MockProviderOptions: capabilities?: Partial<ProviderCapabilities> merges defaults
  ```
  Note: Do NOT add `functionCalling` as required duplicating `toolCalling` — either drop and use `toolCalling`, or keep both optional with TSDoc alias `'alias of toolCalling for OpenAI function calling, default false'`. Remove duplication where plan sets both `true` (`provider-openai:120-125`, `provider-anthropic:164-169`).
- **`provider-openai`**: Set `structuredOutput: true` for models that support it (GPT-4o, GPT-4o-mini) if kept, `toolCalling: true` already exists — do NOT duplicate `functionCalling: true` unless alias documented. Align with `final-evaluation-and-roadmap:66` which defines B13 as `structuredOutput`, `vision` (not `functionCalling`) — remove `functionCalling` if not needed (C2).
- **`provider-anthropic`**: Set `structuredOutput: true` for Claude 3+ models if kept — align scope per C2; do NOT duplicate `functionCalling`.

### Phase 2 — Step 9: Add Pre-Flight Validation in `orchestrator.ts` (M4)

- Open `packages/core/src/orchestrator.ts`.
- In the `run()` method (`orchestrator.ts:160-201`), add capability validation **after `resolveConfig`** (not before — `types.ts:22` `ResolvedConfig.tools is Map<string,Tool>` vs `this.config` distinction):

  ```typescript
  const resolvedConfig = resolveConfig(this.config, input.profile, this.tools);
  if (
    resolvedConfig.tools.size > 0 &&
    resolvedConfig.provider.capabilities.functionCalling === false
  ) {
    throw new ConfigValidationError(['provider does not support function calling']);
  }
  // also check fallbackProvider
  if (
    resolvedConfig.fallbackProvider &&
    resolvedConfig.tools.size > 0 &&
    resolvedConfig.fallbackProvider.capabilities.functionCalling === false
  ) {
    throw new ConfigValidationError(['fallbackProvider does not support function calling']);
  }
  // Prefer: if using toolCalling instead of functionCalling per C2:
  // if (resolvedConfig.tools.size > 0 && !resolvedConfig.provider.capabilities.toolCalling) { ... }
  ```

  Note: `types.ts:22` `ResolvedConfig.tools is Map<string,Tool>`, `orchestrator.ts:160-201` `run()` vs `this.config` distinction — validate `resolvedConfig` after `resolveConfig`.

### Phase 2 — Step 10: Verify B13

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage` for all packages.
- All existing tests pass unchanged (optional fields — no TypeScript enforcement for missing fields; `undefined` → falsy `false`).

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

- **B10:**
  - When `estimateTokens` is defined on a provider, `PromptComposer` uses it instead of `Math.ceil(text.length / 4)`.
  - When `estimateTokens` is undefined, fallback `Math.ceil(text.length / 4)` is used.
  - `MockProvider.estimateTokens()` returns configurable values (defaults to `Math.ceil(text.length / 4)`) via `MockProviderOptions`.
  - Provider adapters expose `estimateTokens()` returning reasonable values (verified via unit test with known text).
  - `estimateTokens('hello world')` ≈ `tiktoken` value fallback test — when `tiktoken` unavailable, fallback `Math.ceil/4` used.
  - Memory budget calculation uses `estimateTokenFn` single source (M1): `activeProvider.capabilities.maxContextTokens - estimate(systemPrompt) - ...`.
  - All existing tests pass unchanged.

- **B13:**
  - `ProviderCapabilities` has `structuredOutput?: boolean` and `functionCalling?: boolean` as optional fields (default `false` via falsy check); `vision` already exists (`71-73`) — not re-added, documented (N1).
  - All `ProviderCapabilities` construction sites may omit new fields (optional) — no TypeScript breakage.
  - When `tools` are configured and `provider.capabilities.functionCalling === false` (or falsy `undefined`), `run()` throws `ConfigValidationError` **after `resolveConfig`** (M4) — also check `fallbackProvider`.
  - When `stream: true` and `provider.capabilities.streaming === false`, existing guard still works.
  - `ProviderCapabilities` optional `undefined` → `run({tools:[...]})` → `ConfigValidationError` matrix (N4).
  - `functionCalling` vs `toolCalling` deduplication respected — not both required (C2).
  - All existing tests pass.

Coverage (N4):

- `pnpm --filter @atisse/core test:coverage` %70, `provider-*` %60, conformance matrix M01, `estimateTokens('hello world')` ≈ `tiktoken` value fallback test, `ProviderCapabilities` optional `undefined` → `run({tools:[...]})` → `ConfigValidationError` matrix.

---

## 8. Risk Assessment

| Risk                                                                             | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B10: Token estimator on provider could be inaccurate                             | Low        | Low    | Fallback always available; estimator is best-effort.                                                                                                                                                                                                                                                                                                                                                                      |
| B10: Adding optional method to AIProvider is non-breaking                        | Low        | Low    | All existing AIProvider implementations work without the method — it's optional.                                                                                                                                                                                                                                                                                                                                          |
| B10: tiktoken dependency adds weight to provider-openai                          | Low        | Low    | `tiktoken` is optional peerDependency or devDependency + lazy `import('tiktoken')` + fallback `Math.ceil/4`, `tsup` external, S-8 audit (M3).                                                                                                                                                                                                                                                                             |
| B13: New optional fields on ProviderCapabilities                                 | Low        | Low    | Additive optional (`structuredOutput?: boolean`, `functionCalling?: boolean` default falsy `false`) — no breakage; existing code unaffected.                                                                                                                                                                                                                                                                              |
| B13: Capability validation in orchestrator.ts duplicates adapter-side validation | Low        | Low    | Core validation is the safety net; adapter-side validation is additional.                                                                                                                                                                                                                                                                                                                                                 |
| B10 + B13: Changes touch interfaces.ts (frozen contract)                         | Low        | High   | All additions are backward-compatible (optional `estimateTokens?` on AIProvider, additive optional `structuredOutput?`/`functionCalling?` on ProviderCapabilities). B13 as optional → core@MINOR, adapters patch/minor (capability declaration). If were required → core@MAJOR (rejected). B13 as optional → MINOR, SPSA review + no user ADR needed; if were required → MAJOR + ADR + user approval required (rejected). |

**Versioning/changeset (M6):** B13 as optional → `core@MINOR`, adapters `patch`/`minor` (capability declaration). If were required → `core@MAJOR` (rejected). Plan needs `.changeset/*.md` — core MINOR, adapters patch/minor; `provider-openai` `peerDependencies` `tiktoken` optional note.

---

## 9. References

- `.opencode/skill/interfaces/SKILL.md` — `AIProvider`, `ProviderCapabilities`, `PromptRequest` contracts (frozen — additive changes only)
- `.opencode/skill/interfaces/SKILL.md` — `OrchestratorConfig`, `Orchestrator.run()` types
- `.opencode/skill/architecture/SKILL.md` — Execution flow Step 4 (PROMPT_COMPOSED — token estimation), Step 1 (INITIALIZED — pre-flight validation)
- `.opencode/skill/principles/SKILL.md` — Principle 1 (Explicit Over Magical — capability declarations)
- `.opencode/skill/code-standards/SKILL.md` — Defensive programming, error messages
- `packages/core/src/interfaces.ts` — Target for `AIProvider.estimateTokens?` and `ProviderCapabilities` extensions
- `packages/core/src/prompt-composer.ts` — Target for `estimateTokenFn` injection (`prompt-composer.ts:128-143` etc. — update line numbers vs `shared.ts` split)
- `packages/core/src/orchestrator.ts` — Target for capability pre-flight validation (`orchestrator.ts:160-201`, `types.ts:22`)
- `packages/core/src/pipeline.ts:300-476` `initializePipeline()` — Target for wiring (B1A sonrası `pipeline/shared.ts`'e taşınacak; refs `pipeline.ts:435-476` / `435-441`)
- `packages/core/src/testing/mock-provider.ts` — Target for both B10 and B13 changes (`MockProviderOptions`)
- `packages/provider-openai/src/index.ts` — Target for B10 implementation + B13 capability declaration (`provider-openai:120-125` duplication fix)
- `packages/provider-anthropic/src/index.ts` — Target for B10 implementation + B13 capability declaration (`provider-anthropic:164-169` duplication fix)
- `.changeset/*.md` — Versioning: core MINOR, adapters patch/minor; `provider-openai/package.json` `peerDependencies` `tiktoken` optional note
- `docs/writing-adapters.md:63` — Capability example update (new optional fields)
- `final-evaluation-and-roadmap:66` — B13 scope definition (`structuredOutput`, `vision` — align `functionCalling` scope per C2)

**Versioning section:** B13 as optional → core@MINOR, adapters patch/minor (capability declaration). If were required → core@MAJOR (rejected). Plan needs `.changeset/*.md` — core MINOR, adapters patch/minor; `provider-openai` `peerDependencies` `tiktoken` optional peer note, `docs/writing-adapters.md:63` capability example update.

<!-- verification anchors for grep: structuredOutput? functionCalling? vision | pipeline.ts:300-476 | MockProviderOptions | tiktoken optional peer | resolveConfig after -->
