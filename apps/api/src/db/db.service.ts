import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResultRow, types } from 'pg';
import { APP_CONFIG, AppConfig } from '../config';

// Return bigint columns (money in minor units, counts) as numbers. All amounts are far below
// Number.MAX_SAFE_INTEGER (about 90 trillion USD in cents).
types.setTypeParser(types.builtins.INT8, (v) => Number.parseInt(v, 10));

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Queryable {
  query<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool: Pool;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool({ connectionString: config.DATABASE_URL, max: 20 });
  }

  query<R extends QueryResultRow = any>(text: string, values?: unknown[]) {
    return this.pool.query<R>(text, values);
  }

  async one<R extends QueryResultRow = any>(text: string, values?: unknown[]): Promise<R | undefined> {
    const { rows } = await this.pool.query<R>(text, values);
    return rows[0];
  }

  /** Runs fn in a transaction; rolls back on any thrown error. */
  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
