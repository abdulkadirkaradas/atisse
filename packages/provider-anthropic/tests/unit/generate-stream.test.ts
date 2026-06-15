import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AnthropicStreamEvent,
  createMockStream,
  createTestableProvider,
} from '../mock-provider.js';
import { OrchestratorError, StreamChunk } from '@atisse/core';

describe('AnthropicProvider Unit Tests - generateStream()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateStream()', () => {
    it('should return Promise<AsyncIterable<StreamChunk>>', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      expect(result).toBeDefined();
      expect(typeof result[Symbol.asyncIterator]).toBe('function');
    });

    it('should yield text delta chunks', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ' world' } },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      const collected: string[] = [];
      for await (const chunk of result) {
        if (chunk.type === 'text') {
          collected.push(chunk.delta);
        }
      }

      expect(collected.join('')).toBe('Hello world');
    });

    it('should accumulate tool input deltas and emit single tool_call at content_block_stop', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_123', name: 'get_weather', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"location":' },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '"NYC"}' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 15 },
        },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Get weather for NYC' }],
      });

      const toolCallChunks: Array<{
        type: string;
        toolCall: { id: string; name: string; input: unknown };
      }> = [];
      for await (const chunk of result) {
        if (chunk.type === 'tool_call') {
          toolCallChunks.push(
            chunk as { type: 'tool_call'; toolCall: { id: string; name: string; input: unknown } },
          );
        }
      }

      expect(toolCallChunks).toHaveLength(1);
      const toolCall = toolCallChunks[0]!.toolCall;
      expect(toolCall.id).toBe('tu_123');
      expect(toolCall.name).toBe('get_weather');
      expect(toolCall.input).toEqual({ location: 'NYC' });
    });

    it('should terminate with done chunk carrying usage', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 2 },
        },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      let doneChunk: StreamChunk | null = null;
      for await (const chunk of result) {
        if (chunk.type === 'done') {
          doneChunk = chunk;
        }
      }

      expect(doneChunk).not.toBeNull();
      expect(doneChunk!.type).toBe('done');
      if (doneChunk!.type === 'done') {
        expect(doneChunk?.usage).toBeDefined();
        expect(doneChunk?.usage?.total).toBe(2);
      }
    });

    it('should reject the Promise on connection error before first chunk (ADR-019)', async () => {
      const connectionError = new Error('Connection refused');
      const mockCreateFn = vi.fn().mockRejectedValue(connectionError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      await expect(
        provider.generateStream({
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      ).rejects.toThrow();
    });

    it('should yield error chunk when stream throws mid-stream', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Partial' } },
      ];

      const streamError = new Error('Stream interrupted');
      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents, streamError));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      let errorChunk: StreamChunk | null = null;
      for await (const chunk of result) {
        if (chunk.type === 'error') {
          errorChunk = chunk;
        }
      }

      expect(errorChunk).not.toBeNull();
      if (errorChunk && errorChunk.type === 'error') {
        expect(errorChunk.error).toBeInstanceOf(OrchestratorError);
      }
    });

    it('should yield done chunk even with no usage when message_stop has no usage', async () => {
      const streamEvents: AnthropicStreamEvent[] = [
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } },
        { type: 'message_stop' },
      ];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(streamEvents));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const result = await provider.generateStream({
        messages: [{ role: 'user', content: 'Hi' }],
      });

      let doneChunk: StreamChunk | null = null;
      for await (const chunk of result) {
        if (chunk.type === 'done') {
          doneChunk = chunk;
        }
      }

      expect(doneChunk).not.toBeNull();
      expect(doneChunk!.type).toBe('done');
    });
  });
});
