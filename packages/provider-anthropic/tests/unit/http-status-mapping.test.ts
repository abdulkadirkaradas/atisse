import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestableProvider } from '../mock-provider.js';
import {
  ProviderAuthError,
  ProviderMalformedResponseError,
  ProviderRateLimitError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '@atisse/core';

describe('AnthropicProvider Unit Tests - HTTP Status Mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('mapError() - HTTP status mapping', () => {
    it('should map HTTP 429 to ProviderRateLimitError with retryAfterMs', async () => {
      const mockError = {
        status: 429,
        message: 'Rate limit exceeded',
        cause: new Error('Rate limit'),
        headers: { 'retry-after': '30' },
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderRateLimitError);
      expect((caughtError as unknown as { retryAfterMs: number }).retryAfterMs).toBe(30000);
    });

    it('should map HTTP 429 without Retry-After header', async () => {
      const mockError = {
        status: 429,
        message: 'Rate limit exceeded',
        cause: new Error('Rate limit'),
        headers: {},
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderRateLimitError);
      expect((caughtError as unknown as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
    });

    it('should map HTTP 401 to ProviderAuthError', async () => {
      const mockError = {
        status: 401,
        message: 'Invalid API key',
        cause: new Error('Unauthorized'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderAuthError);
    });

    it('should map HTTP 403 to ProviderAuthError', async () => {
      const mockError = {
        status: 403,
        message: 'Forbidden',
        cause: new Error('Forbidden'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderAuthError);
    });

    it('should map HTTP 408 to ProviderTimeoutError', async () => {
      const mockError = {
        status: 408,
        message: 'Request timeout',
        cause: new Error('Timeout'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderTimeoutError);
    });

    it('should map HTTP 500 to ProviderUnavailableError', async () => {
      const mockError = {
        status: 500,
        message: 'Internal server error',
        cause: new Error('Server error'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderUnavailableError);
    });

    it('should map HTTP 502 to ProviderUnavailableError', async () => {
      const mockError = {
        status: 502,
        message: 'Bad gateway',
        cause: new Error('Bad gateway'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderUnavailableError);
    });

    it('should map HTTP 503 to ProviderUnavailableError', async () => {
      const mockError = {
        status: 503,
        message: 'Service unavailable',
        cause: new Error('Service down'),
      };

      const mockCreateFn = vi.fn().mockRejectedValue(mockError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderUnavailableError);
    });

    it('should NOT re-wrap OrchestratorError — rethrow directly', async () => {
      const originalError = new ProviderMalformedResponseError('Bad data');

      const mockCreateFn = vi.fn().mockRejectedValue(originalError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderMalformedResponseError);
      expect(caughtError).toBe(originalError);
    });

    it('should map unknown errors to ProviderUnavailableError', async () => {
      const unknownError = new Error('Network disconnected');

      const mockCreateFn = vi.fn().mockRejectedValue(unknownError);
      const provider = createTestableProvider({ apiKey: 'test-key' }, mockCreateFn);

      let caughtError: Error | null = null;
      try {
        await provider.generate({ messages: [{ role: 'user', content: 'Hi' }] });
      } catch (error) {
        caughtError = error as Error;
      }

      expect(caughtError).toBeInstanceOf(ProviderUnavailableError);
    });
  });
});
