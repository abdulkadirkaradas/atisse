import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RedisMemoryAdapter } from '../../src/index.js';

interface MockIsolatedClient {
  watch: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  multi: ReturnType<typeof vi.fn>;
  _exec: ReturnType<typeof vi.fn>;
  _setEx: ReturnType<typeof vi.fn>;
}

interface MockPool {
  connect: ReturnType<typeof vi.fn>;
  execute: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

let mockIsolated: MockIsolatedClient;
let mockPool: MockPool;

const mockClient = {
  get: vi.fn(),
  setEx: vi.fn(),
  del: vi.fn(),
  isOpen: true,
  connect: vi.fn(),
  createPool: vi.fn(),
  unwatch: vi.fn(),
};

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

vi.mock('redis', () => ({
  createClient: vi.fn(() => mockClient),
  WatchError: class WatchError extends Error {
    constructor(message = 'WatchError') {
      super(message);
      this.name = 'WatchError';
    }
  },
}));

describe('RedisMemoryAdapter TTL', () => {
  beforeEach(() => {
    mockIsolated = createMockIsolated();
    mockPool = {
      connect: vi.fn().mockResolvedValue(undefined),
      execute: vi.fn(
        async (cb: (client: MockIsolatedClient) => Promise<boolean>) =>
          cb(mockIsolated as never),
      ),
      close: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };
    vi.clearAllMocks();
    mockClient.createPool.mockReturnValue(mockPool as never);
    mockPool.execute.mockImplementation(
      async (cb: (client: MockIsolatedClient) => Promise<boolean>) =>
        cb(mockIsolated as never),
    );
    mockPool.connect.mockResolvedValue(undefined);
    mockPool.close.mockResolvedValue(undefined);
    mockIsolated.get.mockResolvedValue(null);
    mockIsolated._exec.mockResolvedValue('OK');
  });

  it('writes default TTL via isolated setEx inside pool.execute', async () => {
    const adapter = new RedisMemoryAdapter({ client: mockClient as never });
    await adapter.save('ttl-session', [{ role: 'user', content: 'Hello' }]);
    expect(mockPool.execute).toHaveBeenCalledTimes(1);
    expect(mockIsolated._setEx).toHaveBeenCalledWith(
      'atisse:session:ttl-session',
      3600,
      expect.any(String),
    );
  });

  it('writes custom TTL from URL config via isolated setEx', async () => {
    const adapter = new RedisMemoryAdapter({
      url: 'redis://localhost:6379',
      ttlSeconds: 7200,
    });
    await adapter.save('ttl-custom', [{ role: 'user', content: 'Hello' }]);
    expect(mockIsolated._setEx).toHaveBeenCalledWith(
      'atisse:session:ttl-custom',
      7200,
      expect.any(String),
    );
  });

  it('refreshes TTL on every save', async () => {
    const adapter = new RedisMemoryAdapter({ client: mockClient as never });
    await adapter.save('ttl-refresh', [{ role: 'user', content: 'First' }]);
    await adapter.save('ttl-refresh', [{ role: 'user', content: 'Second' }]);
    expect(mockIsolated._setEx).toHaveBeenCalledTimes(2);
    expect(mockIsolated._setEx).toHaveBeenNthCalledWith(
      1,
      'atisse:session:ttl-refresh',
      3600,
      expect.any(String),
    );
    expect(mockIsolated._setEx).toHaveBeenNthCalledWith(
      2,
      'atisse:session:ttl-refresh',
      3600,
      expect.any(String),
    );
  });

  it('applies key prefix to TTL writes', async () => {
    const adapter = new RedisMemoryAdapter({ client: mockClient as never, keyPrefix: 'custom:' });
    await adapter.save('ttl-prefixed', [{ role: 'user', content: 'Hello' }]);
    expect(mockIsolated.watch).toHaveBeenCalledWith('custom:ttl-prefixed');
    expect(mockIsolated._setEx).toHaveBeenCalledWith(
      'custom:ttl-prefixed',
      3600,
      expect.any(String),
    );
  });
});
