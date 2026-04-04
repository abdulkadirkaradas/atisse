# SECURITY
## Trust Boundaries, Threat Model, and Security Constraints

This kernel sits between user code and external systems (LLM providers, storage, tools).
Every crossing point is a trust boundary. This document defines those boundaries and the
security constraints that govern each layer.

---

## Trust Boundary Map

```
[UNTRUSTED: user input / prompt]
          │
          ▼
[BOUNDARY 1] run() → OrchestratorConfig validation
          │
          ├──► [BOUNDARY 2] ContextProvider.provide() → output message limit
          │
          ├──► [BOUNDARY 3] MemoryAdapter.load() → session isolation
          │
          ├──► [BOUNDARY 4] AIProvider.generate() → timeout, token limit
          │
          └──► [BOUNDARY 5] Tool.execute() → schema validation, round limit
```

The kernel **defines and enforces** these boundaries.
It does NOT make security policy decisions — that is the user's responsibility via hooks.

---

## Kernel Responsibility vs. User Responsibility

| Kernel Enforces | User / Adapter Responsibility |
|---|---|
| Trust boundary definitions | Content moderation |
| Input validation API surface | Allowlist decisions |
| Secret hygiene in core code | Authentication |
| Session isolation contract | Authorization logic |
| Tool hook surface | Sandboxing implementation |
| Message role integrity | Prompt injection detection |

---

## Security Constraints

### S-1: Secret Hygiene

Secrets MUST NEVER appear in logs, error messages, or events.
"Secret" includes: API keys, tokens, hashes, passwords, connection strings.

```typescript
// FORBIDDEN — secret leaked to log or error message
logger.error('Auth failed', { apiKey: this.config.apiKey });
throw new ProviderAuthError(`Key ${apiKey} rejected`);

// CORRECT
logger.error('Authentication failed', { runId, providerId: this.id });
throw new ProviderAuthError('Authentication failed — verify your API key');
```

**Rule:** Error messages describe *what* went wrong, never *which value* caused it.

**`provider.id` is NOT a secret:** `AIProvider.id` (e.g. `"openai-gpt-4o"`) is configuration metadata — it is safe to include in event payloads, log entries, and error messages. The S-1 prohibition applies to credentials, not to provider identity strings.

---

### S-2: Message Role Integrity (CRITICAL)

`run.input.prompt` MUST always be mapped to `role: 'user'`.
User input MUST NEVER be injected as `role: 'system'`.

```typescript
// FORBIDDEN — user input elevated to system role
messages.push({ role: 'system', content: userInput });   // FORBIDDEN

// CORRECT — user input is always user role
messages.push({ role: 'user', content: input.prompt });
```

`role: 'system'` is reserved exclusively for:
- Hardcoded instructions added via `beforeGenerate` hooks (developer-authored, trusted)
- `ContextProvider` outputs (trusted adapter content, see S-5)
- `OrchestratorProfile.systemPrompt` (developer-configured)

Any code path that accepts external input and maps it to `role: 'system'`
is a **security violation** — reject in code review without exception.

#### S-2a: Profile Factory Contamination

`OrchestratorProfile.systemPrompt` is developer-authored, trusted content.
Profile factory functions that accept user-controlled runtime input as arguments
flowing into `systemPrompt`, `hooks`, or `tools` violate this trust boundary —
even indirectly through string interpolation.

```typescript
// FORBIDDEN — user-controlled value flows into systemPrompt
export function createProfile(userPreference: string): OrchestratorProfile {
  return {
    name: 'assistant',
    systemPrompt: `Be helpful. User style: ${userPreference}`,  // S-2 VIOLATION
  };
}

// CORRECT — factory accepts only initialized adapter instances
export function createSupportProfile(vectorStore: VectorStore): OrchestratorProfile {
  return {
    name: 'support',
    systemPrompt: 'You are a helpful customer support agent.',   // hardcoded — safe
    contextProviders: [new RAGContextProvider({ vectorStore })],
  };
}
```

**Rule:** Profile factory function parameters MUST be initialized adapter instances
or developer-controlled configuration values — never strings, objects, or any other
data derived from `run.input` or external request payloads.

---

### S-3: Tool Execution Trust Boundary

Tools are the highest-risk surface — they call external systems.

#### S-3a: Input Validation (Kernel Enforces)

The kernel runs Zod schema validation BEFORE `Tool.execute()` is called.
`ToolValidationError` is FATAL — no retry.

```typescript
// FORBIDDEN — empty schema accepts any input
const badTool: Tool = {
  inputSchema: {},   // FORBIDDEN
  execute: async (input) => { ... }
};

// CORRECT — every field explicitly typed
const goodTool: Tool = {
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', maxLength: 500 } },
    required: ['query'],
    additionalProperties: false,
  },
  execute: async (input) => { ... }
};
```

#### S-3b: SSRF / URL Allowlist (Adapter Responsibility)

The kernel cannot prevent outbound HTTP calls from tools.
Tool authors MUST validate origins for any tool that makes HTTP requests:

```typescript
execute: async (input: unknown) => {
  const parsed = schema.parse(input);
  if (!isAllowedOrigin(parsed.url)) {
    throw new ToolExecutionError('fetch', new Error('URL not in allowlist'));
  }
  return fetch(parsed.url);
}
```

#### S-3c: Tool Output Serialization

Tool output MUST be serializable via `JSON.stringify` before entering the message pipeline.
Objects with circular references or non-serializable prototype chains are rejected.

---

### S-4: Cross-Session Memory Isolation

`MemoryAdapter` implementations MUST guarantee that session A's data never
appears in session B's `load()` result.

```typescript
// CORRECT — sessionId is part of the storage key
const key = `session:${sessionId}:messages`;

// FORBIDDEN — no session scoping
const key = `all_messages`;   // FORBIDDEN
```

The kernel verifies the return type (`Message[]`) but cannot verify isolation.
This is the adapter author's responsibility — see `ADAPTER_PATTERN.md`.

---

### S-5: ContextProvider Output Limits

Context provider outputs are bounded to prevent a malformed or malicious provider
from exhausting the token budget or injecting excessive content.

```typescript
// Default limits applied by the kernel (policies.ts) — internal only
contextPolicy: {
  maxMessagesPerProvider: 50,
  maxContentLengthChars: 50_000,
}
```

These limits are **kernel-internal defaults and are not user-configurable in v1**. They cannot be overridden via `OrchestratorConfig`. Community feedback on whether override support is needed will be considered for v2.

When limits are exceeded, the kernel logs a warning and truncates — it does not throw.

Note: `ContextProvider` outputs use `role: 'system'` because they represent
trusted, adapter-managed content — not user input. See S-2 for the distinction.

---

### S-6: ContextProvider Input Access Scope

`ContextProvider.provide()` receives `ContextProviderInput` — `Omit<RunInput, 'stream' | 'profile'>` — which includes `prompt`, `sessionId`, and `metadata`. The pipeline-internal `stream` and `profile` fields are excluded. Providers MAY read any of the remaining fields for retrieval (e.g. `input.metadata.userId`).

However, `input.prompt` MUST NOT be forwarded into a message with `role: 'system'`. User-authored content mapped to the system role is a trust boundary violation — see S-2.

```typescript
// FORBIDDEN — user prompt elevated to system role via context provider
return [{ role: 'system', content: input.prompt }];   // S-2 VIOLATION

// CORRECT — provider uses prompt for retrieval, returns its own content
const docs = await vectorStore.search(input.prompt);
return docs.map(doc => ({ role: 'system' as const, content: doc.text }));
```

---

### S-7: Code Execution and Error Exposure

**No dynamic code execution:** `eval()`, `new Function()`, and `vm.runInNewContext()` are forbidden in all kernel and adapter code. There are no legitimate use cases that require dynamic code evaluation.

**No internal details in error messages:** Error messages visible to callers MUST describe what went wrong in user-facing terms — never expose internal file paths, stack frames, config values, or system internals.

```typescript
// FORBIDDEN — exposes internal details
throw new ProviderUnavailableError(`Failed in pipeline.ts:142 — retryCount=${count}`);

// CORRECT — user-facing description only
throw new ProviderUnavailableError('Provider request failed after maximum retries');
```

---

### S-8: Dependency Security

| Requirement | Enforcement |
|---|---|
| Every PR | `pnpm audit --audit-level=high` — HIGH/CRITICAL block merge |
| Before release | `pnpm audit` — all levels must be clean |
| Adding a dependency | PR description must include justification |
| `@atisse/core` runtime deps | Zero (except Zod) — any new dep requires architecture discussion |

---

## Security Review Checklist (PR)

```
[ ] No secrets in log statements or error messages                (S-1)
[ ] User input (run.input.prompt) never mapped to role: 'system'  (S-2)
[ ] Profile factory args are adapter instances only — not strings  (S-2a)
    or any value derived from run.input or external request data
[ ] New tools have specific inputSchema — not empty object         (S-3a)
[ ] HTTP-calling tools implement URL allowlist check               (S-3b)
[ ] New MemoryAdapter uses sessionId-scoped storage keys           (S-4)
[ ] contextPolicy limits not bypassed — internal kernel default    (S-5)
[ ] ContextProvider does not map input.prompt to role: 'system'    (S-6)
[ ] No eval(), new Function(), or vm.runInNewContext() usage        (S-7)
[ ] Error messages contain no internal paths, counts, or details   (S-7)
[ ] pnpm audit HIGH+ is clean                                      (S-8)
```

---

## Reporting Security Vulnerabilities

Security vulnerabilities MUST NOT be reported via GitHub Issues.
Use private disclosure: [security contact — to be defined before public launch]