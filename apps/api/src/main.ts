import 'dotenv/config';
import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';

export function configureApp(app: INestApplication, corsOrigins: string) {
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.enableCors({ origin: corsOrigins.split(',').map((s) => s.trim()), exposedHeaders: ['x-trace-id'] });
}

async function bootstrap() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule);
  configureApp(app, config.CORS_ORIGINS);
  app.enableShutdownHooks();
  await app.listen(config.PORT);
  console.log(`Tripwise API listening on http://localhost:${config.PORT}/api/v1`);
}

if (require.main === module) {
  bootstrap();
}
