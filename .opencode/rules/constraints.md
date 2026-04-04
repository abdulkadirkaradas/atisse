# CONSTRAINTS
## Hard Limits and Forbidden Patterns

This document defines what is NOT allowed in this codebase.
These constraints are non-negotiable and enforced in code review.

---

## v1 Scope Hard Limits

The following features are FORBIDDEN in v1. Do not implement, scaffold, or add configuration for them.

| Forbidden Feature | Category | Why |
|---|---|---|
| Agent planning loop | Agent | Turns this into an agent framework |
| Autonomous decision-making | Agent | Kernel does not reason |
| Multi-agent communication | Agent | Different product |
| Workflow DAG / step chaining | Workflow | Pipeline engine scope |
| Graph-based execution | Workflow | Pipeline engine scope |
| Parallel tool execution | Tools | v2 feature — v1 is serial only |
| Visual editor / no-code UI | Product | Not a UI project |
| SaaS dashboard | Product | Not a SaaS |
| Prompt template DSL | DSL | Not a template engine |
| Distributed orchestration | Infra | Not this project's concern |
| Cost analytics dashboard | Analytics | SaaS feature |
| Built-in RAG pipeline | RAG | RAG is a ContextProvider adapter, not core |

If a task requires one of the above, stop and clarify with the user.

---

## Code-Level Forbidden Patterns

### No state on Orchestrator instance during run()

```typescript
// FORBIDDEN
class Orchestrator {
  private currentRunState: RunState;  // FORBIDDEN
  async run(input: RunInput) {
    this.currentRunState = { ... };   // FORBIDDEN
  }
}

// CORRECT — all state is local to run()
async run(input: RunInput): Promise<RunOutput> {
  const stateMachine = new LifecycleStateMachine();
  const runId = generateRunId();
  let roundCounter = 0;  // local — never on this
}
```

### No imports from adapters in core

```typescript
// FORBIDDEN
import { OpenAIProvider } from '@atisse/provider-openai';   // FORBIDDEN in core
import { RedisMemoryAdapter } from '@atisse/memory-redis';  // FORBIDDEN in core

// CORRECT
import type { AIProvider, MemoryAdapter } from './interfaces';
```

### No breaking changes to interfaces.ts

```typescript
// FORBIDDEN — removing a field
export interface AIProvider {
  readonly id: string;
  // readonly capabilities removed  <-- FORBIDDEN
}

// FORBIDDEN — changing a type
export interface RetryPolicy {
  maxAttempts: string;  // was number  <-- FORBIDDEN
}

// ALLOWED — adding optional fields only
export interface RetryPolicy {
  maxAttempts: number;
  backoffMultiplier?: number;  // new optional field — backward compatible
}
```

### No `any` types

```typescript
// FORBIDDEN
function processResponse(data: any): string { ... }

// CORRECT
function processResponse(data: unknown): string {
  if (typeof data !== 'string') throw new Error('Expected string');
  return data;
}
```

### No secrets in logs or errors

```typescript
// FORBIDDEN
throw new ProviderAuthError(`API key ${apiKey} was rejected`);
logger.debug('Request', { headers: { Authorization: `Bearer ${token}` } });

// CORRECT
throw new ProviderAuthError('Authentication failed — check your API key');
logger.debug('Request sent', { model: this.model, messageCount: request.messages.length });
```

### No synchronous blocking in async functions

```typescript
// FORBIDDEN
async function generate(request: PromptRequest) {
  const data = fs.readFileSync('./config.json');  // sync blocking
}

// CORRECT
async function generate(request: PromptRequest) {
  const data = await fs.promises.readFile('./config.json');
}
```

### No event listeners that throw

```typescript
// FORBIDDEN
orchestrator.on('run.failed', (event) => {
  errorTracker.capture(event.error);  // if this throws, silently breaks observability
});

// CORRECT
orchestrator.on('run.failed', (event) => {
  try { errorTracker.capture(event.error); } catch { /* silently handle */ }
});
```

### No circular dependencies

Imports between `core/` modules must follow the layer rules in `architecture.md`.
`import type` from the same Layer 0 is permitted (e.g. `interfaces.ts` ↔ `errors.ts`).
Runtime circular imports (non-type) are FORBIDDEN.

### No User Input as System Role

```typescript
// FORBIDDEN
messages.push({ role: 'system', content: userInput });     // FORBIDDEN
messages.push({ role: 'system', content: input.prompt });  // FORBIDDEN

// CORRECT
messages.push({ role: 'user', content: input.prompt });
```

`role: 'system'` is reserved for developer-authored content: hardcoded hook instructions,
ContextProvider outputs, and profile `systemPrompt`. See `security.md` S-2.

### No User-Controlled Input in Profile Factory Arguments

```typescript
// FORBIDDEN — user value flows into systemPrompt
export function createProfile(userPreference: string): OrchestratorProfile {
  return { name: 'assistant', systemPrompt: `Style: ${userPreference}` }; // FORBIDDEN
}

// CORRECT — factory accepts initialized adapter instances only
export function createSupportProfile(vectorStore: VectorStore): OrchestratorProfile {
  return {
    name: 'support',
    systemPrompt: 'You are a helpful customer support agent.',  // hardcoded — safe
    contextProviders: [new RAGContextProvider({ vectorStore })],
  };
}
```

### No mismatched `profiles` key and `name` field

```typescript
// FORBIDDEN
profiles: { editor: { name: 'copy-editor', ... } }  // key !== name

// CORRECT
profiles: { editor: { name: 'editor', ... } }        // key === name
```

Constructor validates this invariant and throws `ConfigValidationError` on mismatch.

### No duplicate tool names

```typescript
// FORBIDDEN — two tools with the same name
new Orchestrator({
  tools: [
    { name: 'search', ... },
    { name: 'search', ... },  // FORBIDDEN — duplicate name
  ]
});
```

Constructor throws `ConfigValidationError` on duplicate tool names.

### No `allowParallelTools: true` in v1

```typescript
// FORBIDDEN in v1
new Orchestrator({ toolPolicy: { allowParallelTools: true } });  // ConfigValidationError
```

### No `maxToolRounds` below 1

```typescript
// FORBIDDEN
new Orchestrator({ toolPolicy: { maxToolRounds: 0 } });  // ConfigValidationError
```

### No `stream: true` combined with `fallbackProvider`

```typescript
// FORBIDDEN
const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({ apiKey }),
  fallbackProvider: new OpenAIProvider({ model: 'gpt-4o-mini', apiKey }),
});
await orchestrator.run({ prompt: '...', stream: true }); // ConfigValidationError at run() entry
```

### No plain `Error` throws in adapters or kernel

```typescript
// FORBIDDEN — kernel cannot make retry decision
throw new Error('Rate limited');

// CORRECT
throw new ProviderRateLimitError('Rate limited', retryAfterMs, originalError);
```

### `TokenLimitExceededError` is user-land only

The kernel does NOT throw `TokenLimitExceededError` internally — prompt overflow is handled
by trimming `memoryMessages`. This class exists for use in `beforeRun` hooks where user code
enforces custom token budgets.

---

## Interface Modification Rules

| Question | If YES |
|---|---|
| Does removing a field break any adapter? | Do NOT remove the field |
| Does changing a type break existing code? | Do NOT change the type |
| Is the new field required? | Make it optional instead |
| Does this change the `run()` return shape? | Major version — escalate to SPSA |

---

## Test Constraints

- NO real API calls in tests — always use `MockProvider`
- NO network access in unit tests
- NO file system writes in tests (use in-memory alternatives)
- NO `setTimeout` with real durations — use fake timers per-test (`vi.useFakeTimers()`)
- Test files MUST NOT import from other test files (no shared mutable state)
