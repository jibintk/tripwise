import { z } from 'zod';
import { badRequest } from './errors';

/** Parses untrusted input at the API edge; returns typed data or throws VALIDATION_FAILED with field errors. */
export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw badRequest('Request is invalid', {
      errors: result.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export const iataCode = z
  .string()
  .regex(/^[A-Za-z]{3}$/, 'Must be a 3-letter IATA code')
  .transform((s) => s.toUpperCase());
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');
