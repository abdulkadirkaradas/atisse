import { describe, expect, it, vi } from 'vitest';
import type { ContextProvider, ContextProviderInput } from '../interfaces.js';
import { ConfigValidationError } from '../errors.js';

interface SearchableStore {
  search: ReturnType<typeof vi.fn>;
}

/**
 * Access the backing vector store without importing adapter packages.
 * Core has zero adapter imports — duck typing keeps the direction intact.
 */
function getBackingStore(provider: ContextProvider): SearchableStore {
  const holder = provider as unknown as { vectorStore?: unknown };
  const store = holder.vectorStore as { search?: unknown } | undefined;
  if (store !== undefined && typeof store.search === 'function') {
    return store as SearchableStore;
  }
  throw new ConfigValidationError(['Unrecognized context provider backing store for conformance mocking']);
}

function installSearchMock(
  provider: ContextProvider,
  impl: (...args: unknown[]) => Promise<unknown>,
): ReturnType<typeof vi.fn> {
  const store = getBackingStore(provider);
  const mockSearch = vi.fn(impl);
  store.search = mockSearch;
  return mockSearch;
}

function sampleDocs(): Array<Record<string, unknown>> {
  return [{ content: 'First context passage.' }, { content: 'Second context passage.' }];
}

function baseInput(prompt: string): ContextProviderInput {
  return { prompt };
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

async function expectErrorCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error: unknown) {
    expect(errorCodeOf(error)).toBe(code);
    return;
  }
  expect.unreachable(`should have thrown ${code}`);
}

/**
 * Shared conformance suite for ContextProvider implementations.
 *
 * Verifies ContextProvider contract compliance (provide, input shape,
 * SystemMessage output, role safety, error mapping). The backing vector
 * store is replaced with a duck-typed mock per test — no external backend.
 *
 * @param label - Human-readable provider name for test block titles
 * @param contextProviderFactory - Returns a fresh provider instance per test
 */
export function runContextProviderConformanceTests(
  label: string,
  contextProviderFactory: () => ContextProvider,
): void {
  describe(`ContextProvider conformance: ${label}`, () => {
    it('provide() returns SystemMessage[] with role system', async () => {
      const provider = contextProviderFactory();
      installSearchMock(provider, () => Promise.resolve(sampleDocs()));
      const result = await provider.provide(baseInput('Tell me about AI'));
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      for (const message of result) {
        expect(message.role).toBe('system');
        expect(typeof message.content).toBe('string');
      }
    });

    it('accepts minimal input without stream or profile fields', async () => {
      const provider = contextProviderFactory();
      installSearchMock(provider, () => Promise.resolve(sampleDocs()));
      const input: ContextProviderInput = { prompt: 'minimal input' };
      expect('stream' in input).toBe(false);
      expect('profile' in input).toBe(false);
      const result = await provider.provide(input);
      expect(Array.isArray(result)).toBe(true);
    });

    it('output roles are always system, never user', async () => {
      const provider = contextProviderFactory();
      installSearchMock(provider, () => Promise.resolve(sampleDocs()));
      const result = await provider.provide(baseInput('role check'));
      expect(result.length).toBeGreaterThan(0);
      for (const message of result) {
        expect(message.role).not.toBe('user');
        expect(message.role).toBe('system');
      }
    });

    it('is deterministic for a fixed backing store', async () => {
      const provider = contextProviderFactory();
      installSearchMock(provider, () => Promise.resolve(sampleDocs()));
      const first = await provider.provide(baseInput('same prompt'));
      const second = await provider.provide(baseInput('same prompt'));
      expect(second).toEqual(first);
    });

    it('wraps search throw as ContextLoadError', async () => {
      const provider = contextProviderFactory();
      installSearchMock(provider, () =>
        Promise.reject(new Error('Vector database unavailable')),
      );
      await expectErrorCode(provider.provide(baseInput('test')), 'CONTEXT_LOAD_FAILED');
    });

    it('maps non-array search result to ContextProviderError', async () => {
      const provider = contextProviderFactory();
      installSearchMock(provider, () => Promise.resolve(null));
      await expectErrorCode(provider.provide(baseInput('test')), 'CONTEXT_PROVIDER_FAILED');
    });

    it('maps doc missing content to ContextProviderError', async () => {
      const provider = contextProviderFactory();
      installSearchMock(provider, () => Promise.resolve([{ metadata: { key: 'value' } }]));
      await expectErrorCode(provider.provide(baseInput('test')), 'CONTEXT_PROVIDER_FAILED');
    });

    it('returns [] when search returns empty docs', async () => {
      const provider = contextProviderFactory();
      installSearchMock(provider, () => Promise.resolve([]));
      const result = await provider.provide(baseInput('unknown topic'));
      expect(result).toEqual([]);
    });

    it('forwards input.prompt to search query', async () => {
      const provider = contextProviderFactory();
      const mockSearch = installSearchMock(provider, () => Promise.resolve(sampleDocs()));
      await provider.provide(baseInput('forwarded query'));
      expect(mockSearch).toHaveBeenCalledTimes(1);
      expect(mockSearch.mock.calls[0]?.[0]).toBe('forwarded query');
    });

    it('every element satisfies SystemMessage shape', async () => {
      const provider = contextProviderFactory();
      installSearchMock(provider, () => Promise.resolve(sampleDocs()));
      const result = await provider.provide(baseInput('shape check'));
      expect(result.length).toBeGreaterThan(0);
      for (const message of result) {
        expect(message).toHaveProperty('role', 'system');
        expect(message).toHaveProperty('content');
        expect(typeof message.content).toBe('string');
      }
    });
  });
}
