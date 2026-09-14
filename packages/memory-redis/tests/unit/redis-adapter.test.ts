import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContextLoadError, MemorySaveError, isRetryable } from '@atisse/core';
import { createClient, WatchError } from 'redis';

import { RedisMemoryAdapter } from '../../src/index.js';

interface MockPool {
  connect: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

interface MockIsolatedClient {
  watch: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  multi: ReturnType<typeof vi.fn>;
  _exec: ReturnType<typeof vi.fn>;
  _setEx: ReturnType<typeof vi.fn>;
}

interface MockRedisClient {
  get: ReturnType<typeof vi.fn>;
  setEx: ReturnType<typeof vi.fn>;
  del: ReturnType<typeof vi.fn>;
  isOpen: boolean;
  connect: ReturnType<typeof vi.fn>;
  createPool: ReturnType<typeof vi.fn>;
  unwatch: ReturnType<typeof vi.fn>;
}

let mockClient: MockRedisClient;
let mockPool: MockPool;
let mockIsolatedClient: MockIsolatedClient;

function createMockIsolated(): MockIsolatedClient {
  const exec = vi.fn().mockResolvedValue('OK');
  const setEx = vi.fn(() => ({ exec }));
  const multi = vi.fn(() => ({ setEx }));
  return {
    watch: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(null),
    multi,
    _exec: exec,
    _setEx: setEx,
  };
}

function createMockPool(isolated: MockIsolatedClient): MockPool {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn(async (cb: (c: MockIsolatedClient) => Promise<boolean>) => {
      return cb(isolated as never);
    }),
    close: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  };
}

function createMockClient(): MockRedisClient {
  return {
    get: vi.fn(),
    setEx: vi.fn(),
    del: vi.fn(),
    isOpen: false,
    connect: vi.fn(),
    createPool: vi.fn(),
    unwatch: vi.fn(),
  };
}

vi.mock('redis', () => ({
  createClient: vi.fn(() => mockClient),
  WatchError: class WatchError extends Error {
    constructor(message = 'WatchError') {
      super(message);
      this.name = 'WatchError';
    }
  },
}));

describe('RedisMemoryAdapter', () => {
  beforeEach(() => {
    mockIsolatedClient = createMockIsolated();
    mockPool = createMockPool(mockIsolatedClient);
    mockClient = createMockClient();
    mockClient.createPool.mockReturnValue(mockPool as never);
    vi.clearAllMocks();
    // re-apply mockReturnValue after clear
    mockClient.createPool.mockReturnValue(mockPool as never);
    mockIsolatedClient.get.mockResolvedValue(null);
    mockIsolatedClient._exec.mockResolvedValue('OK');
    mockPool.execute.mockImplementation(async (cb: (c: MockIsolatedClient) => Promise<boolean>) => {
      return cb(mockIsolatedClient as never);
    });
    mockPool.connect.mockResolvedValue(undefined);
    mockPool.close.mockResolvedValue(undefined);
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

    it('should produce ContextLoadError that is retryable', async () => {
      mockClient.get.mockRejectedValue(new Error('Connection lost'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      try {
        await adapter.load('session-1');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ContextLoadError);
        expect(isRetryable(error)).toBe(true);
      }
    });
  });

  // ── save() ─────────────────────────────────────────────────

  describe('save()', () => {
    it('should append messages to existing data via WATCH/MULTI/EXEC on pooled client', async () => {
      const existing = [{ role: 'user' as const, content: 'Hello' }];
      mockIsolatedClient.get.mockResolvedValue(JSON.stringify(existing));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.save('session-1', [{ role: 'assistant', content: 'Hi' }]);

      expect(mockClient.createPool).toHaveBeenCalledTimes(1);
      expect(mockPool.connect).toHaveBeenCalledTimes(1);
      expect(mockPool.execute).toHaveBeenCalledTimes(1);
      expect(mockIsolatedClient.watch).toHaveBeenCalledWith('atisse:session:session-1');
      expect(mockIsolatedClient.get).toHaveBeenCalledWith('atisse:session:session-1');
      expect(mockIsolatedClient.multi).toHaveBeenCalledTimes(1);
      expect(mockIsolatedClient._setEx).toHaveBeenCalledWith(
        'atisse:session:session-1',
        3600,
        JSON.stringify([
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
        ]),
      );
      expect(mockIsolatedClient._exec).toHaveBeenCalledTimes(1);
      // Ensure save no longer calls shared client directly for get/setEx
      expect(mockClient.get).not.toHaveBeenCalled();
      expect(mockClient.setEx).not.toHaveBeenCalled();
      expect(mockPool.close).toHaveBeenCalledTimes(1);
    });

    it('should handle empty existing session', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.save('session-1', [{ role: 'user', content: 'First' }]);

      expect(mockIsolatedClient._setEx).toHaveBeenCalledWith(
        'atisse:session:session-1',
        3600,
        JSON.stringify([{ role: 'user', content: 'First' }]),
      );
    });

    it('should refresh TTL on every save', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.save('session-1', [{ role: 'user', content: 'Msg 1' }]);
      // Need fresh pool for second call because save creates pool per invocation
      // mockClient.createPool returns same mockPool; reset exec count
      // Recreate isolated for second save to track separately but reuse pool mock
      mockIsolatedClient.get.mockResolvedValue(null);
      await adapter.save('session-1', [{ role: 'user', content: 'Msg 2' }]);

      expect(mockIsolatedClient._setEx).toHaveBeenCalledTimes(2);
      expect(mockIsolatedClient._setEx).toHaveBeenNthCalledWith(
        1,
        'atisse:session:session-1',
        3600,
        expect.any(String),
      );
      expect(mockIsolatedClient._setEx).toHaveBeenNthCalledWith(
        2,
        'atisse:session:session-1',
        3600,
        expect.any(String),
      );
    });

    it('should use custom TTL from URL config when executing transaction', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      // URL mode with custom ttl is stored on adapter
      const adapter = new RedisMemoryAdapter({ url: 'redis://localhost:6379', ttlSeconds: 7200 });
      // ensureConnected will call connect, then save will create pool
      mockClient.isOpen = true; // to avoid ensureConnected connect if needed, but URL mode may still check
      // For save, ensureConnected will check isOpen or ownsConnection
      // Since adapter with url ownsConnection true and isOpen true, ensureConnected returns early
      // Provide fresh pool mock
      await adapter.save('session-1', [{ role: 'user', content: 'Hi' }]);
      expect(mockIsolatedClient._setEx).toHaveBeenCalledWith(
        'atisse:session:session-1',
        7200,
        expect.any(String),
      );
    });

    it('should throw MemorySaveError on Redis exec error (non-WatchError) instantly without retry', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      const execError = new Error('Write failed');
      mockIsolatedClient._exec.mockRejectedValue(execError);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.save('session-1', [{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        MemorySaveError,
      );

      expect(mockPool.execute).toHaveBeenCalledTimes(1);
      // Ensure MemorySaveError is not retryable
      try {
        await adapter.save('session-1', [{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect(isRetryable(e)).toBe(false);
      }
      expect(mockPool.close).toHaveBeenCalled();
    });

    it('should throw MemorySaveError on Redis get error during save (isolated get)', async () => {
      mockIsolatedClient.get.mockRejectedValue(new Error('Read failed'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.save('session-1', [{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        MemorySaveError,
      );
      expect(isRetryable(await adapter.save('session-1', [{ role: 'user', content: 'Hi' }]).catch((e) => e))).toBe(false);
    });

    it('should throw MemorySaveError when pool.connect fails and cleanup pool', async () => {
      mockPool.connect.mockRejectedValue(new Error('Pool connect failed'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.save('session-1', [{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        MemorySaveError,
      );
      expect(mockPool.close).toHaveBeenCalled();
      expect(mockPool.destroy).toHaveBeenCalled();
    });

    it('should call pool.close in finally on success (no leak)', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });
      await adapter.save('session-1', [{ role: 'user', content: 'Hi' }]);
      expect(mockPool.close).toHaveBeenCalledTimes(1);
    });

    it('should call pool.close in finally on failure (no leak)', async () => {
      mockIsolatedClient.get.mockRejectedValue(new Error('Read failed'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });
      await expect(adapter.save('session-1', [{ role: 'user', content: 'Hi' }])).rejects.toThrow(MemorySaveError);
      expect(mockPool.close).toHaveBeenCalledTimes(1);
    });

    it('should never call this.client directly for WATCH/MULTI/EXEC', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });
      await adapter.save('session-1', [{ role: 'user', content: 'Hi' }]);
      // Shared client should not receive watch/multi/get/setEx for transaction
      expect(mockClient.get).not.toHaveBeenCalled();
      expect(mockClient.setEx).not.toHaveBeenCalled();
      // Unwatch should never be called on shared client
      expect(mockClient.unwatch).not.toHaveBeenCalled();
      // Isolated client should have received the calls
      expect(mockIsolatedClient.watch).toHaveBeenCalled();
      expect(mockIsolatedClient.multi).toHaveBeenCalled();
    });
  });

  // ── save() transaction retry semantics ───────────────────────

  describe('save() WATCH retry', () => {
    it('should retry on WatchError x2 then succeed on third attempt', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      // Simulate WatchError on first two execs, success on third
      mockIsolatedClient._exec
        .mockRejectedValueOnce(new WatchError('WatchError'))
        .mockRejectedValueOnce(new WatchError('WatchError'))
        .mockResolvedValueOnce('OK');
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.save('session-1', [{ role: 'user', content: 'Hi' }]);

      // pool.execute should have been called 3 times (retry loop)
      expect(mockPool.execute).toHaveBeenCalledTimes(3);
      expect(mockIsolatedClient.watch).toHaveBeenCalledTimes(3);
      expect(mockIsolatedClient._exec).toHaveBeenCalledTimes(3);
      // Finally close once
      expect(mockPool.close).toHaveBeenCalledTimes(1);
    });

    it('should throw MemorySaveError after 3 WatchError failures (max retries)', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      mockIsolatedClient._exec.mockRejectedValue(new WatchError('WatchError'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.save('session-1', [{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        MemorySaveError,
      );
      expect(mockPool.execute).toHaveBeenCalledTimes(3);
      expect(mockPool.close).toHaveBeenCalledTimes(1);
      // Verify retryable is false for exhausted retries
      try {
        await adapter.save('session-1', [{ role: 'user', content: 'Hi' }]);
      } catch (e) {
        expect(e).toBeInstanceOf(MemorySaveError);
        expect(isRetryable(e)).toBe(false);
        const cause = (e as MemorySaveError).cause as Error | undefined;
        expect(cause?.message).toMatch(/max retries/i);
      }
    });

    it('should not retry non-WatchError and throw MemorySaveError immediately', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      const nonWatch = new Error('Connection reset');
      mockIsolatedClient._exec.mockRejectedValue(nonWatch);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.save('session-1', [{ role: 'user', content: 'Hi' }])).rejects.toThrow(
        MemorySaveError,
      );
      expect(mockPool.execute).toHaveBeenCalledTimes(1);
      expect(mockPool.close).toHaveBeenCalledTimes(1);
    });

    it('should perform retries with no delay (synchronous tight loop)', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      mockIsolatedClient._exec
        .mockRejectedValueOnce(new WatchError('WatchError'))
        .mockRejectedValueOnce(new WatchError('WatchError'))
        .mockResolvedValueOnce('OK');
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      const start = Date.now();
      await adapter.save('session-1', [{ role: 'user', content: 'Hi' }]);
      const elapsed = Date.now() - start;

      expect(mockPool.execute).toHaveBeenCalledTimes(3);
      // No artificial delay: should complete well under 50ms (unit test threshold)
      expect(elapsed).toBeLessThan(50);
      // Ensure no timers were used internally (no setTimeout)
      // This is implicitly verified by immediate completion without fake timers
    });

    it('should create pool once per save and reuse across retries (no leak)', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      mockIsolatedClient._exec
        .mockRejectedValueOnce(new WatchError('WatchError'))
        .mockRejectedValueOnce(new WatchError('WatchError'))
        .mockResolvedValueOnce('OK');
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.save('session-1', [{ role: 'user', content: 'Hi' }]);

      expect(mockClient.createPool).toHaveBeenCalledTimes(1);
      expect(mockPool.close).toHaveBeenCalledTimes(1);
    });
  });

  // ── concurrent isolation ─────────────────────────────────────

  describe('concurrent save isolation', () => {
    it('should isolate concurrent saves via pool.execute with dedicated isolated clients', async () => {
      // For concurrent test, create two distinct isolated clients/pools
      const isolatedA = createMockIsolated();
      const isolatedB = createMockIsolated();
      const poolA = createMockPool(isolatedA);
      const poolB = createMockPool(isolatedB);
      // Make pool execute use the respective isolated client
      poolA.execute.mockImplementation(async (cb: (c: MockIsolatedClient) => Promise<boolean>) => cb(isolatedA as never));
      poolB.execute.mockImplementation(async (cb: (c: MockIsolatedClient) => Promise<boolean>) => cb(isolatedB as never));
      mockClient.createPool.mockReturnValueOnce(poolA as never).mockReturnValueOnce(poolB as never);
      isolatedA.get.mockResolvedValue(null);
      isolatedB.get.mockResolvedValue(null);

      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await Promise.all([
        adapter.save('session-A', [{ role: 'user', content: 'msg A' }]),
        adapter.save('session-B', [{ role: 'user', content: 'msg B' }]),
      ]);

      expect(mockClient.createPool).toHaveBeenCalledTimes(2);
      expect(poolA.execute).toHaveBeenCalledTimes(1);
      expect(poolB.execute).toHaveBeenCalledTimes(1);
      expect(isolatedA.watch).toHaveBeenCalledWith('atisse:session:session-A');
      expect(isolatedB.watch).toHaveBeenCalledWith('atisse:session:session-B');
      expect(isolatedA._setEx).toHaveBeenCalledWith('atisse:session:session-A', expect.any(Number), expect.any(String));
      expect(isolatedB._setEx).toHaveBeenCalledWith('atisse:session:session-B', expect.any(Number), expect.any(String));
      // Shared client never directly handled transaction
      expect(mockClient.get).not.toHaveBeenCalled();
      expect(mockClient.setEx).not.toHaveBeenCalled();
      expect(poolA.close).toHaveBeenCalledTimes(1);
      expect(poolB.close).toHaveBeenCalledTimes(1);
    });

    it('should not share WATCH state between concurrent transactions', async () => {
      // Each transaction watches its own key on its own isolated connection
      const isolated1 = createMockIsolated();
      const isolated2 = createMockIsolated();
      const pool1 = createMockPool(isolated1);
      const pool2 = createMockPool(isolated2);
      pool1.execute.mockImplementation(async (cb) => cb(isolated1 as never));
      pool2.execute.mockImplementation(async (cb) => cb(isolated2 as never));
      mockClient.createPool.mockReturnValueOnce(pool1 as never).mockReturnValueOnce(pool2 as never);
      isolated1.get.mockResolvedValue(JSON.stringify([{ role: 'user', content: 'existing' }]));
      isolated2.get.mockResolvedValue(null);

      const adapter = new RedisMemoryAdapter({ client: mockClient as never });
      await Promise.all([
        adapter.save('session-1', [{ role: 'user', content: 'A' }]),
        adapter.save('session-2', [{ role: 'user', content: 'B' }]),
      ]);

      expect(isolated1.watch).toHaveBeenCalledWith('atisse:session:session-1');
      expect(isolated2.watch).toHaveBeenCalledWith('atisse:session:session-2');
      expect(isolated1.get).toHaveBeenCalledWith('atisse:session:session-1');
      expect(isolated2.get).toHaveBeenCalledWith('atisse:session:session-2');
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

    it('should throw MemorySaveError on Redis del error', async () => {
      mockClient.del.mockRejectedValue(new Error('Delete failed'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await expect(adapter.clear('session-1')).rejects.toThrow(MemorySaveError);
    });

    it('should produce MemorySaveError that is not retryable for clear()', async () => {
      mockClient.del.mockRejectedValue(new Error('Delete failed'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      try {
        await adapter.clear('session-1');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MemorySaveError);
        expect(isRetryable(error)).toBe(false);
      }
    });

    it('should produce MemorySaveError that is not retryable for save()', async () => {
      mockIsolatedClient.get.mockRejectedValue(new Error('Read failed'));
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      try {
        await adapter.save('session-1', [{ role: 'user', content: 'Hi' }]);
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MemorySaveError);
        expect(isRetryable(error)).toBe(false);
      }
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
      mockIsolatedClient.get.mockResolvedValue(null);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });

      await adapter.save('session-X', [{ role: 'user', content: 'test' }]);

      // save uses isolated client get with same key prefix
      expect(mockIsolatedClient.get).toHaveBeenCalledWith('atisse:session:session-X');
      // load uses shared client get with same prefix
      mockClient.get.mockResolvedValue('[{"role":"user","content":"test"}]');
      await adapter.load('session-X');
      expect(mockClient.get).toHaveBeenCalledWith('atisse:session:session-X');
    });
  });

  // ── Custom keyPrefix ───────────────────────────────────────

  describe('custom keyPrefix', () => {
    it('should use custom keyPrefix for load() in client mode', async () => {
      mockClient.get.mockResolvedValue(null);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never, keyPrefix: 'custom:' });
      await adapter.load('session-1');
      expect(mockClient.get).toHaveBeenCalledWith('custom:session-1');
    });

    it('should use custom keyPrefix for save() in client mode', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never, keyPrefix: 'custom:' });
      await adapter.save('session-1', [{ role: 'user' as const, content: 'Hello' }]);
      expect(mockIsolatedClient.watch).toHaveBeenCalledWith('custom:session-1');
      expect(mockIsolatedClient._setEx).toHaveBeenCalledWith('custom:session-1', 3600, expect.any(String));
    });

    it('should use custom keyPrefix for clear() in client mode', async () => {
      mockClient.del.mockResolvedValue(1);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never, keyPrefix: 'custom:' });
      await adapter.clear('session-1');
      expect(mockClient.del).toHaveBeenCalledWith('custom:session-1');
    });

    it('should use custom keyPrefix in URL mode', async () => {
      mockClient.get.mockResolvedValue(null);
      mockClient.connect.mockResolvedValue(undefined);
      // Need to set isOpen true for ensureConnected to avoid extra connect for load
      // Actually load will call ensureConnected which checks isOpen
      // With url config, isOpen false by default, so it will call connect
      const adapter = new RedisMemoryAdapter({
        url: 'redis://localhost:6379',
        keyPrefix: 'app:session:',
      });
      mockClient.isOpen = true;
      await adapter.load('sess-1');
      expect(mockClient.get).toHaveBeenCalledWith('app:session:sess-1');
    });

    it('should apply default prefix when keyPrefix is omitted', async () => {
      mockClient.get.mockResolvedValue(null);
      const adapter = new RedisMemoryAdapter({ client: mockClient as never });
      await adapter.load('session-1');
      expect(mockClient.get).toHaveBeenCalledWith('atisse:session:session-1');
    });

    it('should produce distinct Redis keys for different keyPrefix values with same sessionId', async () => {
      mockClient.get.mockResolvedValue(null);
      const adapterA = new RedisMemoryAdapter({
        client: mockClient as never,
        keyPrefix: 'tenant-a:',
      });
      const adapterB = new RedisMemoryAdapter({
        client: mockClient as never,
        keyPrefix: 'tenant-b:',
      });
      await adapterA.load('session-1');
      await adapterB.load('session-1');
      expect(mockClient.get).toHaveBeenNthCalledWith(1, 'tenant-a:session-1');
      expect(mockClient.get).toHaveBeenNthCalledWith(2, 'tenant-b:session-1');
    });

    it('should use custom keyPrefix for pooled save in URL mode', async () => {
      mockIsolatedClient.get.mockResolvedValue(null);
      mockClient.isOpen = true;
      const adapter = new RedisMemoryAdapter({ url: 'redis://localhost:6379', keyPrefix: 'appns:' });
      await adapter.save('session-1', [{ role: 'user', content: 'Hi' }]);
      expect(mockIsolatedClient.watch).toHaveBeenCalledWith('appns:session-1');
      expect(mockIsolatedClient._setEx).toHaveBeenCalledWith('appns:session-1', expect.any(Number), expect.any(String));
    });
  });
});

