import { Injectable } from '@nestjs/common';
import { Money } from '@tripwise/contracts';
import { AuthUser, hasRole } from '../auth/auth.types';
import { forbidden, notFound } from '../common/errors';
import { DbService } from '../db/db.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { PriceQuote, PricingContext, PricingRule, quote } from './pricing-engine';

const COLUMNS = `id, owner_tenant_id AS "ownerTenantId", name, product, channel, supplier, origin, destination, cabin,
  value_type AS "valueType", value, currency, priority, created_at AS "createdAt"`;

export interface NewRule {
  name: string;
  product?: string | null;
  channel?: string | null;
  supplier?: string | null;
  origin?: string | null;
  destination?: string | null;
  cabin?: string | null;
  valueType: 'percent' | 'fixed';
  value: number;
  currency?: string | null;
  priority?: number;
}

@Injectable()
export class PricingService {
  constructor(
    private readonly db: DbService,
    private readonly tenancy: TenancyService,
  ) {}

  /**
   * Loads the rules for a tenant chain once; reuse the returned pricer for every offer in a search
   * so a 300-offer result costs one query, not 300.
   */
  async pricerFor(tenantPath: string): Promise<(net: Money, ctx: PricingContext) => PriceQuote> {
    const chain = await this.tenancy.ancestors(tenantPath);
    const { rows } = await this.db.query<PricingRule>(
      `SELECT ${COLUMNS} FROM pricing.pricing_rule WHERE active AND owner_tenant_id = ANY($1::uuid[])`,
      [chain.map((t) => t.id)],
    );
    const byTenant = new Map<string, PricingRule[]>();
    for (const r of rows) byTenant.set(r.ownerTenantId, [...(byTenant.get(r.ownerTenantId) ?? []), r]);
    return (net, ctx) => quote(net, chain, byTenant, ctx);
  }

  async listOwn(user: AuthUser): Promise<PricingRule[]> {
    const { rows } = await this.db.query<PricingRule>(
      `SELECT ${COLUMNS} FROM pricing.pricing_rule WHERE active AND owner_tenant_id = $1 ORDER BY created_at`,
      [user.tenantId],
    );
    return rows;
  }

  /** A tenant only ever sets its own markup; it cannot change what its parents charge. */
  async create(user: AuthUser, input: NewRule): Promise<PricingRule> {
    if (!hasRole(user, 'admin')) throw forbidden('Only admins can change pricing');
    const rule = await this.db.one<PricingRule>(
      `INSERT INTO pricing.pricing_rule
         (owner_tenant_id, name, product, channel, supplier, origin, destination, cabin, value_type, value, currency, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${COLUMNS}`,
      [
        user.tenantId,
        input.name,
        input.product ?? null,
        input.channel ?? null,
        input.supplier ?? null,
        input.origin ?? null,
        input.destination ?? null,
        input.cabin ?? null,
        input.valueType,
        input.value,
        input.valueType === 'fixed' ? (input.currency ?? user.currency) : null,
        input.priority ?? 0,
      ],
    );
    await this.audit(user, 'pricing_rule.created', rule!.id, input);
    return rule!;
  }

  async deactivate(user: AuthUser, id: string): Promise<void> {
    if (!hasRole(user, 'admin')) throw forbidden('Only admins can change pricing');
    const res = await this.db.query(
      `UPDATE pricing.pricing_rule SET active = false WHERE id = $1 AND owner_tenant_id = $2 AND active`,
      [id, user.tenantId],
    );
    if (!res.rowCount) throw notFound('Pricing rule');
    await this.audit(user, 'pricing_rule.deactivated', id, {});
  }

  private audit(user: AuthUser, action: string, id: string, data: unknown) {
    return this.db.query(
      `INSERT INTO audit.audit_log (actor_id, tenant_id, action, entity, entity_id, data) VALUES ($1,$2,$3,'pricing_rule',$4,$5)`,
      [user.id, user.tenantId, action, id, JSON.stringify(data)],
    );
  }
}
