# PHILOSOPHY

## Core Design Principles

These principles are non-negotiable. Every implementation decision MUST be evaluated against them.
When in doubt, choose the option that better aligns with these principles.

---

## Principle 1: Explicit Over Magical

**Definition:** Every behavior must be visible, traceable, and predictable. No hidden state, no implicit side effects, no surprise execution paths.

**In practice:**

- If something happens, there is an explicit code path the developer can follow
- No monkey-patching, no global singletons with hidden mutation
- Every config option maps to exactly one observable behavior
- Debug output must tell the full story

**Violation example:**

```typescript
// WRONG — magic inference, hidden behavior
const chain = new ConversationalChain.fromLLM(llm, retriever);

// CORRECT — explicit wiring, every piece visible
const orchestrator = new Orchestrator({
  provider: new OpenAIProvider({ apiKey }),
  contextProviders: [new RAGContextProvider({ vectorStore })],
  hooks: {
    beforeGenerate: [
      (ctx) => {
        console.log(ctx.messages);
        return ctx;
      },
    ],
  },
});
```

---

## Principle 2: Interface-First Design

**Definition:** The core knows nothing about concrete implementations. All external dependencies are accessed through interfaces defined in `interfaces.ts`.

**In practice:**

- `core` never imports from `provider-openai`, `memory-redis`, or any adapter package
- All extension points are `interface` — not abstract class, not base class
- `interfaces.ts` is the single source of truth for contracts
- Adapters depend on core. Core never depends on adapters.

**Dependency direction:**

```
provider-anthropic  -->  core/interfaces.ts
provider-openai     -->  core/interfaces.ts
memory-inmemory     -->  core/interfaces.ts
memory-redis        -->  core/interfaces.ts
context-rag         -->  core/interfaces.ts
                          ^
                          core depends only on this file internally
```

---

## Principle 3: Kernel, Not Framework

**Definition:** This project is execution infrastructure. It enforces lifecycle rules. It does not make intelligent decisions, plan autonomously, or chain workflows.

**The Linux kernel analogy:**
| Linux Kernel                    | This Project                             |
| ------------------------------- | ---------------------------------------- |
| Manages process lifecycle       | Manages LLM interaction lifecycle        |
| Provides driver interfaces      | Provides adapter interfaces              |
| Enforces syscall boundaries     | Enforces provider/tool/memory boundaries |
| Is NOT a desktop environment    | Is NOT an agent framework                |
| Is NOT a scheduler that reasons | Is NOT a workflow engine                 |

**Litmus test:** If a feature requires the system to "decide" something on behalf of the user, it doesn't belong in the kernel.

---

## Principle 4: Stateless Core

**Definition:** The kernel holds no state between `run()` calls. Each execution is isolated, deterministic, and reproducible.

**In practice:**

- `run()` creates all execution state locally and discards it when complete
- No instance-level mutation during execution
- Session/conversation state lives exclusively in adapters (MemoryAdapter)
- Two concurrent `run()` calls must not interfere with each other

**Why:**

- Determinism — same input always produces same behavior
- Scalability — horizontal scaling requires no shared state
- Testability — each test is fully isolated
- Debuggability — reproducing a bug means replaying the same config + input

---

## Principle 5: Config Over Code

**Definition:** System behavior is defined through configuration objects, not by subclassing or overriding methods.

**In practice:**

- `new Orchestrator(config)` — everything is in the config
- Profiles are config snapshots, not subclasses
- Policies are plain objects, not strategy class hierarchies
- Hooks are functions in arrays, not overridden lifecycle methods

---

## Principle 6: Production-Ready Defaults

**Definition:** The defaults must be safe and sensible for production. A developer who uses the library without reading the docs should not ship broken reliability.

**Required defaults:**

```typescript
retry:   { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 30_000, jitter: true }
timeout: { generateTimeoutMs: 30_000, toolTimeoutMs: 10_000, totalTimeoutMs: 60_000 }
tools:   { maxToolRounds: 5, allowParallelTools: false }
```

---

## Principle 7: Small Core, Large Ecosystem

**Definition:** The `core` package must remain small, stable, and focused. Growth happens through adapters and ecosystem packages — not by expanding core.

**Core is responsible for:**

- Lifecycle state machine
- Retry/fallback policy engine
- Prompt composition
- Hook and event systems
- Interface contracts

**Core is NOT responsible for:**

- How OpenAI formats requests
- How Redis stores sessions
- How a vector DB finds similar documents
- How a specific tool executes

---

## When These Principles Conflict

Priority order when two principles appear to conflict:

1. Interface-First (never violate the contract boundary)
2. Stateless Core (never introduce cross-run state)
3. Explicit Over Magical (never hide behavior)
4. Kernel, Not Framework (never add intelligent decision-making)
5. Production-Ready Defaults (never ship unsafe defaults)
6. Config Over Code
7. Small Core, Large Ecosystem
