import { Injectable } from '@nestjs/common';
import { AuthUser, hasRole } from '../auth/auth.types';
import { badRequest, forbidden, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { Cabin, evaluateFlight, evaluateHotel, PolicyRules, PolicyVerdict } from './policy-engine';

export type ApprovalMode = 'always' | 'out_of_policy' | 'never';

export interface TravelPolicy {
  id: string;
  grade: string;
  rules: PolicyRules;
  approvalMode: ApprovalMode;
}

/** Everything about a corporate traveller that decides how their trip is checked and approved. */
export interface TravellerContext {
  corporateId: string;
  grade: string;
  costCentre: string | null;
  approverId: string | null;
  policy: TravelPolicy;
}

const DEFAULT_GRADE = 'default';
/** A corporate with no policy for a grade gets this: no rules, no approval. */
const NO_POLICY: Omit<TravelPolicy, 'grade'> = { id: '', rules: {}, approvalMode: 'never' };

@Injectable()
export class CorporateService {
  constructor(private readonly db: DbService) {}

  isCorporate(user: AuthUser) {
    return user.tenantType === 'corporate';
  }

  async travellerContext(user: AuthUser): Promise<TravellerContext | null> {
    if (!this.isCorporate(user)) return null;
    const emp = await this.db.one<{ grade: string; cost_centre: string | null; approver_user_id: string | null }>(
      `SELECT grade, cost_centre, approver_user_id FROM policy.employee WHERE user_id = $1`,
      [user.id],
    );
    const grade = emp?.grade ?? DEFAULT_GRADE;
    const p = await this.db.one<{ id: string; rules: PolicyRules; approval_mode: ApprovalMode }>(
      `SELECT id, rules, approval_mode FROM policy.travel_policy WHERE corporate_id = $1 AND grade IN ($2, $3)
       ORDER BY (grade = $2) DESC LIMIT 1`,
      [user.tenantId, grade, DEFAULT_GRADE],
    );
    return {
      corporateId: user.tenantId,
      grade,
      costCentre: emp?.cost_centre ?? null,
      approverId: emp?.approver_user_id ?? null,
      policy: p ? { id: p.id, grade, rules: p.rules, approvalMode: p.approval_mode } : { ...NO_POLICY, grade },
    };
  }

  flightVerdict(
    ctx: TravellerContext,
    trip: { cabin: Cabin; sellAmount: number; currency: string; travellers: number; departureDate: string; refundable: boolean },
  ): PolicyVerdict {
    return evaluateFlight(trip, ctx.policy.rules.flight);
  }

  hotelVerdict(ctx: TravellerContext, stay: { stars: number; sellAmount: number; currency: string; nights: number; rooms: number }) {
    return evaluateHotel(stay, ctx.policy.rules.hotel);
  }

  // ---------- travel manager: policies ----------

  async listPolicies(user: AuthUser): Promise<TravelPolicy[]> {
    this.requireManager(user);
    const { rows } = await this.db.query(
      `SELECT id, grade, rules, approval_mode AS "approvalMode" FROM policy.travel_policy WHERE corporate_id = $1 ORDER BY grade`,
      [user.tenantId],
    );
    return rows;
  }

  async upsertPolicy(user: AuthUser, input: { grade: string; rules: PolicyRules; approvalMode: ApprovalMode }) {
    this.requireManager(user);
    const row = await this.db.one(
      `INSERT INTO policy.travel_policy (corporate_id, grade, rules, approval_mode) VALUES ($1, $2, $3, $4)
       ON CONFLICT (corporate_id, grade) DO UPDATE SET rules = EXCLUDED.rules, approval_mode = EXCLUDED.approval_mode, updated_at = now()
       RETURNING id, grade, rules, approval_mode AS "approvalMode"`,
      [user.tenantId, input.grade, JSON.stringify(input.rules), input.approvalMode],
    );
    await this.audit(user, 'policy.updated', input.grade, input);
    return row;
  }

  // ---------- travel manager: employees ----------

  async listEmployees(user: AuthUser) {
    this.requireManager(user);
    const { rows } = await this.db.query(
      `SELECT u.id, u.name, u.email, u.roles, e.grade, e.cost_centre AS "costCentre", e.approver_user_id AS "approverId",
              a.name AS "approverName"
         FROM tenancy.app_user u
         LEFT JOIN policy.employee e ON e.user_id = u.id
         LEFT JOIN tenancy.app_user a ON a.id = e.approver_user_id
        WHERE u.tenant_id = $1 ORDER BY u.name`,
      [user.tenantId],
    );
    return rows;
  }

  async setEmployee(user: AuthUser, userId: string, input: { grade: string; costCentre?: string | null; approverId?: string | null }) {
    this.requireManager(user);
    const target = await this.db.one(`SELECT id FROM tenancy.app_user WHERE id = $1 AND tenant_id = $2`, [userId, user.tenantId]);
    if (!target) throw notFound('Employee');
    if (input.approverId) {
      if (input.approverId === userId) throw badRequest('An employee cannot approve their own trips');
      const approver = await this.db.one<{ roles: string[] }>(`SELECT roles FROM tenancy.app_user WHERE id = $1 AND tenant_id = $2`, [
        input.approverId,
        user.tenantId,
      ]);
      if (!approver) throw notFound('Approver');
      if (!approver.roles.includes('approver') && !approver.roles.includes('admin')) {
        throw badRequest('The chosen approver does not have the approver role');
      }
    }
    await this.db.query(
      `INSERT INTO policy.employee (user_id, corporate_id, grade, cost_centre, approver_user_id) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET grade = EXCLUDED.grade, cost_centre = EXCLUDED.cost_centre,
         approver_user_id = EXCLUDED.approver_user_id, updated_at = now()`,
      [userId, user.tenantId, input.grade, input.costCentre ?? null, input.approverId ?? null],
    );
    await this.audit(user, 'employee.updated', userId, input);
    return (await this.listEmployees(user)).find((e: { id: string }) => e.id === userId);
  }

  // ---------- travel manager: reporting ----------

  /** Spend by traveller for a period: trips, money, how much was out of policy and the savings missed. */
  async spendReport(user: AuthUser, from: string, to: string) {
    this.requireManager(user);
    const { rows } = await this.db.query(
      `SELECT u.id AS "travellerId", u.name AS traveller, e.cost_centre AS "costCentre",
              count(*)::int AS trips,
              COALESCE(SUM(b.agent_cost_amount), 0)::bigint AS spend,
              count(*) FILTER (WHERE (b.policy->>'inPolicy')::boolean IS FALSE)::int AS "outOfPolicyTrips",
              COALESCE(SUM((b.policy->>'missedSaving')::bigint), 0)::bigint AS "missedSavings",
              max(b.currency) AS currency
         FROM booking.booking b
         JOIN tenancy.app_user u ON u.id = b.created_by
         LEFT JOIN policy.employee e ON e.user_id = u.id
        WHERE b.tenant_id = $1 AND b.status = 'confirmed' AND b.created_at >= $2::date AND b.created_at < ($3::date + 1)
        GROUP BY u.id, u.name, e.cost_centre ORDER BY spend DESC`,
      [user.tenantId, from, to],
    );
    const totals = rows.reduce(
      (t, r) => ({
        trips: t.trips + r.trips,
        spend: t.spend + Number(r.spend),
        outOfPolicyTrips: t.outOfPolicyTrips + r.outOfPolicyTrips,
        missedSavings: t.missedSavings + Number(r.missedSavings),
      }),
      { trips: 0, spend: 0, outOfPolicyTrips: 0, missedSavings: 0 },
    );
    return { from, to, currency: user.currency, totals, travellers: rows };
  }

  private requireManager(user: AuthUser) {
    if (!this.isCorporate(user) || !hasRole(user, 'admin')) throw forbidden('Travel manager access required');
  }

  private audit(user: AuthUser, action: string, entityId: string, data: unknown) {
    return this.db.query(
      `INSERT INTO audit.audit_log (actor_id, tenant_id, action, entity, entity_id, data) VALUES ($1,$2,$3,'policy',$4,$5)`,
      [user.id, user.tenantId, action, entityId, JSON.stringify(data)],
    );
  }
}
