import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { sql } from '../src/db/client.ts';
import { project } from '../src/app/projector.ts';
import {
  batchUnanchored,
  ledgerChecks,
  proveDecision,
  retryAnchor,
  submitPending,
  verifyBatch,
} from '../src/app/anchor.ts';
import { auditTrail } from '../src/app/audit.ts';
import { decisionLeaf, merkleRoot, verifyProof } from '../src/domain/merkle.ts';
import { LedgerConflictError, type LedgerPort } from '../src/lib/ledger.ts';
import { simulatedLedger } from '../src/sim/ledger.ts';
import { assertNoCompetingRelay, MERCHANT, createdEvent, event } from './helpers.ts';

/**
 * Ledger anchoring against real Postgres and the simulated ledger: batching is
 * once-per-decision by constraint, an anchored decision proves into a root the
 * ledger holds, and each way of rewriting history after the fact — editing a
 * decision, deleting one, rewriting a leaf, inventing an anchor — is caught
 * and named. The Drunix adapter is the same port; its network half is not
 * exercised here.
 */

/** 2035, outside every other suite's window and every seeded dataset. */
const BASE = Date.parse('2035-05-01T10:00:00.000Z');
const T = (m: number) => new Date(BASE + m * 60_000).toISOString();
const CUSTOMER = 'cus_ledger_p19';
const PAYMENT = 'pay_lg_p19_1';
const CASE = 'case_lg_p19_1';
const DECISIONS = ['pd_lg_p19_1', 'pd_lg_p19_2', 'pd_lg_p19_3', 'pd_lg_p19_4', 'pd_lg_p19_5'];

async function reset(): Promise<void> {
  const anchors = await sql<{ id: string; merkle_root: string }[]>`
    SELECT DISTINCT a.id, a.merkle_root FROM ledger_anchors a
    JOIN ledger_anchor_items i ON i.anchor_id = a.id
    WHERE i.decision_id LIKE 'pd_lg_%'`;
  if (anchors.length > 0) {
    await sql`DELETE FROM sim_ledger WHERE root IN ${sql(anchors.map((a) => a.merkle_root))}`;
    await sql`DELETE FROM ledger_anchors WHERE id IN ${sql(anchors.map((a) => a.id))}`;
  }
  await sql`DELETE FROM ledger_anchor_items WHERE decision_id LIKE 'pd_lg_%'`;
  await sql`DELETE FROM policy_decisions WHERE case_id LIKE 'case_lg_%'`;
  await sql`DELETE FROM recovery_cases WHERE id LIKE 'case_lg_%'`;
  await sql`DELETE FROM metrics_rollup WHERE bucket_start >= '2035-01-01' AND bucket_start < '2036-01-01'`;
  await sql`DELETE FROM payment_state_transitions WHERE payment_id LIKE 'pay_lg_%'`;
  await sql`DELETE FROM payment_events WHERE payment_id LIKE 'pay_lg_%'`;
  await sql`DELETE FROM outbox WHERE payload->>'payment_id' LIKE 'pay_lg_%'`;
  await sql`DELETE FROM payments WHERE id LIKE 'pay_lg_%'`;
  await sql`
    INSERT INTO customers (id, merchant_id, lifetime_value_paise)
    VALUES (${CUSTOMER}, ${MERCHANT}, 500000)
    ON CONFLICT (id) DO NOTHING`;
}

/** A failed payment, its case, and `n` decisions on it — the shape the gate writes. */
async function fixture(n = 3): Promise<string[]> {
  await project(createdEvent(PAYMENT, T(0), { customer_id: CUSTOMER, amount_paise: 480_000 }));
  await project(event(PAYMENT, 'payment.attempted', T(1)));
  await project(event(PAYMENT, 'payment.failed', T(2), { failure_code: 'THREEDS_FAILED' }));
  await sql`
    INSERT INTO recovery_cases (id, payment_id, merchant_id, status, chosen_strategy, expected_value_paise, opened_at)
    VALUES (${CASE}, ${PAYMENT}, ${MERCHANT}, 'OPEN', 'alternate_gateway', 250000, ${T(5)})`;
  const ids = DECISIONS.slice(0, n);
  for (const [i, id] of ids.entries()) {
    const reasons = { rules: [{ rule: 9, name: 'blast radius', passed: i % 2 === 0, verdict: 'DENY', detail: `attempt ${i}` }], deferred: i % 2 === 1 };
    await sql`
      INSERT INTO policy_decisions (id, case_id, proposed_action, verdict, reasons, policy_version, input_hash, decided_at)
      VALUES (${id}, ${CASE}, 'route_alternate_gateway', ${i % 2 === 0 ? 'ALLOW' : 'DENY'}, ${sql.json(reasons)},
              'v1.0.0', ${String(i).repeat(64)}, ${T(6 + i)})`;
  }
  return ids;
}

type DecisionRow = Record<string, unknown> & { decided_at: Date };
/** The leaf of a row as it stands in the database now. */
const leafOf = (row: DecisionRow) => decisionLeaf({ ...row, decided_at: row.decided_at.toISOString() } as unknown as Parameters<typeof decisionLeaf>[0]);

const anchorOf = async (decisionId: string) => {
  const [row] = await sql<{ anchor_id: string }[]>`SELECT anchor_id FROM ledger_anchor_items WHERE decision_id = ${decisionId}`;
  return row?.anchor_id ?? null;
};

/** Batch this suite's decisions and anchor them on the simulated ledger. */
async function anchorAll(ids: string[]): Promise<string> {
  await batchUnanchored('simulated', 256, 8, ids);
  const anchorId = (await anchorOf(ids[0]!))!;
  const r = await submitPending(simulatedLedger, 20, [anchorId]);
  expect(r.anchored).toBe(1);
  return anchorId;
}

/** A ledger that is down: every call fails the way an unreachable peer does. */
const downLedger: LedgerPort = {
  name: 'simulated',
  anchor: async () => {
    throw new Error('14 UNAVAILABLE: No connection established');
  },
  getAnchor: async () => {
    throw new Error('14 UNAVAILABLE: No connection established');
  },
  close: async () => {},
};

beforeAll(async () => {
  await assertNoCompetingRelay();
}, 30_000);
beforeEach(reset);
afterAll(reset);

describe('batching', () => {
  test('decisions are committed into one batch, in insertion order, with the root of their leaves', async () => {
    const ids = await fixture(3);
    const r = await batchUnanchored('simulated', 256, 8, ids);
    expect(r).toEqual({ batches: 1, decisions: 3 });

    const anchorId = (await anchorOf(ids[0]!))!;
    const [anchor] = await sql<{ merkle_root: string; leaf_count: number; status: string; first_decided_at: Date; last_decided_at: Date }[]>`
      SELECT * FROM ledger_anchors WHERE id = ${anchorId}`;
    const items = await sql<{ decision_id: string; leaf_index: number; leaf_hash: string }[]>`
      SELECT * FROM ledger_anchor_items WHERE anchor_id = ${anchorId} ORDER BY leaf_index`;
    expect(items.map((i) => i.decision_id)).toEqual(ids);
    expect(anchor!.leaf_count).toBe(3);
    expect(anchor!.status).toBe('PENDING');
    expect(anchor!.first_decided_at.toISOString()).toBe(T(6));
    expect(anchor!.last_decided_at.toISOString()).toBe(T(8));

    // The stored leaves are the leaves of the rows as written, and their root is the anchored root.
    const rows = await sql<DecisionRow[]>`SELECT * FROM policy_decisions WHERE id IN ${sql(ids)} ORDER BY id`;
    const leaves = rows.map(leafOf);
    expect(items.map((i) => i.leaf_hash)).toEqual(leaves);
    expect(anchor!.merkle_root).toBe(merkleRoot(leaves));
  });

  test('a decision is batched once — a second pass finds nothing', async () => {
    const ids = await fixture(3);
    await batchUnanchored('simulated', 256, 8, ids);
    expect(await batchUnanchored('simulated', 256, 8, ids)).toEqual({ batches: 0, decisions: 0 });
    const [items] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM ledger_anchor_items WHERE decision_id LIKE 'pd_lg_%'`;
    expect(items?.n).toBe(3);
  });

  test('the second item for a decision is refused by the primary key, not by an if', async () => {
    const ids = await fixture(1);
    await batchUnanchored('simulated', 256, 8, ids);
    const anchorId = (await anchorOf(ids[0]!))!;
    await expect(sql`
      INSERT INTO ledger_anchor_items (decision_id, anchor_id, leaf_index, leaf_hash)
      VALUES (${ids[0]!}, ${anchorId}, 7, ${'f'.repeat(64)})`).rejects.toThrow(/duplicate key|unique/i);
  });

  test('a full batch rolls straight into the next', async () => {
    const ids = await fixture(5);
    expect(await batchUnanchored('simulated', 2, 8, ids)).toEqual({ batches: 3, decisions: 5 });
    const sizes = await sql<{ leaf_count: number }[]>`
      SELECT a.leaf_count FROM ledger_anchors a
      WHERE a.id IN (SELECT anchor_id FROM ledger_anchor_items WHERE decision_id LIKE 'pd_lg_%')
      ORDER BY a.id`;
    expect(sizes.map((s) => s.leaf_count)).toEqual([2, 2, 1]);
  });
});

describe('anchoring and proof', () => {
  test('an anchored decision proves into a root the ledger holds', async () => {
    const ids = await fixture(3);
    const anchorId = await anchorAll(ids);

    const [a] = await sql<{ status: string; tx_id: string; block_number: number; attempts: number }[]>`SELECT * FROM ledger_anchors WHERE id = ${anchorId}`;
    expect(a!.status).toBe('ANCHORED');
    expect(a!.tx_id).toMatch(/^[0-9a-f]{64}$/);
    expect(a!.block_number).toBeGreaterThan(0);
    expect(a!.attempts).toBe(1);

    const p = await proveDecision(ids[1]!);
    expect(p.status).toBe('verified');
    expect(p.ok).toBe(true);
    expect(p.leaf_index).toBe(1);
    expect(p.on_chain?.txId).toBe(a!.tx_id);
    expect(verifyProof(p.leaf_hash, p.proof, p.anchor!.root)).toBe(true);

    const b = await verifyBatch(anchorId);
    expect(b.verified).toBe(true);
    expect(b.present).toBe(3);
  });

  test('anchoring a root twice is a no-op; the same root with different metadata is a conflict', async () => {
    const ids = await fixture(2);
    const anchorId = await anchorAll(ids);
    const [a] = await sql<{ merkle_root: string; tx_id: string; first_decided_at: Date; last_decided_at: Date }[]>`SELECT * FROM ledger_anchors WHERE id = ${anchorId}`;
    const payload = { root: a!.merkle_root, leafCount: 2, firstDecidedAt: a!.first_decided_at.toISOString(), lastDecidedAt: a!.last_decided_at.toISOString() };

    expect(await simulatedLedger.anchor(payload)).toEqual({ txId: a!.tx_id, blockNumber: null });
    await expect(simulatedLedger.anchor({ ...payload, leafCount: 3 })).rejects.toBeInstanceOf(LedgerConflictError);
    const [onLedger] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sim_ledger WHERE root = ${payload.root}`;
    expect(onLedger?.n).toBe(1);
  });

  test('before the ledger confirms, a decision is pending — not verified, not tampered', async () => {
    const ids = await fixture(2);
    await batchUnanchored('simulated', 256, 8, ids);
    const p = await proveDecision(ids[0]!);
    expect(p.status).toBe('pending');
    expect(p.ok).toBeNull();
  });
});

describe('rewriting history is caught', () => {
  test('a decision edited after anchoring no longer matches its leaf', async () => {
    const ids = await fixture(3);
    const anchorId = await anchorAll(ids);
    await sql`UPDATE policy_decisions SET verdict = 'ALLOW' WHERE id = ${ids[1]!}`;

    const p = await proveDecision(ids[1]!);
    expect(p.status).toBe('mismatch');
    expect(p.ok).toBe(false);
    expect(p.detail).toMatch(/changed after it was batched/);
    // Its neighbours still verify: tampering is localised to the row touched.
    expect((await proveDecision(ids[0]!)).ok).toBe(true);

    const b = await verifyBatch(anchorId);
    expect(b.verified).toBe(false);
    expect(b.changed).toEqual([ids[1]!]);
  });

  test('a decision deleted after anchoring shows up as missing from its batch', async () => {
    const ids = await fixture(3);
    const anchorId = await anchorAll(ids);
    await sql`DELETE FROM policy_decisions WHERE id = ${ids[2]!}`;

    const b = await verifyBatch(anchorId);
    expect(b.verified).toBe(false);
    expect(b.missing).toEqual([ids[2]!]);
    expect(b.present).toBe(2);
  });

  test('rewriting a stored leaf to match an edit breaks the batch root instead', async () => {
    const ids = await fixture(3);
    await anchorAll(ids);
    await sql`UPDATE policy_decisions SET verdict = 'ALLOW' WHERE id = ${ids[1]!}`;
    const [row] = await sql<DecisionRow[]>`SELECT * FROM policy_decisions WHERE id = ${ids[1]!}`;
    const forged = leafOf(row!);
    await sql`UPDATE ledger_anchor_items SET leaf_hash = ${forged} WHERE decision_id = ${ids[1]!}`;

    const p = await proveDecision(ids[1]!);
    expect(p.ok).toBe(false);
    expect(p.detail).toMatch(/no longer produce its root/);
  });

  test('an anchor record whose root the ledger never received is called out', async () => {
    const ids = await fixture(2);
    const anchorId = await anchorAll(ids);
    const [a] = await sql<{ merkle_root: string }[]>`SELECT merkle_root FROM ledger_anchors WHERE id = ${anchorId}`;
    await sql`DELETE FROM sim_ledger WHERE root = ${a!.merkle_root}`;

    const p = await proveDecision(ids[0]!);
    expect(p.status).toBe('mismatch');
    expect(p.detail).toMatch(/is not on simulated/);
    expect((await verifyBatch(anchorId)).verified).toBe(false);
  });

  test('the audit trail carries the check on every policy node', async () => {
    const ids = await fixture(3);
    await anchorAll(ids);
    await sql`UPDATE policy_decisions SET verdict = 'ALLOW' WHERE id = ${ids[1]!}`;

    const trail = await auditTrail(PAYMENT);
    const policy = trail.nodes.filter((n) => n.stage === 'policy');
    expect(policy).toHaveLength(3);
    expect(policy.find((n) => n.id === ids[0])?.ledger?.status).toBe('verified');
    expect(policy.find((n) => n.id === ids[1])?.ledger?.status).toBe('mismatch');
    expect(trail.anchored).toEqual({ decisions: 3, verified: 2, tampered: 1, unmeasured: 0 });
  });
});

describe('when the ledger misbehaves', () => {
  test('a transient failure keeps the batch pending, counts the attempt, and ends the pass', async () => {
    const ids = await fixture(4);
    await batchUnanchored('simulated', 2, 8, ids);
    const anchors = [...new Set([await anchorOf(ids[0]!), await anchorOf(ids[2]!)])] as string[];
    expect(anchors).toHaveLength(2);

    const r = await submitPending(downLedger, 20, anchors);
    // One call, not one per batch: an unreachable ledger costs one attempt a pass.
    expect(r).toEqual({ anchored: 0, retrying: 1, failed: 0 });
    const rows = await sql<{ status: string; attempts: number; last_error: string | null }[]>`
      SELECT status, attempts, last_error FROM ledger_anchors WHERE id IN ${sql(anchors)} ORDER BY attempts DESC`;
    expect(rows.map((x) => [x.status, x.attempts])).toEqual([['PENDING', 1], ['PENDING', 0]]);
    expect(rows[0]!.last_error).toMatch(/UNAVAILABLE/);

    // Least-tried first: the next pass tries the other batch, so one bad batch cannot block the queue.
    await submitPending(simulatedLedger, 20, anchors);
    const after = await sql<{ status: string }[]>`SELECT status FROM ledger_anchors WHERE id IN ${sql(anchors)}`;
    expect(after.every((x) => x.status === 'ANCHORED')).toBe(true);
  });

  test('a batch is FAILED after eight transient failures, and can be retried once fixed', async () => {
    const ids = await fixture(2);
    await batchUnanchored('simulated', 256, 8, ids);
    const anchorId = (await anchorOf(ids[0]!))!;

    for (let i = 0; i < 7; i += 1) expect((await submitPending(downLedger, 20, [anchorId])).retrying).toBe(1);
    expect(await submitPending(downLedger, 20, [anchorId])).toEqual({ anchored: 0, retrying: 0, failed: 1 });
    const [failed] = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM ledger_anchors WHERE id = ${anchorId}`;
    expect(failed).toEqual({ status: 'FAILED', attempts: 8 });
    expect((await proveDecision(ids[0]!)).status).toBe('failed');

    const retried = await retryAnchor(anchorId);
    expect(retried.status).toBe('PENDING');
    expect(retried.attempts).toBe(0);
    await expect(retryAnchor(anchorId)).rejects.toThrow(/only a FAILED anchor/);
    expect((await submitPending(simulatedLedger, 20, [anchorId])).anchored).toBe(1);
  });

  test('a conflict fails the batch at once — retrying cannot change what the ledger holds', async () => {
    const ids = await fixture(2);
    await batchUnanchored('simulated', 256, 8, ids);
    const anchorId = (await anchorOf(ids[0]!))!;
    const conflicting: LedgerPort = { ...downLedger, anchor: async () => { throw new LedgerConflictError('root already anchored with different metadata'); } };

    expect(await submitPending(conflicting, 20, [anchorId])).toEqual({ anchored: 0, retrying: 0, failed: 1 });
    const [row] = await sql<{ status: string; attempts: number }[]>`SELECT status, attempts FROM ledger_anchors WHERE id = ${anchorId}`;
    expect(row).toEqual({ status: 'FAILED', attempts: 1 });
  });

  test('a decision in no batch is reported as unanchored, never as verified or tampered', async () => {
    const ids = await fixture(1);
    const [row] = await sql<DecisionRow[]>`SELECT * FROM policy_decisions WHERE id = ${ids[0]!}`;
    const check = (await ledgerChecks([row as unknown as Parameters<typeof ledgerChecks>[0][number]])).get(ids[0]!)!;
    expect(check.status).toBe('unanchored');
    expect(check.ok).toBeNull();
  });
});
