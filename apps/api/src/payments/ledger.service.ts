import { HttpStatus, Injectable } from '@nestjs/common';
import { Money } from '@tripwise/contracts';
import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { AuthUser, hasRole } from '../auth/auth.types';
import { AppError, forbidden, notFound } from '../common/errors';
import { DbService, Queryable } from '../db/db.service';
import { TenancyService } from '../tenancy/tenancy.service';

export interface AccountSummary {
  accountId: string;
  tenantId: string;
  currency: string;
  balance: number;
  creditLimit: number;
  /** balance + credit limit: what the tenant can spend right now */
  available: number;
}

/**
 * Double-entry ledger. Every movement is one transaction id whose entries sum to zero, and
 * balances are always derived from entries, never stored. Entries are append-only.
 */
@Injectable()
export class LedgerService {
  constructor(
    private readonly db: DbService,
    private readonly tenancy: TenancyService,
  ) {}

  async summary(tenantId: string, currency: string, q: Queryable = this.db): Promise<AccountSummary> {
    const { rows } = await q.query(
      `SELECT a.id, a.tenant_id, a.currency, a.credit_limit,
              COALESCE((SELECT SUM(amount) FROM payments.ledger_entry e WHERE e.account_id = a.id), 0)::bigint AS balance
         FROM payments.account a WHERE a.tenant_id = $1 AND a.type = 'wallet' AND a.currency = $2`,
      [tenantId, currency],
    );
    const a = rows[0];
    if (!a) throw notFound('Wallet');
    return {
      accountId: a.id,
      tenantId: a.tenant_id,
      currency: a.currency,
      balance: Number(a.balance),
      creditLimit: Number(a.credit_limit),
      available: Number(a.balance) + Number(a.credit_limit),
    };
  }

  async statement(tenantId: string, currency: string, limit = 50) {
    const account = await this.summary(tenantId, currency);
    const { rows } = await this.db.query(
      `SELECT id, txn_id AS "txnId", amount, currency, kind, ref_type AS "refType", ref_id AS "refId", memo, created_at AS "createdAt"
         FROM payments.ledger_entry WHERE account_id = $1 ORDER BY id DESC LIMIT $2`,
      [account.accountId, limit],
    );
    return { account, entries: rows };
  }

  /** Every wallet in the caller's subtree with live balances. Admins and finance only. */
  async listWallets(user: AuthUser) {
    if (!hasRole(user, 'admin', 'finance')) throw forbidden('Only admins and finance can view wallets');
    const { rows } = await this.db.query(
      `SELECT t.id AS "tenantId", t.name, t.type, t.path::text AS path, t.status, a.currency, a.credit_limit AS "creditLimit",
              COALESCE((SELECT SUM(amount) FROM payments.ledger_entry e WHERE e.account_id = a.id), 0)::bigint AS balance
         FROM payments.account a JOIN tenancy.tenant t ON t.id = a.tenant_id
        WHERE a.type = 'wallet' AND t.path <@ $1::ltree AND t.id <> $2
        ORDER BY t.path`,
      [user.tenantPath, user.tenantId],
    );
    return rows.map((r) => ({ ...r, available: Number(r.balance) + Number(r.creditLimit) }));
  }

  /** Credit lines are an operator finance decision. */
  async setCreditLimit(user: AuthUser, tenantId: string, currency: string, creditLimit: number) {
    if (user.tenantType !== 'operator' || !hasRole(user, 'finance')) {
      throw forbidden('Only operator finance users can change credit limits');
    }
    const tenant = await this.tenancy.get(tenantId);
    if (!this.tenancy.inScope(user, tenant.path)) throw notFound('Tenant');
    const res = await this.db.query(
      `UPDATE payments.account SET credit_limit = $3 WHERE tenant_id = $1 AND type = 'wallet' AND currency = $2`,
      [tenantId, currency, creditLimit],
    );
    if (!res.rowCount) throw notFound(`${currency} wallet`);
    await this.db.query(
      `INSERT INTO audit.audit_log (actor_id, tenant_id, action, entity, entity_id, data)
       VALUES ($1, $2, 'wallet.credit_limit_changed', 'tenant', $3, $4)`,
      [user.id, user.tenantId, tenantId, JSON.stringify({ currency, creditLimit })],
    );
    return this.summary(tenantId, currency);
  }

  /** Operator finance credits a wallet in its subtree from the operator funding account. */
  async topup(user: AuthUser, tenantId: string, amount: Money, memo: string) {
    if (user.tenantType !== 'operator' || !hasRole(user, 'finance')) {
      throw forbidden('Only operator finance users can top up wallets');
    }
    const tenant = await this.tenancy.get(tenantId);
    if (!this.tenancy.inScope(user, tenant.path)) throw notFound('Tenant');
    return this.db.tx(async (client) => {
      const wallet = await this.lockWallet(client, tenantId, amount.currency);
      const funding = await this.systemAccount(client, user.tenantId, 'funding', amount.currency);
      const txn = randomUUID();
      await this.post(client, txn, 'topup', 'topup', txn, memo, [
        [wallet.id, amount.amount],
        [funding, -amount.amount],
      ]);
      return { txnId: txn, ...(await this.summary(tenantId, amount.currency, client)) };
    });
  }

  /**
   * Debits the booking tenant's wallet and credits the operator's sales account, inside the
   * caller's transaction. Fails with INSUFFICIENT_FUNDS when balance + credit cannot cover it.
   * The wallet row is locked, so two bookings racing for the last credit cannot both succeed.
   */
  async chargeBooking(client: PoolClient, tenantId: string, operatorTenantId: string, amount: Money, bookingRef: string) {
    const wallet = await this.lockWallet(client, tenantId, amount.currency);
    const { available } = await this.summary(tenantId, amount.currency, client);
    if (available < amount.amount) {
      throw new AppError(HttpStatus.PAYMENT_REQUIRED, 'INSUFFICIENT_FUNDS', 'Wallet balance and credit do not cover this booking', {
        available,
        required: amount.amount,
        currency: amount.currency,
      });
    }
    const sales = await this.systemAccount(client, operatorTenantId, 'sales', amount.currency);
    const txn = randomUUID();
    await this.post(client, txn, 'booking_payment', 'booking', bookingRef, `Booking ${bookingRef}`, [
      [wallet.id, -amount.amount],
      [sales, amount.amount],
    ]);
    return txn;
  }

  /** Reverses a booking charge. Idempotent: a second refund for the same booking is a no-op. */
  async refundBooking(client: PoolClient, tenantId: string, operatorTenantId: string, amount: Money, bookingRef: string) {
    const existing = await client.query(
      `SELECT txn_id FROM payments.ledger_entry WHERE kind = 'refund' AND ref_type = 'booking' AND ref_id = $1 LIMIT 1`,
      [bookingRef],
    );
    if (existing.rowCount) return existing.rows[0].txn_id as string;
    const wallet = await this.lockWallet(client, tenantId, amount.currency);
    const sales = await this.systemAccount(client, operatorTenantId, 'sales', amount.currency);
    const txn = randomUUID();
    await this.post(client, txn, 'refund', 'booking', bookingRef, `Refund ${bookingRef}`, [
      [wallet.id, amount.amount],
      [sales, -amount.amount],
    ]);
    return txn;
  }

  private async lockWallet(client: PoolClient, tenantId: string, currency: string) {
    const { rows } = await client.query(
      `SELECT id FROM payments.account WHERE tenant_id = $1 AND type = 'wallet' AND currency = $2 FOR UPDATE`,
      [tenantId, currency],
    );
    if (!rows[0]) throw notFound(`${currency} wallet`);
    return rows[0] as { id: string };
  }

  private async systemAccount(client: PoolClient, operatorId: string, type: 'sales' | 'funding', currency: string) {
    const { rows } = await client.query(
      `INSERT INTO payments.account (tenant_id, type, currency) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, type, currency) DO UPDATE SET currency = EXCLUDED.currency RETURNING id`,
      [operatorId, type, currency],
    );
    return rows[0].id as string;
  }

  private async post(
    client: PoolClient,
    txn: string,
    kind: string,
    refType: string,
    refId: string,
    memo: string,
    lines: [accountId: string, amount: number][],
  ) {
    if (lines.reduce((s, [, a]) => s + a, 0) !== 0) throw new Error(`Unbalanced ledger transaction ${txn}`);
    for (const [accountId, amount] of lines) {
      await client.query(
        `INSERT INTO payments.ledger_entry (txn_id, account_id, amount, currency, kind, ref_type, ref_id, memo)
         SELECT $1, $2, $3, currency, $4, $5, $6, $7 FROM payments.account WHERE id = $2`,
        [txn, accountId, amount, kind, refType, refId, memo],
      );
    }
  }
}
