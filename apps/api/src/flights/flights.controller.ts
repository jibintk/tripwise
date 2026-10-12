import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, TraceId } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { iataCode, isoDate, parse } from '../common/validate';
import { FlightSearchService } from './flight-search.service';

const SearchBody = z
  .object({
    origin: iataCode,
    destination: iataCode,
    departureDate: isoDate,
    returnDate: isoDate.optional(),
    passengers: z.object({
      ADT: z.number().int().min(1).max(9),
      CHD: z.number().int().min(0).max(8).optional(),
      INF: z.number().int().min(0).max(4).optional(),
    }),
    cabin: z.enum(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']).default('ECONOMY'),
  })
  .refine((b) => b.origin !== b.destination, { message: 'Origin and destination must differ', path: ['destination'] })
  .refine((b) => !b.returnDate || b.returnDate >= b.departureDate, {
    message: 'Return date must be on or after departure',
    path: ['returnDate'],
  })
  .refine((b) => (b.passengers.INF ?? 0) <= b.passengers.ADT, {
    message: 'Each infant needs an adult',
    path: ['passengers', 'INF'],
  });

@Controller('flights')
export class FlightsController {
  constructor(private readonly search: FlightSearchService) {}

  @Post('searches')
  @HttpCode(200)
  run(@CurrentUser() user: AuthUser, @TraceId() traceId: string, @Body() body: unknown) {
    return this.search.search(user, parse(SearchBody, body), traceId);
  }

  @Get('offers/:offerId/rules')
  rules(@CurrentUser() user: AuthUser, @TraceId() traceId: string, @Param('offerId') offerId: string) {
    return this.search.fareRules(user, offerId, traceId);
  }

  @Post('offers/:offerId/reprice')
  @HttpCode(200)
  async reprice(@CurrentUser() user: AuthUser, @TraceId() traceId: string, @Param('offerId') offerId: string) {
    const { offer, quote } = await this.search.reprice(user, offerId, traceId);
    return this.search.present(user, offer, quote);
  }
}
