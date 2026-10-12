import { createHash } from 'crypto';
import {
  CallContext,
  InsuranceProvider,
  IssuedPolicy,
  PolicyCancelResult,
  PolicyIssueRequest,
  SupplierError,
  SupplierErrorCode,
} from '@tripwise/contracts';

/**
 * In-memory underwriter for development and tests. Issuing is idempotent per booking reference.
 *
 * Test hook: a traveller with last name POLICYFAIL makes issuing fail with BOOKING_FAILED.
 */
export class MockInsuranceProvider implements InsuranceProvider {
  readonly code: string;
  private readonly policies = new Map<string, { reference: string; status: 'active' | 'cancelled' }>();
  private readonly byReference = new Map<string, string>();

  constructor(options: { code?: string } = {}) {
    this.code = options.code ?? 'mockinsure';
  }

  async issue(req: PolicyIssueRequest, _ctx: CallContext): Promise<IssuedPolicy> {
    const existing = this.byReference.get(req.reference);
    if (existing) return { policyNumber: existing };
    if (req.travellers.some((t) => t.lastName.toUpperCase() === 'POLICYFAIL')) {
      throw new SupplierError(SupplierErrorCode.BOOKING_FAILED, 'The underwriter declined the application', this.code);
    }
    const digits = Number.parseInt(createHash('sha256').update(req.reference).digest('hex').slice(0, 10), 16) % 1e8;
    const policyNumber = `TI-${req.planCode.toUpperCase()}-${digits.toString().padStart(8, '0')}`;
    this.policies.set(policyNumber, { reference: req.reference, status: 'active' });
    this.byReference.set(req.reference, policyNumber);
    return { policyNumber };
  }

  async cancel(policyNumber: string, _ctx: CallContext): Promise<PolicyCancelResult> {
    // Unknown numbers are accepted: the mock forgets its policies when the API restarts.
    const p = this.policies.get(policyNumber);
    if (p) p.status = 'cancelled';
    return { cancelled: true };
  }
}
