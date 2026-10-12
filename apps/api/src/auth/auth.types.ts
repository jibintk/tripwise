export type Role = 'admin' | 'agent' | 'finance' | 'ops';

/** The authenticated caller, resolved from the JWT on every request. */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  tenantId: string;
  /** ltree path of the caller's tenant, e.g. tripwise.kenya_gsa.safari_desk */
  tenantPath: string;
  tenantType: string;
  currency: string;
  roles: Role[];
}

export interface JwtPayload {
  sub: string;
  tid: string;
  tpath: string;
  ttype: string;
  cur: string;
  roles: Role[];
  email: string;
  name: string;
}

export const hasRole = (user: AuthUser, ...roles: Role[]) => roles.some((r) => user.roles.includes(r));
