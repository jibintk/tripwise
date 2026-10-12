import { Inject, Injectable } from '@nestjs/common';
import { CallContext, FlightSupplier, HotelSupplier, InsuranceProvider, SupplierError, SupplierErrorCode } from '@tripwise/contracts';
import { CircuitBreaker, withTimeout } from '@tripwise/supplier-gateway';

export const FLIGHT_SUPPLIERS = Symbol('FLIGHT_SUPPLIERS');
export const HOTEL_SUPPLIERS = Symbol('HOTEL_SUPPLIERS');
export const INSURANCE_PROVIDERS = Symbol('INSURANCE_PROVIDERS');

/**
 * A set of suppliers of one product, each behind its own circuit breaker. Every supplier call
 * goes through `call`, so timeouts and breakers apply everywhere, not just in search.
 */
export class SupplierPool<T extends { code: string }> {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly byCode = new Map<string, T>();

  constructor(readonly suppliers: T[]) {
    for (const s of suppliers) {
      this.byCode.set(s.code, s);
      this.breakers.set(s.code, new CircuitBreaker(s.code, { failureThreshold: 5, openMs: 30_000 }));
    }
  }

  get(code: string): T {
    const s = this.byCode.get(code);
    if (!s) throw new SupplierError(SupplierErrorCode.SUPPLIER_UNAVAILABLE, `Supplier ${code} is not enabled`, code);
    return s;
  }

  call<R>(code: string, ctx: CallContext, fn: (s: T) => Promise<R>): Promise<R> {
    const supplier = this.get(code);
    return this.breakers.get(code)!.call(() => withTimeout(code, ctx.timeoutMs, () => fn(supplier)));
  }
}

@Injectable()
export class SupplierRegistry extends SupplierPool<FlightSupplier> {
  constructor(@Inject(FLIGHT_SUPPLIERS) suppliers: FlightSupplier[]) {
    super(suppliers);
  }
}

@Injectable()
export class HotelSupplierRegistry extends SupplierPool<HotelSupplier> {
  constructor(@Inject(HOTEL_SUPPLIERS) suppliers: HotelSupplier[]) {
    super(suppliers);
  }
}

@Injectable()
export class InsuranceProviderRegistry extends SupplierPool<InsuranceProvider> {
  constructor(@Inject(INSURANCE_PROVIDERS) providers: InsuranceProvider[]) {
    super(providers);
  }
}
