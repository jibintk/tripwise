import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MockFlightSupplier } from '@tripwise/supplier-gateway';
import { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { APP_CONFIG, loadConfig } from '../src/config';
import { migrate } from '../src/db/migrate';
import { seed, SEED_PASSWORD } from '../src/db/seed';
import { FLIGHT_SUPPLIERS } from '../src/flights/supplier-registry';
import { configureApp } from '../src/main';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://tripwise:tripwise@localhost:5432/tripwise_test';

/** Drops every Tripwise schema, migrates from scratch and seeds the standard world. */
export async function resetDatabase(pool: Pool) {
  await pool.query(`
    DROP SCHEMA IF EXISTS tenancy, pricing, payments, booking, audit, platform, notify CASCADE;
    DROP TABLE IF EXISTS public.schema_migration;`);
  await migrate(pool);
  await seed(pool);
}

export async function startApp() {
  const pool = new Pool({ connectionString: TEST_DATABASE_URL });
  await resetDatabase(pool);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(
      loadConfig({
        DATABASE_URL: TEST_DATABASE_URL,
        JWT_SECRET: 'test-secret-at-least-16-chars',
        SEARCH_SUPPLIER_TIMEOUT_MS: '2000',
        JOBS_ENABLED: 'false',
      }),
    )
    .overrideProvider(FLIGHT_SUPPLIERS)
    .useValue([new MockFlightSupplier({ priceChangeRoutes: ['NBO-MBA'] })])
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, 'http://localhost:3000');
  await app.init();
  const http = request(app.getHttpServer());
  return { app, pool, http };
}

export async function login(http: ReturnType<typeof request>, email: string): Promise<string> {
  const res = await http.post('/api/v1/auth/login').send({ email, password: SEED_PASSWORD }).expect(200);
  return res.body.accessToken;
}

export const passenger = (lastName = 'ODHIAMBO') => ({
  type: 'ADT',
  title: 'MR',
  firstName: 'James',
  lastName,
  dateOfBirth: '1988-04-12',
});

export const contact = { email: 'james@example.com', phone: '+254700000001' };

export async function stopApp(ctx: { app: INestApplication; pool: Pool }) {
  await ctx.app.close();
  await ctx.pool.end();
}
