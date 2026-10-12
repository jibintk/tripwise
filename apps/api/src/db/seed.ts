import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { hashPassword } from '../auth/password';

export const SEED_PASSWORD = 'Password123!';

export const SEED_USERS = {
  operatorAdmin: 'admin@tripwise.dev',
  gsaAdmin: 'gsa@tripwise.dev',
  agencyAdmin: 'owner@safaridesk.dev',
  agent: 'agent@safaridesk.dev',
  otherAgent: 'agent@coastways.dev',
  travelManager: 'manager@acme.dev',
  approver: 'approver@acme.dev',
  staff: 'staff@acme.dev',
  executive: 'exec@acme.dev',
};

interface SeedTenant {
  code: string;
  type: string;
  parent?: string;
  name: string;
}

/**
 * Creates a standard world for development and tests:
 * operator -> Kenya GSA -> Safari Desk Travel (agency) and Coastways Tours (agency),
 * one user per role, wallets with balances and a markup rule at each level.
 * Safe to run on an empty database only.
 */
export async function seed(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenants: SeedTenant[] = [
      { code: 'tripwise', type: 'operator', name: 'Tripwise Travel' },
      { code: 'kenya_gsa', type: 'gsa', parent: 'tripwise', name: 'Kenya GSA' },
      { code: 'safari_desk', type: 'agency', parent: 'kenya_gsa', name: 'Safari Desk Travel' },
      { code: 'coastways', type: 'agency', parent: 'kenya_gsa', name: 'Coastways Tours' },
      { code: 'acme_kenya', type: 'corporate', parent: 'tripwise', name: 'Acme Kenya Ltd' },
    ];
    const ids: Record<string, string> = {};
    const paths: Record<string, string> = {};
    for (const t of tenants) {
      const id = randomUUID();
      const path = t.parent ? `${paths[t.parent]}.${t.code}` : t.code;
      await client.query(
        `INSERT INTO tenancy.tenant (id, type, parent_id, code, path, name, country, currency)
         VALUES ($1,$2,$3,$4,$5,$6,'KE','USD')`,
        [id, t.type, t.parent ? ids[t.parent] : null, t.code, path, t.name],
      );
      ids[t.code] = id;
      paths[t.code] = path;
    }

    const hash = await hashPassword(SEED_PASSWORD);
    const users: [string, string, string, string[]][] = [
      [SEED_USERS.operatorAdmin, 'tripwise', 'Operator Admin', ['admin', 'finance', 'ops']],
      [SEED_USERS.gsaAdmin, 'kenya_gsa', 'GSA Admin', ['admin']],
      [SEED_USERS.agencyAdmin, 'safari_desk', 'Amina Otieno', ['admin', 'agent']],
      [SEED_USERS.agent, 'safari_desk', 'Brian Mwangi', ['agent']],
      [SEED_USERS.otherAgent, 'coastways', 'Fatma Salim', ['agent']],
      [SEED_USERS.travelManager, 'acme_kenya', 'Joyce Njeri', ['admin', 'traveller']],
      [SEED_USERS.approver, 'acme_kenya', 'David Ochieng', ['approver', 'traveller']],
      [SEED_USERS.staff, 'acme_kenya', 'Mary Akinyi', ['traveller']],
      [SEED_USERS.executive, 'acme_kenya', 'Samuel Mutua', ['traveller']],
    ];
    for (const [email, tenant, name, roles] of users) {
      await client.query(
        `INSERT INTO tenancy.app_user (tenant_id, email, name, password_hash, roles) VALUES ($1,$2,$3,$4,$5)`,
        [ids[tenant], email, name, hash, roles],
      );
    }

    // Accounts: the operator has a sales account (money it receives) and a funding account
    // (the source of top-ups); every other tenant has a wallet.
    const account = async (tenant: string, type: string, creditLimit = 0) => {
      const { rows } = await client.query(
        `INSERT INTO payments.account (tenant_id, type, currency, credit_limit) VALUES ($1,$2,'USD',$3) RETURNING id`,
        [ids[tenant], type, creditLimit],
      );
      return rows[0].id as string;
    };
    await account('tripwise', 'sales');
    const funding = await account('tripwise', 'funding');
    await account('kenya_gsa', 'wallet');
    const safariWallet = await account('safari_desk', 'wallet', 100_000); // USD 1,000 credit line
    const coastWallet = await account('coastways', 'wallet');
    await account('acme_kenya', 'wallet', 2_000_000); // corporate billed on a USD 20,000 credit line

    const topup = async (wallet: string, amount: number) => {
      const txn = randomUUID();
      await client.query(
        `INSERT INTO payments.ledger_entry (txn_id, account_id, amount, currency, kind, ref_type, ref_id, memo)
         VALUES ($1::uuid,$2,$3,'USD','topup','seed',$1::text,'Opening balance'),
                ($1::uuid,$4,$5,'USD','topup','seed',$1::text,'Opening balance')`,
        [txn, wallet, amount, funding, -amount],
      );
    };
    await topup(safariWallet, 500_000); // USD 5,000
    await topup(coastWallet, 50_000); // USD 500

    const rule = (owner: string, name: string, valueType: string, value: number, extra: Record<string, unknown> = {}) =>
      client.query(
        `INSERT INTO pricing.pricing_rule (owner_tenant_id, name, product, value_type, value, currency, destination, priority)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [ids[owner], name, extra.product ?? 'flight', valueType, value, valueType === 'fixed' ? 'USD' : null, extra.destination ?? null, extra.priority ?? 0],
      );
    await rule('tripwise', 'Operator flight markup', 'percent', 300); // 3%
    await rule('tripwise', 'Operator Zanzibar markup', 'percent', 500, { destination: 'ZNZ' }); // 5% on ZNZ
    await rule('kenya_gsa', 'GSA flight markup', 'percent', 150); // 1.5%
    await rule('safari_desk', 'Agency service fee', 'fixed', 1_500); // USD 15 per booking
    await rule('tripwise', 'Operator hotel markup', 'percent', 800, { product: 'hotel' }); // 8%
    await rule('kenya_gsa', 'GSA hotel markup', 'percent', 200, { product: 'hotel' }); // 2%

    // Corporate travel policy: staff fly economy under USD 800 booked a week ahead; executives may fly business.
    await client.query(
      `INSERT INTO policy.travel_policy (corporate_id, grade, rules, approval_mode) VALUES
         ($1, 'staff', $2, 'out_of_policy'), ($1, 'executive', $3, 'never')`,
      [
        ids.acme_kenya,
        JSON.stringify({
          flight: { maxCabin: 'ECONOMY', maxFarePerTraveller: 80_000, minAdvanceDays: 7 },
          hotel: { maxStars: 4, maxNightlyPerRoom: 25_000 },
        }),
        JSON.stringify({ flight: { maxCabin: 'BUSINESS' }, hotel: { maxStars: 5 } }),
      ],
    );
    const userId = async (email: string) =>
      (await client.query(`SELECT id FROM tenancy.app_user WHERE email = $1`, [email])).rows[0].id as string;
    const approverId = await userId(SEED_USERS.approver);
    const managerId = await userId(SEED_USERS.travelManager);
    for (const [email, grade, approver, cc] of [
      [SEED_USERS.staff, 'staff', approverId, 'SALES'],
      [SEED_USERS.approver, 'staff', managerId, 'SALES'],
      [SEED_USERS.executive, 'executive', null, 'EXEC'],
      [SEED_USERS.travelManager, 'staff', approverId, 'HR'],
    ] as const) {
      await client.query(
        `INSERT INTO policy.employee (user_id, corporate_id, grade, cost_centre, approver_user_id) VALUES ($1,$2,$3,$4,$5)`,
        [await userId(email), ids.acme_kenya, grade, cc, approver],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
