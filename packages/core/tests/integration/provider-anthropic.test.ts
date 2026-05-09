import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BeforeGenerateContext } from '@atisse/core';
import { Orchestrator, ProviderAuthError, MaxRetriesExceededError } from '@atisse/core';

import { AnthropicProvider } from '@atisse/provider-anthropic';

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}));

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}
interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicTextDelta {
  type: 'text_delta';
  text: string;
}

type AnthropicStreamEvent =
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | {
      type: 'content_block_delta';
      index: number;
      delta: AnthropicTextDelta | { type: 'input_json_delta'; partial_json: string };
    }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: string; stop_sequence: string | null };
      usage?: { output_tokens: number };
    }
  | { type: 'message_stop' };

interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

function createMockStream(chunks: AnthropicStreamEvent[]): AsyncIterable<unknown> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }
          return { done: true, value: undefined } as const;
        },
      };
    },
  };
}

function createTestableProvider(
  config: { apiKey: string; model?: string },
  mockCreateFn: ReturnType<typeof vi.fn>,
): AnthropicProvider {
  const provider = new AnthropicProvider(config);
  Object.defineProperty(provider, 'client', {
    value: { messages: { create: mockCreateFn } },
    writable: true,
    configurable: true,
  });
  return provider;
}

describe('AnthropicProvider + Orchestrator (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should execute full run() lifecycle with mocked SDK', async () => {
    const mockResponse = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello from Claude!' }],
      model: 'claude-sonnet-4-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as AnthropicMessageResponse;

    const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
    const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

    const orchestrator = new Orchestrator({
      provider,
      timeout: { generateTimeoutMs: 5000, toolTimeoutMs: 1000, totalTimeoutMs: 60_000 },
    });

    const result = await orchestrator.run({ prompt: 'Say hello' });

    expect(result.text).toBe('Hello from Claude!');
    expect(result.usage).toEqual({ prompt: 10, completion: 5, total: 15 });
    expect(result.runId).toBeDefined();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should retry on ProviderRateLimitError and succeed', async () => {
    const mockResponse = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Success!' }],
      model: 'claude-sonnet-4-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 3 },
    } as AnthropicMessageResponse;

    const rateLimitError = {
      status: 429,
      message: 'Rate limit exceeded',
      cause: new Error('Rate limit'),
      headers: {},
    };

    const mockCreateFn = vi
      .fn()
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(mockResponse);

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

    expect(result.text).toBe('Success!');
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
    const mockResponse = {
      id: 'msg_123',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: 'Response' }],
      model: 'claude-sonnet-4-5',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    } as AnthropicMessageResponse;

    const mockCreateFn = vi.fn().mockResolvedValue(mockResponse);
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
    const streamEvents: AnthropicStreamEvent[] = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
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

    expect(fullText).toBe('Hello');
  });

  it('should throw MaxRetriesExceededError when all retries fail', async () => {
    const rateLimitError = {
      status: 429,
      message: 'Rate limit',
      cause: new Error('Rate limit'),
      headers: {},
    };

    const mockCreateFn = vi.fn().mockRejectedValue(rateLimitError);
    const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

    const orchestrator = new Orchestrator({
      provider,
      retry: { maxAttempts: 2, baseDelayMs: 10, jitter: false },
      timeout: { totalTimeoutMs: 60_000 },
    });

    vi.useFakeTimers();
    const runPromise = orchestrator.run({ prompt: 'test' });
    vi.runAllTimersAsync();
    await expect(runPromise).rejects.toThrow(MaxRetriesExceededError);
    vi.useRealTimers();
  });
});
