import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { iataCode, parse } from '../common/validate';
import { PricingService } from './pricing.service';

const RuleBody = z
  .object({
    name: z.string().min(2).max(120),
    product: z.enum(['flight', 'hotel', 'insurance', 'package', 'visa']).nullish(),
    channel: z.enum(['b2b', 'b2e', 'b2c', 'pos']).nullish(),
    supplier: z.string().min(1).nullish(),
    origin: iataCode.nullish(),
    destination: iataCode.nullish(),
    cabin: z.enum(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']).nullish(),
    valueType: z.enum(['percent', 'fixed']),
    /** percent: basis points (250 = 2.5%); fixed: minor units */
    value: z.number().int().min(0),
    currency: z.string().length(3).nullish(),
    priority: z.number().int().optional(),
  })
  .refine((r) => r.valueType !== 'percent' || r.value <= 5000, {
    message: 'A percentage markup above 50% is almost certainly a mistake',
    path: ['value'],
  });

@Controller('pricing/rules')
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.pricing.listOwn(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.pricing.create(user, parse(RuleBody, body));
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.pricing.deactivate(user, id);
  }
}
