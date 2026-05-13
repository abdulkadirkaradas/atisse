import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockStream, createTestableProvider } from '../mock-provider.js';
import type { ChatCompletion, ChatCompletionChunk } from 'openai/resources/chat/completions';
import {
  BeforeGenerateContext,
  MaxRetriesExceededError,
  Orchestrator,
  ProviderAuthError,
} from '@atisse/core';

describe('OpenAIProvider + Orchestrator (integration (mocked HTTP))', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('integration with Orchestrator', () => {
    it('should run end-to-end with mocked OpenAI SDK', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Hello from OpenAI!' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const orchestrator = new Orchestrator({
        provider,
        timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
      });

      const result = await orchestrator.run({ prompt: 'Hi' });

      expect(result.text).toBe('Hello from OpenAI!');
      expect(result.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
      expect(result.runId).toBeDefined();
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should retry on ProviderRateLimitError and succeed', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Hello from OpenAI!' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      } as Partial<ChatCompletion>;

      const rateLimitError = {
        status: 429,
        message: 'Rate limit exceeded',
        cause: new Error('Rate limit'),
        response: {
          headers: {
            get: () => null,
          },
        },
      };

      const mockCreateFn = vi
        .fn()
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const orchestrator = new Orchestrator({
        provider,
        retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      vi.useFakeTimers();
      const resultPromise = orchestrator.run({ prompt: 'test' });
      vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.text).toBe('Hello from OpenAI!');
      expect(mockCreateFn).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    });

    it('should fail immediately on ProviderAuthError - no retry', async () => {
      const authError = {
        status: 401,
        message: 'Invalid API key',
        cause: new Error('Unauthorized'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(authError);
      const provider = createTestableProvider({ apiKey: 'bad-key' }, mockCreateFn);

      const orchestrator = new Orchestrator({
        provider,
        retry: { maxAttempts: 3, baseDelayMs: 10, jitter: false },
        timeout: { totalTimeoutMs: 60_000 },
      });

      await expect(orchestrator.run({ prompt: 'test' })).rejects.toThrow(ProviderAuthError);
      expect(mockCreateFn).toHaveBeenCalledTimes(1);
    });

    it('beforeGenerate hook sees system prompt in messages array before extraction', async () => {
      const mockCompletion: Partial<ChatCompletion> = {
        choices: [
          {
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      } as Partial<ChatCompletion>;

      const mockCreateFn = vi.fn().mockResolvedValue(mockCompletion as ChatCompletion);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const beforeGenerateHook = vi.fn(async (ctx: BeforeGenerateContext) => {
        expect(ctx.messages.some((m) => m.role === 'system')).toBe(true);
        return ctx;
      });

      const orchestrator = new Orchestrator({
        provider,
        systemPrompt: 'You are helpful.',
        hooks: { beforeGenerate: [beforeGenerateHook] },
        timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
      });

      await orchestrator.run({ prompt: 'Hi' });
      expect(beforeGenerateHook).toHaveBeenCalledTimes(1);
    });

    it('should deliver streaming chunks in correct order', async () => {
      const chunks: ChatCompletionChunk[] = [
        {
          id: 'chatcmpl-1',
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: undefined }],
          model: 'gpt-4o',
          usage: undefined,
        },
        {
          id: 'chatcmpl-1',
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: undefined }],
          model: 'gpt-4o',
          usage: undefined,
        },
        {
          id: 'chatcmpl-1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          model: 'gpt-4o',
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        },
      ] as ChatCompletionChunk[];

      const mockCreateFn = vi.fn().mockResolvedValue(createMockStream(chunks));
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const orchestrator = new Orchestrator({
        provider,
        timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
      });

      const result = await orchestrator.run({ prompt: 'Hi', stream: true });

      let fullText = '';
      for await (const chunk of result as AsyncIterable<{ type: string; delta?: string }>) {
        if (chunk.type === 'text') {
          fullText += chunk.delta;
        }
      }

      expect(fullText).toBe('Hello world');
    });

    it('should propagate provider errors as MaxRetriesExceededError through Orchestrator', async () => {
      const mockError = {
        status: 429,
        message: 'Rate limit exceeded',
        cause: new Error('Rate limit'),
        response: {
          headers: {
            get: () => null,
          },
        },
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      const orchestrator = new Orchestrator({
        provider,
        retry: { maxAttempts: 1, baseDelayMs: 0, jitter: false },
        timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
      });

      // Orchestrator retry wraps the final error in MaxRetriesExceededError
      await expect(orchestrator.run({ prompt: 'Hi' })).rejects.toThrow(MaxRetriesExceededError);
    });
  });
});
