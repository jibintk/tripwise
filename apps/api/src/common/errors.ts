import { HttpStatus } from '@nestjs/common';

/**
 * Domain error that maps to an RFC 9457 problem+json response.
 * `code` is stable and documented; clients branch on it, never on `detail`.
 */
export class AppError extends Error {
  constructor(
    public readonly status: HttpStatus,
    public readonly code: string,
    message: string,
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${what} not found`);
export const forbidden = (msg = 'You do not have permission for this action') =>
  new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', msg);
export const badRequest = (msg: string, extra?: Record<string, unknown>) =>
  new AppError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED', msg, extra);
export const conflict = (code: string, msg: string, extra?: Record<string, unknown>) =>
  new AppError(HttpStatus.CONFLICT, code, msg, extra);
