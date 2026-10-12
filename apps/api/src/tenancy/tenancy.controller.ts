import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser } from '../auth/auth.decorators';
import { AuthUser } from '../auth/auth.types';
import { parse } from '../common/validate';
import { TenancyService } from './tenancy.service';

const CreateTenantBody = z.object({
  parentId: z.string().uuid().optional(),
  type: z.enum(['gsa', 'agency', 'sub_agency', 'branch', 'corporate']),
  code: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'Lowercase letters, digits and underscores, starting with a letter'),
  name: z.string().min(2).max(120),
  country: z.string().length(2).transform((s) => s.toUpperCase()),
});

const StatusBody = z.object({ status: z.enum(['active', 'suspended']) });

const CreateUserBody = z.object({
  email: z.string().email(),
  name: z.string().min(2).max(120),
  roles: z.array(z.enum(['admin', 'agent', 'finance', 'ops'])).min(1),
});

@Controller('tenants')
export class TenancyController {
  constructor(private readonly tenancy: TenancyService) {}

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.tenancy.get(user.tenantId);
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.tenancy.subtree(user);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() body: unknown) {
    return this.tenancy.createChild(user, parse(CreateTenantBody, body));
  }

  @Patch(':id')
  setStatus(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.tenancy.setStatus(user, id, parse(StatusBody, body).status);
  }

  @Get(':id/users')
  users(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.tenancy.listUsers(user, id);
  }

  @Post(':id/users')
  createUser(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.tenancy.createUser(user, id, parse(CreateUserBody, body));
  }
}
