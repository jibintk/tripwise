import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { SupplierError, SupplierErrorCode } from '@tripwise/contracts';
import { Request, Response } from 'express';
import { AppError } from './errors';

const SUPPLIER_STATUS: Record<string, HttpStatus> = {
  [SupplierErrorCode.PRICE_CHANGED]: HttpStatus.CONFLICT,
  [SupplierErrorCode.SOLD_OUT]: HttpStatus.CONFLICT,
  [SupplierErrorCode.HOLD_EXPIRED]: HttpStatus.CONFLICT,
  [SupplierErrorCode.INVALID_PASSENGER_DATA]: HttpStatus.UNPROCESSABLE_ENTITY,
  [SupplierErrorCode.SUPPLIER_TIMEOUT]: HttpStatus.GATEWAY_TIMEOUT,
  [SupplierErrorCode.SUPPLIER_UNAVAILABLE]: HttpStatus.SERVICE_UNAVAILABLE,
  [SupplierErrorCode.TICKETING_FAILED]: HttpStatus.BAD_GATEWAY,
  [SupplierErrorCode.AUTH_FAILED]: HttpStatus.BAD_GATEWAY,
};

/** Every error leaves the API as application/problem+json with a stable `code` and the traceId. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('Problem');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<Request & { traceId?: string }>();
    const traceId = req.traceId;

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let detail = 'Something went wrong. Quote the traceId when reporting this.';
    let extra: Record<string, unknown> | undefined;

    if (err instanceof AppError) {
      ({ status, code } = err);
      detail = err.message;
      extra = err.extra;
    } else if (err instanceof SupplierError) {
      status = SUPPLIER_STATUS[err.code] ?? HttpStatus.BAD_GATEWAY;
      code = err.code;
      detail = err.message;
      extra = { supplier: err.supplier, ...err.details };
    } else if (err instanceof HttpException) {
      status = err.getStatus();
      code = status === 401 ? 'UNAUTHENTICATED' : status === 404 ? 'NOT_FOUND' : 'HTTP_ERROR';
      detail = err.message;
    } else {
      this.logger.error({ traceId, err }, (err as Error)?.stack);
    }

    res
      .status(status)
      .type('application/problem+json')
      .json({ type: `https://errors.tripwise.dev/${code.toLowerCase()}`, title: code, status, detail, code, traceId, ...extra });
  }
}
