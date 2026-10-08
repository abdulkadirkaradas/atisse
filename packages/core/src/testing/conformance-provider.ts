import { describe, expect, it, vi } from 'vitest';
import type { AIProvider, PromptRequest, StreamChunk } from '../interfaces.js';
import { ConfigValidationError } from '../errors.js';

type ClientShape = 'openai' | 'anthropic';

interface OpenAIStyleClient {
  chat: { completions: { create: unknown } };
}

interface AnthropicStyleClient {
  messages: { create: unknown };
}

/**
 * Detect the underlying SDK client shape without importing adapter packages.
 * Core has zero adapter imports — duck typing keeps the dependency direction intact.
 */
function detectClientShape(provider: AIProvider): ClientShape {
  const holder = provider as unknown as { client?: unknown };
  const client = holder.client as Record<string, unknown> | undefined;
  if (client !== undefined && client !== null) {
    const chat = client.chat as Record<string, unknown> | undefined;
    if (chat !== undefined && chat !== null) {
      const completions = chat.completions as Record<string, unknown> | undefined;
      if (completions !== undefined && typeof completions.create === 'function') {
        return 'openai';
      }
    }
    const messages = client.messages as Record<string, unknown> | undefined;
    if (messages !== undefined && typeof messages.create === 'function') {
      return 'anthropic';
    }
  }
  throw new ConfigValidationError(['Unrecognized provider client shape for conformance mocking']);
}

/**
 * Replace the provider transport with a controllable mock.
 * Returns the mock create function for per-test configuration and assertions.
 */
function installMockTransport(
  provider: AIProvider,
  shape: ClientShape,
): ReturnType<typeof vi.fn> {
  const mockCreateFn = vi.fn();
  if (shape === 'openai') {
    const mockClient: OpenAIStyleClient = {
      chat: { completions: { create: mockCreateFn } },
    };
    Object.defineProperty(provider, 'client', {
      value: mockClient,
      writable: true,
      configurable: true,
    });
  } else {
    const mockClient: AnthropicStyleClient = {
      messages: { create: mockCreateFn },
    };
    Object.defineProperty(provider, 'client', {
      value: mockClient,
      writable: true,
      configurable: true,
    });
  }
  return mockCreateFn;
}

function buildOpenAISuccessResponse(
  text: string,
  finishReason: string,
): Record<string, unknown> {
  return {
    choices: [
      {
        message: { role: 'assistant', content: text },
        finish_reason: finishReason,
        index: 0,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function buildOpenAIToolResponse(): Record<string, unknown> {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'get_data', arguments: '{"key":"value"}' },
            },
          ],
        },
        finish_reason: 'tool_calls',
        index: 0,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function buildAnthropicSuccessResponse(
  text: string,
  stopReason: string,
): Record<string, unknown> {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'test-model',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function buildAnthropicToolResponse(): Record<string, unknown> {
  return {
    id: 'msg_2',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_1', name: 'get_data', input: { key: 'value' } }],
    model: 'test-model',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function buildTransportError(
  shape: ClientShape,
  status: number,
  retryAfterHeader?: string,
): Record<string, unknown> {
  if (shape === 'openai') {
    return {
      status,
      message: 'Transport failure',
      cause: new Error('Transport failure'),
      response: {
        headers: {
          get: (key: string): string | null =>
            key === 'Retry-After' ? (retryAfterHeader ?? null) : null,
        },
      },
    };
  }
  const headers: Record<string, string | undefined> = {};
  if (retryAfterHeader !== undefined) {
    headers['retry-after'] = retryAfterHeader;
  }
  return { status, message: 'Transport failure', cause: new Error('Transport failure'), headers };
}

function buildOpenAIStreamChunks(): Array<Record<string, unknown>> {
  return [
    { choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: 'lo' }, finish_reason: null }] },
    {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  ];
}

function buildAnthropicStreamEvents(): Array<Record<string, unknown>> {
  return [
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ];
}

function toAsyncIterable(items: Array<Record<string, unknown>>): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (const item of items) {
        await Promise.resolve();
        yield item;
      }
    },
  };
}

function toFailingIterable(): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      await Promise.resolve();
      yield { text: 'partial' };
      await Promise.resolve();
      // Intentional raw transport failure mock (simulates third-party SDK
      // behavior) — the adapter under test must map it to an error chunk.
      throw new Error('Stream transport failure');
    },
  };
}

async function collectChunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

function baseRequest(prompt: string): PromptRequest {
  return { messages: [{ role: 'user', content: prompt }] };
}

/**
 * Read the error code without instanceof.
 *
 * The testing bundle carries its own copy of the error classes, so
 * cross-bundle instanceof checks fail. Error codes are the stable
 * contract surface — assert on those instead.
 */
function errorCodeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

async function expectErrorCode(
  promise: Promise<unknown>,
  code: string,
): Promise<unknown> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(errorCodeOf(error)).toBe(code);
    return error;
  }
  expect.unreachable(`should have thrown ${code}`);
}

/**
 * Shared conformance suite for AIProvider implementations.
 *
 * Verifies AIProvider contract compliance (generate, capabilities, error
 * mapping, streaming) across provider adapters. The transport is replaced
 * with a duck-typed mock per test — never a real API call.
 *
 * @param label - Human-readable provider name for test block titles
 * @param providerFactory - Returns a fresh provider instance per test
 */
export function runProviderConformanceTests(
  label: string,
  providerFactory: () => AIProvider,
): void {
  describe(`AIProvider conformance: ${label}`, () => {
    it('exposes id and capabilities', () => {
      const provider = providerFactory();
      expect(typeof provider.id).toBe('string');
      expect(provider.id.length).toBeGreaterThan(0);
      expect(typeof provider.capabilities.streaming).toBe('boolean');
      expect(typeof provider.capabilities.toolCalling).toBe('boolean');
      expect(typeof provider.capabilities.vision).toBe('boolean');
      expect(typeof provider.capabilities.maxContextTokens).toBe('number');
    });

    it('capabilities.streaming truthfulness matches generateStream presence', () => {
      const provider = providerFactory();
      // eslint-disable-next-line @typescript-eslint/unbound-method -- intentional method-presence check, never invoked unbound
      const generateStreamRef: unknown = provider.generateStream;
      if (provider.capabilities.streaming) {
        expect(generateStreamRef).toBeDefined();
      } else {
        expect(generateStreamRef).toBeUndefined();
      }
    });

    it('generate() returns PromptResponse with text and usage', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      const mockCreate = installMockTransport(provider, shape);
      if (shape === 'openai') {
        mockCreate.mockResolvedValue(buildOpenAISuccessResponse('Hello', 'stop'));
      } else {
        mockCreate.mockResolvedValue(buildAnthropicSuccessResponse('Hello', 'end_turn'));
      }
      const response = await provider.generate(baseRequest('Hi'));
      expect(typeof response.text).toBe('string');
      expect(response.text).toBe('Hello');
      expect(typeof response.usage.prompt).toBe('number');
      expect(typeof response.usage.completion).toBe('number');
      expect(typeof response.usage.total).toBe('number');
    });

    it('maps 401 and 403 to ProviderAuthError', async () => {
      for (const status of [401, 403]) {
        const provider = providerFactory();
        const shape = detectClientShape(provider);
        const mockCreate = installMockTransport(provider, shape);
        mockCreate.mockRejectedValue(buildTransportError(shape, status));
        await expectErrorCode(provider.generate(baseRequest('Hi')), 'PROVIDER_AUTH_FAILED');
      }
    });

    it('maps 429 to ProviderRateLimitError with retryAfterMs', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      const mockCreate = installMockTransport(provider, shape);
      mockCreate.mockRejectedValue(buildTransportError(shape, 429, '30'));
      const error = await expectErrorCode(
        provider.generate(baseRequest('Hi')),
        'PROVIDER_RATE_LIMIT',
      );
      expect((error as { retryAfterMs?: unknown }).retryAfterMs).toBe(30000);
    });

    it('maps 408 to ProviderTimeoutError', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      const mockCreate = installMockTransport(provider, shape);
      mockCreate.mockRejectedValue(buildTransportError(shape, 408));
      await expectErrorCode(provider.generate(baseRequest('Hi')), 'PROVIDER_TIMEOUT');
    });

    it('maps 5xx to ProviderUnavailableError', async () => {
      for (const status of [500, 503]) {
        const provider = providerFactory();
        const shape = detectClientShape(provider);
        const mockCreate = installMockTransport(provider, shape);
        mockCreate.mockRejectedValue(buildTransportError(shape, status));
        await expectErrorCode(provider.generate(baseRequest('Hi')), 'PROVIDER_UNAVAILABLE');
      }
    });

    it('maps malformed response to ProviderMalformedResponseError', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      const mockCreate = installMockTransport(provider, shape);
      if (shape === 'openai') {
        mockCreate.mockResolvedValue({ choices: [] });
      } else {
        mockCreate.mockResolvedValue({ id: 'msg_x', usage: { input_tokens: 1, output_tokens: 1 } });
      }
      await expectErrorCode(provider.generate(baseRequest('Hi')), 'PROVIDER_MALFORMED_RESPONSE');
    });

    it('error messages never embed API keys', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      const mockCreate = installMockTransport(provider, shape);
      mockCreate.mockRejectedValue(buildTransportError(shape, 401));
      const error = await expectErrorCode(
        provider.generate(baseRequest('Hi')),
        'PROVIDER_AUTH_FAILED',
      );
      expect((error as Error).message).not.toContain('test-key');
    });

    it('providerOptions reserved key throws ConfigValidationError', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      installMockTransport(provider, shape);
      await expectErrorCode(
        provider.generate({ ...baseRequest('Hi'), providerOptions: { model: 'other' } }),
        'CONFIG_VALIDATION_FAILED',
      );
    });

    it('forwards AbortSignal to the transport', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      const mockCreate = installMockTransport(provider, shape);
      if (shape === 'openai') {
        mockCreate.mockResolvedValue(buildOpenAISuccessResponse('ok', 'stop'));
      } else {
        mockCreate.mockResolvedValue(buildAnthropicSuccessResponse('ok', 'end_turn'));
      }
      const controller = new AbortController();
      await provider.generate({ ...baseRequest('Hi'), signal: controller.signal });
      const secondArg = mockCreate.mock.calls[0]?.[1] as { signal?: AbortSignal } | undefined;
      expect(secondArg?.signal).toBe(controller.signal);
    });

    it('forwards maxTokens and temperature', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      const mockCreate = installMockTransport(provider, shape);
      if (shape === 'openai') {
        mockCreate.mockResolvedValue(buildOpenAISuccessResponse('ok', 'stop'));
      } else {
        mockCreate.mockResolvedValue(buildAnthropicSuccessResponse('ok', 'end_turn'));
      }
      await provider.generate({ ...baseRequest('Hi'), maxTokens: 100, temperature: 0.7 });
      const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(params?.max_tokens).toBe(100);
      expect(params?.temperature).toBe(0.7);
    });

    it('maps finishReason values', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      const mockCreate = installMockTransport(provider, shape);
      if (shape === 'openai') {
        mockCreate.mockResolvedValueOnce(buildOpenAISuccessResponse('a', 'stop'));
        expect((await provider.generate(baseRequest('a'))).finishReason).toBe('stop');
        mockCreate.mockResolvedValueOnce(buildOpenAIToolResponse());
        expect((await provider.generate(baseRequest('b'))).finishReason).toBe('tool_calls');
        mockCreate.mockResolvedValueOnce(buildOpenAISuccessResponse('c', 'length'));
        expect((await provider.generate(baseRequest('c'))).finishReason).toBe('length');
      } else {
        mockCreate.mockResolvedValueOnce(buildAnthropicSuccessResponse('a', 'end_turn'));
        expect((await provider.generate(baseRequest('a'))).finishReason).toBe('stop');
        mockCreate.mockResolvedValueOnce(buildAnthropicToolResponse());
        expect((await provider.generate(baseRequest('b'))).finishReason).toBe('tool_calls');
        mockCreate.mockResolvedValueOnce(buildAnthropicSuccessResponse('c', 'max_tokens'));
        expect((await provider.generate(baseRequest('c'))).finishReason).toBe('length');
      }
    });

    it('preserves user role in outgoing request', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      const mockCreate = installMockTransport(provider, shape);
      if (shape === 'openai') {
        mockCreate.mockResolvedValue(buildOpenAISuccessResponse('ok', 'stop'));
      } else {
        mockCreate.mockResolvedValue(buildAnthropicSuccessResponse('ok', 'end_turn'));
      }
      await provider.generate(baseRequest('unique-prompt-text'));
      const params = mockCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(JSON.stringify(params)).toContain('unique-prompt-text');
      expect(JSON.stringify(params)).toContain('"user"');
    });

    it('streaming terminates with exactly one done chunk', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      const mockCreate = installMockTransport(provider, shape);
      if (shape === 'openai') {
        mockCreate.mockResolvedValue(toAsyncIterable(buildOpenAIStreamChunks()));
      } else {
        mockCreate.mockResolvedValue(toAsyncIterable(buildAnthropicStreamEvents()));
      }
      if (provider.generateStream === undefined) {
        expect.unreachable('generateStream should be defined');
      }
      const stream = await provider.generateStream(baseRequest('Hi'));
      const chunks = await collectChunks(stream);
      const doneCount = chunks.filter((chunk) => chunk.type === 'done').length;
      const errorCount = chunks.filter((chunk) => chunk.type === 'error').length;
      expect(doneCount).toBe(1);
      expect(errorCount).toBe(0);
    });

    it('streaming surfaces transport failure as single error chunk', async () => {
      const provider = providerFactory();
      const shape = detectClientShape(provider);
      const mockCreate = installMockTransport(provider, shape);
      mockCreate.mockResolvedValue(toFailingIterable());
      if (provider.generateStream === undefined) {
        expect.unreachable('generateStream should be defined');
      }
      const stream = await provider.generateStream(baseRequest('Hi'));
      const chunks = await collectChunks(stream);
      const doneCount = chunks.filter((chunk) => chunk.type === 'done').length;
      const errorCount = chunks.filter((chunk) => chunk.type === 'error').length;
      expect(errorCount).toBe(1);
      expect(doneCount).toBe(0);
    });
  });
}
