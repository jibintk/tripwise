import { Inject, Injectable } from '@nestjs/common';
import { CallContext, FlightSupplier, SupplierError, SupplierErrorCode } from '@tripwise/contracts';
import { CircuitBreaker, withTimeout } from '@tripwise/supplier-gateway';

export const FLIGHT_SUPPLIERS = Symbol('FLIGHT_SUPPLIERS');

/**
 * Holds every enabled flight supplier with its own circuit breaker. All supplier calls go
 * through `call`, so timeouts and breakers apply everywhere, not just in search.
 */
@Injectable()
export class SupplierRegistry {
  private readonly breakers = new Map<string, CircuitBreaker>();
  private readonly byCode = new Map<string, FlightSupplier>();

  constructor(@Inject(FLIGHT_SUPPLIERS) readonly suppliers: FlightSupplier[]) {
    for (const s of suppliers) {
      this.byCode.set(s.code, s);
      this.breakers.set(s.code, new CircuitBreaker(s.code, { failureThreshold: 5, openMs: 30_000 }));
    }
  }

  get(code: string): FlightSupplier {
    const s = this.byCode.get(code);
    if (!s) throw new SupplierError(SupplierErrorCode.SUPPLIER_UNAVAILABLE, `Supplier ${code} is not enabled`, code);
    return s;
  }

  call<T>(code: string, ctx: CallContext, fn: (s: FlightSupplier) => Promise<T>): Promise<T> {
    const supplier = this.get(code);
    return this.breakers.get(code)!.call(() => withTimeout(code, ctx.timeoutMs, () => fn(supplier)));
  }
}
