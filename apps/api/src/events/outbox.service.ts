import { Injectable, Logger } from '@nestjs/common';
import { Queryable } from '../db/db.service';
import { DbService } from '../db/db.service';

export interface DomainEvent<T = Record<string, unknown>> {
  id: number;
  type: string;
  aggregate: string;
  aggregateId: string;
  tenantId: string | null;
  payload: T;
  createdAt: Date;
}

export type EventHandler = (event: DomainEvent) => Promise<void>;

/**
 * Transactional outbox plus an in-process dispatcher.
 * Modules call `add` inside their own transaction; `dispatch` delivers committed events to
 * subscribers at least once. Handlers must therefore be idempotent.
 * Swapping the in-process bus for Kafka (ADR-07) changes only `dispatch`.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly handlers = new Map<string, EventHandler[]>();

  constructor(private readonly db: DbService) {}

  add(q: Queryable, type: string, aggregate: string, aggregateId: string, tenantId: string | null, payload: object) {
    return q.query(
      `INSERT INTO platform.outbox_event (type, aggregate, aggregate_id, tenant_id, payload) VALUES ($1,$2,$3,$4,$5)`,
      [type, aggregate, aggregateId, tenantId, JSON.stringify(payload)],
    );
  }

  /** Subscribe to one event type, or '*' for all. */
  on(type: string, handler: EventHandler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }

  /**
   * Delivers up to `batch` unpublished events in order. Rows are claimed with SKIP LOCKED,
   * so several API instances can run the dispatcher without delivering an event twice at once.
   * A failing handler leaves the event unpublished for the next run (up to 10 attempts).
   */
  async dispatch(batch = 100): Promise<number> {
    return this.db.tx(async (client) => {
      const { rows } = await client.query(
        `SELECT id, type, aggregate, aggregate_id AS "aggregateId", tenant_id AS "tenantId", payload, created_at AS "createdAt"
           FROM platform.outbox_event
          WHERE published_at IS NULL AND attempts < 10
          ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batch],
      );
      let delivered = 0;
      for (const event of rows as DomainEvent[]) {
        const handlers = [...(this.handlers.get(event.type) ?? []), ...(this.handlers.get('*') ?? [])];
        try {
          for (const h of handlers) await h(event);
          await client.query(`UPDATE platform.outbox_event SET published_at = now(), attempts = attempts + 1 WHERE id = $1`, [
            event.id,
          ]);
          delivered++;
        } catch (err) {
          this.logger.warn(`Event ${event.id} (${event.type}) failed: ${(err as Error).message}`);
          await client.query(`UPDATE platform.outbox_event SET attempts = attempts + 1, last_error = $2 WHERE id = $1`, [
            event.id,
            (err as Error).message.slice(0, 500),
          ]);
        }
      }
      return delivered;
    });
  }
}
