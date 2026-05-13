import { vi } from 'vitest';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { Stream } from 'openai/core/streaming';
import { OpenAIProvider, type OpenAIProviderConfig } from '../src/index.js';

// Helper to create mock stream
function createMockStream(
  chunks: ChatCompletionChunk[],
  error?: Error,
): Stream<ChatCompletionChunk> {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (error && index > 0) {
            throw error;
          }
          if (index < chunks.length) {
            return { done: false, value: chunks[index++] };
          }
          return { done: true, value: undefined };
        },
      };
    },
  } as unknown as Stream<ChatCompletionChunk>;
}

// Testable provider factory - creates provider and injects mock client
function createTestableProvider(
  config: OpenAIProviderConfig,
  mockCreateFn: ReturnType<typeof vi.fn>,
): OpenAIProvider {
  // Create real provider
  const provider = new OpenAIProvider(config);
  // Replace internal client with mock
  const mockClient = {
    chat: {
      completions: {
        create: mockCreateFn,
      },
    },
  };
  // Use Object.defineProperty to bypass readonly
  Object.defineProperty(provider, 'client', {
    value: mockClient,
    writable: true,
    configurable: true,
  });
  return provider;
}

export { createMockStream, createTestableProvider };
