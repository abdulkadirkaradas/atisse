import { createClient, type RedisClientType } from 'redis';
import type { MemoryAdapter, Message } from '@atisse/core';
import { ContextLoadError } from '@atisse/core';

const DEFAULT_TTL_SECONDS = 3600;
const KEY_PREFIX = 'atisse:session:';

export class RedisMemoryAdapter implements MemoryAdapter {
  readonly id = 'redis-memory';
  private readonly client: RedisClientType;
  private readonly ttlSeconds: number;
  private readonly ownsConnection: boolean;

  constructor(config: { client: RedisClientType } | { url: string; ttlSeconds?: number }) {
    if ('client' in config) {
      this.client = config.client;
      this.ownsConnection = false;
      this.ttlSeconds = DEFAULT_TTL_SECONDS;
    } else {
      this.client = createClient({ url: config.url });
      this.ownsConnection = true;
      this.ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    }
  }

  async load(sessionId: string): Promise<Message[]> {
    await this.ensureConnected();
    try {
      const raw = await this.client.get(`${KEY_PREFIX}${sessionId}`);
      if (raw === null) return [];
      return JSON.parse(raw) as Message[];
    } catch (error: unknown) {
      if (error instanceof ContextLoadError) throw error;
      throw new ContextLoadError(this.id, error);
    }
  }

  async save(sessionId: string, messages: Message[]): Promise<void> {
    await this.ensureConnected();
    try {
      const existing = await this.load(sessionId);
      const key = `${KEY_PREFIX}${sessionId}`;
      await this.client.setEx(key, this.ttlSeconds, JSON.stringify([...existing, ...messages]));
    } catch (error: unknown) {
      if (error instanceof ContextLoadError) throw error;
      throw new ContextLoadError(this.id, error);
    }
  }

  async clear(sessionId: string): Promise<void> {
    await this.ensureConnected();
    try {
      await this.client.del(`${KEY_PREFIX}${sessionId}`);
    } catch (error: unknown) {
      if (error instanceof ContextLoadError) throw error;
      throw new ContextLoadError(this.id, error);
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
