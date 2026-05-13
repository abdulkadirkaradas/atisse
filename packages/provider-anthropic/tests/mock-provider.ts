import { vi } from 'vitest';
import { AnthropicProvider, AnthropicProviderConfig } from '../src/index.js';

// ── Mock Stream ────────────────────────────────────────────────

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
interface AnthropicInputJSONDelta {
  type: 'input_json_delta';
  partial_json: string;
}

type AnthropicStreamEvent =
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | {
      type: 'content_block_delta';
      index: number;
      delta: AnthropicTextDelta | AnthropicInputJSONDelta;
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

function createMockStream(chunks: AnthropicStreamEvent[], error?: Error): AsyncIterable<unknown> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (error && index > 0) throw error;
          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }
          return { done: true, value: undefined } as const;
        },
      };
    },
  };
}

// ── Testable Provider Factory ──────────────────────────────────

function createTestableProvider(
  config: AnthropicProviderConfig,
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

export {
  createMockStream,
  createTestableProvider,
  type AnthropicStreamEvent,
  type AnthropicMessageResponse,
};
