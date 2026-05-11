import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextLoadError } from '@atisse/core';
import { createClient } from 'redis';

import { RedisMemoryAdapter } from '../../src/index.js';

interface MockRedisClient {
  get: ReturnType<typeof vi.fn>;
  setEx: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  isOpen: boolean;
  connect: ReturnType<typeof vi.fn>;
}

let mockClient: MockRedisClient;

function createMockClient(): MockRedisClient {
  return {
    get: vi.fn(),
    setEx: vi.fn(),
    del: vi.fn(),
    isOpen: false,
    connect: vi.fn(),
  };
}

vi.mock('redis', () => ({
  createClient: vi.fn(() => mockClient),
}));

describe('RedisMemoryAdapter', () => {
  beforeEach(() => {
    mockClient = createMockClient();
    vi.clearAllMocks();
  });

  // ── Constructor ────────────────────────────────────────────

  describe('constructor', () => {
    it('should accept pre-connected client', () => {
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });
      expect(adapter.id).toBe('redis-memory');
    });

    it('should accept URL string config', () => {
      const adapter = new RedisMemoryAdapter({ url: 'redis://localhost:6379' });
      expect(adapter.id).toBe('redis-memory');
    });

    it('should create client when URL provided', () => {
      const adapter = new RedisMemoryAdapter({ url: 'redis://custom:6379' });
      expect(adapter.id).toBe('redis-memory');
      expect(createClient).toHaveBeenCalledWith({ url: 'redis://custom:6379' });
    });

    it('should use default TTL when not provided', () => {
      const adapter = new RedisMemoryAdapter({ url: 'redis://localhost:6379' });
      expect((adapter as unknown as { ttlSeconds: number }).ttlSeconds).toBe(3600);
    });

    it('should use custom TTL when provided', () => {
      const adapter = new RedisMemoryAdapter({ url: 'redis://localhost:6379', ttlSeconds: 7200 });
      expect((adapter as unknown as { ttlSeconds: number }).ttlSeconds).toBe(7200);
    });
  });

  // ── load() ─────────────────────────────────────────────────

  describe('load()', () => {
    it('should return empty array for missing key (null result)', async () => {
      mockClient.get.mockResolvedValue(null);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      const result = await adapter.load('session-1');

      expect(result).toEqual([]);
      expect(mockClient.get).toHaveBeenCalledWith('atisse:session:session-1');
    });

    it('should parse and return stored messages', async () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ];
      mockClient.get.mockResolvedValue(JSON.stringify(messages));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      const result = await adapter.load('session-1');

      expect(result).toHaveLength(2);
      expect(result[0]?.role).toBe('user');
      expect(result[1]?.content).toBe('Hi there');
    });

    it('should throw ContextLoadError on Redis get error', async () => {
      mockClient.get.mockRejectedValue(new Error('Connection lost'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.load('session-1')).rejects.toThrow(ContextLoadError);
    });

    it('should use sessionId-scoped key', async () => {
      mockClient.get.mockResolvedValue(null);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.load('my-specific-session');

      expect(mockClient.get).toHaveBeenCalledWith('atisse:session:my-specific-session');
    });

    it('should throw ContextLoadError when stored data is not valid JSON', async () => {
      mockClient.get.mockResolvedValue('invalid json');
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.load('test-session')).rejects.toThrow(ContextLoadError);
    });

    it('should throw ContextLoadError when URL-based connect fails', async () => {
      mockClient.connect.mockRejectedValueOnce(new Error('Connection refused'));
      const adapter = new RedisMemoryAdapter({ url: 'redis://localhost:6379' });

      await expect(adapter.load('test-session')).rejects.toThrow(ContextLoadError);
    });
  });

  // ── save() ─────────────────────────────────────────────────

  describe('save()', () => {
    it('should append messages to existing data', async () => {
      const existing = [{ role: 'user' as const, content: 'Hello' }];
      mockClient.get.mockResolvedValue(JSON.stringify(existing));
      mockClient.setEx.mockResolvedValue('OK');
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.save('session-1', [{ role: 'assistant', content: 'Hi' }]);

      expect(mockClient.setEx).toHaveBeenCalledWith(
        'atisse:session:session-1',
        3600,
        JSON.stringify([
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
        ]),
      );
    });

    it('should handle empty existing session', async () => {
      mockClient.get.mockResolvedValue(null);
      mockClient.setEx.mockResolvedValue('OK');
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.save('session-1', [{ role: 'user', content: 'First' }]);

      expect(mockClient.setEx).toHaveBeenCalledWith(
        'atisse:session:session-1',
        3600,
        JSON.stringify([{ role: 'user', content: 'First' }]),
      );
    });

    it('should refresh TTL on every save', async () => {
      mockClient.get.mockResolvedValue(null);
      mockClient.setEx.mockResolvedValue('OK');
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.save('session-1', [{ role: 'user', content: 'Msg 1' }]);
      await adapter.save('session-1', [{ role: 'user', content: 'Msg 2' }]);

      expect(mockClient.setEx).toHaveBeenCalledTimes(2);
      expect(mockClient.setEx).toHaveBeenNthCalledWith(
        1,
        'atisse:session:session-1',
        3600,
        expect.any(String),
      );
      expect(mockClient.setEx).toHaveBeenNthCalledWith(
        2,
        'atisse:session:session-1',
        3600,
        expect.any(String),
      );
    });

    it('should throw ContextLoadError on Redis setEx error', async () => {
      mockClient.get.mockResolvedValue(null);
      mockClient.setEx.mockRejectedValue(new Error('Write failed'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.save('session-1', [{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        ContextLoadError,
      );
    });

    it('should throw ContextLoadError on Redis get error during save', async () => {
      mockClient.get.mockRejectedValue(new Error('Read failed'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.save('session-1', [{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        ContextLoadError,
      );
    });
  });

  // ── clear() ────────────────────────────────────────────────

  describe('clear()', () => {
    it('should delete the key', async () => {
      mockClient.del.mockResolvedValue(1);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.clear('session-1');

      expect(mockClient.del).toHaveBeenCalledWith('atisse:session:session-1');
    });

    it('should be idempotent on non-existent key', async () => {
      mockClient.del.mockResolvedValue(0);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.clear('non-existent')).resolves.toBeUndefined();
    });

    it('should throw ContextLoadError on Redis del error', async () => {
      mockClient.del.mockRejectedValue(new Error('Delete failed'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.clear('session-1')).rejects.toThrow(ContextLoadError);
    });
  });

  // ── Key Isolation ──────────────────────────────────────────

  describe('key isolation', () => {
    it('should use different keys for different session IDs', async () => {
      mockClient.get.mockResolvedValue(null);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.load('session-A');
      await adapter.load('session-B');

      expect(mockClient.get).toHaveBeenCalledWith('atisse:session:session-A');
      expect(mockClient.get).toHaveBeenCalledWith('atisse:session:session-B');
    });

    it('should use same key format for load and save', async () => {
      mockClient.get.mockResolvedValue(null);
      mockClient.setEx.mockResolvedValue('OK');
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.save('session-X', [{ role: 'user', content: 'test' }]);

      const saveKey = mockClient.setEx.mock.calls[0]?.[0];
      mockClient.get.mockResolvedValue('[{"role":"user","content":"test"}]');
      await adapter.load('session-X');
      const loadKey = mockClient.get.mock.calls[mockClient.get.mock.calls.length - 1]?.[0];

      expect(saveKey).toBe('atisse:session:session-X');
      expect(loadKey).toBe('atisse:session:session-X');
    });
  });
});
