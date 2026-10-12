import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Public, TraceId } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { isoDate, parse } from '../common/validate';
import { ApprovalService } from './approval.service';
import { CorporateService } from './corporate.service';

const money = z.number().int().positive();

const PolicyBody = z.object({
  grade: z.string().trim().min(1).max(40),
  approvalMode: z.enum(['always', 'out_of_policy', 'never']),
  rules: z.object({
    flight: z
      .object({
        maxCabin: z.enum(['ECONOMY', 'PREMIUM_ECONOMY', 'BUSINESS', 'FIRST']).optional(),
        maxFarePerTraveller: money.optional(),
        minAdvanceDays: z.number().int().min(0).max(365).optional(),
        refundableOnly: z.boolean().optional(),
      })
      .optional(),
    hotel: z
      .object({
        maxStars: z.number().int().min(1).max(5).optional(),
        maxNightlyPerRoom: money.optional(),
      })
      .optional(),
  }),
});

const EmployeeBody = z.object({
  grade: z.string().trim().min(1).max(40),
  costCentre: z.string().trim().max(40).nullish(),
  approverId: z.string().uuid().nullish(),
});

const DecisionBody = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: z.string().trim().max(500).optional(),
});

const TokenDecisionBody = DecisionBody.extend({ token: z.string().min(10).max(100) });

const ReportQuery = z.object({ from: isoDate, to: isoDate });

@Controller('corporate')
export class CorporateController {
  constructor(private readonly corporate: CorporateService) {}

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    return this.corporate.travellerContext(user);
  }

  @Get('policies')
  policies(@CurrentUser() user: AuthUser) {
    return this.corporate.listPolicies(user);
  }

  @Put('policies')
  upsertPolicy(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.corporate.upsertPolicy(user, parse(PolicyBody, body));
  }

  @Get('employees')
  employees(@CurrentUser() user: AuthUser) {
    return this.corporate.listEmployees(user);
  }

  @Put('employees/:userId')
  setEmployee(@CurrentUser() user: AuthUser, @Param('userId', ParseUUIDPipe) userId: string, @Body() body: unknown) {
    return this.corporate.setEmployee(user, userId, parse(EmployeeBody, body));
  }

  @Get('reports/spend')
  spend(@CurrentUser() user: AuthUser, @Query() query: unknown) {
    const q = parse(ReportQuery, query);
    return this.corporate.spendReport(user, q.from, q.to);
  }
}

@Controller('approvals')
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalService) {}

  @Get()
  pending(@CurrentUser() user: AuthUser) {
    return this.approvals.listPending(user);
  }

  @Post(':id/decision')
  @HttpCode(200)
  decide(@CurrentUser() user: AuthUser, @TraceId() traceId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(DecisionBody, body);
    return this.approvals.decide(user, id, b.decision, b.comment, traceId);
  }

  /** One-click links from the approval email: authorised by the single-use token, no login. */
  @Public()
  @Get(':id/by-token')
  describe(@Param('id', ParseUUIDPipe) id: string, @Query('token') token: string) {
    return this.approvals.describeByToken(id, token);
  }

  @Public()
  @Post(':id/by-token')
  @HttpCode(200)
  decideByToken(@TraceId() traceId: string, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const b = parse(TokenDecisionBody, body);
    return this.approvals.decideByToken(id, b.token, b.decision, b.comment, traceId);
  }
}
