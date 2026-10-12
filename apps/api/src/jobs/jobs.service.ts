import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { BookingService } from '../bookings/booking.service';
import { APP_CONFIG, AppConfig } from '../config';
import { OutboxService } from '../events/outbox.service';
import { NotificationService } from '../notify/notification.service';

export interface JobRunResult {
  eventsDelivered: number;
  notificationsProcessed: number;
  holdsExpired: string[];
  ticketingRecovered: string[];
}

/**
 * Runs the background work on a fixed interval inside the API process. Each job claims its rows
 * with SKIP LOCKED, so running several API replicas is safe. Move to a dedicated worker
 * deployment when load requires it; the job methods stay the same.
 */
@Injectable()
export class JobsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(JobsService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly outbox: OutboxService,
    private readonly notifications: NotificationService,
    private readonly bookings: BookingService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap() {
    if (!this.config.JOBS_ENABLED) return;
    this.timer = setInterval(() => void this.tick(), this.config.JOBS_INTERVAL_MS);
    this.timer.unref();
    this.logger.log(`Background jobs every ${this.config.JOBS_INTERVAL_MS} ms`);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.runAll();
      if (r.eventsDelivered || r.holdsExpired.length || r.ticketingRecovered.length) this.logger.log(JSON.stringify(r));
    } catch (err) {
      this.logger.error(`Job run failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One full pass of every job, in dependency order. Also used by tests and the ops endpoint. */
  async runAll(): Promise<JobRunResult> {
    const holdsExpired = await this.bookings.expireHolds();
    const ticketingRecovered = await this.bookings.recoverStuckTicketing(this.config.STUCK_TICKETING_SECONDS);
    let eventsDelivered = 0;
    for (let n = await this.outbox.dispatch(); n > 0; n = await this.outbox.dispatch()) eventsDelivered += n;
    const notificationsProcessed = await this.notifications.sendPending();
    return { eventsDelivered, notificationsProcessed, holdsExpired, ticketingRecovered };
  }
}
