import { Money } from './money';
import { CallContext } from './supplier';

export type InsuranceRegion = 'east_africa' | 'africa' | 'worldwide';

export interface InsuredTraveller {
  title: 'MR' | 'MRS' | 'MS' | 'MSTR' | 'MISS';
  firstName: string;
  lastName: string;
  dateOfBirth: string; // YYYY-MM-DD
  documentNumber?: string;
}

/** What the underwriter needs to issue a policy. The premium was quoted from agreed net rates. */
export interface PolicyIssueRequest {
  planCode: string;
  region: InsuranceRegion;
  startDate: string; // YYYY-MM-DD, first day of cover
  endDate: string; // YYYY-MM-DD, last day of cover
  travellers: InsuredTraveller[];
  premium: Money;
  /** Our booking reference, so a retried call never issues a second policy. */
  reference: string;
}

export interface IssuedPolicy {
  policyNumber: string;
}

export interface PolicyCancelResult {
  cancelled: boolean;
}

/**
 * Every insurer integration implements this. Plans and net rates are agreed commercially and kept
 * in our own catalogue, so the interface covers only issuing and cancelling policies.
 */
export interface InsuranceProvider {
  readonly code: string;
  issue(req: PolicyIssueRequest, ctx: CallContext): Promise<IssuedPolicy>;
  /** Cancels a policy before cover starts (the free-look period). */
  cancel(policyNumber: string, ctx: CallContext): Promise<PolicyCancelResult>;
}
