import 'dotenv/config';
import { Pool } from 'pg';
import { migrate } from './migrate';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const applied = await migrate(pool, console.log);
    console.log(applied.length ? `Done: ${applied.length} migration(s) applied.` : 'Database is up to date.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
