---
trigger: model_decision
description: Load when writing TypeScript code. Applies naming conventions, type declaration rules, async/await patterns, import ordering, and ESLint/Prettier configuration standards.
---

# TYPESCRIPT STYLE
## Language Conventions and Syntax Standards

---

## TypeScript Configuration

### tsconfig.base.json (root)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  }
}
```

Key flags explained:
- `strict: true` — enables all strict checks (required, non-negotiable)
- `exactOptionalPropertyTypes` — `{ a?: string }` cannot be `{ a: undefined }`
- `noUncheckedIndexedAccess` — array/object index access returns `T | undefined`
- `noUnusedLocals/Parameters` — dead code is a compile error

---

## Type Declarations

### Prefer `interface` over `type` for objects
```typescript
// CORRECT — use interface for object shapes
interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
}

// CORRECT — use type for unions, primitives, computed types
type LifecycleState = 'INITIALIZED' | 'GENERATING' | 'FAILED';
type LifecycleHook<T> = (context: T) => Promise<T> | T;
```

### Use `type` for imports when the value is only used as a type
```typescript
// Preferred for interface/type imports — enables type erasure
import type { AIProvider, RunInput } from './interfaces';

// Only use plain import when you need the value at runtime
import { ProviderRateLimitError } from './errors';
```

### Never use `any`
```typescript
// WRONG
function parseResponse(data: any): string { ... }

// CORRECT — use unknown and narrow
function parseResponse(data: unknown): string {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid');
  return (data as Record<string, unknown>).text as string;
}

// CORRECT — use generics
function wrap<T>(value: T): { data: T } { return { data: value }; }
```

### Readonly and Immutability
```typescript
// Use readonly on interface fields that should not be mutated externally
export interface AIProvider {
  readonly id: string;
  readonly capabilities: Readonly<ProviderCapabilities>;
}

// Use ReadonlyArray for arrays that should not be mutated
type HookList<T> = ReadonlyArray<LifecycleHook<T>>;
```

---

## Naming Conventions

| Element | Convention | Example |
|---|---|---|
| Class | PascalCase | `LifecycleStateMachine` |
| Interface | PascalCase | `AIProvider`, `RetryPolicy` |
| Type alias | PascalCase | `LifecycleState`, `StreamChunk` |
| Enum | PascalCase (avoid — use union types) | — |
| Function | camelCase verb | `executeWithRetry()` |
| Method | camelCase verb | `.generate()`, `.isTerminal()` |
| Variable | camelCase noun | `retryPolicy`, `toolResults` |
| Constant | SCREAMING_SNAKE | `VALID_TRANSITIONS`, `DEFAULT_RETRY` |
| File | kebab-case | `lifecycle.ts`, `mock-provider.ts` |
| Test file | `*.test.ts` | `orchestrator.test.ts` |
| Generic type | Single uppercase or descriptive | `T`, `TContext`, `TInput` |
| Boolean var | `is/has/should` prefix | `isRetryable`, `hasToolCalls` |
| Private field | no underscore (use `private`) | `private client: OpenAI` |

---

## Async / Await

```typescript
// ALWAYS use async/await — never .then().catch() chains
// CORRECT
async function loadContext(sessionId: string): Promise<Message[]> {
  const messages = await memoryAdapter.load(sessionId);
  return messages;
}

// WRONG
function loadContext(sessionId: string): Promise<Message[]> {
  return memoryAdapter.load(sessionId).then(m => m).catch(e => { throw e; });
}
```

### Parallel Execution (use sparingly)
```typescript
// Only when operations are truly independent AND sequential ordering has no meaning.
// Context loading and memory loading are NOT candidates — they are sequential
// by design (see ARCHITECTURE.md Execution Flow Steps 2–3).

// Example of genuinely independent operations:
const [userProfile, featureFlags] = await Promise.all([
  profileService.get(userId),
  featureFlagService.getAll(),
]);
```

### Async Iterables (for streaming)
```typescript
// Use for-await-of for consuming AsyncIterable
async function* generateStream(request: PromptRequest): AsyncIterable<StreamChunk> {
  for await (const chunk of this.client.stream(request)) {
    yield { type: 'text', delta: chunk.content };
  }
  yield { type: 'done', usage: { ... } };
}
```

---

## Error Handling Syntax

```typescript
// Type narrowing in catch — never catch as `any`
try {
  return await provider.generate(request);
} catch (error: unknown) {
  if (error instanceof ProviderRateLimitError) {
    // typed, specific handling
    throw error;
  }
  if (error instanceof OrchestratorError) {
    throw error;  // rethrow typed errors as-is
  }
  // Unknown errors — wrap with context
  throw new ProviderUnavailableError('Unknown provider error', error);
}
```

---

## Generics

```typescript
// Use generics when the type flows through without transformation
async function runHooks<TContext>(
  hooks: LifecycleHook<TContext>[],
  context: TContext
): Promise<TContext> {
  let ctx = context;
  for (const hook of hooks) {
    ctx = await hook(ctx);
  }
  return ctx;
}

// Constrain generics when needed
function mergePolicy<T extends Partial<RetryPolicy>>(
  base: RetryPolicy,
  override: T
): RetryPolicy {
  return { ...base, ...override };
}
```

---

## Object Patterns

```typescript
// Spread for immutable updates — never mutate objects
const updatedContext: RunContext = {
  ...context,
  messages: [...context.messages, newMessage],
};

// Destructure for readability
const { maxAttempts, baseDelayMs, jitter } = retryPolicy;

// Optional chaining for nullable access
const retryAfter = error instanceof ProviderRateLimitError
  ? error.retryAfterMs
  : undefined;
```

---

## File Structure Template

Every TypeScript source file follows this structure:

```typescript
// 1. Node built-in imports
import { randomUUID } from 'crypto';

// 2. External package imports (type-only preferred)
import type { /* ... */ } from 'zod';

// 3. Internal imports — types first, then values
import type { AIProvider, RunInput, RunOutput } from './interfaces';
import { ProviderRateLimitError, isRetryable } from './errors';
import { LifecycleStateMachine } from './lifecycle';

// 4. Constants (SCREAMING_SNAKE)
const DEFAULT_RUN_TIMEOUT_MS = 60_000;

// 5. Types / Interfaces (local to this file, not exported)
interface InternalRunState {
  runId: string;
  startTime: number;
}

// 6. Main export (class, function, or const)
export class Orchestrator {
  // ...
}

// 7. Helper functions (not exported)
function generateRunId(): string {
  return randomUUID();
}
```

---

## ESLint Rules (enforce these)

```json
{
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/consistent-type-imports": ["error", { "prefer": "type-imports" }],
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/await-thenable": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "no-console": "warn",
  "prefer-const": "error",
  "no-var": "error"
}
```

---

## Prettier Configuration

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2,
  "arrowParens": "always"
}
```
