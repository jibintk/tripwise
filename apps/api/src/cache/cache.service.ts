import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, AppConfig } from '../config';

/**
 * JSON cache backed by Redis when REDIS_URL is set, otherwise by process memory
 * (fine for local development and tests; production always runs Redis).
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis?: Redis;
  private readonly memory = new Map<string, { value: string; expiresAt: number }>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    if (config.REDIS_URL) {
      this.redis = new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
      this.redis.on('error', (err) => this.logger.warn(`Redis error: ${err.message}`));
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    const raw = this.redis ? await this.redis.get(key) : this.memoryGet(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    const raw = JSON.stringify(value);
    if (this.redis) {
      await this.redis.set(key, raw, 'EX', ttlSeconds);
    } else {
      this.memory.set(key, { value: raw, expiresAt: Date.now() + ttlSeconds * 1000 });
    }
  }

  private memoryGet(key: string): string | undefined {
    const hit = this.memory.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt < Date.now()) {
      this.memory.delete(key);
      return undefined;
    }
    return hit.value;
  }

  async onModuleDestroy() {
    await this.redis?.quit().catch(() => undefined);
  }
}
