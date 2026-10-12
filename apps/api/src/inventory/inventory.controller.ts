import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { iataCode, isoDate, parse } from '../common/validate';
import { InventoryService } from './inventory.service';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be HH:MM');
const amount = z.number().int().min(0);

const SeriesBody = z
  .object({
    kind: z.enum(['blocked', 'charter', 'a2a']),
    carrier: z.string().regex(/^[A-Za-z0-9]{2}$/, 'Two-character airline code').transform((s) => s.toUpperCase()),
    flightNumber: z.string().regex(/^\d{1,4}$/, 'Digits only'),
    origin: iataCode,
    destination: iataCode,
    dates: z.array(isoDate).min(1).max(370),
    departureTime: time,
    arrivalTime: time,
    arrivalDayOffset: z.number().int().min(0).max(2).default(0),
    durationMin: z.number().int().min(10).max(24 * 60),
    cabin: z.enum(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']),
    fareBrand: z.string().trim().max(30).optional(),
    checkedPieces: z.number().int().min(0).max(3).default(1),
    cabinKg: z.number().int().min(0).max(23).default(7),
    refundable: z.boolean().default(false),
    changeable: z.boolean().default(false),
    baseAmount: amount,
    taxAmount: amount,
    currency: z.string().length(3).transform((s) => s.toUpperCase()),
    seats: z.number().int().min(1).max(500),
    releaseDaysBefore: z.number().int().min(0).max(90).default(7),
    notes: z.string().max(500).optional(),
  })
  .refine((b) => b.origin !== b.destination, { message: 'Origin and destination must differ', path: ['destination'] });

const UpdateBody = z.object({
  baseAmount: amount.optional(),
  taxAmount: amount.optional(),
  seatsTotal: z.number().int().min(1).max(500).optional(),
  releaseAt: z.string().datetime({ offset: true }).optional(),
  status: z.enum(['active', 'closed']).optional(),
  notes: z.string().max(500).nullable().optional(),
});

const ListQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  origin: iataCode.optional(),
  destination: iataCode.optional(),
  status: z.enum(['active', 'closed']).optional(),
});

@Controller('inventory/allotments')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    this.inventory.requireOperator(user);
    return this.inventory.list(user, parse(ListQuery, query));
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    this.inventory.requireOperator(user);
    return this.inventory.createSeries(user, parse(SeriesBody, body));
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    this.inventory.requireOperator(user);
    return this.inventory.update(user, id, parse(UpdateBody, body));
  }

  @Get(':id/manifest')
  manifest(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.manifest(user, id);
  }

  @Get(':id/manifest.csv')
  async manifestCsv(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const m = await this.inventory.manifest(user, id);
    const a = m.allotment as { carrier: string; flightNumber: string; departureLocal: string };
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="manifest-${a.carrier}${a.flightNumber}-${a.departureLocal.slice(0, 10)}.csv"`);
    res.send(this.inventory.manifestCsv(m));
  }
}
