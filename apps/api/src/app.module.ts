import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MockFlightSupplier } from '@tripwise/supplier-gateway';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { BookingService } from './bookings/booking.service';
import { BookingsController } from './bookings/bookings.controller';
import { CacheService } from './cache/cache.service';
import { ProblemFilter } from './common/problem.filter';
import { TraceMiddleware } from './common/trace.middleware';
import { APP_CONFIG, AppConfig, loadConfig } from './config';
import { DbService } from './db/db.service';
import { FlightSearchService } from './flights/flight-search.service';
import { FlightsController } from './flights/flights.controller';
import { FLIGHT_SUPPLIERS, SupplierRegistry } from './flights/supplier-registry';
import { HealthController } from './health.controller';
import { AccountsController } from './payments/accounts.controller';
import { LedgerService } from './payments/ledger.service';
import { PricingController } from './pricing/pricing.controller';
import { PricingService } from './pricing/pricing.service';
import { TenancyController } from './tenancy/tenancy.controller';
import { TenancyService } from './tenancy/tenancy.service';

/**
 * The core app: a modular monolith. Modules talk through their services' public methods and
 * own their own Postgres schema; any of them can be split into a service later.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => ({ secret: config.JWT_SECRET, signOptions: { expiresIn: '8h' } }),
      extraProviders: [{ provide: APP_CONFIG, useFactory: () => loadConfig() }],
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    TenancyController,
    PricingController,
    AccountsController,
    FlightsController,
    BookingsController,
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    // Real adapters (Amadeus, an NDC aggregator, own inventory) are added here as they are certified.
    { provide: FLIGHT_SUPPLIERS, useFactory: () => [new MockFlightSupplier({ priceChangeRoutes: ['NBO-MBA'] })] },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ProblemFilter },
    DbService,
    CacheService,
    AuthService,
    TenancyService,
    PricingService,
    LedgerService,
    SupplierRegistry,
    FlightSearchService,
    BookingService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceMiddleware).forRoutes('*path');
  }
}
