import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { money } from '@tripwise/contracts';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { parse } from '../common/validate';
import { LedgerService } from './ledger.service';

const TopupBody = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  memo: z.string().min(2).max(200),
});

const CreditBody = z.object({
  creditLimit: z.number().int().min(0),
  currency: z.string().length(3),
});

@Controller('accounts')
export class AccountsController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.ledger.listWallets(user);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.ledger.summary(user.tenantId, user.currency);
  }

  @Get('me/ledger')
  statement(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.ledger.statement(user.tenantId, user.currency, Math.min(Number(limit) || 50, 200));
  }

  @Post(':tenantId/topups')
  topup(@CurrentUser() user: AuthUser, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: unknown) {
    const b = parse(TopupBody, body);
    return this.ledger.topup(user, tenantId, money(b.amount, b.currency.toUpperCase()), b.memo);
  }

  @Put(':tenantId/credit-limit')
  credit(@CurrentUser() user: AuthUser, @Param('tenantId', ParseUUIDPipe) tenantId: string, @Body() body: unknown) {
    const b = parse(CreditBody, body);
    return this.ledger.setCreditLimit(user, tenantId, b.currency.toUpperCase(), b.creditLimit);
  }
}
