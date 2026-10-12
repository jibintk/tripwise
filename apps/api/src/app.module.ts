import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { MockFlightSupplier, MockHotelSupplier, MockInsuranceProvider } from '@tripwise/supplier-gateway';
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
import {
  FLIGHT_SUPPLIERS,
  HOTEL_SUPPLIERS,
  HotelSupplierRegistry,
  INSURANCE_PROVIDERS,
  InsuranceProviderRegistry,
  SupplierRegistry,
} from './flights/supplier-registry';
import { InsuranceController } from './insurance/insurance.controller';
import { InsuranceService } from './insurance/insurance.service';
import { InventoryController } from './inventory/inventory.controller';
import { InventoryService } from './inventory/inventory.service';
import { OwnInventorySupplier } from './inventory/own-inventory.supplier';
import { HotelContentService } from './hotels/hotel-content.service';
import { HotelSearchService } from './hotels/hotel-search.service';
import { HotelsController } from './hotels/hotels.controller';
import { ApprovalService } from './corporate/approval.service';
import { ApprovalsController, CorporateController } from './corporate/corporate.controller';
import { CorporateService } from './corporate/corporate.service';
import { HealthController } from './health.controller';
import { OpsController } from './bookings/ops.controller';
import { OutboxService } from './events/outbox.service';
import { JobsService } from './jobs/jobs.service';
import { NotificationService } from './notify/notification.service';
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
    OpsController,
    HotelsController,
    CorporateController,
    ApprovalsController,
    InventoryController,
    InsuranceController,
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    // Real adapters (Amadeus, an NDC aggregator) are added here as they are certified. Own inventory is always on.
    {
      provide: FLIGHT_SUPPLIERS,
      inject: [OwnInventorySupplier],
      useFactory: (own: OwnInventorySupplier) => [new MockFlightSupplier({ priceChangeRoutes: ['NBO-MBA'] }), own],
    },
    { provide: INSURANCE_PROVIDERS, useFactory: () => [new MockInsuranceProvider()] },
    // Two mock hotel suppliers that overlap, so content mapping and best-rate selection are exercised.
    {
      provide: HOTEL_SUPPLIERS,
      useFactory: () => [
        new MockHotelSupplier({ variant: 'a', priceChangeCities: ['MBA'] }),
        new MockHotelSupplier({ variant: 'b', priceChangeCities: ['MBA'] }),
      ],
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ProblemFilter },
    DbService,
    CacheService,
    AuthService,
    TenancyService,
    PricingService,
    LedgerService,
    SupplierRegistry,
    HotelSupplierRegistry,
    HotelContentService,
    HotelSearchService,
    FlightSearchService,
    BookingService,
    OutboxService,
    NotificationService,
    JobsService,
    CorporateService,
    ApprovalService,
    OwnInventorySupplier,
    InventoryService,
    InsuranceProviderRegistry,
    InsuranceService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TraceMiddleware).forRoutes('*path');
  }
}
