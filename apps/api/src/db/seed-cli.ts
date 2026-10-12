import 'dotenv/config';
import { Pool } from 'pg';
import { seed, SEED_PASSWORD, SEED_USERS } from './seed';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM tenancy.tenant');
    if (rows[0].n > 0) {
      console.log('Database already has tenants; skipping seed.');
      return;
    }
    await seed(pool);
    console.log('Seeded. Log in with any of these users, password:', SEED_PASSWORD);
    for (const [role, email] of Object.entries(SEED_USERS)) console.log(`  ${role.padEnd(14)} ${email}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
