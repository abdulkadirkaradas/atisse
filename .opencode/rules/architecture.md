# ARCHITECTURE

## System Design Reference

---

## High-Level Overview

```
┌──────────────────────────────────────────────┐
│  USER CODE: orchestrator.run({ prompt })     │
└─────────────────────┬────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────┐
│              ORCHESTRATOR (core)                │
│  ┌──────────────────────────────────────────┐   │
│  │  PIPELINE                                │   │
│  │  beforeRun → ContextProvider.provide()   │   │
│  │  → MemoryAdapter.load()                  │   │
│  │  → PromptComposer.compose()              │   │
│  │  → beforeGenerate → AIProvider.generate()│   │
│  │  → [ToolController loop] → afterGenerate │   │
│  │  → MemoryAdapter.save() → afterRun       │   │
│  └──────────────────────────────────────────┘   │
│  EventBus (async obs.)  PolicyEngine (retry/to) │
└──────────────────┬──────────────────────────────┘
       ┌───────────┼───────────┐
  PROVIDER     MEMORY      CONTEXT
  ADAPTER      ADAPTER     PROVIDER
```

---

## Package Architecture

```
@atisse/provider-openai    ──┐
@atisse/provider-anthropic ──┤
@atisse/memory-inmemory    ──┼──► @atisse/core (interfaces only)
@atisse/memory-redis       ──┤
@atisse/context-rag        ──┘

@atisse/core has ZERO runtime dependencies on adapter packages.
```

### Core Package Internal Structure

```
packages/core/src/
├── interfaces.ts         FROZEN — all public contracts
├── errors.ts             Error hierarchy + isRetryable()
├── types.ts              Internal types (not exported)
├── orchestrator.ts       Public surface: new Orchestrator(config), run(), on()
├── pipeline.ts           Execution sequence — owns all steps 1–10
├── lifecycle.ts          LifecycleStateMachine + VALID_TRANSITIONS
├── prompt-composer.ts    Assembles Message[] from all sources
├── tool-controller.ts    Tool execution loop, round limiting, validation
├── hooks.ts              HookRegistry + runHooks() + normalizeHookRegistry()
├── events.ts             EventBus + OrchestratorEvent union
├── policies.ts           RetryPolicy, TimeoutPolicy, ToolPolicy + defaults + merge utils
├── profile.ts            OrchestratorProfile merge logic
└── testing/
    └── mock-provider.ts  MockProvider — test infrastructure, not an adapter
```

---

## Execution Flow (Detailed)

Every `run()` call follows this exact sequence. The entire pipeline is wrapped in
`Promise.race([executePipeline(...), totalTimeoutTimer])` — `totalTimeoutMs` is a hard ceiling
enforced at the top level regardless of which step is active.

```
1.  INITIALIZED
    - Validate OrchestratorConfig — throw ConfigValidationError if invalid
    - Resolve active profile; merge systemPrompt (profile.systemPrompt replaces config.systemPrompt)
    - Validate: profile key not found in config.profiles → ConfigValidationError
    - Emit: profile.resolved (if active), run.started
    - Generate runId (crypto.randomUUID()); initialize round counter (local: let roundCounter = 0)
    - Initialize tempMessages = [] (holds [userMessage, assistantMessage] for COMPLETING)

2.  CONTEXT_INJECTING
    - For each ContextProvider SEQUENTIALLY: await provider.provide(contextProviderInput)
      contextProviderInput = { prompt, sessionId, metadata } (stream and profile omitted)
    - On success: emit context.loaded; collect SystemMessage[] into contextMessages
    - On ContextLoadError (retryable): emit context.failed; goto RETRYING
    - On fatal error: emit context.failed; goto FAILED
    - Partial success is NOT possible — first provider failure aborts all loading

3.  CONTEXT_INJECTED
    - SEQUENTIALLY after context: await memoryAdapter.load(sessionId) if sessionId present
    - Produces memoryMessages (may be [])
    - Store userMessage = { role: 'user', content: input.prompt } into tempMessages[0]

4.  PROMPT_COMPOSED
    - PromptComposer assembles Message[] in this fixed order:
        1. systemPrompt (resolved string from Step 1 — profile overrides config)
        2. contextMessages (from ContextProviders)
        3. memoryMessages (trimmed to maxTokens — oldest dropped first; never trims context)
        4. userMessage (role: 'user', always last)
        5. tool definitions passed separately in PromptRequest.tools
    - estimateTokens(text) ≈ Math.ceil(text.length / 4) — rough approximation

5.  GENERATING (+ retry loop)
    - Run beforeGenerate hooks (pipeline-blocking); context: BeforeGenerateContext
    - Build PromptRequest — attach AbortSignal from generateTimeoutMs if configured
    - If stream: false → Call AIProvider.generate(request)
    - If stream: true  → Call AIProvider.generateStream(request) (returns Promise<AsyncIterable>)
        Dispatch guard (checked at run() entry, throws ConfigValidationError if violated):
        • provider.capabilities.streaming === false → forbidden
        • provider.generateStream === undefined    → forbidden
        • fallbackProvider configured              → forbidden (see CONSTRAINTS.md)
    - On retryable ProviderError: goto RETRYING (exponential backoff)
    - On fatal ProviderError: goto FAILED
    - On MaxRetriesExceeded + fallback exists: goto FALLBACKING
    - On tool_calls in response: goto TOOL_EXECUTING
    - On stop: run afterGenerate hooks (pipeline-blocking); context: AfterGenerateContext
        Streaming mode: afterGenerate is called AFTER the 'done' chunk is received;
        response contains accumulated text and usage from the completed stream
    - Emit: generate.completed
    - Store assistantMessage = { role: 'assistant', content: response.text } into tempMessages[1]

6.  TOOL_EXECUTING (loop, max=toolPolicy.maxToolRounds)
    - roundCounter lives in pipeline.ts as a local variable — NOT inside ToolController
    - roundCounter increments here and is checked against maxToolRounds (never resets on retry)
    - Run beforeTool hooks for each tool call
    - ToolController: validate tool input against schema (ToolValidationError = FATAL)
    - ToolController: execute tool wrapped in Promise.race(toolTimeoutMs) (ToolExecutionError = retryable)
    - Run afterTool hooks
    - Emit: tool.called, tool.completed / tool.failed
    - Append tool results to messages; return to GENERATING with updated messages

7.  RETRYING
    - Exponential backoff + jitter delay; emit: retry.attempt
    - Return to GENERATING or CONTEXT_INJECTING

8.  FALLBACKING
    - Swap to fallbackProvider; emit: fallback.triggered → return to GENERATING

9.  COMPLETING
    - If sessionId present: await memoryAdapter.save(sessionId, tempMessages)
      tempMessages = [userMessage, assistantMessage] — saved atomically in one call
    - Run afterRun hooks (pipeline-blocking); context: RunContext & { output: RunOutput }

10. COMPLETED (terminal) — emit: run.completed, return RunOutput (includes runId)
    FAILED   (terminal) — emit: run.failed, throw OrchestratorError
```

### Timeout Enforcement

- **`generateTimeoutMs`** — `AbortSignal` attached to each `PromptRequest`; `Promise.race` fallback for non-cooperative providers.
- **`toolTimeoutMs`** — each `Tool.execute()` wrapped in `Promise.race` by `ToolController`.
- **`totalTimeoutMs`** — `Promise.race([executePipeline(...), timeoutPromise])` at `pipeline.ts` top level; hard ceiling covering all steps including context loading, retries, and tool rounds.

### ContextProvider Partial Failure

Fail-fast: first provider failure aborts all context loading → `RETRYING` or `FAILED`.
Partial results from earlier providers are discarded. `context.failed` emitted before transition.

---

## Streaming Execution Flow

Pre-conditions checked at `run()` entry (throw `ConfigValidationError` if violated):
`provider.capabilities.streaming === false`, `provider.generateStream === undefined`, or `fallbackProvider` configured.

Steps 1–4 identical to non-streaming. From Step 5:

```
5. GENERATING (streaming)
    - Await AIProvider.generateStream(request) → AsyncIterable<StreamChunk>
    - Yield { type: 'text', delta: '...' } chunks as they arrive
    - On tool_calls: yield { type: 'tool_call', ... } → pause stream

6. TOOL_EXECUTING (streaming)
    - Execute tool synchronously (blocking — never streamed)
    - Yield { type: 'tool_result', ... }
    - Resume streaming with updated messages

    Final:   yield { type: 'done', usage?: {...} }
    Failure: yield { type: 'error', ... } — stream terminates
    afterGenerate hook fires after 'done' chunk — response holds accumulated output
```

---

## Profile Resolution

`BaseConfig + ProfileOverride = ResolvedConfig` (local to this `run()` call only).

| Field                            | Merge strategy                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------- |
| `provider`, `systemPrompt`       | profile value replaces base (`??`)                                                  |
| `retry`, `timeout`, `toolPolicy` | deep merge — profile keys override matching base keys                               |
| `tools`, `contextProviders`      | full replace — base list discarded when profile defines either (`[]` also replaces) |
| `hooks`                          | concatenate — base hooks first, then profile hooks                                  |

Profile key not found in `config.profiles` → `ConfigValidationError` at `run()` entry.
`profile.resolved` event emitted after merge, before `CONTEXT_INJECTING`.

---

## Internal Layer Architecture

Dependencies flow downward only — upward imports are forbidden.

```
Layer 0 — contracts:   interfaces.ts, errors.ts, types.ts
Layer 1 — primitives:  lifecycle.ts, policies.ts, prompt-composer.ts
Layer 2 — controllers: tool-controller.ts, hooks.ts, events.ts
Layer 3 — pipeline:    pipeline.ts
Layer 4 — surface:     orchestrator.ts
Adapters:              depend only on Layer 0 — never on L1–L4
```

---

## pipeline.ts vs orchestrator.ts

**`orchestrator.ts` (L4):** owns `new Orchestrator(config)`, `run()`, `on()`. Validates config eagerly.
Constructor checks: provider present, profiles[key].name === key, allowParallelTools !== true,
maxToolRounds ≥ 1, timeout values valid, no duplicate tool names. Constructs and owns `EventBus`.
Delegates all execution to `pipeline.ts`.

**`pipeline.ts` (L3):** owns all steps 1–10. Creates `LifecycleStateMachine`, `runId`,
`tempMessages`, and `roundCounter` as local variables per call — nothing stored on `this`.
Receives `EventBus` and `Logger` by injection. Emits all events and writes all logs.

---

## Key Design Constraints

1. `core` has zero imports from adapter packages
2. `interfaces.ts` is never modified in a breaking way during v1
3. `run()` never stores state on `this` — all state is local to the call
4. Hooks execute serially, in registration order
5. Events never throw — listener errors are swallowed
6. `MockProvider` lives in `core/testing/` — test infrastructure, not an adapter
7. All public API types exported from `interfaces.ts` — not from implementation files
