import { config } from '../config.ts';

/**
 * The ledger port.
 *
 * Revenant anchors Merkle roots of its policy log to a ledger it does not
 * control alone, so a decision edited after the fact is detectable by someone
 * who does not have to trust this database. The ledger never holds a decision,
 * an amount or a customer — only a root, a leaf count and a time range.
 *
 * Two implementations sit behind it, chosen by `LEDGER_PROVIDER`:
 *
 *   simulated   sim/ledger.ts — a table in this database. Shows the flow and
 *               exercises every check; proves nothing to a third party.
 *   drunix      lib/drunix.ts — NPCI's Drunix (a Hyperledger Fabric 2.5 fork)
 *               through the Fabric Gateway client and the `revenant-anchor`
 *               chaincode in ledger/chaincode.
 *
 * `none` is the default and a first-class state, the same way the LLM is:
 * every other stage of the pipeline is identical with the ledger off.
 */

export type LedgerName = 'simulated' | 'drunix';
export type LedgerProvider = 'none' | LedgerName;

/** What goes on the ledger. Nothing else does. */
export interface AnchorPayload {
  root: string;
  leafCount: number;
  firstDecidedAt: string;
  lastDecidedAt: string;
}

export interface AnchorReceipt {
  txId: string;
  /** Null when the root was already on the ledger and this call committed nothing new. */
  blockNumber: number | null;
}

/** An anchor as the ledger reports it — the only copy verification trusts. */
export interface OnChainAnchor extends AnchorPayload {
  txId: string;
  /** Ledger time of the anchoring transaction. */
  anchoredAt: string;
  /** MSP that submitted it, where the ledger records one. */
  submitter: string | null;
}

export interface LedgerPort {
  readonly name: LedgerName;
  /**
   * Idempotent by root: anchoring a root that is already on the ledger with
   * the same metadata returns the original transaction and commits nothing.
   * The same root with different metadata is refused.
   */
  anchor(payload: AnchorPayload): Promise<AnchorReceipt>;
  /** `null` means the ledger answered and has no such root. Throws when it cannot answer. */
  getAnchor(root: string): Promise<OnChainAnchor | null>;
  close(): Promise<void>;
}

export interface LedgerStatus {
  enabled: boolean;
  provider: LedgerProvider;
  /** Why it is off, or what is wrong with it. Surfaced on /ready and in the UI. */
  reason?: string;
  /** Where anchors go, when on. */
  target?: string;
  /** The last error the anchorer saw talking to the ledger, cleared on success. */
  lastError?: string;
}

/**
 * The root is already on the ledger with different metadata. Not transient —
 * retrying cannot change what the ledger holds — so the anchorer fails the
 * batch at once instead of spending its retries. Classified by class, never by
 * message text (the same rule as domain/execution.ts).
 */
export class LedgerConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerConflictError';
  }
}

let lastError: string | null = null;

export function setLedgerError(message: string | null): void {
  lastError = message;
}

/** Same metadata or not — the one rule both adapters enforce on a repeated root. */
export function samePayload(a: AnchorPayload, b: AnchorPayload): boolean {
  return (
    a.root === b.root &&
    a.leafCount === b.leafCount &&
    Date.parse(a.firstDecidedAt) === Date.parse(b.firstDecidedAt) &&
    Date.parse(a.lastDecidedAt) === Date.parse(b.lastDecidedAt)
  );
}

/** Config-only and cheap: safe to call on every /ready probe. */
export function ledgerStatus(): LedgerStatus {
  const provider = config.LEDGER_PROVIDER;
  const err = lastError ? { lastError } : {};
  if (provider === 'none') {
    return { enabled: false, provider, reason: 'LEDGER_PROVIDER=none' };
  }
  if (provider === 'simulated') {
    return {
      enabled: true,
      provider,
      target: 'sim_ledger (this database)',
      reason: 'simulated — shows the flow, proves nothing to a third party',
      ...err,
    };
  }
  const missing = (
    [
      ['DRUNIX_TLS_CERT_PATH', config.DRUNIX_TLS_CERT_PATH],
      ['DRUNIX_CERT_PATH', config.DRUNIX_CERT_PATH],
      ['DRUNIX_KEY_PATH', config.DRUNIX_KEY_PATH],
    ] as const
  )
    .filter(([, v]) => v.length === 0)
    .map(([k]) => k);
  if (missing.length > 0) {
    return { enabled: false, provider, reason: `unset: ${missing.join(', ')}` };
  }
  return {
    enabled: true,
    provider,
    target: `${config.DRUNIX_CHAINCODE} on ${config.DRUNIX_CHANNEL} via ${config.DRUNIX_PEER_ENDPOINT} as ${config.DRUNIX_MSP_ID}`,
    ...err,
  };
}
