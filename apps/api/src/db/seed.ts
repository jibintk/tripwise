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

    await rule('tripwise', 'Operator insurance commission', 'percent', 1_000, { product: 'insurance' }); // 10%
    await rule('kenya_gsa', 'GSA insurance commission', 'percent', 200, { product: 'insurance' }); // 2%

    // Travel insurance plans (net rates per traveller, USD cents, by trip length).
    const plans = [
      {
        code: 'essential',
        name: 'Essential East Africa',
        regions: ['east_africa'],
        summary: 'Medical cover for regional trips within Kenya, Tanzania, Uganda, Rwanda and Burundi.',
        coverage: [
          { label: 'Emergency medical', limit: 'USD 50,000' },
          { label: 'Medical evacuation', limit: 'USD 100,000' },
          { label: 'Trip cancellation', limit: 'USD 1,000' },
          { label: 'Baggage', limit: 'USD 500' },
        ],
        rates: [
          { maxDays: 8, amount: 1_200 },
          { maxDays: 15, amount: 1_800 },
          { maxDays: 31, amount: 2_800 },
          { maxDays: 62, amount: 4_500 },
          { maxDays: 92, amount: 6_000 },
        ],
        maxAge: 75,
        sort: 1,
      },
      {
        code: 'africa_plus',
        name: 'Africa Plus',
        regions: ['east_africa', 'africa'],
        summary: 'Higher medical limits and trip protection anywhere in Africa, including safaris.',
        coverage: [
          { label: 'Emergency medical', limit: 'USD 150,000' },
          { label: 'Medical evacuation (incl. air ambulance)', limit: 'USD 250,000' },
          { label: 'Trip cancellation', limit: 'USD 3,000' },
          { label: 'Missed connection', limit: 'USD 500' },
          { label: 'Baggage', limit: 'USD 1,000' },
        ],
        rates: [
          { maxDays: 8, amount: 2_200 },
          { maxDays: 15, amount: 3_200 },
          { maxDays: 31, amount: 4_800 },
          { maxDays: 62, amount: 7_500 },
          { maxDays: 92, amount: 9_800 },
          { maxDays: 180, amount: 15_000 },
        ],
        maxAge: 80,
        sort: 2,
      },
      {
        code: 'worldwide',
        name: 'Worldwide Premier',
        regions: ['east_africa', 'africa', 'worldwide'],
        summary: 'Comprehensive cover worldwide, including the Schengen visa minimum of EUR 30,000 medical.',
        coverage: [
          { label: 'Emergency medical', limit: 'USD 500,000' },
          { label: 'Medical evacuation and repatriation', limit: 'Unlimited' },
          { label: 'Trip cancellation', limit: 'USD 5,000' },
          { label: 'Travel delay', limit: 'USD 600' },
          { label: 'Baggage', limit: 'USD 2,000' },
          { label: 'Personal liability', limit: 'USD 1,000,000' },
        ],
        rates: [
          { maxDays: 8, amount: 3_900 },
          { maxDays: 15, amount: 5_600 },
          { maxDays: 31, amount: 8_200 },
          { maxDays: 62, amount: 13_000 },
          { maxDays: 92, amount: 17_500 },
          { maxDays: 180, amount: 28_000 },
        ],
        maxAge: 85,
        sort: 3,
      },
    ];
    for (const p of plans) {
      await client.query(
        `INSERT INTO insurance.plan (code, name, provider, regions, summary, coverage, rates, currency, max_age, sort)
         VALUES ($1, $2, 'mockinsure', $3, $4, $5, $6, 'USD', $7, $8)`,
        [p.code, p.name, p.regions, p.summary, JSON.stringify(p.coverage), JSON.stringify(p.rates), p.maxAge, p.sort],
      );
    }

    // Own inventory, dated from today: blocked seats to Zanzibar four days a week, and a Saturday Mara charter.
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);
    const series: [string, string, string, string, string, string, number, number, number, number, number, string][] = [];
    for (let i = 1; i <= 90; i++) {
      const d = day(i);
      const date = d.toISOString().slice(0, 10);
      if ([0, 1, 3, 5].includes(d.getUTCDay())) {
        series.push(['blocked', 'KQ', '480', 'NBO', 'ZNZ', `${date} 07:40`, 85, 20, 9_000, 4_500, 10, `${date} 09:05`]);
        series.push(['blocked', 'KQ', '481', 'ZNZ', 'NBO', `${date} 10:00`, 85, 20, 9_000, 4_500, 10, `${date} 11:25`]);
      }
      if (d.getUTCDay() === 6) {
        series.push(['charter', 'XK', '701', 'NBO', 'MRE', `${date} 10:00`, 45, 12, 18_000, 1_500, 3, `${date} 10:45`]);
        series.push(['charter', 'XK', '702', 'MRE', 'NBO', `${date} 15:00`, 45, 12, 18_000, 1_500, 3, `${date} 15:45`]);
      }
    }
    for (const [kind, carrier, fn, from, to, dep, mins, seats, base, tax, releaseDays, arr] of series) {
      await client.query(
        `INSERT INTO inventory.allotment (owner_tenant_id, kind, carrier, flight_number, origin, destination, departure_local, arrival_local,
           duration_min, cabin, fare_brand, checked_pieces, cabin_kg, base_amount, tax_amount, currency, seats_total, release_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamp, $14::timestamp, $8, 'ECONOMY', $9, $10, 7, $11, $12, 'USD', $13,
                 ($7::timestamp - make_interval(days => $15)) AT TIME ZONE 'UTC')`,
        [ids.tripwise, kind, carrier, fn, from, to, dep, mins, kind === 'charter' ? 'Charter' : 'Group', 1, base, tax, seats, arr, releaseDays],
      );
    }

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
