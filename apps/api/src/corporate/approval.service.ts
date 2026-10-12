import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { AuthUser, hasRole } from '../auth/auth.types';
import { BookingService } from '../bookings/booking.service';
import { AppError, conflict, forbidden, notFound } from '../common/errors';
import { DbService } from '../db/db.service';

interface ApprovalRow {
  id: string;
  booking_id: string;
  booking_reference: string;
  corporate_id: string;
  traveller_id: string;
  approver_id: string;
  status: string;
  token_hash: string;
  token_expires_at: Date;
  comment: string | null;
  decided_at: Date | null;
  created_at: Date;
}

export type Decision = 'approve' | 'reject';

/**
 * Approver decisions, from the portal (signed in) or from the one-click email link (token).
 * The request row is locked and moved out of `pending` before the booking is touched, so two
 * clicks, or a click plus a portal decision, can never both act.
 */
@Injectable()
export class ApprovalService {
  constructor(
    private readonly db: DbService,
    private readonly bookings: BookingService,
  ) {}

  async listPending(user: AuthUser) {
    if (!hasRole(user, 'approver', 'admin')) throw forbidden('Approver access required');
    const { rows } = await this.db.query(
      `SELECT r.id, r.booking_reference AS reference, r.created_at AS "requestedAt", t.name AS traveller,
              b.product, b.policy, b.agent_cost_amount AS amount, b.currency, b.offer_snapshot AS snapshot
         FROM policy.approval_request r
         JOIN tenancy.app_user t ON t.id = r.traveller_id
         JOIN booking.booking b ON b.id = r.booking_id
        WHERE r.approver_id = $1 AND r.status = 'pending' ORDER BY r.created_at`,
      [user.id],
    );
    return rows.map(({ snapshot, ...r }) => ({ ...r, trip: summarise(r.product, snapshot) }));
  }

  /** What the email-link page shows before the approver decides. */
  async describeByToken(id: string, token: string) {
    const req = await this.verifyToken(id, token);
    const row = await this.db.one(
      `SELECT t.name AS traveller, b.product, b.policy, b.agent_cost_amount AS amount, b.currency, b.offer_snapshot AS snapshot,
              b.status AS "bookingStatus"
         FROM booking.booking b JOIN tenancy.app_user t ON t.id = $2 WHERE b.id = $1`,
      [req.booking_id, req.traveller_id],
    );
    const { snapshot, ...rest } = row;
    return { id: req.id, reference: req.booking_reference, status: req.status, ...rest, trip: summarise(row.product, snapshot) };
  }

  async decide(user: AuthUser, id: string, decision: Decision, comment: string | undefined, traceId: string) {
    const req = await this.claim(id, decision, comment, 'portal', (r) => {
      if (r.approver_id !== user.id) throw forbidden('Only the assigned approver can decide this trip');
    });
    return this.apply(req, decision, comment, traceId);
  }

  async decideByToken(id: string, token: string, decision: Decision, comment: string | undefined, traceId: string) {
    await this.verifyToken(id, token);
    const req = await this.claim(id, decision, comment, 'email');
    return this.apply(req, decision, comment, traceId);
  }

  private async apply(req: ApprovalRow, decision: Decision, comment: string | undefined, traceId: string) {
    const booking =
      decision === 'approve'
        ? await this.bookings.resumeAfterApproval(req.booking_reference, req.approver_id, traceId)
        : await this.bookings.rejectAfterApproval(req.booking_reference, req.approver_id, comment, traceId);
    return { id: req.id, decision, reference: booking.reference, bookingStatus: booking.status, failureReason: booking.failure_reason };
  }

  /** Atomically moves a pending request to its decision; refuses if someone already decided. */
  private async claim(id: string, decision: Decision, comment: string | undefined, via: 'portal' | 'email', check?: (r: ApprovalRow) => void) {
    return this.db.tx(async (client) => {
      const { rows } = await client.query<ApprovalRow>(`SELECT * FROM policy.approval_request WHERE id = $1 FOR UPDATE`, [id]);
      const r = rows[0];
      if (!r) throw notFound('Approval request');
      check?.(r);
      if (r.status !== 'pending') throw conflict('ALREADY_DECIDED', `This trip was already ${r.status}`);
      const { rows: updated } = await client.query<ApprovalRow>(
        `UPDATE policy.approval_request SET status = $2, comment = $3, decided_at = now(), decided_via = $4 WHERE id = $1 RETURNING *`,
        [id, decision === 'approve' ? 'approved' : 'rejected', comment ?? null, via],
      );
      await client.query(
        `INSERT INTO audit.audit_log (actor_id, tenant_id, action, entity, entity_id, data) VALUES ($1, $2, $3, 'approval', $4, $5)`,
        [r.approver_id, r.corporate_id, `approval.${decision}`, id, JSON.stringify({ via, comment, booking: r.booking_reference })],
      );
      return updated[0];
    });
  }

  private async verifyToken(id: string, token: string): Promise<ApprovalRow> {
    const r = await this.db.one<ApprovalRow>(`SELECT * FROM policy.approval_request WHERE id = $1`, [id]);
    const expected = r ? Buffer.from(r.token_hash, 'hex') : Buffer.alloc(32);
    const actual = createHash('sha256').update(token ?? '').digest();
    const ok = r && expected.length === actual.length && timingSafeEqual(expected, actual);
    if (!ok) throw new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', 'This approval link is not valid');
    if (r.token_expires_at.getTime() < Date.now() && r.status === 'pending') {
      throw new AppError(HttpStatus.GONE, 'LINK_EXPIRED', 'This approval link has expired. Decide from the portal instead.');
    }
    return r;
  }
}

function summarise(product: string, s: any): string {
  if (product === 'insurance') return `${s.plan.name}, ${s.request.startDate} to ${s.request.endDate}`;
  if (product === 'hotel') return `${s.hotel.name}, ${s.request.checkIn} to ${s.request.checkOut}`;
  const first = s.slices[0].segments[0];
  const last = s.slices[0].segments[s.slices[0].segments.length - 1];
  return `${first.origin} to ${last.destination}${s.slices.length > 1 ? ' and back' : ''}, ${first.departureLocal.slice(0, 10)} (${s.cabin ?? 'ECONOMY'})`;
}
