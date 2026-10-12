import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, TraceId } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { BookingService } from '../bookings/booking.service';
import { iataCode, isoDate, parse } from '../common/validate';
import { HotelSearchService } from './hotel-search.service';

const MAX_NIGHTS = 30;

const SearchBody = z
  .object({
    city: iataCode,
    checkIn: isoDate,
    checkOut: isoDate,
    rooms: z
      .array(z.object({ adults: z.number().int().min(1).max(4), childAges: z.array(z.number().int().min(0).max(17)).max(3).optional() }))
      .min(1)
      .max(5),
    nationality: z.string().length(2).optional(),
  })
  .refine((b) => b.checkOut > b.checkIn, { message: 'Check-out must be after check-in', path: ['checkOut'] })
  .refine((b) => (Date.parse(b.checkOut) - Date.parse(b.checkIn)) / 86_400_000 <= MAX_NIGHTS, {
    message: `Stays are limited to ${MAX_NIGHTS} nights`,
    path: ['checkOut'],
  });

const Guest = z.object({
  title: z.enum(['MR', 'MRS', 'MS', 'MSTR', 'MISS']),
  firstName: z.string().trim().min(1).max(60).regex(/^[A-Za-z' -]+$/, 'Letters only'),
  lastName: z.string().trim().min(2).max(60).regex(/^[A-Za-z' -]+$/, 'Letters only'),
});

const BookBody = z.object({
  rateId: z.string().min(1),
  /** One lead guest per room */
  guests: z.array(Guest).min(1).max(5),
  contact: z.object({ email: z.string().email(), phone: z.string().min(6).max(20) }),
  specialRequests: z.string().max(500).optional(),
  expectedSellAmount: z.number().int().positive().optional(),
});

@Controller('hotels')
export class HotelsController {
  constructor(
    private readonly hotels: HotelSearchService,
    private readonly bookings: BookingService,
  ) {}

  @Post('searches')
  @HttpCode(200)
  search(@CurrentUser() user: AuthUser, @TraceId() traceId: string, @Body() body: unknown) {
    return this.hotels.search(user, parse(SearchBody, body), traceId);
  }

  @Get('searches/:searchId/hotels/:hotelId')
  rooms(
    @CurrentUser() user: AuthUser,
    @Param('searchId') searchId: string,
    @Param('hotelId', ParseUUIDPipe) hotelId: string,
  ) {
    return this.hotels.rooms(user, searchId, hotelId);
  }

  @Post('bookings')
  book(
    @CurrentUser() user: AuthUser,
    @TraceId() traceId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    return this.bookings.createHotel(user, parse(BookBody, body), idempotencyKey, traceId);
  }
}
