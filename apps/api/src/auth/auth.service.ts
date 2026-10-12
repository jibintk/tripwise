import { HttpStatus, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppError } from '../common/errors';
import { DbService } from '../db/db.service';
import { JwtPayload, Role } from './auth.types';
import { verifyPassword } from './password';

/**
 * Local email/password login issuing a short-lived JWT.
 * In production this is replaced by Keycloak (ADR-08); the JWT claims stay the same shape,
 * so the guard and every module keep working unchanged.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly db: DbService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string) {
    const user = await this.db.one<{
      id: string;
      email: string;
      name: string;
      password_hash: string;
      roles: Role[];
      user_status: string;
      tenant_id: string;
      path: string;
      type: string;
      currency: string;
      tenant_status: string;
      tenant_name: string;
    }>(
      `SELECT u.id, u.email, u.name, u.password_hash, u.roles, u.status AS user_status,
              t.id AS tenant_id, t.path::text AS path, t.type, t.currency, t.status AS tenant_status, t.name AS tenant_name
         FROM tenancy.app_user u JOIN tenancy.tenant t ON t.id = u.tenant_id
        WHERE lower(u.email) = lower($1)`,
      [email],
    );
    const ok = user && (await verifyPassword(password, user.password_hash));
    if (!user || !ok) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }
    if (user.user_status !== 'active' || user.tenant_status !== 'active') {
      throw new AppError(HttpStatus.FORBIDDEN, 'ACCOUNT_INACTIVE', 'This account is not active');
    }
    const payload: JwtPayload = {
      sub: user.id,
      tid: user.tenant_id,
      tpath: user.path,
      ttype: user.type,
      cur: user.currency,
      roles: user.roles,
      email: user.email,
      name: user.name,
    };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
        tenant: { id: user.tenant_id, name: user.tenant_name, type: user.type, currency: user.currency },
      },
    };
  }
}
