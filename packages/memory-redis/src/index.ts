import { createClient, WatchError, type RedisClientType } from 'redis';
import type { MemoryAdapter, Message } from '@atisse/core';
import { ContextLoadError, MemorySaveError } from '@atisse/core';

const DEFAULT_TTL_SECONDS = 3600;
const DEFAULT_KEY_PREFIX = 'atisse:session:';
const MAX_TRANSACTION_RETRIES = 3;

export class RedisMemoryAdapter implements MemoryAdapter {
  readonly id = 'redis-memory';
  private readonly client: RedisClientType;
  private readonly ttlSeconds: number;
  private readonly ownsConnection: boolean;
  private readonly keyPrefix: string;

  constructor(
    config:
      | { client: RedisClientType; keyPrefix?: string }
      | { url: string; ttlSeconds?: number; keyPrefix?: string },
  ) {
    if ('client' in config) {
      this.client = config.client;
      this.ownsConnection = false;
      this.ttlSeconds = DEFAULT_TTL_SECONDS;
      this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
    } else {
      this.client = createClient({ url: config.url });
      this.ownsConnection = true;
      this.ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
      this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
    }
  }

  async load(sessionId: string): Promise<Message[]> {
    await this.ensureConnected();
    try {
      const raw = await this.client.get(`${this.keyPrefix}${sessionId}`);
      if (raw === null) return [];
      return JSON.parse(raw) as Message[];
    } catch (error: unknown) {
      if (error instanceof ContextLoadError) throw error;
      throw new ContextLoadError(this.id, error);
    }
  }

  async save(sessionId: string, messages: Message[]): Promise<void> {
    await this.ensureConnected();
    const key = `${this.keyPrefix}${sessionId}`;

    // Pool is created once per save() and reused across retries — creating it
    // inside the retry loop leaks connections (up to MAX_TRANSACTION_RETRIES
    // per call). Lifecycle is bound to this method via try/finally.
    const pool = this.client.createPool();
    try {
      await pool.connect();
    } catch (error: unknown) {
      // Connect failed — pool may hold a partially-initialized connection.
      // Attempt cleanup via close() then destroy(), ignore all errors.
      try {
        await pool.close();
      } catch {
        // ignore close error after connect failure
      }
      try {
        pool.destroy();
      } catch {
        // ignore destroy error
      }
      throw new MemorySaveError(error);
    }

    try {
      let attempt = 0;
      while (attempt < MAX_TRANSACTION_RETRIES) {
        try {
          // WATCH is connection-scoped state in node-redis v6. On a shared client,
          // concurrent save() calls could interleave their WATCH/MULTI/EXEC
          // sequences on the same underlying connection and corrupt the lock.
          // RedisClientPool.execute() gives this transaction a dedicated connection.
          const committed = await pool.execute(async (isolatedClient) => {
            // Optimistic lock: WATCH the key (on the pooled client)
            await isolatedClient.watch(key);

            // Read existing data inside watch
            const raw = await isolatedClient.get(key);
            const existing: Message[] = raw === null ? [] : (JSON.parse(raw) as Message[]);
            const merged = [...existing, ...messages];
            const value = JSON.stringify(merged);

            // Execute transaction: SET with TTL.
            // Pool-managed connection lifecycle: #returnClient -> resetIfDirty
            // resets WATCH state automatically. No manual unwatch() needed.
            try {
              await isolatedClient.multi().setEx(key, this.ttlSeconds, value).exec();
              return true;
            } catch (error: unknown) {
              if (error instanceof WatchError) return false;
              throw error;
            }
          });

          if (committed) return;

          // WATCH triggered - retry the transaction
          attempt++;
        } catch (error: unknown) {
          // Never call this.client.unwatch() - no WATCH is active on the shared connection.
          throw new MemorySaveError(error);
        }
      }

      // Max retries exceeded
      throw new MemorySaveError(new Error('Transaction failed after max retries'));
    } finally {
      try {
        await pool.close();
      } catch {
        // ignore errors during pool cleanup
      }
    }
  }

  async clear(sessionId: string): Promise<void> {
    await this.ensureConnected();
    try {
      await this.client.del(`${this.keyPrefix}${sessionId}`);
    } catch (error: unknown) {
      throw new MemorySaveError(error);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (!this.ownsConnection) return;
    if (this.client.isOpen) return;
    try {
      await this.client.connect();
    } catch (error: unknown) {
      throw new ContextLoadError(this.id, error);
    }
  }
}
