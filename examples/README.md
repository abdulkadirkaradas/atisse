# Examples

## 01 — Basic Run
Minimal `Orchestrator` setup with `OpenAIProvider`. Single `run()` call.

## 02 — Retry and Fallback
Primary provider with fallback. Demonstrates `orchestrator.on()` event listeners.

## 03 — Tool Execution
Custom tool definitions (`calculator`, `weather`) with schema validation.

## 04 — Orchestrator Profiles
Multiple profiles (`editor`, `analyzer`, `support`) with `RAGContextProvider` and `InMemoryAdapter`.

## 05 — Streaming with Tools
Streaming output via `run({ stream: true })` with mid-stream tool execution.

---

> **Note:** All examples require the `OPENAI_KEY` environment variable.
> Run each with `npx tsx index.ts` from its directory.
"