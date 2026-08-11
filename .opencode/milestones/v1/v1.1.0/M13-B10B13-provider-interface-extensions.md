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

1. Add new optional boolean fields to `ProviderCapabilities`: `structuredOutput`, `vision` (already exists — ensure it's documented), `functionCalling`.
2. Update `ProviderCapabilities` interface with the new fields (all defaulting to `false`).
3. Add pre-flight validation in `orchestrator.ts` `run()` entry: when a user requests a feature whose required capability is `false`, throw `ConfigValidationError`.
4. Update `MockProvider` capabilities declaration to expose these fields.
5. Update `provider-openai` and `provider-anthropic` capability declarations to reflect actual feature support.

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

| Field       | Value                                                                                                                                                             |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/interfaces.ts`                                                                                                                                 |
| Lines       | `ProviderCapabilities` interface (lines 69–74)                                                                                                                    |
| Severity    | LOW                                                                                                                                                               |
| Description | `ProviderCapabilities` has `streaming`, `toolCalling`, `vision`, `maxContextTokens`. Missing explicit capability flags for `structuredOutput`, `functionCalling`. |
| Fix         | Add `structuredOutput: boolean` and `functionCalling: boolean` as optional fields (default `false`). `vision` already exists — ensure it's used in validation.    |

| Field       | Value                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/orchestrator.ts`                                                                                                   |
| Lines       | `run()` entry validation (streaming guard, fallback guard)                                                                            |
| Severity    | LOW                                                                                                                                   |
| Description | Only streaming + fallback have pre-flight capability checks. `structuredOutput` and `functionCalling` have no config-time validation. |
| Fix         | Add pre-flight validation: if user config implies a capability that the provider lacks, throw `ConfigValidationError`.                |

| Field       | Value                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------- |
| File        | `packages/core/src/testing/mock-provider.ts`                                                    |
| Lines       | Constructor capabilities initialization (lines 60–65)                                           |
| Severity    | LOW                                                                                             |
| Description | `MockProvider` needs to declare the new capability fields.                                      |
| Fix         | Add `structuredOutput: false` and `functionCalling: true` (MockProvider supports tool calling). |

---

## 4. Architectural Directives

### 4.1 Chosen Approach

**B10 — Token Estimation:**

- `AIProvider.estimateTokens?` is an **optional** method. When absent, core falls back to `Math.ceil(text.length / 4)`.
- `PromptComposer.compose()` gains an optional parameter `estimateTokenFn?: (text: string) => number`. When provided, the composer uses it for all token estimation. If absent, uses the existing `Math.ceil(text.length / 4)`.
- `PromptComposer.estimateTokens()` and `estimateMessageTokens()` are refactored to use the injected function when available.
- Pipeline passes `activeProvider.estimateTokens?.bind(activeProvider)` as the `estimateTokenFn` to `PromptComposer.compose()`.
- `MockProvider.estimateTokens?` is configurable via constructor option:
  ```typescript
  constructor(id = 'mock-test', estimateTokens?: (text: string) => number)
  ```
  Default: `(text) => Math.ceil(text.length / 4)`.
- Provider adapters implement `estimateTokens()`:
  - `provider-openai`: Use `tiktoken` package (already an optional dependency) or a lookup table for known models with `encode()` method.
  - `provider-anthropic`: Use Anthropic SDK's token counter or an approximation for known Claude models.
  - Both: Fall back to `Math.ceil(text.length / 4)` when the model-specific tokenizer is unavailable.

**B13 — Capability Extensions:**

- New capability fields are **optional booleans defaulting to `false`** at the type level. However, since `ProviderCapabilities` is currently a concrete interface (not using `Partial`), all fields are required at runtime. Therefore:
  - Add new fields as **required booleans** to `ProviderCapabilities` (consistent with existing pattern).
  - Default values are set at the provider adapter level (each adapter declares what it supports).
  - This is NOT a breaking change — existing code that constructs `ProviderCapabilities` objects (provider adapters) adds the new fields. Code that only _reads_ capabilities is unaffected.
- Pre-flight validation in `orchestrator.ts` `run()` entry:
  - When `stream: true` and `!provider.capabilities.streaming`: existing guard.
  - When `config.tools` is non-empty and `!provider.capabilities.functionCalling`: new `ConfigValidationError`.
  - `structuredOutput` validation is reserved for future use (no current consumer) — add field but no pre-flight check yet.
- The existing `vision` field is already `boolean` — no change needed.

> **V2_EVOLUTION_PATH:** This milestone adds `structuredOutput` and `functionCalling` booleans to `ProviderCapabilities` (delivered in v1.1.0). These are a provisional v1 surface; v2 will replace the fixed-field boolean model with a `Set<string>` / `supports(feature)` extensible model. Treat the booleans as throwaway scaffolding.

### 4.2 What NOT to Do

- **B10:** Do NOT add a tokenizer dependency to core (tiktoken, etc.) — tokenizer lives on provider adapters.
- **B10:** Do NOT change the `PromptComposer` public API in a breaking way — `estimateTokenFn` is an optional parameter.
- **B10:** Do NOT make `estimateTokens` a required method — providers that don't implement it must still work.
- **B10:** Do NOT expose `estimateTokens` on `OrchestratorConfig` or `RunInput` — it's a provider-level feature.
- **B13:** Do NOT change the `streaming: boolean` field — it already exists and is used.
- **B13:** Do NOT make capability fields optional via `Partial<ProviderCapabilities>` — keep consistent with current required-boolean pattern.
- **B13:** Do NOT add capability negotiation logic (e.g., capability downgrading or feature negotiation) — just pre-flight validation.
- **B13:** Do NOT validate `structuredOutput` in v1.1.0 — field is additive with no consumer yet.

---

## 5. Files to Modify

### Phase 1 (B10)

| File                                         | Action    | Notes                                                                                                                      |
| -------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`            | MODIFY    | Add optional `estimateTokens?` to `AIProvider`                                                                             |
| `packages/core/src/prompt-composer.ts`       | MODIFY    | Add optional `estimateTokenFn` parameter to `compose()`; use it when provided                                              |
| `packages/core/src/pipeline/shared.ts`       | MODIFY    | Pass `activeProvider.estimateTokens?.bind(activeProvider)` to composer (in `initializePipeline()`, Step 4 PROMPT_COMPOSED) |
| `packages/core/src/testing/mock-provider.ts` | MODIFY    | Add `estimateTokens?` method, configurable via constructor                                                                 |
| `packages/core/src/testing/index.ts`         | No change | MockProvider type exports unchanged                                                                                        |
| `packages/provider-openai/src/index.ts`      | MODIFY    | Implement `estimateTokens()` using `tiktoken` or approximation                                                             |
| `packages/provider-anthropic/src/index.ts`   | MODIFY    | Implement `estimateTokens()` using Anthropic tokenizer or approximation                                                    |

### Phase 2 (B13)

| File                                         | Action | Notes                                                                                               |
| -------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------- |
| `packages/core/src/interfaces.ts`            | MODIFY | Add `structuredOutput`, `functionCalling` to `ProviderCapabilities`                                 |
| `packages/core/src/orchestrator.ts`          | MODIFY | Add pre-flight validation for `functionCalling` capability                                          |
| `packages/core/src/testing/mock-provider.ts` | MODIFY | Add new capability fields to constructor default                                                    |
| `packages/provider-openai/src/index.ts`      | MODIFY | Declare actual capabilities (e.g., `functionCalling: true`, `structuredOutput: true` for GPT-4o)    |
| `packages/provider-anthropic/src/index.ts`   | MODIFY | Declare actual capabilities (e.g., `functionCalling: true`, `structuredOutput: true` for Claude 3+) |

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

### Phase 1 — Step 3: Update `MockProvider` with `estimateTokens()`

- Open `packages/core/src/testing/mock-provider.ts`.
- Add constructor parameter:
  ```typescript
  constructor(
    id = 'mock-test',
    private estimateTokensFn?: (text: string) => number,
  ) {
    // ...existing code...
  }
  ```
- Add method:
  ```typescript
  estimateTokens(text: string): number {
    return this.estimateTokensFn?.(text) ?? Math.ceil(text.length / 4);
  }
  ```

### Phase 1 — Step 4: Wire into Pipeline

- Open `packages/core/src/pipeline/shared.ts` (where `initializePipeline()` — Steps 1–4 — lands after B1A–B1E).
- In the `PROMPT_COMPOSED` step of `initializePipeline()`, pass the provider's estimator:
  ```typescript
  const messages = composer.compose({
    systemPrompt: config.systemPrompt,
    contextMessages,
    memoryMessages,
    userPrompt: input.prompt,
    maxTokens: config.provider.capabilities.maxContextTokens,
    estimateTokenFn: config.provider.estimateTokens?.bind(config.provider),
  });
  ```

### Phase 1 — Step 5: Implement in Provider Adapters

- **`provider-openai`**: Add `estimateTokens()` that uses `tiktoken`'s `encoding_for_model(modelName)` to get the encoder and call `.encode(text).length`.
  - Model name extraction from `this.id` (e.g., `'openai-gpt-4o'` → `'gpt-4o'`).
  - Fall back to `Math.ceil(text.length / 4)` when `tiktoken` is unavailable or model unknown.
- **`provider-anthropic`**: Add `estimateTokens()` using Anthropic's SDK token counting utility, or a model-specific approximation table.
  - Fall back to `Math.ceil(text.length / 4)` when unavailable.

### Phase 1 — Step 6: Verify B10

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage` for all packages.

### Phase 2 — Step 7: Add Capability Fields to `ProviderCapabilities`

- Open `packages/core/src/interfaces.ts`.
- Update `ProviderCapabilities`:
  ```typescript
  export interface ProviderCapabilities {
    streaming: boolean;
    toolCalling: boolean;
    vision: boolean;
    structuredOutput: boolean;
    functionCalling: boolean;
    maxContextTokens: number;
  }
  ```
- Note: `vision` already exists. `structuredOutput` and `functionCalling` are new. All are required booleans (consistent with existing pattern).

### Phase 2 — Step 8: Update Provider Capability Declarations

- **`MockProvider`**: Update constructor defaults:
  ```typescript
  this.capabilities = {
    streaming: true,
    toolCalling: true,
    vision: false,
    structuredOutput: false,
    functionCalling: true, // MockProvider supports tool calling
    maxContextTokens: 128_000,
  };
  ```
- **`provider-openai`**: Set `structuredOutput: true` for models that support it (GPT-4o, GPT-4o-mini), `functionCalling: true` for all models.
- **`provider-anthropic`**: Set `structuredOutput: true` for Claude 3+ models, `functionCalling: true` for Claude 3+ models.

### Phase 2 — Step 9: Add Pre-Flight Validation in `orchestrator.ts`

- Open `packages/core/src/orchestrator.ts`.
- In the `run()` method, add capability validation after existing guards:

  ```typescript
  // Existing streaming guard
  if (input.stream && !resolvedConfig.provider.capabilities.streaming) {
    throw new ConfigValidationError(
      'Provider does not support streaming',
      'provider.capabilities.streaming',
    );
  }

  // New: tool calling capability guard
  if (resolvedConfig.tools.size > 0 && !resolvedConfig.provider.capabilities.functionCalling) {
    throw new ConfigValidationError(
      'Provider does not support function calling',
      'provider.capabilities.functionCalling',
    );
  }
  ```

### Phase 2 — Step 10: Verify B13

- Run `pnpm lint && pnpm typecheck && pnpm test && pnpm test:coverage` for all packages.
- All existing tests pass. Any test that constructs a `ProviderCapabilities` object directly must add the new fields (TypeScript will enforce this at compile time).

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
  - `MockProvider.estimateTokens()` returns configurable values (defaults to `Math.ceil(text.length / 4)`).
  - Provider adapters expose `estimateTokens()` returning reasonable values (verified via unit test with known text).
  - All existing tests pass unchanged.

- **B13:**
  - `ProviderCapabilities` has `structuredOutput: boolean` and `functionCalling: boolean` fields.
  - All `ProviderCapabilities` construction sites in codebase include the new fields.
  - When `tools` are configured and `provider.capabilities.functionCalling === false`, `run()` throws `ConfigValidationError`.
  - When `stream: true` and `provider.capabilities.streaming === false`, existing guard still works.
  - All existing tests pass (TypeScript compiler catches missing fields at compile time).

---

## 8. Risk Assessment

| Risk                                                                            | Likelihood | Impact | Mitigation                                                                                                                                |
| ------------------------------------------------------------------------------- | ---------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| B10: Token estimator on provider could be inaccurate                            | Low        | Low    | Fallback always available; estimator is best-effort.                                                                                      |
| B10: Adding optional method to AIProvider is non-breaking                       | Low        | Low    | All existing AIProvider implementations work without the method — it's optional.                                                          |
| B10: tiktoken dependency adds weight to provider-openai                         | Low        | Low    | tiktoken is an optional peer dependency; fallback works without it.                                                                       |
| B13: New required fields on ProviderCapabilities break adapter builds           | Medium     | Medium | All adapter packages must add the new fields — caught by TypeScript compilation.                                                          |
| B13: Capability validation in orchestator.ts duplicates adapter-side validation | Low        | Low    | Core validation is the safety net; adapter-side validation is additional.                                                                 |
| B10 + B13: Changes touch interfaces.ts (frozen contract)                        | Low        | High   | All additions are backward-compatible (optional field on AIProvider, additive required fields on ProviderCapabilities). Approved by SPSA. |

---

## 9. References

- `.opencode/skill/interfaces/SKILL.md` — `AIProvider`, `ProviderCapabilities`, `PromptRequest` contracts (frozen — additive changes only)
- `.opencode/skill/interfaces/SKILL.md` — `OrchestratorConfig`, `Orchestrator.run()` types
- `.opencode/skill/architecture/SKILL.md` — Execution flow Step 4 (PROMPT_COMPOSED — token estimation), Step 1 (INITIALIZED — pre-flight validation)
- `.opencode/skill/principles/SKILL.md` — Principle 1 (Explicit Over Magical — capability declarations)
- `.opencode/skill/code-standards/SKILL.md` — Defensive programming, error messages
- `packages/core/src/interfaces.ts` — Target for `AIProvider.estimateTokens?` and `ProviderCapabilities` extensions
- `packages/core/src/prompt-composer.ts` — Target for `estimateTokenFn` injection
- `packages/core/src/orchestrator.ts` — Target for capability pre-flight validation
- `packages/core/src/testing/mock-provider.ts` — Target for both B10 and B13 changes
- `packages/provider-openai/src/index.ts` — Target for B10 implementation + B13 capability declaration
- `packages/provider-anthropic/src/index.ts` — Target for B10 implementation + B13 capability declaration
