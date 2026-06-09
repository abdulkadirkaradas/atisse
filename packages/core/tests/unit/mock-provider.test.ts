import { describe, it, expect, beforeEach } from 'vitest';
import { MockProvider } from '../../src/testing/mock-provider.js';
import {
  ProviderUnavailableError,
  ProviderAuthError,
  ToolExecutionError,
} from '../../src/errors.js';
import type { PromptRequest } from '../../src/interfaces.js';

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
  });
});
