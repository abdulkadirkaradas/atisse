# M4 Implementation Plan

## Official Adapter Set — Anthropic Provider, Redis Memory, RAG Context

**Status:** Ready to implement
**Blocker:** M3 complete
**Prerequisite Decisions:** All M1 + M2 + M3 decisions + D-M4-1 through D-M4-8 (autonomous)

---

## 1. Mandatory Reading Before Writing Any Code

1. `.opencode/rules/interfaces-core.md` + `.opencode/rules/interfaces-runtime.md` — frozen contracts
2. `.opencode/workflows/adapter-pattern.md` — provider, memory, context checklists (primary reference)
3. `.opencode/rules/error-taxonomy.md` — error mapping rules for adapters
4. `.opencode/rules/security.md` — S-2, S-3, S-4, S-6 (trust boundary rules)
5. `.opencode/rules/constraints.md` — forbidden patterns
6. `.opencode/rules/typescript-style.md` + `.opencode/rules/implementation-standards.md`
7. `.opencode/workflows/testing-standards.md` — MockProvider API, test structure

---

## 2. Approved Decisions (Autonomous — SPSA Authority)

### D-M4-1: Anthropic SDK Version

`@anthropic-ai/sdk ^0.55.0` declared as `peerDependency` in `packages/provider-anthropic/package.json`.
Consistent with M3 pattern (OpenAI SDK as peerDep). Stable minor version prefix.

### D-M4-2: Redis Client

`redis ^5.0.0` (official Node.js Redis client) declared as `peerDependency`.
Chosen over `ioredis` for consistency with existing architecture doc examples. Users bring their own connected client or pass a URL for auto-connect.

### D-M4-3: RAGContextProvider Scope — Functional, Not Scaffold

Despite roadmap saying "scaffold", M4 exit criteria requires `fail-fast path tested (ADR-015)`.
Decision: functional implementation with a minimal `VectorStore` interface defined within the package.
The `VectorStore` interface is the package's only public abstraction — adapters implement it.

### D-M4-4: Redis TTL Default

`ttlSeconds: 3600` default. Configurable via constructor. TTL refreshed on every `save()` call.

### D-M4-5: Anthropic Streaming — Tool Call Accumulation

Same pattern as D-M3-4 (OpenAI): accumulate tool call argument deltas across chunks, emit a single complete `{ type: 'tool_call', toolCall }` chunk. Consumer never sees partial tool call chunks.

### D-M4-6: `context-rag` Package Exports

Exports: `VectorStore` interface + `RAGContextProvider` class.
`VectorStore` is a minimal duck-typed interface — any conforming object works without inheritance.

### D-M4-8: RAG Error Type Disambiguation

`VectorStore.search()` infrastructure failure (network timeout, connection refused) → `ContextLoadError` (retryable).
Unexpected return shape from `search()` (missing `content` field) → `ContextProviderError` (retryable).
Rationale: mirrors `ContextLoadError` vs `ContextProviderError` distinction in `error-taxonomy.md`.
Read-modify-write pattern with `GET` + `SETEX`. Atomicity via single JSON array per session.
Race condition risk is documented — Redis `WATCH/MULTI/EXEC` transactions are a V2 candidate.
The M4 test verifies sequential append correctness, not concurrent write-lock behavior.

---

## 3. Package Structure

```
packages/
├── provider-anthropic/
│   ├── src/index.ts
│   ├── tests/anthropic-provider.test.ts
│   ├── package.json          (@atisse/provider-anthropic)
│   ├── tsconfig.json
│   ├── tsup.config.ts
│   └── vitest.config.ts
│
├── memory-redis/
│   ├── src/index.ts
│   ├── tests/redis-adapter.test.ts
│   ├── package.json          (@atisse/memory-redis)
│   ├── tsconfig.json
│   ├── tsup.config.ts
│   └── vitest.config.ts
│
└── context-rag/
    ├── src/index.ts
    ├── tests/rag-provider.test.ts
    ├── package.json          (@atisse/context-rag)
    ├── tsconfig.json
    ├── tsup.config.ts
    └── vitest.config.ts
```

All `package.json` files include `"engines": { "node": ">=24" }`.
All `tsconfig.json` files extend `../../tsconfig.base.json`.
All `vitest.config.ts` files extend `../../vitest.base.config.ts`.

---

## 4. Implementation Order

```
Phase 1 — provider-anthropic
Phase 2 — memory-redis
Phase 3 — context-rag
Phase 4 — Unit + Integration tests
Phase 5 — CI update
```

**Phase 5 — CI Concrete Steps:**

- [ ] Add `packages/provider-anthropic`, `packages/memory-redis`, `packages/context-rag` to `pnpm-workspace.yaml` (if workspace glob `packages/*` not already present — verify)
- [ ] Confirm `pnpm --recursive lint/typecheck/test` discovers new packages automatically via workspace glob
- [ ] Verify `pnpm audit --audit-level=high` covers new peer deps (`@anthropic-ai/sdk`, `redis`)
- [ ] CI matrix: no per-package step additions needed — `--recursive` handles discovery

Typecheck after each phase: `pnpm --filter @atisse/provider-anthropic typecheck`

---

## 5. Phase 1 — `packages/provider-anthropic/src/index.ts`

### `AnthropicProvider implements AIProvider`

**Constructor:**

- [ ] `constructor(config: { apiKey: string; model?: string; baseURL?: string })`
- [ ] `this.model = config.model ?? 'claude-sonnet-4-5'`
- [ ] `this.id = \`anthropic-${this.model}\``

**`readonly capabilities`:**

- [ ] `streaming: true`, `toolCalling: true`, `vision: true`, `maxContextTokens: 200_000`

**`generate(request: PromptRequest): Promise<PromptResponse>`:**

- [ ] Map `Message[]` → Anthropic `MessageParam[]` via `private mapMessages()`
- [ ] Map `ToolDefinition[]` → Anthropic `Tool[]` (when present)
- [ ] Extract `system` messages from `messages` array — Anthropic API requires them in a separate `system` field
- [ ] Forward `request.signal` to SDK call (`abortSignal` param)
- [ ] Forward `request.providerOptions` via spread into SDK params
- [ ] Map response → `PromptResponse`:
  - `text`: concatenate all `{ type: 'text' }` content blocks — Anthropic may return multiple text blocks
  - `toolCalls`: extract all `{ type: 'tool_use' }` content blocks
  - `finishReason`: `'end_turn'` → `'stop'`; `'tool_use'` → `'tool_calls'`; `'max_tokens'` → `'length'`; `'stop_sequence'` → `'stop'`
- [ ] `ToolCall.id`: use SDK-provided `id`; fallback to `randomUUID()` if absent
- [ ] Unrecognized `stop_reason` → throw `ProviderMalformedResponse` (intentional divergence from OpenAI adapter which defaults to 'stop' — Anthropic adapter is fail-fast per Principle 1: Explicit Over Magical)
- [ ] All errors caught and mapped via `private mapError(error: unknown): never`

**`generateStream(request: PromptRequest): Promise<AsyncIterable<StreamChunk>>`:**

- [ ] Returns `Promise<AsyncIterable<StreamChunk>>` — connection errors surface as Promise rejection (ADR-019)
- [ ] Forward `request.signal` to SDK stream call (`abortSignal` param) — same as `generate()` (D-M3-2)
- [ ] Accumulate tool input JSON deltas internally → emit complete `ToolCall` in one chunk at `content_block_stop` (D-M4-5)
- [ ] Yield `{ type: 'text', delta }` for `content_block_delta` text events
- [ ] Yield `{ type: 'tool_call', toolCall }` when tool input is fully assembled at `content_block_stop` — NOT at `message_stop`
- [ ] Yield `{ type: 'done', usage }` from `message_stop` event (usage from `message_delta.usage`)
- [ ] Catch iterator errors → yield `{ type: 'error', error: mapped }` and return
- [ ] **Do NOT re-wrap already-mapped `OrchestratorError` instances** — check `instanceof OrchestratorError` before mapping

**`private mapError(error: unknown): never` — HTTP status mapping:**

| HTTP Status              | Error Class                                                |
| ------------------------ | ---------------------------------------------------------- |
| 429                      | `ProviderRateLimitError(msg, retryAfterMs, cause)`         |
| 401 / 403                | `ProviderAuthError(msg, cause)`                            |
| 408                      | `ProviderTimeoutError(msg, cause)`                         |
| 500 / 502 / 503          | `ProviderUnavailableError(msg, cause)`                     |
| Malformed response shape | `ProviderMalformedResponse(msg, cause)` — retryable: false |
| Unknown                  | `ProviderUnavailableError('Unknown error', cause)`         |

- [ ] `retryAfterMs`: `Number(error.headers?.['retry-after']) * 1000 || undefined`
- [ ] If `error instanceof OrchestratorError` → rethrow directly, do NOT wrap again

**`private mapMessages(messages: Message[]): { system?: string; messages: MessageParam[] }`:**

- [ ] `role: 'system'` messages → extracted and concatenated into a single `system` string
- [ ] `role: 'user'` → `{ role: 'user', content }`
- [ ] `role: 'assistant'` → `{ role: 'assistant', content }` (with tool_use blocks if `toolCalls` present)
- [ ] `role: 'tool'` → `{ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolCallId, content }] }`
  - When `content` is `string` → pass as string
  - When `content` is `MessageContent[]` with `type: 'image'` → pass as Anthropic image content block array
- [ ] `MessageContent[]` with `type: 'image'` → Anthropic vision format (`{ type: 'image', source: { type: 'base64', ... } }`)
- [ ] Data URI parsing for images: extract `mimeType` and `base64` data from `data:{mimeType};base64,{data}` format → Anthropic `{ source: { type: 'base64', media_type: mimeType, data } }`. Non-data-URI (plain https URL) → throw `ProviderMalformedResponse('Image URL must be a data URI for Anthropic provider')`

---

## 6. Phase 2 — `packages/memory-redis/src/index.ts`

### `RedisMemoryAdapter implements MemoryAdapter`

**Constructor:**

- [ ] `constructor(config: { client: RedisClientType } | { url: string; ttlSeconds?: number })`
- [ ] When `url` provided: create client but do NOT call `connect()` immediately — lazy-connect on first `load()`/`save()`/`clear()` call
- [ ] When pre-connected `client` provided: use directly, no connection management
- [ ] `connect()` failure propagates as `ContextLoadError`
- [ ] `disconnect()` is the caller's responsibility — not managed by the adapter
- [ ] `this.ttlSeconds = config.ttlSeconds ?? 3600`
- [ ] `this.keyPrefix = 'atisse:session:'` (internal default, not configurable in v1)

**`load(sessionId: string): Promise<Message[]>`:**

- [ ] `const raw = await this.client.get(\`${this.keyPrefix}${sessionId}\`)`
- [ ] Returns `[]` (never throws) for `null` result — new session
- [ ] Parse JSON: `JSON.parse(raw) as Message[]`
- [ ] Connection/parse error → `throw new ContextLoadError(this.id, error)`

**`save(sessionId: string, messages: Message[]): Promise<void>`:**

- [ ] `const existing = await this.load(sessionId)` — read first
- [ ] `await this.client.setEx(key, this.ttlSeconds, JSON.stringify([...existing, ...messages]))`
- [ ] TTL refreshed on every save
- [ ] Error → `throw new ContextLoadError(this.id, error)`

**`clear(sessionId: string): Promise<void>`:**

- [ ] `await this.client.del(key)` — idempotent, `del` on missing key is a no-op in Redis
- [ ] Error → `throw new ContextLoadError(this.id, error)`

**Security (S-4):**

- [ ] Key format: `atisse:session:{sessionId}` — always sessionId-scoped, never global

---

## 7. Phase 3 — `packages/context-rag/src/index.ts`

### `VectorStore` Interface (exported)

```typescript
export interface VectorStore {
  readonly id: string;
  search(query: string, topK?: number): Promise<VectorDocument[]>;
}

export interface VectorDocument {
  content: string; // the text to inject as context
  metadata?: Record<string, unknown>;
}
```

### `RAGContextProvider implements ContextProvider`

**Constructor:**

- [ ] `constructor(config: { vectorStore: VectorStore; topK?: number; id?: string })`
- [ ] `this.topK = config.topK ?? 5`
- [ ] `this.id = config.id ?? \`rag-${vectorStore.id}\``

**`provide(input: ContextProviderInput): Promise<SystemMessage[]>`:**

- [ ] `const docs = await this.vectorStore.search(input.prompt, this.topK)`
- [ ] Returns `[]` (never throws) when `docs.length === 0`
- [ ] Maps: `docs.map(doc => ({ role: 'system' as const, content: doc.content }))`
- [ ] **Security (S-2, S-6):** `input.prompt` used for `search()` query ONLY — NEVER forwarded to output
- [ ] `doc.content` (trusted adapter content) → `role: 'system'` is correct
- [ ] `VectorStore.search()` throws (infrastructure/connectivity failure) → `throw new ContextLoadError(this.id, error)`
- [ ] Business-logic failure (unexpected return shape) → `throw new ContextProviderError(this.id, error)`

---

## 8. Phase 4 — Tests

### Unit Tests

**`packages/provider-anthropic/tests/anthropic-provider.test.ts`**

> Anthropic SDK calls mocked via `vi.mock('@anthropic-ai/sdk')`. No real API keys.

- [ ] `generate()` returns correct `PromptResponse` shape
- [ ] Multiple `type: 'text'` content blocks concatenated into single `text` field
- [ ] `system` messages extracted and passed separately, not in `messages` array
- [ ] `role: 'tool'` messages mapped to `role: 'user'` with `tool_result` content blocks
- [ ] `role: 'tool'` with `MessageContent[]` including image → Anthropic image content block in tool_result
- [ ] `generate()` maps tool calls correctly — `ToolCall.id` fallback to `randomUUID()`
- [ ] `stop_sequence` finish_reason → `'stop'` (same as `end_turn`)
- [ ] HTTP 429 → `ProviderRateLimitError` with `retryAfterMs`
- [ ] HTTP 401 → `ProviderAuthError` (retryable: false)
- [ ] HTTP 503 → `ProviderUnavailableError` (retryable: true)
- [ ] Malformed response (missing content) → `ProviderMalformedResponse` (retryable: false)
- [ ] Already-mapped `OrchestratorError` not re-wrapped — rethrown directly
- [ ] `generateStream()` returns `Promise<AsyncIterable<StreamChunk>>`
- [ ] Streaming: text deltas → `{ type: 'text' }` chunks
- [ ] Streaming: tool input deltas accumulated → single `{ type: 'tool_call' }` emitted at `content_block_stop`
- [ ] Streaming: terminates with `{ type: 'done' }` carrying usage
- [ ] Streaming: connection error before first chunk → Promise rejection (ADR-019)
- [ ] Streaming: iterator error mid-stream → yields `{ type: 'error', error }` chunk

**`packages/memory-redis/tests/redis-adapter.test.ts`**

> Redis client mocked via `vi.mock('redis')`. No live Redis instance.

- [ ] `load()` returns `[]` for missing key (null result)
- [ ] `save()` appends messages — `load()` after `save()` returns combined array
- [ ] `save()` refreshes TTL on every call (`setEx` called with `ttlSeconds`)
- [ ] `clear()` is idempotent — calling on non-existent key does not throw
- [ ] `load()` Redis error → `ContextLoadError` thrown
- [ ] `save()` Redis error → `ContextLoadError` thrown
- [ ] Storage key always contains `sessionId` — verified via mock call args
- [ ] Cross-session isolation: `load('session-A')` never returns session-B data

**`packages/context-rag/tests/rag-provider.test.ts`**

> `VectorStore` mocked inline — no external DB required.

- [ ] `provide()` returns `SystemMessage[]` with `role: 'system'`
- [ ] `provide()` returns `[]` when `vectorStore.search()` returns empty array
- [ ] `input.prompt` NOT present in any output message content — security assertion
- [ ] `vectorStore.search()` called with `input.prompt` and configured `topK`
- [ ] `vectorStore.search()` throws (connectivity) → `ContextLoadError` thrown (retryable: true)
- [ ] `vectorStore.search()` returns malformed shape → `ContextProviderError` thrown (retryable: true)
- [ ] Output messages have `role: 'system'` — compile-time `SystemMessage[]` type verified

### Integration Tests

Per existing pattern — one file per concern, not monolithic.

**`packages/core/tests/integration/provider-anthropic.test.ts`**

- [ ] `AnthropicProvider` wired into `Orchestrator` — full `run()` lifecycle executes
- [ ] Retry on `ProviderRateLimitError`: provider called N times, success on Nth
- [ ] `ProviderAuthError` → immediate failure, no retry
- [ ] `beforeGenerate` hook receives `messages` where system messages have been extracted (not in array)
- [ ] Streaming run: chunks delivered in correct order

**`packages/core/tests/integration/memory-redis.test.ts`**

- [ ] `sessionId` present → `load()` called before generation, `save()` called at COMPLETING
- [ ] Second `run()` with same `sessionId` → history from first run present in messages
- [ ] `save()` failure → run transitions to `FAILED`, `ContextLoadError` thrown (D-M2-1)
- [ ] No `sessionId` → memory adapter methods NOT called
- [ ] Append semantics: two sequential saves produce `[run1_user, run1_assistant, run2_user, run2_assistant]`

**`packages/core/tests/integration/context-rag.test.ts`**

- [ ] Context messages injected into `messages` before generation
- [ ] Fail-fast (ADR-015): `vectorStore.search()` throws → `context.failed` event emitted → run fails
- [ ] `provide()` called with `ContextProviderInput` — `stream` and `profile` fields absent
- [ ] Multiple providers: first provider failure aborts remaining providers, partial results discarded

---

## 9. Layer Compliance

Per `.opencode/rules/architecture.md` §Internal Layer Architecture:

| Package                           | Layer   | May Import From                |
| --------------------------------- | ------- | ------------------------------ |
| `provider-anthropic/src/index.ts` | Adapter | L0 only (`@atisse/core` types) |
| `memory-redis/src/index.ts`       | Adapter | L0 only (`@atisse/core` types) |
| `context-rag/src/index.ts`        | Adapter | L0 only (`@atisse/core` types) |

Adapters depend on **Layer 0 only** — never on L1–L4 internals.

---

## 10. Constraint Verification Checklist

Per `.opencode/rules/constraints.md` — applied to every M4 file before PR:

- [ ] No `any` type — `unknown` + narrowing throughout
- [ ] No `.then()/.catch()` chains — `async/await` only
- [ ] No plain `Error` throws — always typed `OrchestratorError`
- [ ] All imports from `@atisse/core` use `import type` for type-only symbols
- [ ] `ContextProvider.provide()` output NEVER maps `input.prompt` to `role: 'system'`
- [ ] Redis storage key always includes `sessionId` — never global key
- [ ] Tool call deltas accumulated inside adapter — no partial chunks exposed (D-M4-5)

---

## 11. Security Checklist

Per `.opencode/rules/security.md`:

- [ ] API keys never appear in log entries or error messages (S-1)
- [ ] `AnthropicProvider`: `input.prompt` always mapped to `role: 'user'`, never `role: 'system'` (S-2)
- [ ] `RAGContextProvider`: `input.prompt` used for search query only — NOT in output messages (S-2, S-6)
- [ ] `RedisMemoryAdapter`: storage key always scoped to `sessionId` (S-4)
- [ ] `mapError()` messages describe failure category — no internal HTTP body or paths (S-7)
- [ ] `pnpm audit --audit-level=high` clean (S-8)

---

## 12. Exit Criteria

Per `.opencode/rules/roadmap.md` §M4 Exit Criteria — M4 is complete when ALL pass:

- [ ] `AnthropicProvider` passes all unit tests (error mapping, message mapping, streaming chunk assembly)
- [ ] `AnthropicProvider` wired into `Orchestrator` integration tests: retry, hooks, state machine
- [ ] `RedisMemoryAdapter` passes unit tests — append semantics, error mapping, key isolation
- [ ] `RedisMemoryAdapter` append semantics verified in integration: sequential `run()` calls accumulate history correctly
- [ ] `RAGContextProvider` passes unit tests — output type, security assertion, error path
- [ ] `RAGContextProvider` fail-fast path tested end-to-end (ADR-015)
- [ ] `pnpm --recursive lint` exits 0
- [ ] `pnpm --recursive typecheck` exits 0
- [ ] `pnpm --recursive test` exits 0
- [ ] CI pipeline green on a clean checkout

---

## 13. What M4 Does NOT Include

Per `.opencode/rules/roadmap.md` §M5 and `.opencode/rules/constraints.md`:

- Coverage threshold enforcement → M5
- TypeDoc error blocking in CI → M5
- Performance benchmarks → M5
- Security checklist formal sign-off → M5
- Parallel tool execution → FORBIDDEN in v1
- Streaming + fallback combination → FORBIDDEN in v1 (ADR-017)
- Configurable partial context failure → FORBIDDEN in v1 (ADR-015)
- RAGContextProvider with a specific vector DB SDK (Pinecone, pgvector, etc.) → user-land
