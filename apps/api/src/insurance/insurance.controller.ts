import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, TraceId } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { BookingService } from '../bookings/booking.service';
import { isoDate, parse } from '../common/validate';
import { coverDays, InsuranceService } from './insurance.service';

const MAX_COVER_DAYS = 180;
const today = () => new Date().toISOString().slice(0, 10);
const dob = isoDate.refine((d) => d <= today(), 'Date of birth cannot be in the future');

const QuoteBody = z
  .object({
    region: z.enum(['east_africa', 'africa', 'worldwide']),
    startDate: isoDate,
    endDate: isoDate,
    travellers: z.array(z.object({ dateOfBirth: dob })).min(1).max(9),
  })
  .refine((b) => b.startDate >= today(), { message: 'Cover cannot start in the past', path: ['startDate'] })
  .refine((b) => b.endDate >= b.startDate, { message: 'The last day of cover must be on or after the first', path: ['endDate'] })
  .refine((b) => coverDays(b.startDate, b.endDate) <= MAX_COVER_DAYS, { message: `Cover is limited to ${MAX_COVER_DAYS} days`, path: ['endDate'] });

const name = z.string().trim().min(1).max(60).regex(/^[A-Za-z' -]+$/, 'Letters only, as on the passport');

const BookBody = z.object({
  quoteId: z.string().min(1).max(64),
  travellers: z
    .array(
      z.object({
        title: z.enum(['MR', 'MRS', 'MS', 'MSTR', 'MISS']),
        firstName: name,
        lastName: name.refine((s) => s.length >= 2, 'At least 2 letters'),
        dateOfBirth: dob,
        documentNumber: z.string().trim().max(20).optional(),
      }),
    )
    .min(1)
    .max(9),
  contact: z.object({ email: z.string().email(), phone: z.string().min(6).max(20) }),
  expectedSellAmount: z.number().int().positive().optional(),
  linkedReference: z.string().regex(/^TW-[A-Z0-9]{6}$/i, 'A booking reference like TW-AB12CD').optional(),
});

@Controller('insurance')
export class InsuranceController {
  constructor(
    private readonly insurance: InsuranceService,
    private readonly bookings: BookingService,
  ) {}

  @Get('plans')
  plans(@CurrentUser() user: AuthUser) {
    return this.insurance.plans(user);
  }

  @Put('plans/:code/active')
  setActive(@CurrentUser() user: AuthUser, @Param('code') code: string, @Body() body: unknown) {
    return this.insurance.setActive(user, code, parse(z.object({ active: z.boolean() }), body).active);
  }

  @Post('quotes')
  @HttpCode(200)
  quote(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.insurance.quote(user, parse(QuoteBody, body));
  }

  @Post('bookings')
  book(
    @CurrentUser() user: AuthUser,
    @TraceId() traceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.bookings.createInsurance(user, parse(BookBody, body), idempotencyKey, traceId);
  }
}
