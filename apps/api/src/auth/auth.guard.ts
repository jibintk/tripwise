import { CanActivate, ExecutionContext, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AppError } from '../common/errors';
import { DbService } from '../db/db.service';
import { IS_PUBLIC } from './auth.decorators';
import { AuthUser, JwtPayload } from './auth.types';

const STATUS_CACHE_MS = 30_000;

@Injectable()
export class AuthGuard implements CanActivate {
  /** user id -> whether the user and every tenant above it are active, with expiry */
  private readonly activeCache = new Map<string, { active: boolean; until: number }>();

  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
    private readonly db: DbService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()])) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing bearer token');
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (!(await this.isActive(payload.sub, payload.tpath))) {
      throw new AppError(HttpStatus.UNAUTHORIZED, 'ACCOUNT_INACTIVE', 'This account or agency has been suspended');
    }
    const user: AuthUser = {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      tenantId: payload.tid,
      tenantPath: payload.tpath,
      tenantType: payload.ttype,
      currency: payload.cur,
      roles: payload.roles,
    };
    req.user = user;
    return true;
  }

  /** A suspension anywhere up the tree locks out everyone below it, within STATUS_CACHE_MS. */
  private async isActive(userId: string, tenantPath: string): Promise<boolean> {
    const hit = this.activeCache.get(userId);
    if (hit && hit.until > Date.now()) return hit.active;
    const row = await this.db.one<{ active: boolean }>(
      `SELECT (SELECT status = 'active' FROM tenancy.app_user WHERE id = $1)
              AND COALESCE((SELECT bool_and(status = 'active') FROM tenancy.tenant WHERE path @> $2::ltree), false) AS active`,
      [userId, tenantPath],
    );
    const active = !!row?.active;
    this.activeCache.set(userId, { active, until: Date.now() + STATUS_CACHE_MS });
    return active;
  }
}
