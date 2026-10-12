import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.decorators';
import { DbService } from './db/db.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get()
  async check() {
    await this.db.query('SELECT 1');
    return { status: 'ok', time: new Date().toISOString() };
  }
}
