import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { NextFunction, Request, Response } from 'express';

/** Takes the trace id from a W3C traceparent header or creates one, and echoes it on the response. */
@Injectable()
export class TraceMiddleware implements NestMiddleware {
  use(req: Request & { traceId?: string }, res: Response, next: NextFunction) {
    const parent = req.header('traceparent');
    const fromParent = parent?.split('-')[1];
    req.traceId = fromParent && /^[0-9a-f]{32}$/.test(fromParent) ? fromParent : randomBytes(16).toString('hex');
    res.setHeader('x-trace-id', req.traceId);
    next();
  }
}
