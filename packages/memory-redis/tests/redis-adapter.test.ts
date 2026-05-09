import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextLoadError } from '@atisse/core';
import type { Message } from '@atisse/core';

const { mockClient, mockGet, mockSetEx, mockDel, mockConnect } = vi.hoisted(
  () => {
    const mockGet = vi.fn();
    const mockSetEx = vi.fn();
    const mockDel = vi.fn();
    const mockConnect = vi.fn();
    const mockClient = {
      get: mockGet,
      setEx: mockSetEx,
      del: mockDel,
      connect: mockConnect,
      isOpen: true,
    };
    return { mockClient, mockGet, mockSetEx, mockDel, mockConnect };
  },
);

vi.mock('redis', () => ({
  createClient: vi.fn(() => mockClient),
}));

import { RedisMemoryAdapter } from '../src/index.js';

const SESSION_ID = 'test-session-123';
const URL_CONFIG = { url: 'redis://localhost:6379' };

function createAdapter(): RedisMemoryAdapter {
  return new RedisMemoryAdapter(URL_CONFIG);
}

const userMessage: Message = {
  role: 'user',
  content: 'hello',
};

const assistantMessage: Message = {
  role: 'assistant',
  content: 'world',
};

describe('RedisMemoryAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.isOpen = true;
  });

  describe('load()', () => {
    it('returns empty array when key does not exist (null result)', async () => {
      mockGet.mockResolvedValue(null);
      const adapter = createAdapter();

      const result = await adapter.load(SESSION_ID);

      expect(result).toEqual([]);
      expect(mockGet).toHaveBeenCalledWith(
        `atisse:session:${SESSION_ID}`,
      );
    });

    it('returns parsed messages when key exists', async () => {
      const stored = JSON.stringify([userMessage, assistantMessage]);
      mockGet.mockResolvedValue(stored);
      const adapter = createAdapter();

      const result = await adapter.load(SESSION_ID);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject(userMessage);
      expect(result[1]).toMatchObject(assistantMessage);
    });

    it('throws ContextLoadError on Redis error', async () => {
      const redisError = new Error('Connection refused');
      mockGet.mockRejectedValue(redisError);
      const adapter = createAdapter();

      await expect(adapter.load(SESSION_ID)).rejects.toThrow(
        ContextLoadError,
      );
    });

    it('throws ContextLoadError on malformed JSON in Redis', async () => {
      mockGet.mockResolvedValue('not-valid-json');
      const adapter = createAdapter();

      await expect(adapter.load(SESSION_ID)).rejects.toThrow(
        ContextLoadError,
      );
    });
  });

  describe('connection management', () => {
    it('calls connect() on first operation when not connected', async () => {
      mockClient.isOpen = false;
      mockConnect.mockResolvedValue(undefined);
      mockGet.mockResolvedValue(null);
      const adapter = createAdapter();

      await adapter.load(SESSION_ID);

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockGet).toHaveBeenCalledWith(
        `atisse:session:${SESSION_ID}`,
      );
    });

    it('throws ContextLoadError when connect() fails', async () => {
      mockClient.isOpen = false;
      mockConnect.mockRejectedValue(new Error('Connection refused'));
      const adapter = createAdapter();

      await expect(adapter.load(SESSION_ID)).rejects.toThrow(
        ContextLoadError,
      );
    });
  });

  describe('save()', () => {
    it('appends messages to existing session history', async () => {
      const existing = JSON.stringify([userMessage]);
      mockGet.mockResolvedValue(existing);
      const adapter = createAdapter();

      await adapter.save(SESSION_ID, [assistantMessage]);

      expect(mockSetEx).toHaveBeenCalledWith(
        `atisse:session:${SESSION_ID}`,
        3600,
        JSON.stringify([userMessage, assistantMessage]),
      );
    });

    it('creates new session when no existing data', async () => {
      mockGet.mockResolvedValue(null);
      const adapter = createAdapter();

      await adapter.save(SESSION_ID, [userMessage]);

      expect(mockSetEx).toHaveBeenCalledWith(
        `atisse:session:${SESSION_ID}`,
        3600,
        JSON.stringify([userMessage]),
      );
    });

    it('refreshes TTL on every call', async () => {
      mockGet.mockResolvedValue(null);
      const adapter = createAdapter();

      await adapter.save(SESSION_ID, [userMessage]);
      await adapter.save(SESSION_ID, [assistantMessage]);

      expect(mockSetEx).toHaveBeenCalledTimes(2);
      expect(mockSetEx).toHaveBeenLastCalledWith(
        `atisse:session:${SESSION_ID}`,
        3600,
        expect.any(String),
      );
    });

    it('throws ContextLoadError when load fails inside save', async () => {
      const redisError = new Error('Connection refused');
      mockGet.mockRejectedValue(redisError);
      const adapter = createAdapter();

      await expect(
        adapter.save(SESSION_ID, [userMessage]),
      ).rejects.toThrow(ContextLoadError);
    });

    it('throws ContextLoadError when setEx fails', async () => {
      mockGet.mockResolvedValue(null);
      const redisError = new Error('Write failed');
      mockSetEx.mockRejectedValue(redisError);
      const adapter = createAdapter();

      await expect(
        adapter.save(SESSION_ID, [userMessage]),
      ).rejects.toThrow(ContextLoadError);
    });
  });

  describe('clear()', () => {
    it('deletes the session key', async () => {
      mockDel.mockResolvedValue(1);
      const adapter = createAdapter();

      await adapter.clear(SESSION_ID);

      expect(mockDel).toHaveBeenCalledWith(
        `atisse:session:${SESSION_ID}`,
      );
    });

    it('is idempotent — does not throw on non-existent key', async () => {
      mockDel.mockResolvedValue(0);
      const adapter = createAdapter();

      await expect(adapter.clear('non-existent-session')).resolves.not.toThrow();
    });

    it('throws ContextLoadError on Redis error', async () => {
      const redisError = new Error('Connection refused');
      mockDel.mockRejectedValue(redisError);
      const adapter = createAdapter();

      await expect(adapter.clear(SESSION_ID)).rejects.toThrow(
        ContextLoadError,
      );
    });
  });

  describe('storage key isolation', () => {
    it('includes sessionId in storage key', async () => {
      mockGet.mockResolvedValue(null);
      const adapter = createAdapter();

      await adapter.load(SESSION_ID);

      expect(mockGet).toHaveBeenCalledWith(
        `atisse:session:${SESSION_ID}`,
      );
    });

    it('isolates data between sessions', async () => {
      const sessionAData = JSON.stringify([userMessage]);
      const sessionBData = JSON.stringify([assistantMessage]);

      mockGet.mockImplementation((key: string) => {
        if (key === 'atisse:session:session-A') return Promise.resolve(sessionAData);
        if (key === 'atisse:session:session-B') return Promise.resolve(sessionBData);
        return Promise.resolve(null);
      });
      const adapter = createAdapter();

      const resultA = await adapter.load('session-A');
      const resultB = await adapter.load('session-B');

      expect(resultA).toHaveLength(1);
      expect(resultA[0]!.content).toBe('hello');
      expect(resultB).toHaveLength(1);
      expect(resultB[0]!.content).toBe('world');
    });
  });

  describe('constructor variants', () => {
    it('accepts pre-connected client', () => {
      const adapter = new RedisMemoryAdapter({
        client: mockClient as any,
      });
      expect(adapter).toBeInstanceOf(RedisMemoryAdapter);
    });

    it('accepts url configuration', () => {
      const adapter = createAdapter();
      expect(adapter).toBeInstanceOf(RedisMemoryAdapter);
    });
  });
});
