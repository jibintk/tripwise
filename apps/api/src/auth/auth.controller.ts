import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { z } from 'zod';
import { parse } from '../common/validate';
import { CurrentUser, Public } from './auth.decorators';
import { AuthService } from './auth.service';
import { AuthUser } from './auth.types';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    const { email, password } = parse(LoginBody, body);
    return this.auth.login(email, password);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }
}
