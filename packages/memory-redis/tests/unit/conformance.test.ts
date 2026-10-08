import { beforeEach, vi } from 'vitest';
import { runMemoryAdapterConformanceTests } from '@atisse/core/testing';

import { RedisMemoryAdapter } from '../../src/index.js';

const store = new Map<string, string>();

interface MockIsolatedClient {
  watch: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  multi: ReturnType<typeof vi.fn>;
  _exec: ReturnType<typeof vi.fn>;
  _setEx: ReturnType<typeof vi.fn>;
}

function createMockIsolated(): MockIsolatedClient {
  const exec = vi.fn(async () => 'OK');
  const setEx = vi.fn((key: string, _ttl: number, value: string) => {
    store.set(key, value);
    return { exec };
  });
  const multi = vi.fn(() => ({ setEx }));
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  const watch = vi.fn(async () => undefined);
  return { watch, get, multi, _exec: exec, _setEx: setEx };
}

const mockIsolated = createMockIsolated();

const mockPool = {
  connect: vi.fn(async () => undefined),
  execute: vi.fn(async (cb: (client: MockIsolatedClient) => Promise<boolean>) => {
    return cb(mockIsolated);
  }),
  close: vi.fn(async () => undefined),
  destroy: vi.fn(() => undefined),
};

const mockClient = {
  get: vi.fn(async (key: string) => store.get(key) ?? null),
  setEx: vi.fn(),
  del: vi.fn(async (key: string) => {
    store.delete(key);
    return 1;
  }),
  isOpen: true,
  connect: vi.fn(async () => undefined),
  createPool: vi.fn(() => mockPool),
  unwatch: vi.fn(async () => undefined),
};

vi.mock('redis', () => ({
  createClient: vi.fn(() => mockClient),
  WatchError: class WatchError extends Error {
    constructor(message = 'WatchError') {
      super(message);
      this.name = 'WatchError';
    }
  },
}));

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
  mockClient.createPool.mockReturnValue(mockPool as never);
  mockPool.execute.mockImplementation(
    async (cb: (client: MockIsolatedClient) => Promise<boolean>) => {
      return cb(mockIsolated as never);
    },
  );
  mockPool.connect.mockResolvedValue(undefined);
  mockPool.close.mockResolvedValue(undefined);
});

runMemoryAdapterConformanceTests(
  'RedisMemoryAdapter',
  () => new RedisMemoryAdapter({ url: 'redis://localhost:6379' }),
);
