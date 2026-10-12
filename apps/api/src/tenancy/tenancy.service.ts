import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AuthUser, hasRole, Role } from '../auth/auth.types';
import { hashPassword } from '../auth/password';
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

  /** Suspend or reactivate a tenant below the caller. Suspended tenants cannot log in. */
  async setStatus(user: AuthUser, id: string, status: 'active' | 'suspended'): Promise<Tenant> {
    if (!hasRole(user, 'admin')) throw forbidden('Only admins can change agency status');
    const t = await this.get(id);
    if (!this.inScope(user, t.path)) throw notFound('Tenant');
    if (t.id === user.tenantId) throw conflict('INVALID_TARGET', 'You cannot change the status of your own organisation');
    const updated = await this.db.one<Tenant>(`UPDATE tenancy.tenant SET status = $2 WHERE id = $1 RETURNING ${COLUMNS}`, [id, status]);
    await this.db.query(
      `INSERT INTO audit.audit_log (actor_id, tenant_id, action, entity, entity_id, data) VALUES ($1,$2,$3,'tenant',$4,'{}')`,
      [user.id, user.tenantId, `tenant.${status}`, id],
    );
    return updated!;
  }

  async listUsers(user: AuthUser, tenantId: string) {
    if (!hasRole(user, 'admin')) throw forbidden('Only admins can view users');
    const t = await this.get(tenantId);
    if (!this.inScope(user, t.path)) throw notFound('Tenant');
    const { rows } = await this.db.query(
      `SELECT id, email, name, roles, status, created_at AS "createdAt" FROM tenancy.app_user WHERE tenant_id = $1 ORDER BY name`,
      [tenantId],
    );
    return rows;
  }

  /**
   * Creates a user with a one-time password returned once in the response.
   * Admins can grant only roles they hold themselves; finance and ops exist only at the operator.
   */
  async createUser(user: AuthUser, tenantId: string, input: { email: string; name: string; roles: Role[] }) {
    if (!hasRole(user, 'admin')) throw forbidden('Only admins can create users');
    const t = await this.get(tenantId);
    if (!this.inScope(user, t.path)) throw notFound('Tenant');
    const notHeld = input.roles.filter((r) => r !== 'agent' && !user.roles.includes(r));
    if (notHeld.length) throw forbidden(`You cannot grant roles you do not hold: ${notHeld.join(', ')}`);
    if (t.type !== 'operator' && input.roles.some((r) => r === 'finance' || r === 'ops')) {
      throw conflict('INVALID_ROLE', 'Finance and ops roles exist only at the operator');
    }
    const temporaryPassword = randomBytes(9).toString('base64url');
    try {
      const created = await this.db.one(
        `INSERT INTO tenancy.app_user (tenant_id, email, name, password_hash, roles) VALUES ($1, lower($2), $3, $4, $5)
         RETURNING id, email, name, roles, status`,
        [tenantId, input.email, input.name, await hashPassword(temporaryPassword), input.roles],
      );
      await this.db.query(
        `INSERT INTO audit.audit_log (actor_id, tenant_id, action, entity, entity_id, data) VALUES ($1,$2,'user.created','user',$3,$4)`,
        [user.id, user.tenantId, created.id, JSON.stringify({ email: input.email, roles: input.roles, tenantId })],
      );
      return { ...created, temporaryPassword };
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw conflict('EMAIL_TAKEN', 'A user with this email already exists');
      throw err;
    }
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
