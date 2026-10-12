import { Inject, Injectable, Logger } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';
import { APP_CONFIG, AppConfig } from '../config';
import { DbService } from '../db/db.service';
import { DomainEvent, OutboxService } from '../events/outbox.service';
import * as T from './templates';

const TEMPLATES: Record<string, (b: T.BookingView) => T.Rendered> = {
  'booking.held': T.bookingHeld,
  'booking.confirmed': T.bookingConfirmed,
  'booking.failed': T.bookingFailed,
  'booking.expired': T.bookingExpired,
  'booking.cancelled': T.bookingCancelled,
  'booking.rejected': T.bookingRejected,
};

/**
 * Turns booking events into emails. Messages are queued in notify.notification (deduplicated per
 * event and template) and sent by the jobs runner, so a slow mail server never slows a booking.
 * Without SMTP_URL, messages are logged and marked sent: useful locally and in tests.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);
  private readonly transport?: Transporter;

  constructor(
    private readonly db: DbService,
    outbox: OutboxService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    if (config.SMTP_URL) this.transport = nodemailer.createTransport(config.SMTP_URL);
    for (const type of Object.keys(TEMPLATES)) outbox.on(type, (e) => this.queueForBooking(e));
  }

  async queueForBooking(event: DomainEvent) {
    const render = TEMPLATES[event.type];
    const b = await this.db.one(`SELECT * FROM booking.booking WHERE reference = $1`, [event.aggregateId]);
    if (!render || !b) return;
    // Corporate trips are paid on account (straight away, or on approval), so a "pay before" email would only confuse.
    if (event.type === 'booking.held' && b.channel === 'b2e') return;
    let route: string;
    let departure: string;
    if (b.product === 'hotel') {
      const s = b.offer_snapshot;
      route = `${s.hotel.name}, ${s.hotel.city}`;
      departure = `check-in ${s.request.checkIn}, check-out ${s.request.checkOut}`;
    } else {
      const first = b.offer_snapshot.slices[0].segments[0];
      const lastSeg = b.offer_snapshot.slices[0].segments.at(-1);
      route = `${first.origin} to ${lastSeg.destination}${b.offer_snapshot.slices.length > 1 ? ' and back' : ''}`;
      departure = first.departureLocal.replace('T', ' ').slice(0, 16);
    }
    const view: T.BookingView = {
      reference: b.reference,
      product: b.product,
      pnr: b.pnr,
      passengers: b.passengers,
      ticketNumbers: b.ticket_numbers,
      route,
      departure,
      sell: `${b.currency} ${(Number(b.sell_amount) / 100).toFixed(2)}`,
      holdExpiresAt: b.hold_expires_at ? new Date(b.hold_expires_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : null,
      failureReason: b.failure_reason,
    };
    const msg = render(view);
    await this.db.query(
      `INSERT INTO notify.notification (channel, recipient, template, subject, body_text, body_html, ref_type, ref_id, dedupe_key)
       VALUES ('email', $1, $2, $3, $4, $5, 'booking', $6, $7) ON CONFLICT (dedupe_key) DO NOTHING`,
      [b.contact.email, event.type, msg.subject, msg.text, msg.html, b.reference, `${event.type}:${event.id}`],
    );
  }

  /** Sends pending messages; failures retry up to 5 times, then stay `failed` for operations. */
  async sendPending(batch = 50): Promise<number> {
    return this.db.tx(async (client) => {
      const { rows } = await client.query(
        `SELECT * FROM notify.notification WHERE status = 'pending' ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
        [batch],
      );
      for (const n of rows) {
        try {
          if (this.transport) {
            await this.transport.sendMail({
              from: this.config.MAIL_FROM,
              to: n.recipient,
              subject: n.subject,
              text: n.body_text,
              html: n.body_html ?? undefined,
            });
          } else {
            this.logger.log(`[mail:log] to=${n.recipient} subject="${n.subject}"`);
          }
          await client.query(`UPDATE notify.notification SET status = 'sent', sent_at = now(), attempts = attempts + 1 WHERE id = $1`, [
            n.id,
          ]);
        } catch (err) {
          await client.query(
            `UPDATE notify.notification SET attempts = attempts + 1, last_error = $2,
                    status = CASE WHEN attempts + 1 >= 5 THEN 'failed' ELSE 'pending' END WHERE id = $1`,
            [n.id, (err as Error).message.slice(0, 500)],
          );
        }
      }
      return rows.length;
    });
  }
}
