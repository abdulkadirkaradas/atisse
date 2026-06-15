# M3 Implementation Plan

## Streaming + OrchestratorProfile Integration + OpenAI Provider

**Status:** Ready to implement
**Blocker:** M2 complete
**Prerequisite Decisions:** All M1 + M2 decisions + D-M3-1 through D-M3-4 (autonomous)

---

## 1. Mandatory Reading Before Writing Any Code

1. `.opencode/rules/interfaces-core.md` + `.opencode/rules/interfaces-runtime.md` — `StreamChunk`, `AIProvider.generateStream?`, `OrchestratorEvent`
2. `.opencode/rules/architecture.md` — Streaming Execution Flow section (Steps 5–6 streaming variant)
3. `.opencode/rules/constraints.md` — streaming + fallback forbidden combination (ADR-017)
4. `.opencode/rules/error-taxonomy.md` — retry classification for streaming errors
5. `.opencode/rules/typescript-style.md` + `.opencode/rules/implementation-standards.md`
6. `.opencode/workflows/adapter-pattern.md` — Provider Adapter Checklist
7. `.opencode/workflows/testing-standards.md` — MockProvider streaming behavior
8. `.opencode/rules/decision-log.md` — key decisions and ADRs that affect implementation; not required but provides helpful context and rationale for certain patterns
    1. `(ADR-0*)` references in the checklists link to specific ADRs in the decision log for deeper context on those decisions. For reference see `8.`

---

## 2. Approved Decisions (Autonomous — SPSA Authority)

### D-M3-1: Streaming Retry Boundary

**Decision:** Retry is permitted only when `provider.generateStream()` **rejects as a Promise** (before the stream begins). Once the `AsyncIterable` is being consumed (first chunk read), errors arrive as `{ type: 'error' }` chunks — the stream terminates, no retry is triggered from `pipeline.ts`.

**Rationale:** ADR-019 established `Promise<AsyncIterable>` precisely so connection errors surface before streaming starts. ADR-017 forbids fallback with streaming. This decision closes the only remaining ambiguity: mid-stream failures are terminal, pre-stream failures are retryable if the error type permits. Consistent with the fail-fast philosophy.

---

### D-M3-2: AbortSignal Forwarded to `generateStream()`

**Decision:** `PromptRequest.signal` (from `generateTimeoutMs`) is attached to streaming requests identically to non-streaming requests. The `totalTimeoutMs` `Promise.race` guard wraps the entire stream consumption loop, not just the initial `generateStream()` call.

**Rationale:** ADR-014 defines timeout via `AbortSignal` + `Promise.race` fallback. Streaming must respect both levels. The `Promise.race` at pipeline top level already covers `totalTimeoutMs` — this decision clarifies that the same `AbortSignal` is injected into the streaming `PromptRequest`.

---

### D-M3-3: `afterGenerate` Hook — Streaming Accumulation Strategy

**Decision:** `pipeline.ts` accumulates all `{ type: 'text', delta }` chunks into a single string. When `{ type: 'done' }` is received, a `PromptResponse` is constructed from the accumulated text and usage, then `afterGenerate` hooks fire with that complete response. **The consumer's `AsyncIterable` is yielded concurrently** — the pipeline does not buffer the full stream before yielding to the consumer.

**Rationale:** ADR-027 settled the timing (after `done` chunk). This decision clarifies the implementation: the kernel yields chunks to the consumer as they arrive AND accumulates for the hook. Both happen in the same `for await` loop. The hook fires at the end of the loop, not before.

---

### D-M3-4: `OpenAIProvider` Tool Call Handling in Streaming

**Decision:** In streaming mode, `OpenAIProvider` accumulates tool call deltas across chunks and emits a single `{ type: 'tool_call', toolCall }` chunk with the complete, assembled `ToolCall` object. The consumer never sees partial tool call chunks.

**Rationale:** Providers stream tool call arguments as JSON fragments. Exposing partial JSON to the pipeline creates an impossible-to-use contract. Accumulation inside the adapter is the correct boundary — the kernel's `StreamChunk.tool_call` type carries a complete `ToolCall`.

---

## 3. Scope Summary

M3 completes three deliverables:

| Deliverable | Owned by | Depends on |
|---|---|---|
| Streaming execution path in `pipeline.ts` | `packages/core` | M2 pipeline skeleton |
| `packages/provider-openai` full implementation | New package | Core interfaces |
| Streaming + profile integration tests | `packages/core/tests` | Both above |

> **Note:** `profile.ts` merge logic was fully implemented in M2 (Phase 2). M3 adds the `profile.resolved` event emission and end-to-end streaming + profile combination tests.

---

## 4. Phase 1 — Streaming Path in `pipeline.ts`

The M2 plan deferred `stream: true` with a placeholder. This phase replaces that placeholder with the full streaming execution.

### 4.1 Consumer-Facing Generator

`pipeline.ts` exposes an internal async generator that the `orchestrator.ts` `run()` overload returns as `Promise<AsyncIterable<StreamChunk>>`.

```typescript
// Internal — not exported
async function* executeStreamingPipeline(
  input: RunInput,
  config: ResolvedConfig,
  eventBus: EventBus,
  logger: Logger,
): AsyncGenerator<StreamChunk>
```

The top-level `executePipeline` function routes to this generator when `input.stream === true`.

### 4.2 Steps 1–4 (Unchanged)

Steps 1–4 (INITIALIZED → CONTEXT_INJECTING → CONTEXT_INJECTED → PROMPT_COMPOSED) are identical to the non-streaming path. No chunk is yielded during these steps.

### 4.3 Step 5 — GENERATING (Streaming Variant)

Implementation checklist:

- [ ] Run `beforeGenerate` hooks — identical to non-streaming
- [ ] Emit `generate.started { runId, messageCount }`
- [ ] Build `PromptRequest` with `AbortSignal` from `generateTimeoutMs` (D-M3-2)
- [ ] `const streamIterable = await config.provider.generateStream(request)`
  - Promise rejection here → check `isRetryable` → `RETRYING` or `FAILED` (D-M3-1)
- [ ] Initialize accumulation variables: `let accumulatedText = ''`, `let accumulatedUsage: TokenUsage | undefined`, `let pendingToolCalls: ToolCall[] = []`
- [ ] Wrap stream consumption in `Promise.race([consumeStream(), rejectAfter(config.timeout.generateTimeoutMs)])` — non-cooperative provider fallback (D-M3-2)
- [ ] `for await (const chunk of streamIterable)`:
  - `{ type: 'text' }` → `accumulatedText += chunk.delta`; yield chunk to consumer
  - `{ type: 'tool_call' }` → yield chunk; push `chunk.toolCall` into `pendingToolCalls[]`
  - `{ type: 'done' }` → `accumulatedUsage = chunk.usage`; break loop
  - `{ type: 'error' }` → yield `{ type: 'error', error: chunk.error }`; transition to `FAILED`
- [ ] After `done`: construct `PromptResponse` from accumulated data
- [ ] Run `afterGenerate` hooks with assembled `PromptResponse` (ADR-027)
- [ ] Emit `generate.completed { runId, durationMs, finishReason }`
- [ ] `tempMessages[1] = { role: 'assistant', content: accumulatedText, toolCalls: pendingToolCalls }`

### 4.4 Step 6 — TOOL_EXECUTING (Streaming Variant)

Tool execution in streaming mode is synchronous and blocking — the stream pauses.

- [ ] When `pendingToolCalls` is non-empty after step 5: transition to `TOOL_EXECUTING`
- [ ] `roundCounter++`; check `maxToolRounds` → `MaxToolRoundsExceededError` if exceeded
- [ ] Execute tools via `toolController.executeRound(pendingToolCalls)` — identical to non-streaming
- [ ] For each `ToolResult`: yield `{ type: 'tool_result', toolResult }` to consumer
- [ ] Convert tool results to messages and append to `messages[]` for next generation:
  - For each `ToolResult` (success arm): `{ role: 'tool', content: JSON.stringify(result.output), toolCallId: result.id, name: result.name }`
  - For each `ToolResult` (error arm): `{ role: 'tool', content: result.error.message, toolCallId: result.id, name: result.name }`
- [ ] Reset `pendingToolCalls = []`; return to `GENERATING` (re-enter streaming loop with updated messages)

### 4.5 Step 9 — COMPLETING (Streaming Variant)

- [ ] Memory save via `memoryAdapter.save` — identical to non-streaming (D-M2-1 still applies)
- [ ] Run `afterRun` hooks
- [ ] Yield `{ type: 'done', usage: accumulatedUsage }` as the **last** chunk
- [ ] Transition to `COMPLETED`

### 4.6 FAILED path (Streaming)

- [ ] Yield `{ type: 'error', error }` chunk (if not already yielded)
- [ ] Emit `run.failed`; log; transition to `FAILED`
- [ ] Generator returns (no throw — consumer reads the error chunk)

> **Invariant:** The streaming generator ALWAYS terminates with exactly one `{ type: 'done' }` or `{ type: 'error' }` chunk. Consumers MUST handle unknown `type` values per `interfaces-runtime.md` Rule 7.

---

## 5. Phase 2 — `packages/provider-openai/`

### 5.1 Package Structure

```
packages/provider-openai/
├── src/
│   └── index.ts
├── tests/
│   └── openai-provider.test.ts
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── vitest.config.ts          (extends ../../vitest.base.config.ts)
```

### 5.2 `package.json`

```json
{
  "name": "@atisse/provider-openai",
  "engines": { "node": ">=24" },
  "peerDependencies": {
    "@atisse/core": "workspace:*",
    "openai": "^6.34.0"
  }
}
```

### 5.3 `OpenAIProvider implements AIProvider`

Implementation checklist:

**Constructor:**
- [ ] `constructor(config: { apiKey: string; model?: string; baseURL?: string })`
- [ ] `this.model = config.model ?? 'gpt-4o'`
- [ ] `this.id = \`openai-${this.model}\``

**`readonly capabilities`:**
- [ ] `streaming: true`, `toolCalling: true`, `vision: true`, `maxContextTokens: 128_000`

**`generate(request: PromptRequest): Promise<PromptResponse>`:**
- [ ] Map `Message[]` → OpenAI `ChatCompletionMessageParam[]`
- [ ] Map `ToolDefinition[]` → OpenAI `Tool[]` (when present)
- [ ] Forward `request.signal` to SDK call
- [ ] Forward `request.providerOptions` via spread into SDK params
- [ ] Map response → `PromptResponse` (text, toolCalls, usage, finishReason)
- [ ] Map `finish_reason: 'tool_calls'` → `'tool_calls'`; `'stop'` → `'stop'`; `'length'` → `'length'`
- [ ] `ToolCall.id`: use SDK-provided `id`; fallback to `randomUUID()` if absent (ADR `ToolCall.id` contract)
- [ ] All errors caught and mapped via `private mapError(error: unknown): never`

**`generateStream(request: PromptRequest): Promise<AsyncIterable<StreamChunk>>`:**
- [ ] Returns `Promise<AsyncIterable<StreamChunk>>` — connection errors surface as Promise rejection (ADR-019)
- [ ] Accumulate tool call argument deltas internally → emit complete `ToolCall` in one chunk (D-M3-4)
- [ ] Yield `{ type: 'text', delta }` for content deltas
- [ ] Yield `{ type: 'tool_call', toolCall }` when tool call is fully assembled
- [ ] Yield `{ type: 'done', usage }` when `finish_reason` received (usage from `stream.finalUsage()` or last chunk)
- [ ] Catch iterator errors → yield `{ type: 'error', error: mapped }` and return

**`private mapError(error: unknown): never` — HTTP status mapping:**

| HTTP Status | Error Class |
|---|---|
| 429 | `ProviderRateLimitError(msg, retryAfterMs, cause)` |
| 401 / 403 | `ProviderAuthError(msg, cause)` |
| 408 | `ProviderTimeoutError(msg, cause)` |
| 500 / 502 / 503 | `ProviderUnavailableError(msg, cause)` |
| Unknown | `ProviderUnavailableError('Unknown error', cause)` |

- [ ] `retryAfterMs`: `Number(response.headers?.['retry-after']) * 1000 || undefined`
- [ ] Never throw plain `Error` — always typed `OrchestratorError` subclass

**`private mapMessages(messages: Message[]): ChatCompletionMessageParam[]`:**
- [ ] `role: 'system'` → `{ role: 'system', content }`
- [ ] `role: 'user'` → `{ role: 'user', content }`
- [ ] `role: 'assistant'` → `{ role: 'assistant', content, tool_calls? }`
- [ ] `role: 'tool'` → `{ role: 'tool', tool_call_id: toolCallId, content }`
- [ ] `MessageContent[]` with `type: 'image'` → OpenAI vision format

---

## 6. Phase 3 — `profile.resolved` Event Emission

This small addition to `orchestrator.ts` was deferred from M2.

- [ ] After `resolveConfig()` returns and when a profile was active, emit:

```typescript
eventBus.emit({
  type: 'profile.resolved',
  runId,
  profileName: config.profiles[input.profile!].name, // use validated name from profiles map
  overrides: {
    provider: profile.provider !== undefined,
    tools: profile.tools !== undefined,
    contextProviders: profile.contextProviders !== undefined,
    systemPrompt: profile.systemPrompt !== undefined,
    retry: profile.retry !== undefined,
  },
  hookCount:
    (profile.hooks?.beforeRun?.length ?? 0) +
    (profile.hooks?.afterRun?.length ?? 0) +
    (profile.hooks?.beforeGenerate?.length ?? 0) +
    (profile.hooks?.afterGenerate?.length ?? 0) +
    (profile.hooks?.beforeTool?.length ?? 0) +
    (profile.hooks?.afterTool?.length ?? 0),
});
```

> **Note:** Emit `profile.resolved` inside `pipeline.ts` Step 1 (INITIALIZED), immediately after `run.started`, using the resolved config and profile name passed from `orchestrator.ts`. `runId` is generated at Step 1 — not available in `orchestrator.ts`.

---

## 7. Phase 4 — Tests

### 7.1 Unit Tests

**`packages/core/tests/unit/streaming.test.ts`**

- [ ] Streaming path yields chunks in correct order: `text*` → (`tool_call` → `tool_result`)* → `done`
- [ ] Stream always terminates with exactly one `done` or `error` chunk
- [ ] `{ type: 'error' }` chunk received → generator terminates, no `done` chunk follows
- [ ] `afterGenerate` hook fires with accumulated text (not partial) — ADR-027
- [ ] Tool-only response (no text): `accumulatedText === ""` → `afterGenerate` receives `response.text === ""`
- [ ] Provider returns empty stream (no text chunks, immediate `done`) → yields `done` immediately
- [ ] `generateTimeoutMs` expires mid-stream → `Promise.race` rejects, `{ type: 'error' }` yielded (D-M3-2)
- [ ] Pre-stream Promise rejection from provider → retried when retryable (D-M3-1)
- [ ] Pre-stream Promise rejection from provider → immediate FAILED when fatal (D-M3-1)
- [ ] `stream: true` + `fallbackProvider` → `ConfigValidationError` (ADR-017)
- [ ] `stream: true` + `capabilities.streaming === false` → `ConfigValidationError`
- [ ] `stream: true` + `generateStream === undefined` → `ConfigValidationError`

**`packages/provider-openai/tests/openai-provider.test.ts`**

> OpenAI SDK calls are mocked via `vi.mock('openai')` or HTTP-level mocking (e.g., MSW). No real API keys. No `MockProvider` — this is the adapter's own unit test suite.

- [ ] `generate()` returns correct `PromptResponse` shape
- [ ] `generate()` maps tool calls correctly — `ToolCall.id` fallback to `randomUUID()` when absent
- [ ] HTTP 429 → `ProviderRateLimitError` with `retryAfterMs`
- [ ] HTTP 401 → `ProviderAuthError` (no retry)
- [ ] HTTP 503 → `ProviderUnavailableError` (retryable)
- [ ] `generateStream()` returns `Promise<AsyncIterable<StreamChunk>>`
- [ ] Streaming: text deltas assembled into `{ type: 'text' }` chunks
- [ ] Streaming: tool call deltas accumulated → single `{ type: 'tool_call' }` per call (D-M3-4)
- [ ] Streaming: terminates with `{ type: 'done' }`
- [ ] Streaming: connection error before first chunk → Promise rejection (ADR-019)
- [ ] Streaming: iterator error mid-stream → yields `{ type: 'error', error }` chunk

### 7.2 Integration Tests

**`packages/core/tests/integration/streaming.test.ts`**

- [ ] End-to-end stream: `MockProvider` enqueued streaming entry → consumer receives all chunks
- [ ] Streaming + tool call: `tool_call` chunk → pause → execute → `tool_result` chunk → resume → `done`
- [ ] `tool.called` + `tool.completed` events emitted during streaming tool execution
- [ ] `roundCounter` cumulative in streaming — `MaxToolRoundsExceededError` at correct count
- [ ] `afterGenerate` fires with complete accumulated response, not partial
- [ ] Memory saved atomically at COMPLETING (same as non-streaming)
- [ ] `beforeGenerate` hook modifies messages → modified messages sent to provider

**`packages/core/tests/integration/profiles.test.ts`** (additions)

- [ ] `profile.resolved` event emitted with correct `overrides` bitmap
- [ ] `profile.resolved` emitted before `generate.started`
- [ ] `hookCount` correctly reflects concatenated profile + base hooks
- [ ] Streaming run with active profile → profile provider used for stream

---

## 8. Layer Compliance

| File | Layer | May import from |
|---|---|---|
| `pipeline.ts` (streaming addition) | L3 | L0, L1, L2 — no change |
| `orchestrator.ts` (profile.resolved) | L4 | L0, L1, L2, L3 — no change |
| `provider-openai/src/index.ts` | Adapter | L0 only (`@atisse/core` types) |

Adapters depend on **Layer 0 only** — never on L1–L4 internals.

---

## 9. Constraint Verification Checklist

Per `.opencode/rules/constraints.md` — applied to every M3 file before PR:

- [ ] No `any` type — `unknown` + narrowing throughout `OpenAIProvider`
- [ ] No `.then()/.catch()` chains — `async/await` and `for await` only
- [ ] No plain `Error` throws in `OpenAIProvider` — always typed `OrchestratorError`
- [ ] Streaming generator ALWAYS yields exactly one terminal chunk (`done` or `error`)
- [ ] `stream: true` + `fallbackProvider` → `ConfigValidationError` enforced at `run()` entry
- [ ] Tool call deltas accumulated inside adapter, never exposed as partial chunks (D-M3-4)
- [ ] All imports from `@atisse/core` in adapter use `import type` for type-only symbols

---

## 10. Security Checklist

Per `.opencode/rules/security.md`:

- [ ] API key never appears in log entries or error messages (S-1)
- [ ] `provider.id` safe to log — configuration metadata, not a secret (S-1 note)
- [ ] No user input elevated to `role: 'system'` in streaming path (S-2)
- [ ] `OpenAIProvider.mapError()` messages describe failure category — no internal HTTP body or paths (S-7)
- [ ] `pnpm audit --audit-level=high` clean (S-8)

---

## 11. Exit Criteria

Per `.opencode/rules/roadmap.md` §M3 Exit Criteria — M3 is complete when ALL pass:

- [ ] `run({ stream: true })` returns `Promise<AsyncIterable<StreamChunk>>` — consumer iterates correctly
- [ ] Streaming + tool calls: chunks in correct order, tool execution blocking between tool_call and tool_result
- [ ] Streaming error termination: `{ type: 'error' }` chunk received, iterator exhausted
- [ ] `afterGenerate` hook fires after `done` chunk with complete accumulated response
- [ ] Pre-stream Promise rejection: retryable errors retry, fatal errors fail immediately (D-M3-1)
- [ ] `profile.resolved` event emitted with correct fields when profile is active
- [ ] `profile.resolved` + streaming + tools → correct provider used, events fire in correct order
- [ ] `OpenAIProvider` passes all unit tests (error mapping, streaming chunk assembly)
- [ ] `OpenAIProvider` wired into `Orchestrator` integration tests: retry, hooks, state machine
- [ ] `pnpm --recursive lint` exits 0
- [ ] `pnpm --recursive typecheck` exits 0
- [ ] `pnpm --recursive test` exits 0
- [ ] CI pipeline green on a clean checkout

---

## 12. What M3 Does NOT Include

---

## Appendix A: Changes Made (Post-Review)

| Date | Change | Rationale |
|---|---|---|
| 2026-04-23 | Pin OpenAI SDK version `"^6.34.0"` | Per security.md S-8: stable SDK versions avoid breaking changes from minor updates |
| 2026-04-23 | Add mid-stream iterator error test | Improves test coverage for error chunk emission |
| 2026-04-23 | Add profile + streaming + tools to exit criteria | Ensures profile provider resolution works correctly in streaming mode |

---

## 12. What M3 Does NOT Include

Per `.opencode/rules/roadmap.md` §M4 and `.opencode/rules/constraints.md`:

- `@atisse/provider-anthropic` → M4
- `@atisse/memory-redis` → M4
- `@atisse/context-rag` → M4
- Streaming + fallback combination → FORBIDDEN in v1 (ADR-017)
- Parallel tool execution → FORBIDDEN in v1
- Agent planning, workflow DAG → FORBIDDEN in v1
- TypeDoc enforcement (soft-fail CI only) → M5
- Coverage threshold enforcement → M5