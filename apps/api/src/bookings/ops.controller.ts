import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser, hasRole } from '../auth/auth.types';
import { forbidden } from '../common/errors';
import { parse } from '../common/validate';
import { JobsService } from '../jobs/jobs.service';
import { BookingService } from './booking.service';

const ResolveBody = z.object({ note: z.string().min(3).max(1000) });

@Controller('ops')
export class OpsController {
  constructor(
    private readonly bookings: BookingService,
    private readonly jobs: JobsService,
  ) {}

  @Get('queue')
  queue(@CurrentUser() user: AuthUser) {
    return this.bookings.opsQueue(user);
  }

  @Post('bookings/:reference/resolve')
  @HttpCode(200)
  resolve(@CurrentUser() user: AuthUser, @Param('reference') reference: string, @Body() body: unknown) {
    return this.bookings.resolveFailure(user, reference, parse(ResolveBody, body).note);
  }

  /** Runs every background job once, now. Operator admins only; handy after an incident. */
  @Post('jobs/run')
  @HttpCode(200)
  runJobs(@CurrentUser() user: AuthUser) {
    if (user.tenantType !== 'operator' || !hasRole(user, 'admin')) throw forbidden();
    return this.jobs.runAll();
  }
}
