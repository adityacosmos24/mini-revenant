import { randomBytes } from 'node:crypto';
import { sql } from '../db/client.ts';
import { LedgerConflictError, samePayload, type AnchorPayload, type AnchorReceipt, type LedgerPort, type OnChainAnchor } from '../lib/ledger.ts';

/**
 * The simulated ledger (`LEDGER_PROVIDER=simulated`).
 *
 * Stands in for Drunix the way sim/gateway.ts stands in for the processor:
 * same port, same idempotency contract, so the anchorer, the proofs and the
 * verification on /audit run unchanged against either. What it cannot do is
 * the point of the real one — it lives in the database it attests to, so an
 * operator who can rewrite a decision can rewrite this table too. It is
 * labelled `simulated` everywhere it shows.
 *
 * Idempotent by constraint, never by `if (exists)` (invariant 2): `root` is
 * UNIQUE, the insert is ON CONFLICT DO NOTHING, and a conflict reads the
 * original back.
 */

interface SimRow {
  block_number: number;
  tx_id: string;
  root: string;
  leaf_count: number;
  first_decided_at: Date;
  last_decided_at: Date;
  committed_at: Date;
}

const toAnchor = (r: SimRow): OnChainAnchor => ({
  root: r.root,
  leafCount: r.leaf_count,
  firstDecidedAt: r.first_decided_at.toISOString(),
  lastDecidedAt: r.last_decided_at.toISOString(),
  txId: r.tx_id,
  anchoredAt: r.committed_at.toISOString(),
  submitter: null,
});

async function getAnchor(root: string): Promise<OnChainAnchor | null> {
  const [row] = await sql<SimRow[]>`SELECT * FROM sim_ledger WHERE root = ${root}`;
  return row ? toAnchor(row) : null;
}

export const simulatedLedger: LedgerPort = {
  name: 'simulated',

  async anchor(p: AnchorPayload): Promise<AnchorReceipt> {
    const [inserted] = await sql<SimRow[]>`
      INSERT INTO sim_ledger (tx_id, root, leaf_count, first_decided_at, last_decided_at)
      VALUES (${randomBytes(32).toString('hex')}, ${p.root}, ${p.leafCount}, ${p.firstDecidedAt}, ${p.lastDecidedAt})
      ON CONFLICT (root) DO NOTHING
      RETURNING *`;
    if (inserted) return { txId: inserted.tx_id, blockNumber: inserted.block_number };

    const existing = await getAnchor(p.root);
    if (!existing) throw new Error(`root ${p.root.slice(0, 12)}… conflicted but cannot be read back`);
    if (!samePayload(existing, p)) {
      throw new LedgerConflictError(`root ${p.root.slice(0, 12)}… is already anchored with different metadata (tx ${existing.txId})`);
    }
    return { txId: existing.txId, blockNumber: null };
  },

  getAnchor,

  async close(): Promise<void> {
    // Shares the process pool; nothing of its own to release.
  },
};
