import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

/**
 * Applies every migrations/*.sql file not yet recorded, in file-name order, each in its own
 * transaction. Migrations must stay backward compatible with the previous app version.
 */
export async function migrate(pool: Pool, log: (m: string) => void = () => undefined): Promise<string[]> {
  await pool.query(`CREATE TABLE IF NOT EXISTS public.schema_migration (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM public.schema_migration');
  const done = new Set(rows.map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    if (done.has(file)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      await client.query('INSERT INTO public.schema_migration (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}
