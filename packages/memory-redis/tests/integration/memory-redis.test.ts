import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRetryable, MemorySaveError, Orchestrator } from '@atisse/core';
import { MockProvider } from '@atisse/core/testing';
import { RedisMemoryAdapter } from '@atisse/memory-redis';

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
    execute: vi.fn(async (cb: (c: MockIsolatedClient) => Promise<boolean>) => cb(isolated as never)),
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

function createMockProvider(): MockProvider {
  return new MockProvider('test-provider');
}

describe('RedisMemoryAdapter + Orchestrator (integration)', () => {
  beforeEach(() => {
    mockIsolatedClient = createMockIsolated();
    mockPool = createMockPool(mockIsolatedClient);
    mockClient = createMockClient();
    mockClient.createPool.mockReturnValue(mockPool as never);
    vi.clearAllMocks();
    mockClient.createPool.mockReturnValue(mockPool as never);
    mockClient.isOpen = false;
    mockIsolatedClient.get.mockResolvedValue(null);
    mockIsolatedClient._exec.mockResolvedValue('OK');
    mockPool.execute.mockImplementation(async (cb: (c: MockIsolatedClient) => Promise<boolean>) => cb(mockIsolatedClient as never));
    mockPool.connect.mockResolvedValue(undefined);
    mockPool.close.mockResolvedValue(undefined);
  });

  it('should call load() before generation and save() at COMPLETING when sessionId present', async () => {
    mockClient.get.mockResolvedValue(null);
    mockIsolatedClient.get.mockResolvedValue(null);

    const provider = createMockProvider();
    provider.enqueue({ text: 'Hello!' });
    const memory = new RedisMemoryAdapter({ client: mockClient as never });
    const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

    await orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' });

    expect(mockClient.get).toHaveBeenCalledWith('atisse:session:session-1');
    // save now uses pooled transaction, not direct setEx
    expect(mockIsolatedClient._setEx).toHaveBeenCalled();
    expect(mockPool.execute).toHaveBeenCalledTimes(1);
    expect(mockPool.close).toHaveBeenCalled();
    // Ensure shared client setEx not used for transaction
    expect(mockClient.setEx).not.toHaveBeenCalled();
  });

  it('should accumulate history across sequential runs with same sessionId', async () => {
    // Orchestrator load phase uses mockClient.get
    // Save internal read uses isolated get
    mockClient.get
      .mockResolvedValueOnce(null) // orchestrator.load (run 1)
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
        ]),
      ); // orchestrator.load (run 2)

    mockIsolatedClient.get
      .mockResolvedValueOnce(null) // save internal get (run 1)
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'Hi' },
          { role: 'assistant', content: 'Hello!' },
        ]),
      ); // save internal get (run 2)

    const provider = createMockProvider();
    provider.enqueue({ text: 'Hello!' }).enqueue({ text: 'You said: test' });
    const memory = new RedisMemoryAdapter({ client: mockClient as never });
    const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

    // First run
    await orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' });

    expect(mockIsolatedClient._setEx).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Number),
      expect.any(String),
    );

    // Second run - reset isolated tracking but keep pool
    mockIsolatedClient._setEx.mockClear();
    mockClient.get.mockClear();

    // Re-setup mocks for second run isolated get already consumed one, need fresh for check in this test
    // Actually second run's isolated get was already set above as second resolvedOnce
    // No need to re-setup; but ensure pool still works
    mockIsolatedClient._exec.mockResolvedValue('OK');

    await orchestrator.run({ prompt: 'test', sessionId: 'session-1' });

    expect(mockIsolatedClient._setEx).toHaveBeenCalledTimes(1);
    const [, , data] = mockIsolatedClient._setEx.mock.calls[0]!;
    const secondMessages = JSON.parse(data as string);
    expect(secondMessages).toHaveLength(4);
    expect(secondMessages[0]?.content).toBe('Hi');
    expect(secondMessages[2]?.content).toBe('test');
  });

  it('should transition to FAILED when save fails', async () => {
    mockClient.get.mockResolvedValue(null);
    mockIsolatedClient.get.mockResolvedValue(null);
    mockIsolatedClient._exec.mockRejectedValue(new Error('Redis write failure'));

    const provider = createMockProvider();
    provider.enqueue({ text: 'Response' });
    const memory = new RedisMemoryAdapter({ client: mockClient as never });
    const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

    await expect(orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' })).rejects.toThrow(
      MemorySaveError,
    );
    expect(isRetryable(await orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' }).catch((e) => e))).toBe(false);
  });

  it('should NOT call memory methods when sessionId is absent', async () => {
    const provider = createMockProvider();
    provider.enqueue({ text: 'Response' });
    const memory = new RedisMemoryAdapter({ client: mockClient as never });
    const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

    await orchestrator.run({ prompt: 'Hi' });

    expect(mockClient.get).not.toHaveBeenCalled();
    expect(mockIsolatedClient._setEx).not.toHaveBeenCalled();
    expect(mockPool.execute).not.toHaveBeenCalled();
  });

  it('should produce correct append semantics: [run1_user, run1_asst, run2_user, run2_asst]', async () => {
    mockClient.get
      .mockResolvedValueOnce(null) // orchestrator.load (run 1)
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'resp1' },
        ]),
      ); // orchestrator.load (run 2) - first call for run2
    mockIsolatedClient.get
      .mockResolvedValueOnce(null) // save internal (run 1)
      .mockResolvedValueOnce(
        JSON.stringify([
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'resp1' },
        ]),
      ); // save internal (run 2)

    const provider = createMockProvider();
    provider.enqueue({ text: 'resp1' }).enqueue({ text: 'resp2' });
    const memory = new RedisMemoryAdapter({ client: mockClient as never });
    const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });

    // Run 1
    await orchestrator.run({ prompt: 'first', sessionId: 'sess-1' });
    expect(mockIsolatedClient._setEx).toHaveBeenCalledTimes(1);
    const [, , data] = mockIsolatedClient._setEx.mock.calls[0]!;
    const save1 = JSON.parse(data as string);
    expect(save1).toHaveLength(2);
    expect(save1[0]?.content).toBe('first');
    expect(save1[1]?.content).toBe('resp1');

    mockIsolatedClient._setEx.mockClear();
    mockIsolatedClient._exec.mockResolvedValue('OK');

    // Run 2: orchestrator.load was already mocked as second resolveOnce, but we consumed it
    // Need to re-setup for second run's orchestrator.load if needed already done above as mockResolvedValueOnce second
    // Now after first run, mockClient.get has been called once (for run1 load). For run2 we already have second mock.
    // However our mockClient.get was set with two resolves, second will be used now.
    // But we cleared mocks earlier? We cleared _setEx but not get. So second run's orchestrator.load will use the second resolve.

    await orchestrator.run({ prompt: 'second', sessionId: 'sess-1' });
    expect(mockIsolatedClient._setEx).toHaveBeenCalledTimes(1);
    const [, , data2] = mockIsolatedClient._setEx.mock.calls[0]!;
    const save2 = JSON.parse(data2 as string);
    expect(save2).toHaveLength(4);
    expect(save2[0]?.content).toBe('first');
    expect(save2[1]?.content).toBe('resp1');
    expect(save2[2]?.content).toBe('second');
    expect(save2[3]?.content).toBe('resp2');
  });

  describe('custom keyPrefix', () => {
    it('should use custom keyPrefix in integration with Orchestrator', async () => {
      mockClient.get.mockResolvedValue(null);
      mockIsolatedClient.get.mockResolvedValue(null);
      const provider = createMockProvider();
      provider.enqueue({ text: 'Hello!' });
      const memory = new RedisMemoryAdapter({ client: mockClient as never, keyPrefix: 'myapp:' });
      const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });
      await orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' });
      expect(mockClient.get).toHaveBeenCalledWith('myapp:session-1');
      expect(mockIsolatedClient.watch).toHaveBeenCalledWith('myapp:session-1');
    });

    it('should use custom keyPrefix in URL mode with Orchestrator', async () => {
      mockClient.get.mockResolvedValue(null);
      mockIsolatedClient.get.mockResolvedValue(null);
      mockClient.connect.mockResolvedValue(undefined);
      // URL mode with custom prefix: need to handle pool as well
      mockClient.isOpen = true;
      const provider = createMockProvider();
      provider.enqueue({ text: 'Hello!' });
      const memory = new RedisMemoryAdapter({ url: 'redis://localhost:6379', keyPrefix: 'appns:' });
      const orchestrator = new Orchestrator({ provider, memoryAdapter: memory });
      await orchestrator.run({ prompt: 'Hi', sessionId: 'session-1' });
      expect(mockClient.get).toHaveBeenCalledWith('appns:session-1');
      expect(mockIsolatedClient.watch).toHaveBeenCalledWith('appns:session-1');
    });
  });
});

