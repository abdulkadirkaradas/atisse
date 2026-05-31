import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  AfterGenerateContext,
  PromptResponse,
  StreamChunk,
} from '../../src/interfaces.js';
import { Orchestrator } from '../../src/orchestrator.js';
import { MockProvider } from '../../src/testing/mock-provider.js';
import { ProviderUnavailableError } from '../../src/errors.js';

describe('Unit: Streaming Termination & Edge Cases', () => {
  let provider: MockProvider;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new MockProvider('streaming-unit-test');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Stream termination guarantees', () => {
    it('stream always terminates with done chunk(s) on success', async () => {
      provider.enqueueStream({
        chunks: [
          { type: 'text', delta: 'Hello' },
          { type: 'done', usage: { prompt: 5, completion: 5, total: 10 } },
        ],
      });

      const orchestrator = new Orchestrator({
        provider,
        timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
      });

      const result = (await orchestrator.run({
        prompt: 'test',
        stream: true,
      })) as AsyncIterable<StreamChunk>;

      const chunks: StreamChunk[] = [];
      for await (const chunk of result) {
        chunks.push(chunk);
      }

      // Pipeline yields exactly one done chunk (at COMPLETED) — provider's internal done is not forwarded
      const doneChunks = chunks.filter((c) => c.type === 'done');
      expect(doneChunks.length).toBe(1);

      // Last chunk is always the pipeline's done
      const lastChunk = chunks[chunks.length - 1];
      expect(lastChunk!.type).toBe('done');

      // No error chunks on success
      const errorChunks = chunks.filter((c) => c.type === 'error');
      expect(errorChunks).toHaveLength(0);
    });

    it('error chunk is yielded immediately, done follows after stream ends', async () => {
      provider.enqueueStream({
        chunks: [
          { type: 'text', delta: 'Start' },
          { type: 'error', error: new ProviderUnavailableError('Mid-stream failure') },
        ],
      });

      const orchestrator = new Orchestrator({
        provider,
        timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
      });

      const result = (await orchestrator.run({
        prompt: 'test',
        stream: true,
      })) as AsyncIterable<StreamChunk>;

      const chunks: StreamChunk[] = [];
      for await (const chunk of result) {
        chunks.push(chunk);
      }

      const errorIndex = chunks.findIndex((c) => c.type === 'error');
      const doneAfterError = chunks.slice(errorIndex + 1).some((c) => c.type === 'done');

      expect(errorIndex).toBeGreaterThanOrEqual(0);
      expect(doneAfterError).toBe(true);
    });

    it('empty stream (immediate done) yields done immediately', async () => {
      provider.enqueueStream({
        chunks: [{ type: 'done', usage: { prompt: 0, completion: 0, total: 0 } }],
      });

      const orchestrator = new Orchestrator({
        provider,
        timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
      });

      const result = (await orchestrator.run({
        prompt: 'test',
        stream: true,
      })) as AsyncIterable<StreamChunk>;

      const chunks: StreamChunk[] = [];
      for await (const chunk of result) {
        chunks.push(chunk);
      }

      // Pipeline yields exactly one done chunk (at COMPLETED) — provider's internal done is swallowed
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.type).toBe('done');
    });
  });

  describe('Tool-only response (no text)', () => {
    it('tool-only stream yields empty text to afterGenerate and hook receives complete response', async () => {
      provider.enqueueStream({
        chunks: [
          {
            type: 'tool_call',
            toolCall: { id: 'call-1', name: 'echo', input: { value: 'only-tool' } },
          },
          { type: 'done', usage: { prompt: 3, completion: 1, total: 4 } },
        ],
      });

      // Second stream after tool execution
      provider.enqueueStream({
        chunks: [
          { type: 'text', delta: 'After tool' },
          { type: 'done', usage: { prompt: 6, completion: 3, total: 9 } },
        ],
      });

      const echoTool = {
        name: 'echo',
        description: 'Echo',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        async execute(input: unknown) {
          return input;
        },
      };

      // Track afterGenerate hook calls
      const afterGenerateCalls: Array<PromptResponse> = [];
      const afterGenerateHook = vi.fn(async (ctx: AfterGenerateContext) => {
        afterGenerateCalls.push({
          text: ctx.response.text,
          toolCalls: ctx.response.toolCalls ?? [],
          usage: { completion: 0, prompt: 0, total: 0 },
          finishReason: 'tool_calls',
        });
        return ctx;
      });

      const orchestrator = new Orchestrator({
        provider,
        tools: [echoTool],
        hooks: { afterGenerate: [afterGenerateHook] },
        timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
      });

      const result = (await orchestrator.run({
        prompt: 'test',
        stream: true,
      })) as AsyncIterable<StreamChunk>;

      const chunks: StreamChunk[] = [];
      for await (const chunk of result) {
        chunks.push(chunk);
      }

      // First stream had tool_call + done (no text before tool)
      const textBeforeTool = chunks
        .slice(
          0,
          chunks.findIndex((c) => c.type === 'tool_call'),
        )
        .filter((c) => c.type === 'text');

      expect(textBeforeTool).toHaveLength(0);

      // Verify afterGenerate hook was called once (after tool loop completes)
      // afterGenerate runs only after the generation loop exits (Architecture.md:117-118),
      // not on intermediate tool_calls responses.
      expect(afterGenerateHook).toHaveBeenCalledTimes(1);

      // afterGenerate receives the final response after tool execution
      expect(afterGenerateCalls[0]!.text).toBe('After tool');
      // toolCalls may be empty array (not undefined) when no tools in this response
      expect(afterGenerateCalls[0]!.toolCalls).toEqual([]);
    });
  });

  describe('Multiple text chunks accumulate correctly', () => {
    it('consecutive text chunks concatenate in order', async () => {
      provider.enqueueStream({
        chunks: [
          { type: 'text', delta: 'The ' },
          { type: 'text', delta: 'quick ' },
          { type: 'text', delta: 'brown ' },
          { type: 'text', delta: 'fox' },
          { type: 'done', usage: { prompt: 10, completion: 20, total: 30 } },
        ],
      });

      const orchestrator = new Orchestrator({
        provider,
        timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
      });

      const result = (await orchestrator.run({
        prompt: 'test',
        stream: true,
      })) as AsyncIterable<StreamChunk>;

      const textParts: string[] = [];
      for await (const chunk of result) {
        if (chunk.type === 'text') {
          textParts.push(chunk.delta);
        }
      }

      expect(textParts.join('')).toBe('The quick brown fox');
    });
  });

  describe('Streaming chunk order', () => {
    it('yields chunks in correct order: text* → (tool_call → tool_result)* → done', async () => {
      // Setup: First stream with text + tool_call
      provider.enqueueStream({
        chunks: [
          { type: 'text', delta: 'Let me ' },
          { type: 'text', delta: 'check ' },
          {
            type: 'tool_call',
            toolCall: { id: 'call-1', name: 'echo', input: { value: 'test' } },
          },
          { type: 'done', usage: { prompt: 10, completion: 5, total: 15 } },
        ],
      });

      // Second stream after tool execution
      provider.enqueueStream({
        chunks: [
          { type: 'text', delta: 'After tool' },
          { type: 'done', usage: { prompt: 20, completion: 10, total: 30 } },
        ],
      });

      const echoTool = {
        name: 'echo',
        description: 'Echo',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        async execute(input: unknown) {
          return input;
        },
      };

      const orchestrator = new Orchestrator({
        provider,
        tools: [echoTool],
        timeout: { generateTimeoutMs: 5000, totalTimeoutMs: 60_000 },
      });

      const result = (await orchestrator.run({
        prompt: 'test',
        stream: true,
      })) as AsyncIterable<StreamChunk>;

      const chunkTypes: string[] = [];
      for await (const chunk of result) {
        chunkTypes.push(chunk.type);
      }

      // Verify overall pattern: text* → tool_call → tool_result → text* → done
      // First stream: text, text, tool_call (provider done is NOT forwarded)
      // Then tool_result from execution
      // Second stream: text (provider done is NOT forwarded)
      // And final done from pipeline

      const firstToolCallIndex = chunkTypes.indexOf('tool_call');
      const doneIndex = chunkTypes.indexOf('done');
      const toolResultIndex = chunkTypes.indexOf('tool_result');

      // text chunks should come before tool_call
      expect(firstToolCallIndex).toBeGreaterThan(0); // At least one text before tool_call
      expect(chunkTypes.slice(0, firstToolCallIndex).every((t) => t === 'text')).toBe(true);

      // tool_call should come before tool_result (same round)
      expect(firstToolCallIndex).toBeLessThan(toolResultIndex);

      // tool_result should come before the final done
      expect(toolResultIndex).toBeLessThan(doneIndex);

      // tool_result should come before text chunks of second stream
      const textAfterToolResult = chunkTypes.slice(toolResultIndex + 1, doneIndex).filter((t) => t === 'text');
      expect(textAfterToolResult.length).toBeGreaterThan(0);

      // Last chunk should be done
      expect(chunkTypes[chunkTypes.length - 1]).toBe('done');
    });
  });
});
