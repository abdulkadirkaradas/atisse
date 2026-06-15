import { describe, it, expect, beforeEach } from 'vitest';
import { MockProvider } from '../../src/testing/mock-provider.js';
import {
  ProviderUnavailableError,
  ProviderAuthError,
  ToolExecutionError,
} from '../../src/errors.js';
import type { PromptRequest, StreamChunk } from '../../src/interfaces.js';

describe('MockProvider', () => {
  let provider: MockProvider;

  beforeEach(() => {
    provider = new MockProvider();
  });

  describe('enqueue()', () => {
    it('supports method chaining', () => {
      const result = provider.enqueue({ text: 'hello' });
      expect(result).toBe(provider);
    });
  });

  describe('generate()', () => {
    it('dequeues entries in FIFO order', async () => {
      provider.enqueue({ text: 'first' });
      provider.enqueue({ text: 'second' });

      const result1 = await provider.generate({ messages: [] });
      const result2 = await provider.generate({ messages: [] });

      expect(result1.text).toBe('first');
      expect(result2.text).toBe('second');
    });

    it('throws ProviderUnavailableError when queue empty', async () => {
      await expect(provider.generate({ messages: [] })).rejects.toThrow(ProviderUnavailableError);
    });

    it('throws enqueued OrchestratorError directly', async () => {
      const error = new ProviderAuthError('auth failed');
      provider.enqueue({ error });

      await expect(provider.generate({ messages: [] })).rejects.toThrow(ProviderAuthError);
    });

    it('returns correct PromptResponse shape', async () => {
      provider.enqueue({ text: 'hello' });

      const result = await provider.generate({ messages: [] });

      expect(result).toMatchObject({
        text: 'hello',
        usage: { prompt: 0, completion: 0, total: 0 },
        finishReason: 'stop',
      });
    });

    it('supports toolCalls in response', async () => {
      const toolCalls = [{ id: '1', name: 'tool', input: {} }];
      provider.enqueue({ text: '', toolCalls });

      const result = await provider.generate({ messages: [] });

      expect(result.toolCalls).toEqual(toolCalls);
      expect(result.finishReason).toBe('tool_calls');
    });

    it('supports explicit finishReason override', async () => {
      provider.enqueue({ text: 'hello', finishReason: 'length' });

      const result = await provider.generate({ messages: [] });

      expect(result.finishReason).toBe('length');
    });

    it('honours explicit finishReason over toolCalls inference', async () => {
      const toolCalls = [{ id: '1', name: 'tool', input: {} }];
      provider.enqueue({ text: '', toolCalls, finishReason: 'stop' });

      const result = await provider.generate({ messages: [] });

      // Explicit finishReason takes precedence over tool_calls inference
      expect(result.finishReason).toBe('stop');
    });

    it('allows subsequent generate() to dequeue same entry after injected failure fires', async () => {
      provider.enqueue({ text: 'survivor' });
      provider.failureOnCall(1, new ProviderAuthError('first call fail'));

      // First call: injected failure fires, queue entry NOT consumed
      await expect(provider.generate({ messages: [] })).rejects.toThrow(ProviderAuthError);

      // Second call: no failure injection at callIndex 2, same entry dequeued
      const result = await provider.generate({ messages: [] });
      expect(result.text).toBe('survivor');
    });
  });

  describe('callCount()', () => {
    it('increments correctly', async () => {
      provider.enqueue({ text: 'a' });
      provider.enqueue({ text: 'b' });

      await provider.generate({ messages: [] });
      expect(provider.callCount()).toBe(1);
      expect(provider.wasCalledTimes(1)).toBe(true);

      await provider.generate({ messages: [] });
      expect(provider.callCount()).toBe(2);
      expect(provider.wasCalledTimes(2)).toBe(true);
    });

    it('returns true for wasCalledTimes(0) on fresh provider', () => {
      expect(provider.wasCalledTimes(0)).toBe(true);
      expect(provider.wasCalledTimes(1)).toBe(false);
    });
  });

  describe('lastRequest()', () => {
    it('returns most recent PromptRequest', async () => {
      const request1: PromptRequest = { messages: [] };
      const request2: PromptRequest = { messages: [{ role: 'user', content: 'hello' }] };

      provider.enqueue({ text: 'a' });
      provider.enqueue({ text: 'b' });

      await provider.generate(request1);
      await provider.generate(request2);

      expect(provider.lastRequest()).toEqual(request2);
    });

    it('returns undefined when no generate/generateStream call has been made', () => {
      expect(provider.lastRequest()).toBeUndefined();
    });
  });

  describe('calls()', () => {
    it('returns all requests in order', async () => {
      const request1: PromptRequest = { messages: [] };
      const request2: PromptRequest = { messages: [{ role: 'user', content: 'a' }] };

      provider.enqueue({ text: 'x' });
      provider.enqueue({ text: 'y' });

      await provider.generate(request1);
      await provider.generate(request2);

      expect(provider.calls()).toEqual([request1, request2]);
    });

    it('returns a defensive copy immune to mutation', async () => {
      const request: PromptRequest = { messages: [{ role: 'user', content: 'hi' }] };
      provider.enqueue({ text: 'ok' });
      await provider.generate(request);

      const returned = provider.calls();
      returned.push({ messages: [] });

      expect(provider.calls()).toEqual([request]);
    });
  });

  describe('reset()', () => {
    it('clears queue, call count, and history', async () => {
      provider.enqueue({ text: 'hello' });
      await provider.generate({ messages: [] });

      provider.reset();

      expect(provider.callCount()).toBe(0);
      expect(provider.calls()).toEqual([]);
      await expect(provider.generate({ messages: [] })).rejects.toThrow(ProviderUnavailableError);
    });

    it('clears failure injections', async () => {
      provider.failureOnCall(1, new ProviderAuthError('fail'));
      provider.reset();

      // After reset, enqueue fresh entry and verify failure is cleared
      provider.enqueue({ text: 'works' });
      const result = await provider.generate({ messages: [] });
      expect(result.text).toBe('works');
    });
  });

  describe('generateStream()', () => {
    it('returns Promise<AsyncIterable<StreamChunk>>', async () => {
      provider.enqueue({ text: 'hi' });
      const stream = provider.generateStream({ messages: [] });
      expect(stream).toBeInstanceOf(Promise);
      const iterable = await stream;
      expect(iterable[Symbol.asyncIterator]).toBeDefined();
    });

    it('produces character-level text chunks', async () => {
      provider.enqueue({ text: 'abc' });
      const iterable = await provider.generateStream({ messages: [] });
      const chunks: string[] = [];

      for await (const chunk of iterable) {
        if (chunk.type === 'text') {
          chunks.push(chunk.delta);
        }
      }

      expect(chunks.join('')).toBe('abc');
    });

    it('terminates with done chunk', async () => {
      provider.enqueue({ text: 'test' });
      const iterable = await provider.generateStream({ messages: [] });
      let done = false;

      for await (const chunk of iterable) {
        if (chunk.type === 'done') {
          done = true;
        }
      }

      expect(done).toBe(true);
    });

    it('throws ProviderUnavailableError for empty queue', async () => {
      const provider = new MockProvider('test-stream');
      // Reset to ensure empty queue
      provider.reset();

      await expect(provider.generateStream({ messages: [] })).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
    });

    it('throws error entry as Promise rejection (D-M3-1: pre-stream error)', async () => {
      provider.enqueue({ error: new ToolExecutionError('tool') });

      // D-M3-1: pre-stream errors are Promise rejections, not error chunks
      await expect(provider.generateStream({ messages: [] })).rejects.toBeInstanceOf(
        ToolExecutionError,
      );
    });

    it('emits tool_call StreamChunks when enqueued entry carries toolCalls', async () => {
      const toolCalls = [{ id: '1', name: 'tool', input: {} }];
      provider.enqueue({ text: '', toolCalls });

      const iterable = await provider.generateStream({ messages: [] });
      const chunks: StreamChunk[] = [];

      for await (const chunk of iterable) {
        chunks.push(chunk);
      }

      const toolCallChunks = chunks.filter((c) => c.type === 'tool_call');
      expect(toolCallChunks).toHaveLength(1);
      if (toolCallChunks[0]?.type === 'tool_call') {
        expect(toolCallChunks[0].toolCall).toEqual(toolCalls[0]);
      }
      // Should still have a done chunk at the end
      expect(chunks[chunks.length - 1]).toMatchObject({ type: 'done' });
    });

    it('falls back to queue entries when streamQueue is empty', async () => {
      // enqueue() pushes to both queue and streamQueue
      // First generateStream() consumes from streamQueue, queue entry remains
      provider.enqueue({ text: 'abc', toolCalls: [{ id: '1', name: 'tool', input: {} }] });

      // First call: consumes from streamQueue
      const iter1 = await provider.generateStream({ messages: [] });
      const collected1: string[] = [];
      for await (const chunk of iter1) {
        if (chunk.type === 'text') collected1.push(chunk.delta);
      }
      expect(collected1.join('')).toBe('abc');

      // Second call: streamQueue empty, falls back to queue
      const iter2 = await provider.generateStream({ messages: [] });
      const collected2: string[] = [];
      const toolCalls: StreamChunk[] = [];
      let doneChunk = false;
      for await (const chunk of iter2) {
        if (chunk.type === 'text') collected2.push(chunk.delta);
        if (chunk.type === 'tool_call') toolCalls.push(chunk);
        if (chunk.type === 'done') doneChunk = true;
      }

      expect(collected2.join('')).toBe('abc');
      expect(toolCalls).toHaveLength(1);
      expect(doneChunk).toBe(true);
    });

    it('produces only a done chunk for empty text entry', async () => {
      provider.enqueue({ text: '' });

      const iterable = await provider.generateStream({ messages: [] });
      const chunks: StreamChunk[] = [];
      for await (const chunk of iterable) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ type: 'done' });
    });

    it('injected failure takes priority over missing queue entry for generateStream', async () => {
      const error = new ProviderAuthError('auth failed');
      provider.failureOnCall(1, error);
      // Queue is empty — failure should fire before empty-queue check
      await expect(provider.generateStream({ messages: [] })).rejects.toThrow(ProviderAuthError);
    });
  });

  describe('constructor()', () => {
    it('uses default id and capabilities when no arguments given', () => {
      const p = new MockProvider();
      expect(p.id).toBe('mock-test');
      expect(p.capabilities).toEqual({
        streaming: true,
        toolCalling: true,
        vision: false,
        maxContextTokens: 128_000,
      });
    });

    it('accepts a custom id', () => {
      const p = new MockProvider('my-custom-provider');
      expect(p.id).toBe('my-custom-provider');
      expect(p.capabilities).toBeDefined();
    });

    it('preserves default capabilities regardless of custom id', () => {
      const p = new MockProvider('alt');
      expect(p.capabilities.streaming).toBe(true);
      expect(p.capabilities.toolCalling).toBe(true);
      expect(p.capabilities.maxContextTokens).toBe(128_000);
    });
  });

  describe('enqueueStream()', () => {
    it('supports method chaining', () => {
      const result = provider.enqueueStream({ chunks: [{ type: 'text', delta: 'a' }] });
      expect(result).toBe(provider);
    });

    it('produces custom StreamChunk arrays in order', async () => {
      provider.enqueueStream({
        chunks: [
          { type: 'text', delta: 'A' },
          { type: 'text', delta: 'B' },
          { type: 'done', usage: { prompt: 0, completion: 0, total: 0 } },
        ],
      });

      const iterable = await provider.generateStream({ messages: [] });
      const collected: StreamChunk[] = [];
      for await (const chunk of iterable) {
        collected.push(chunk);
      }

      expect(collected).toHaveLength(3);
      expect(collected[0]).toEqual({ type: 'text', delta: 'A' });
      expect(collected[1]).toEqual({ type: 'text', delta: 'B' });
      if (collected[2]?.type === 'done') {
        expect(collected[2].usage).toEqual({ prompt: 0, completion: 0, total: 0 });
      }
    });

    it('supports custom chunk sequences with mixed types', async () => {
      provider.enqueueStream({
        chunks: [
          { type: 'text', delta: 'hello' },
          {
            type: 'tool_call',
            toolCall: { id: 'tc-1', name: 'search', input: { query: 'test' } },
          },
          { type: 'done', usage: { prompt: 10, completion: 5, total: 15 } },
        ],
      });

      const iterable = await provider.generateStream({ messages: [] });
      const collected: StreamChunk[] = [];
      for await (const chunk of iterable) {
        collected.push(chunk);
      }

      const toolCallChunks = collected.filter((c) => c.type === 'tool_call');
      expect(toolCallChunks).toHaveLength(1);
      expect(collected[collected.length - 1]).toMatchObject({ type: 'done' });
    });
  });

  describe('failureOnCall()', () => {
    it('supports method chaining', () => {
      const error = new ProviderAuthError('fail');
      const result = provider.failureOnCall(1, error);
      expect(result).toBe(provider);
    });

    it('throws injected OrchestratorError on the specified call index (generate)', async () => {
      provider.enqueue({ text: 'first' });
      provider.enqueue({ text: 'second' });
      provider.failureOnCall(2, new ProviderAuthError('second call fail'));

      // First call: no failure at callIndex 2, should succeed
      const result1 = await provider.generate({ messages: [] });
      expect(result1.text).toBe('first');

      // Second call: failure at callIndex 2 fires
      await expect(provider.generate({ messages: [] })).rejects.toThrow(ProviderAuthError);
    });

    it('handles multiple failureOnCall registrations independently', async () => {
      provider.enqueue({ text: 'a' });
      provider.enqueue({ text: 'b' });
      provider.enqueue({ text: 'c' });
      provider.failureOnCall(1, new ProviderAuthError('call 1 fail'));
      provider.failureOnCall(3, new ProviderAuthError('call 3 fail'));

      // Call 1: failure fires, queue entry 'a' NOT consumed
      await expect(provider.generate({ messages: [] })).rejects.toThrow(ProviderAuthError);

      // Call 2: no failure at callIndex 2, dequeues 'a' (still in queue from failed call 1)
      const result2 = await provider.generate({ messages: [] });
      expect(result2.text).toBe('a');

      // Call 3: failure fires, queue entry 'b' NOT consumed
      await expect(provider.generate({ messages: [] })).rejects.toThrow(ProviderAuthError);

      // Call 4: no failure at callIndex 4, dequeues 'b'
      const result4 = await provider.generate({ messages: [] });
      expect(result4.text).toBe('b');
    });
  });

  describe('clearFailures()', () => {
    it('removes pending failure injections for generate', async () => {
      provider.enqueue({ text: 'hello' });
      provider.failureOnCall(1, new ProviderAuthError('should not fire'));
      provider.clearFailures();

      const result = await provider.generate({ messages: [] });
      expect(result.text).toBe('hello');
    });

    it('allows normal generateStream to resume after clearing', async () => {
      provider.enqueue({ text: 'world' });
      provider.failureOnCall(1, new ProviderAuthError('should not fire'));
      provider.clearFailures();

      const iterable = await provider.generateStream({ messages: [] });
      const chunks: string[] = [];
      for await (const chunk of iterable) {
        if (chunk.type === 'text') chunks.push(chunk.delta);
      }
      expect(chunks.join('')).toBe('world');
    });

    it('does not affect entries already enqueued', async () => {
      provider.enqueue({ text: 'survivor' });
      provider.failureOnCall(1, new ProviderAuthError('fail'));
      provider.clearFailures();

      // Even though clear occurred, the enqueued entry remains
      expect(provider.callCount()).toBe(0);
      const result = await provider.generate({ messages: [] });
      expect(result.text).toBe('survivor');
    });
  });
});
