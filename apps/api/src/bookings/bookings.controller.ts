import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, TraceId } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { isoDate, parse } from '../common/validate';
import { BookingService } from './booking.service';

const PassengerSchema = z.object({
  type: z.enum(['ADT', 'CHD', 'INF']),
  title: z.enum(['MR', 'MRS', 'MS', 'MSTR', 'MISS']),
  firstName: z.string().trim().min(1).max(60).regex(/^[A-Za-z' -]+$/, 'Letters only, as on the passport'),
  lastName: z.string().trim().min(2).max(60).regex(/^[A-Za-z' -]+$/, 'Letters only, as on the passport'),
  dateOfBirth: isoDate,
  documentNumber: z.string().max(20).optional(),
  documentExpiry: isoDate.optional(),
  nationality: z.string().length(2).optional(),
});

const CreateBody = z.object({
  offerId: z.string().min(1),
  passengers: z.array(PassengerSchema).min(1).max(9),
  contact: z.object({ email: z.string().email(), phone: z.string().min(6).max(20) }),
  expectedSellAmount: z.number().int().positive().optional(),
  /** Corporate trips: why an out-of-policy option was chosen */
  reasonForException: z.string().trim().min(3).max(500).optional(),
  /** Corporate trips: the search the option came from, to record the lowest logical fare */
  searchId: z.string().max(64).optional(),
});

const ListQuery = z.object({
  status: z.enum(['held', 'pending_approval', 'rejected', 'paid', 'ticketing', 'confirmed', 'cancelled', 'failed', 'expired']).optional(),
  product: z.enum(['flight', 'hotel', 'insurance']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingService) {}

  @Post()
  create(
    @CurrentUser() user: AuthUser,
    @TraceId() traceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.bookings.create(user, parse(CreateBody, body), idempotencyKey, traceId);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    return this.bookings.list(user, parse(ListQuery, query));
  }

  @Get(':reference')
  get(@CurrentUser() user: AuthUser, @Param('reference') reference: string) {
    return this.bookings.get(user, reference);
  }

  /** E-ticket for flights, voucher for hotels. Both paths serve the same document. */
  @Get([':reference/eticket.pdf', ':reference/voucher.pdf', ':reference/certificate.pdf', ':reference/document.pdf'])
  async document(@CurrentUser() user: AuthUser, @Param('reference') reference: string, @Res() res: Response) {
    const { filename, pdf } = await this.bookings.document(user, reference);
    res.setHeader('content-type', 'application/pdf');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    res.send(pdf);
  }

  @Post(':reference/payments')
  @HttpCode(200)
  pay(@CurrentUser() user: AuthUser, @TraceId() traceId: string, @Param('reference') reference: string) {
    return this.bookings.pay(user, reference, traceId);
  }

  @Post(':reference/cancel')
  @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @TraceId() traceId: string, @Param('reference') reference: string) {
    return this.bookings.cancel(user, reference, traceId);
  }
}
