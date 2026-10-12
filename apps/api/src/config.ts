import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  PORT: z.coerce.number().int().default(4000),
  SEARCH_SUPPLIER_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  SEARCH_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  /** Public address of the portal, used in links inside emails. */
  PORTAL_URL: z.string().default('http://localhost:3000'),
  /** e.g. smtp://localhost:1025 for Mailpit. Without it, emails are logged instead of sent. */
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Tripwise <no-reply@tripwise.dev>'),
  /** Background jobs (outbox, emails, hold expiry, ticketing recovery). Off in tests, which run them directly. */
  JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  JOBS_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  /** How long a paid booking may sit in `ticketing` before the recovery job retries it. */
  STUCK_TICKETING_SECONDS: z.coerce.number().int().positive().default(300),
});

export type AppConfig = z.infer<typeof schema>;
export const APP_CONFIG = Symbol('APP_CONFIG');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
