import { SupplierError, SupplierErrorCode } from '@tripwise/contracts';

/** Rejects with SUPPLIER_TIMEOUT if the call does not settle within timeoutMs. */
export async function withTimeout<T>(supplier: string, timeoutMs: number, call: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SupplierError(SupplierErrorCode.SUPPLIER_TIMEOUT, `No answer within ${timeoutMs} ms`, supplier)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type BreakerState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long the circuit stays open before one trial call is allowed. */
  openMs: number;
  now?: () => number;
}

/**
 * One breaker per supplier. While open, calls fail fast with SUPPLIER_UNAVAILABLE so a dead
 * supplier never slows down search or booking for the others.
 * Business errors (sold out, price changed, invalid data) do not count as failures.
 */
export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private failures = 0;
  private openedAt = 0;
  private readonly now: () => number;

  constructor(
    private readonly supplier: string,
    private readonly options: CircuitBreakerOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  get currentState(): BreakerState {
    if (this.state === 'open' && this.now() - this.openedAt >= this.options.openMs) {
      return 'half-open';
    }
    return this.state;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.currentState;
    if (state === 'open') {
      throw new SupplierError(SupplierErrorCode.SUPPLIER_UNAVAILABLE, 'Circuit open', this.supplier);
    }
    try {
      const result = await fn();
      this.state = 'closed';
      this.failures = 0;
      return result;
    } catch (err) {
      if (isInfrastructureFailure(err)) {
        this.failures += 1;
        if (state === 'half-open' || this.failures >= this.options.failureThreshold) {
          this.state = 'open';
          this.openedAt = this.now();
        }
      }
      throw err;
    }
  }
}

const BUSINESS_ERRORS: ReadonlySet<string> = new Set([
  SupplierErrorCode.PRICE_CHANGED,
  SupplierErrorCode.SOLD_OUT,
  SupplierErrorCode.HOLD_EXPIRED,
  SupplierErrorCode.INVALID_PASSENGER_DATA,
]);

function isInfrastructureFailure(err: unknown): boolean {
  return !(err instanceof SupplierError && BUSINESS_ERRORS.has(err.code));
}
