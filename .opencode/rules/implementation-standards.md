# IMPLEMENTATION STANDARDS

## Day-to-Day Coding Rules and Safety Practices

This document defines HOW WE WRITE code. Read this when producing any implementation —
core features, adapters, hooks, tests, or utilities.

---

## Defensive Programming and Fail-Fast

**Core principle:** Validate at the boundary. Trust nothing that enters from outside.
Boundaries are: `run()` entry, adapter returns, tool execution input/output.

### Guard Clauses — Fail at the Top

Reject invalid state immediately. Do not let invalid data propagate deep into the call stack.

```typescript
// WRONG — validation buried inside logic
async function compose(params: ComposeParams): Promise<Message[]> {
  const messages = buildMessages(params);
  if (!params.userPrompt) {
    // too late — already called buildMessages
    throw new Error('Missing prompt');
  }
  return messages;
}

// CORRECT — guard at the top, fail immediately
async function compose(params: ComposeParams): Promise<Message[]> {
  if (!params.userPrompt) throw new ConfigValidationError(['userPrompt is required']);
  if (params.maxTokens !== undefined && params.maxTokens <= 0) {
    throw new ConfigValidationError(['maxTokens must be positive']);
  }
  return buildMessages(params);
}
```

### Config Validation — Fail in Constructor

Invalid configuration must be caught at construction time, not at first `run()`.

```typescript
// WRONG — validation deferred to run()
class Orchestrator {
  async run(input: RunInput) {
    if (!this.config.provider) throw new Error('No provider'); // too late
  }
}

// CORRECT — validate eagerly in constructor
class Orchestrator {
  constructor(config: OrchestratorConfig) {
    if (!config.provider) {
      throw new ConfigValidationError(['provider is required']);
    }
    this.config = config;
  }
}
```

### Trust Nothing From Adapters

Adapter return values must be validated before use. Adapters can be third-party code.

```typescript
// WRONG — trusting adapter blindly
const messages = await memoryAdapter.load(sessionId);
messages.forEach((m) => process(m)); // what if adapter returns null?

// CORRECT — validate adapter output
const raw = await memoryAdapter.load(sessionId);
const messages = Array.isArray(raw) ? raw : [];
```

### Precondition Assertions in Core Functions

Internal functions that require a specific state must assert it explicitly.

```typescript
stateMachine.assertNotTerminal(); // throws InvalidStateTransitionError if terminal
stateMachine.transition('GENERATING');
```

---

## Complexity Management

High complexity is a maintenance liability. Enforce limits proactively.

### Cyclomatic Complexity

Maximum cyclomatic complexity per function: **7**.
If a function exceeds 7 decision paths, extract logic into smaller named functions.

```typescript
// WRONG — high cyclomatic complexity (8+ paths)
async function execute(error: unknown, attempt: number, policy: RetryPolicy) {
  if (error instanceof ProviderRateLimitError) {
    if (error.retryAfterMs) {
      if (attempt < policy.maxAttempts) {
        if (policy.jitter) { ... } else { ... }
      } else {
        if (this.fallback) { ... } else { ... }
      }
    }
  } else if (error instanceof ProviderTimeoutError) {
    if (attempt < policy.maxAttempts) { ... }
  }
}

// CORRECT — extracted, named functions reduce paths per unit
function calculateDelay(error: OrchestratorError, attempt: number, policy: RetryPolicy): number {
  const base = error instanceof ProviderRateLimitError && error.retryAfterMs
    ? error.retryAfterMs
    : policy.baseDelayMs * Math.pow(2, attempt);
  return policy.jitter ? applyJitter(base) : base;
}
```

### Nesting Depth

Maximum nesting depth: **3 levels**.
Beyond 3 levels: extract to a named function or use early return.

```typescript
// WRONG — 4 levels deep
async function run() {
  if (hasSession) {
    const messages = await load();
    if (messages.length > 0) {
      for (const msg of messages) {
        if (msg.role === 'user') { ... }   // level 4
      }
    }
  }
}

// CORRECT — early return + extracted function
async function run() {
  if (!hasSession) return [];
  const messages = await load();
  return messages.filter(m => m.role === 'user').map(processUserMessage);
}
```

### Size Limits

| Unit                     | Maximum   | Action if exceeded          |
| ------------------------ | --------- | --------------------------- |
| Function body            | 40 lines  | Extract a named helper      |
| Class                    | 200 lines | Split into focused classes  |
| Public methods per class | 7         | Reconsider responsibilities |
| Parameters per function  | 3         | Use an options object       |

---

## Concurrency and Async Safety

This project runs on Node.js (single-threaded event loop). "Concurrency" here means
multiple concurrent `run()` calls on the same `Orchestrator` instance, not threads.

### The Stateless Contract

`run()` MUST NOT read from or write to instance-level mutable state.
All execution state lives in local variables scoped to the call.

```typescript
// WRONG — instance-level state causes cross-run contamination
class Orchestrator {
  private activeRunId: string; // FORBIDDEN
  private currentMessages: Message[]; // FORBIDDEN

  async run(input: RunInput) {
    this.activeRunId = generateRunId(); // race condition with concurrent runs
  }
}

// CORRECT — all state is local to run()
class Orchestrator {
  async run(input: RunInput): Promise<RunOutput> {
    const runId = generateRunId(); // local — isolated per call
    const stateMachine = new LifecycleStateMachine(); // local
    const messages: Message[] = []; // local
  }
}
```

### Shared Read-Only State Is Safe

Config, registered tools, and policies are set at construction and never mutated.
Reading from them concurrently is safe.

```typescript
class Orchestrator {
  private readonly config: ResolvedConfig; // set once, never mutated

  async run(input: RunInput) {
    const policy = this.config.retry; // safe concurrent read
  }
}
```

### Event Bus Async Safety

Listeners must not perform long blocking operations.
If a listener needs async work, it fires its own process and does not await it.

```typescript
// WRONG — blocking async inside listener
orchestrator.on('run.completed', async (event) => {
  await database.save(event); // blocks other listeners
});

// CORRECT — fire and forget, handle errors independently
orchestrator.on('run.completed', (event) => {
  database.save(event).catch((err) => logger.error('Failed to save event', { err }));
});
```

### No Shared Mutable Collections

```typescript
// WRONG — shared mutable array across runs
class Orchestrator {
  private toolResults: ToolResult[] = [];   // FORBIDDEN

  async run(input: RunInput) {
    this.toolResults.push(result);
  }
}

// CORRECT — local per run
async run(input: RunInput): Promise<RunOutput> {
  const toolResults: ToolResult[] = [];   // isolated
}
```

---

## Code Quality Rules

### Functions

- Max function length: 40 lines. Extract if longer.
- Max parameters: 3. Use an options object if more are needed.
- Functions do ONE thing. Name them as verbs: `loadContext()`, `validateInput()`.

### Classes

- Max class length: 200 lines. Split if longer.
- No more than 7 public methods per class.
- Constructor must not contain business logic — only validation and assignment.

### Naming

- Use intention-revealing names: `retryableError` not `err2`
- Avoid abbreviations: `sessionId` is acceptable, `sid` is not
- Boolean variables: `isRetryable`, `hasToolCalls`, `shouldFallback`
- Collections use plural: `messages`, `hooks`, `tools`

### Immutability

- Prefer `const` over `let`. Never use `var`.
- Do not mutate function parameters. Return new objects.
- Use `readonly` on all interface fields that should not be mutated externally.

```typescript
// WRONG
function addSystemMessage(messages: Message[], content: string) {
  messages.push({ role: 'system', content }); // mutates input
}

// CORRECT
function addSystemMessage(messages: Message[], content: string): Message[] {
  return [...messages, { role: 'system', content }];
}
```

### Async

- All async operations use `async/await` — never `.then()/.catch()` chains
- Always `await` promises — never fire-and-forget inside the pipeline
- Use `Promise.all()` only when operations are truly independent

### Error Handling

- Never catch and ignore errors silently
- Catch only what you intend to handle
- See `workflows/error-handling.md` for full rules

---

## Module Organization Rules

```
One responsibility per file.
Public API exported from index.ts only.
Internal utilities in types.ts or dedicated util files.
No circular dependencies — verified by ESLint import plugin.
```

### Import Order (enforced by ESLint)

```typescript
// 1. Node built-ins
import { randomUUID } from 'crypto';

// 2. External packages (type-only preferred)
import type { OrchestratorError } from '@atisse/core';

// 3. Internal — contracts layer first
import type { AIProvider, RunInput } from './interfaces';
import { ProviderRateLimitError } from './errors';

// 4. Internal — same layer or below
import { LifecycleStateMachine } from './lifecycle';

// 5. Internal — relative, same directory
import type { RunContext } from './types';
```
