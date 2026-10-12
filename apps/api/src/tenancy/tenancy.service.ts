import { Injectable } from '@nestjs/common';
import { AuthUser, hasRole } from '../auth/auth.types';
import { conflict, forbidden, notFound } from '../common/errors';
import { DbService } from '../db/db.service';

export interface Tenant {
  id: string;
  type: string;
  parentId: string | null;
  code: string;
  path: string;
  name: string;
  country: string;
  currency: string;
  status: string;
}

const COLUMNS = `id, type, parent_id AS "parentId", code, path::text AS path, name, country, currency, status`;

/** Which child types each tenant type may create. */
const ALLOWED_CHILDREN: Record<string, string[]> = {
  operator: ['gsa', 'agency', 'corporate'],
  gsa: ['agency'],
  agency: ['sub_agency', 'branch'],
  sub_agency: ['sub_agency', 'branch'],
  branch: [],
  corporate: [],
};

@Injectable()
export class TenancyService {
  constructor(private readonly db: DbService) {}

  async get(id: string): Promise<Tenant> {
    const t = await this.db.one<Tenant>(`SELECT ${COLUMNS} FROM tenancy.tenant WHERE id = $1`, [id]);
    if (!t) throw notFound('Tenant');
    return t;
  }

  /** Root-first chain from the operator down to the given tenant: the order pricing rules apply in. */
  async ancestors(tenantPath: string): Promise<Tenant[]> {
    const { rows } = await this.db.query<Tenant>(
      `SELECT ${COLUMNS} FROM tenancy.tenant WHERE path @> $1::ltree ORDER BY nlevel(path)`,
      [tenantPath],
    );
    return rows;
  }

  /** The caller's own tenant and everything below it. */
  async subtree(user: AuthUser): Promise<Tenant[]> {
    const { rows } = await this.db.query<Tenant>(
      `SELECT ${COLUMNS} FROM tenancy.tenant WHERE path <@ $1::ltree ORDER BY path`,
      [user.tenantPath],
    );
    return rows;
  }

  /** True if `tenantPath` is the caller's tenant or below it. */
  inScope(user: AuthUser, tenantPath: string): boolean {
    return tenantPath === user.tenantPath || tenantPath.startsWith(`${user.tenantPath}.`);
  }

  async createChild(
    user: AuthUser,
    input: { parentId?: string; type: string; code: string; name: string; country: string },
  ): Promise<Tenant> {
    if (!hasRole(user, 'admin')) throw forbidden('Only admins can create agencies');
    const parent = await this.get(input.parentId ?? user.tenantId);
    if (!this.inScope(user, parent.path)) throw notFound('Tenant');
    if (!ALLOWED_CHILDREN[parent.type]?.includes(input.type)) {
      throw conflict('INVALID_HIERARCHY', `A ${parent.type} cannot have a ${input.type} under it`);
    }
    return this.db.tx(async (client) => {
      const exists = await client.query('SELECT 1 FROM tenancy.tenant WHERE code = $1', [input.code]);
      if (exists.rowCount) throw conflict('CODE_TAKEN', `Tenant code ${input.code} is already used`);
      const { rows } = await client.query<Tenant>(
        `INSERT INTO tenancy.tenant (type, parent_id, code, path, name, country, currency)
         VALUES ($1, $2, $3, $4::ltree, $5, $6, $7) RETURNING ${COLUMNS}`,
        [input.type, parent.id, input.code, `${parent.path}.${input.code}`, input.name, input.country, parent.currency],
      );
      const tenant = rows[0];
      await client.query(`INSERT INTO payments.account (tenant_id, type, currency) VALUES ($1, 'wallet', $2)`, [
        tenant.id,
        tenant.currency,
      ]);
      await client.query(
        `INSERT INTO audit.audit_log (actor_id, tenant_id, action, entity, entity_id, data)
         VALUES ($1, $2, 'tenant.created', 'tenant', $3, $4)`,
        [user.id, user.tenantId, tenant.id, JSON.stringify(input)],
      );
      return tenant;
    });
  }
}
