import { randomUUID } from 'node:crypto';
import { config } from '../config.ts';
import { sql } from '../db/client.ts';
import { decisionLeaf, merkleProof, merkleRoot, verifyProof, type DecisionRecord, type ProofStep } from '../domain/merkle.ts';
import { describeError, NotFoundError, ValidationError } from '../lib/errors.ts';
import {
  LedgerConflictError,
  ledgerStatus,
  setLedgerError,
  type AnchorPayload,
  type LedgerName,
  type LedgerPort,
  type OnChainAnchor,
} from '../lib/ledger.ts';
import { log } from '../lib/logger.ts';
import { simulatedLedger } from '../sim/ledger.ts';

/**
 * Anchoring the policy log to a ledger (optional; `LEDGER_PROVIDER`).
 *
 * Two halves, deliberately separate:
 *
 *  1. **Batch** — local, transactional, never waits on the ledger. Decisions
 *     not yet in any batch are taken in insertion order, hashed into leaves
 *     (domain/merkle.ts), and committed as one `ledger_anchors` row plus one
 *     `ledger_anchor_items` row per decision, in one transaction. The decision
 *     PK on the items table makes "anchored at most once" a constraint.
 *  2. **Submit** — each PENDING batch's root goes to the ledger. A crash
 *     between the ledger committing and our UPDATE is reconciled on the next
 *     attempt, because both adapters are idempotent by root.
 *
 * Neither half sits on the decision path. A ledger that is down, slow or
 * misconfigured delays the *evidence*, never a decision or an action — the
 * gate does not wait for it, and the policy log is complete without it.
 *
 * Verification is recomputed on request, never cached: the leaf from the
 * decision row as it is now, the root from the batch's stored leaves, and the
 * root's presence on the ledger itself. Only the ledger copy is trusted.
 */

const ANCHOR_LOCK_KEY = 0x414e4352; // 'ANCR'
/** Transient failures before a batch is FAILED. Conflicts fail at once. */
const MAX_ATTEMPTS = 8;
const MAX_BATCHES_PER_TICK = 8;
const MAX_SUBMITS_PER_TICK = 20;
/** Longest the loop backs off while the ledger keeps failing. */
const MAX_BACKOFF_MS = 5 * 60_000;

const anchorId = () => `anc_${Date.now().toString(36).padStart(9, '0')}${randomUUID().slice(0, 6)}`;

/** TIMESTAMPTZ arrives as a Date from the driver; leaves commit to ISO strings. */
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

interface DecisionRow {
  id: string;
  case_id: string;
  proposed_action: string;
  verdict: string;
  reasons: unknown;
  policy_version: string;
  input_hash: string;
  decided_at: Date | string;
}

export interface AnchorRow {
  id: string;
  ledger: LedgerName;
  merkle_root: string;
  leaf_count: number;
  first_decided_at: Date;
  last_decided_at: Date;
  status: 'PENDING' | 'ANCHORED' | 'FAILED';
  attempts: number;
  tx_id: string | null;
  block_number: number | null;
  last_error: string | null;
  created_at: Date;
  anchored_at: Date | null;
}

interface ItemRow {
  decision_id: string;
  anchor_id: string;
  leaf_index: number;
  leaf_hash: string;
}

const toRecord = (r: DecisionRow): DecisionRecord => ({
  id: r.id,
  case_id: r.case_id,
  proposed_action: r.proposed_action,
  verdict: r.verdict,
  reasons: r.reasons,
  policy_version: r.policy_version,
  input_hash: r.input_hash,
  decided_at: iso(r.decided_at),
});

const payloadOf = (a: AnchorRow): AnchorPayload => ({
  root: a.merkle_root,
  leafCount: a.leaf_count,
  firstDecidedAt: iso(a.first_decided_at),
  lastDecidedAt: iso(a.last_decided_at),
});

// ── Ports ─────────────────────────────────────────────────────────────────────

let drunix: Promise<LedgerPort> | null = null;

/** Connected once and reused. A failed connect is not cached, so the next tick retries it. */
function drunixPort(): Promise<LedgerPort> {
  if (!drunix) {
    drunix = import('../lib/drunix.ts')
      .then((m) =>
        m.connectDrunix({
          endpoint: config.DRUNIX_PEER_ENDPOINT,
          hostAlias: config.DRUNIX_PEER_HOST_ALIAS,
          tlsCertPath: config.DRUNIX_TLS_CERT_PATH,
          mspId: config.DRUNIX_MSP_ID,
          certPath: config.DRUNIX_CERT_PATH,
          keyPath: config.DRUNIX_KEY_PATH,
          channel: config.DRUNIX_CHANNEL,
          chaincode: config.DRUNIX_CHAINCODE,
          timeoutMs: config.LEDGER_TIMEOUT_MS,
        }),
      )
      .catch((err: unknown) => {
        drunix = null;
        throw err;
      });
  }
  return drunix;
}

/** The port anchors are written to, or null with the ledger off or misconfigured. */
export async function activeLedger(): Promise<LedgerPort | null> {
  if (!ledgerStatus().enabled) return null;
  return config.LEDGER_PROVIDER === 'drunix' ? drunixPort() : simulatedLedger;
}

/**
 * The port that can answer for an anchor already written. The simulated
 * ledger is a table, so it can always be read; a Drunix anchor can only be
 * checked where Drunix is configured.
 */
async function portFor(ledger: LedgerName): Promise<LedgerPort | null> {
  if (ledger === 'simulated') return simulatedLedger;
  return config.LEDGER_PROVIDER === 'drunix' && ledgerStatus().enabled ? drunixPort() : null;
}

// ── 1. Batch ──────────────────────────────────────────────────────────────────

export interface BatchResult {
  batches: number;
  decisions: number;
}

/**
 * Commits unbatched decisions into Merkle batches for `ledger`. Local only.
 * Concurrent callers are serialised by an advisory lock; a caller that does
 * not get it returns at once rather than queueing behind it.
 *
 * `onlyDecisions` scopes the worklist — a test's own rows — instead of the
 * whole log, the same way `onlyCases` scopes the gate.
 */
export async function batchUnanchored(
  ledger: LedgerName,
  batchSize = config.LEDGER_BATCH_SIZE,
  maxBatches = MAX_BATCHES_PER_TICK,
  onlyDecisions?: string[],
): Promise<BatchResult> {
  const result: BatchResult = { batches: 0, decisions: 0 };

  for (let b = 0; b < maxBatches; b += 1) {
    const made = await sql.begin(async (tx) => {
      const [lock] = await tx<{ locked: boolean }[]>`SELECT pg_try_advisory_xact_lock(${ANCHOR_LOCK_KEY}) AS locked`;
      if (!lock?.locked) return 0;

      // Insertion order: decision ids carry the wall clock (app/policy.ts).
      const rows = await tx<DecisionRow[]>`
        SELECT d.id, d.case_id, d.proposed_action, d.verdict, d.reasons, d.policy_version, d.input_hash, d.decided_at
        FROM policy_decisions d
        WHERE NOT EXISTS (SELECT 1 FROM ledger_anchor_items i WHERE i.decision_id = d.id)
          ${onlyDecisions ? tx`AND d.id IN ${tx(onlyDecisions)}` : tx``}
        ORDER BY d.id
        LIMIT ${batchSize}`;
      if (rows.length === 0) return 0;

      const records = rows.map(toRecord);
      const leaves = records.map(decisionLeaf);
      const times = records.map((r) => r.decided_at).sort();
      const id = anchorId();

      await tx`
        INSERT INTO ledger_anchors (id, ledger, merkle_root, leaf_count, first_decided_at, last_decided_at)
        VALUES (${id}, ${ledger}, ${merkleRoot(leaves)}, ${leaves.length}, ${times[0]!}, ${times[times.length - 1]!})`;
      await tx`
        INSERT INTO ledger_anchor_items ${tx(
          records.map((r, i) => ({ decision_id: r.id, anchor_id: id, leaf_index: i, leaf_hash: leaves[i]! })),
        )}`;
      return rows.length;
    });

    if (made === 0) break;
    result.batches += 1;
    result.decisions += made;
    if (made < batchSize) break;
  }

  if (result.batches > 0) log.info('ledger batches committed', { ledger, ...result });
  return result;
}

// ── 2. Submit ─────────────────────────────────────────────────────────────────

export interface SubmitResult {
  anchored: number;
  retrying: number;
  failed: number;
}

/**
 * Sends PENDING roots to the ledger. Least-tried first, so a batch the ledger
 * keeps refusing sinks behind fresh ones instead of blocking them; and the
 * first transient failure ends the pass, so an unreachable ledger costs one
 * call per tick, not one per batch.
 *
 * The row lock is held across the ledger call. A second process skips the
 * batch rather than submitting it twice — and if it did, the ledger's
 * idempotency by root would make the second call a no-op.
 */
export async function submitPending(
  port: LedgerPort,
  limit = MAX_SUBMITS_PER_TICK,
  onlyAnchors?: string[],
): Promise<SubmitResult> {
  const result: SubmitResult = { anchored: 0, retrying: 0, failed: 0 };
  const queue = await sql<{ id: string }[]>`
    SELECT id FROM ledger_anchors
    WHERE status = 'PENDING' AND ledger = ${port.name}
      ${onlyAnchors ? sql`AND id IN ${sql(onlyAnchors)}` : sql``}
    ORDER BY attempts, created_at, id
    LIMIT ${limit}`;

  for (const { id } of queue) {
    const outcome = await sql.begin(async (tx) => {
      const [a] = await tx<AnchorRow[]>`
        SELECT * FROM ledger_anchors WHERE id = ${id} AND status = 'PENDING' FOR UPDATE SKIP LOCKED`;
      if (!a) return 'skipped' as const;

      const attempts = a.attempts + 1;
      try {
        const receipt = await port.anchor(payloadOf(a));
        await tx`
          UPDATE ledger_anchors
          SET status = 'ANCHORED', tx_id = ${receipt.txId}, block_number = ${receipt.blockNumber},
              attempts = ${attempts}, last_error = NULL, anchored_at = now()
          WHERE id = ${id}`;
        log.info('ledger anchored', {
          anchorId: id,
          ledger: port.name,
          root: a.merkle_root,
          leaves: a.leaf_count,
          txId: receipt.txId,
          block: receipt.blockNumber,
        });
        return 'anchored' as const;
      } catch (err) {
        const reason = describeError(err);
        const conflict = err instanceof LedgerConflictError;
        const failed = conflict || attempts >= MAX_ATTEMPTS;
        await tx`
          UPDATE ledger_anchors
          SET attempts = ${attempts}, last_error = ${reason}, status = ${failed ? 'FAILED' : 'PENDING'}
          WHERE id = ${id}`;
        log[failed ? 'error' : 'warn']('ledger anchor failed', { anchorId: id, ledger: port.name, attempts, conflict, failed, err });
        setLedgerError(reason);
        return conflict ? ('conflict' as const) : failed ? ('failed' as const) : ('retrying' as const);
      }
    });

    if (outcome === 'anchored') result.anchored += 1;
    else if (outcome === 'conflict') result.failed += 1; // specific to that batch; carry on with the rest
    else if (outcome === 'failed') {
      result.failed += 1;
      break;
    } else if (outcome === 'retrying') {
      result.retrying += 1;
      break;
    }
  }

  if (result.anchored > 0 && result.retrying === 0) setLedgerError(null);
  return result;
}

// ── The loop ──────────────────────────────────────────────────────────────────

export interface AnchorTickResult {
  ledger: LedgerName;
  batched: BatchResult;
  submitted: SubmitResult;
}

/** One pass: batch, then submit. Exported for tests and `POST /api/v1/ledger/anchor`. */
export async function anchorOnce(): Promise<AnchorTickResult> {
  const status = ledgerStatus();
  if (!status.enabled) {
    throw new ValidationError(`the ledger is off — ${status.reason ?? 'LEDGER_PROVIDER=none'}`, { provider: status.provider });
  }
  const ledger: LedgerName = config.LEDGER_PROVIDER === 'drunix' ? 'drunix' : 'simulated';
  const batched = await batchUnanchored(ledger);

  let port: LedgerPort;
  try {
    port = (await activeLedger())!;
  } catch (err) {
    // Cannot connect (missing cert, bad key, unreachable peer): the batches
    // are committed locally and wait, PENDING, for the next tick.
    setLedgerError(`connect: ${describeError(err)}`);
    throw err;
  }
  const submitted = await submitPending(port);
  return { ledger, batched, submitted };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let stopped = true;

/**
 * Self-scheduling, like the relay. Backs off exponentially while the ledger
 * keeps failing — an outage is retried at a falling rate rather than burning
 * every batch's attempts in a minute — and returns to the base interval on
 * the first clean pass.
 */
export function startAnchorer(intervalMs = config.LEDGER_INTERVAL_MS): void {
  const status = ledgerStatus();
  if (!status.enabled) {
    log.info('ledger anchoring off', { provider: status.provider, reason: status.reason });
    return;
  }
  stopped = false;
  let failures = 0;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const r = await anchorOnce();
      failures = r.submitted.retrying > 0 ? failures + 1 : 0;
    } catch (err) {
      failures += 1;
      log.warn('ledger tick failed', { err, failures });
    } finally {
      running = false;
      const delay = Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.min(failures, 16));
      if (!stopped) timer = setTimeout(() => void tick(), delay);
    }
  };
  timer = setTimeout(() => void tick(), intervalMs);
  log.info('ledger anchoring started', { provider: status.provider, target: status.target, intervalMs, batchSize: config.LEDGER_BATCH_SIZE });
}

/** Lets an in-flight pass finish, then closes the ledger connection. */
export async function stopAnchorer(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  const deadline = Date.now() + 3000;
  while (running && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (drunix) {
    try {
      await (await drunix).close();
    } catch {
      // Never connected; nothing to close.
    }
    drunix = null;
  }
}

// ── Verification ─────────────────────────────────────────────────────────────

export type LedgerCheckStatus = 'verified' | 'mismatch' | 'pending' | 'failed' | 'unanchored' | 'unavailable';

export interface AnchorSummary {
  id: string;
  ledger: LedgerName;
  root: string;
  leaf_count: number;
  status: AnchorRow['status'];
  tx_id: string | null;
  block_number: number | null;
  anchored_at: string | null;
  attempts: number;
  last_error: string | null;
}

export interface LedgerCheck {
  status: LedgerCheckStatus;
  /** true: proven against the ledger. false: evidence of tampering. null: not measured, and why. */
  ok: boolean | null;
  detail: string;
  /** The leaf recomputed from the decision row as it is now. */
  leaf_hash: string;
  leaf_index: number | null;
  proof: ProofStep[];
  anchor: AnchorSummary | null;
  on_chain: OnChainAnchor | null;
}

const summarise = (a: AnchorRow): AnchorSummary => ({
  id: a.id,
  ledger: a.ledger,
  root: a.merkle_root,
  leaf_count: a.leaf_count,
  status: a.status,
  tx_id: a.tx_id,
  block_number: a.block_number,
  anchored_at: a.anchored_at ? iso(a.anchored_at) : null,
  attempts: a.attempts,
  last_error: a.last_error,
});

const short = (h: string) => `${h.slice(0, 10)}…`;

interface AnchorEvidence {
  row: AnchorRow;
  leaves: string[];
  /** The batch's stored leaves still produce the root it anchored. */
  rootOk: boolean;
  /** undefined: not looked up (not anchored yet). null: the ledger has no such root. */
  onChain: OnChainAnchor | null | undefined;
  onChainError: string | null;
}

async function evidenceFor(anchorIds: string[]): Promise<Map<string, AnchorEvidence>> {
  const out = new Map<string, AnchorEvidence>();
  if (anchorIds.length === 0) return out;
  const [anchors, items] = await Promise.all([
    sql<AnchorRow[]>`SELECT * FROM ledger_anchors WHERE id IN ${sql(anchorIds)}`,
    sql<ItemRow[]>`SELECT * FROM ledger_anchor_items WHERE anchor_id IN ${sql(anchorIds)} ORDER BY anchor_id, leaf_index`,
  ]);

  await Promise.all(
    anchors.map(async (a) => {
      const own = items.filter((i) => i.anchor_id === a.id);
      const leaves = own.map((i) => i.leaf_hash);
      // A deleted item leaves a gap in the indices; a gap means the stored
      // leaves are no longer the batch that was anchored.
      const contiguous = own.length === a.leaf_count && own.every((i, n) => i.leaf_index === n);
      const rootOk = contiguous && merkleRoot(leaves) === a.merkle_root;

      let onChain: OnChainAnchor | null | undefined;
      let onChainError: string | null = null;
      if (a.status === 'ANCHORED') {
        try {
          const port = await portFor(a.ledger);
          if (port) onChain = await port.getAnchor(a.merkle_root);
          else onChainError = `anchored on ${a.ledger}, which is not configured on this instance`;
        } catch (err) {
          onChainError = describeError(err);
        }
      }
      out.set(a.id, { row: a, leaves, rootOk, onChain, onChainError });
    }),
  );
  return out;
}

function judge(row: DecisionRow, item: ItemRow | undefined, ev: AnchorEvidence | undefined): LedgerCheck {
  const leaf = decisionLeaf(toRecord(row));
  const base = { leaf_hash: leaf, leaf_index: item?.leaf_index ?? null, proof: [] as ProofStep[], anchor: ev ? summarise(ev.row) : null, on_chain: ev?.onChain ?? null };

  if (!item || !ev) {
    const status = ledgerStatus();
    return {
      ...base,
      status: 'unanchored',
      ok: null,
      detail: status.enabled
        ? `not yet in a batch — the anchorer runs every ${Math.round(config.LEDGER_INTERVAL_MS / 1000)} s`
        : `not anchored — ${status.reason ?? 'ledger off'}`,
    };
  }

  const a = ev.row;
  const proof = ev.rootOk ? merkleProof(ev.leaves, item.leaf_index) : [];
  const withProof = { ...base, proof };

  if (leaf !== item.leaf_hash) {
    return { ...withProof, status: 'mismatch', ok: false, detail: `this decision no longer hashes to the leaf anchored for it (${short(leaf)} vs ${short(item.leaf_hash)}) — the row was changed after it was batched` };
  }
  if (!ev.rootOk) {
    return { ...withProof, status: 'mismatch', ok: false, detail: `batch ${a.id}'s stored leaves no longer produce its root ${short(a.merkle_root)} — the anchor records were changed` };
  }
  if (!verifyProof(leaf, proof, a.merkle_root)) {
    return { ...withProof, status: 'mismatch', ok: false, detail: `the inclusion proof does not fold to root ${short(a.merkle_root)}` };
  }
  if (a.status === 'PENDING') {
    return { ...withProof, status: 'pending', ok: null, detail: `in batch ${a.id} (root ${short(a.merkle_root)}), waiting for ${a.ledger}${a.attempts > 0 ? ` — ${a.attempts} attempt${a.attempts === 1 ? '' : 's'}, last error: ${a.last_error ?? 'none'}` : ''}` };
  }
  if (a.status === 'FAILED') {
    return { ...withProof, status: 'failed', ok: null, detail: `batch ${a.id} could not be anchored on ${a.ledger} after ${a.attempts} attempt${a.attempts === 1 ? '' : 's'}: ${a.last_error ?? 'unknown error'}` };
  }
  if (ev.onChainError !== null) {
    return { ...withProof, status: 'unavailable', ok: null, detail: `leaf and proof check out against root ${short(a.merkle_root)}, but ${a.ledger} could not be asked: ${ev.onChainError}` };
  }
  const c = ev.onChain;
  if (!c) {
    return { ...withProof, status: 'mismatch', ok: false, detail: `root ${short(a.merkle_root)} is not on ${a.ledger} — the anchor record here claims tx ${a.tx_id ?? '?'}, which the ledger does not have` };
  }
  if (c.leafCount !== a.leaf_count) {
    return { ...withProof, status: 'mismatch', ok: false, detail: `${a.ledger} holds root ${short(a.merkle_root)} for ${c.leafCount} decisions; the batch here has ${a.leaf_count}` };
  }
  return {
    ...withProof,
    status: 'verified',
    ok: true,
    detail: `leaf → root ${short(a.merkle_root)} in ${proof.length} step${proof.length === 1 ? '' : 's'}; root found on ${a.ledger}, tx ${short(c.txId)}${a.block_number !== null ? `, block ${a.block_number}` : ''}`,
  };
}

/**
 * The ledger check for each decision passed in, keyed by decision id. One
 * ledger read per distinct batch, not per decision.
 */
export async function ledgerChecks(rows: DecisionRow[]): Promise<Map<string, LedgerCheck>> {
  const out = new Map<string, LedgerCheck>();
  if (rows.length === 0) return out;
  const items = await sql<ItemRow[]>`SELECT * FROM ledger_anchor_items WHERE decision_id IN ${sql(rows.map((r) => r.id))}`;
  const evidence = await evidenceFor([...new Set(items.map((i) => i.anchor_id))]);
  for (const r of rows) {
    const item = items.find((i) => i.decision_id === r.id);
    out.set(r.id, judge(r, item, item ? evidence.get(item.anchor_id) : undefined));
  }
  return out;
}

/** `GET /api/v1/ledger/decisions/:id` — one decision's proof, checked now. */
export async function proveDecision(decisionId: string): Promise<LedgerCheck & { decision_id: string; case_id: string }> {
  const [row] = await sql<DecisionRow[]>`
    SELECT id, case_id, proposed_action, verdict, reasons, policy_version, input_hash, decided_at
    FROM policy_decisions WHERE id = ${decisionId}`;
  if (!row) throw new NotFoundError('policy decision', decisionId);
  const check = (await ledgerChecks([row])).get(row.id)!;
  return { decision_id: row.id, case_id: row.case_id, ...check };
}

export interface BatchVerification {
  anchor: AnchorSummary;
  /** Every decision in the batch is present, unchanged, and the root is on the ledger. */
  verified: boolean | null;
  present: number;
  missing: string[];
  changed: string[];
  root_ok: boolean;
  on_chain: OnChainAnchor | null;
  on_chain_error: string | null;
  detail: string;
}

/**
 * `GET /api/v1/ledger/anchors/:id/verify` — the whole batch. This is the check
 * that catches a *deleted* decision, which no per-decision view can show.
 */
export async function verifyBatch(id: string): Promise<BatchVerification> {
  const ev = (await evidenceFor([id])).get(id);
  if (!ev) throw new NotFoundError('ledger anchor', id);
  const items = await sql<ItemRow[]>`SELECT * FROM ledger_anchor_items WHERE anchor_id = ${id} ORDER BY leaf_index`;
  const rows = items.length
    ? await sql<DecisionRow[]>`
        SELECT id, case_id, proposed_action, verdict, reasons, policy_version, input_hash, decided_at
        FROM policy_decisions WHERE id IN ${sql(items.map((i) => i.decision_id))}`
    : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = items.filter((i) => !byId.has(i.decision_id)).map((i) => i.decision_id);
  const changed = items
    .filter((i) => byId.has(i.decision_id) && decisionLeaf(toRecord(byId.get(i.decision_id)!)) !== i.leaf_hash)
    .map((i) => i.decision_id);

  const a = ev.row;
  const onChainOk = ev.onChain !== undefined && ev.onChain !== null && ev.onChain.leafCount === a.leaf_count;
  const localOk = missing.length === 0 && changed.length === 0 && ev.rootOk;

  let verified: boolean | null;
  let detail: string;
  if (!localOk) {
    verified = false;
    detail = [
      missing.length ? `${missing.length} decision${missing.length === 1 ? '' : 's'} deleted` : '',
      changed.length ? `${changed.length} changed` : '',
      ev.rootOk ? '' : 'stored leaves no longer produce the root',
    ].filter(Boolean).join('; ');
  } else if (a.status !== 'ANCHORED') {
    verified = null;
    detail = a.status === 'PENDING' ? `intact locally; waiting for ${a.ledger}` : `intact locally; anchoring failed: ${a.last_error ?? 'unknown error'}`;
  } else if (ev.onChainError !== null) {
    verified = null;
    detail = `intact locally; ${a.ledger} could not be asked: ${ev.onChainError}`;
  } else if (!onChainOk) {
    verified = false;
    detail = ev.onChain ? `${a.ledger} holds this root for ${ev.onChain.leafCount} decisions, not ${a.leaf_count}` : `root is not on ${a.ledger}`;
  } else {
    verified = true;
    detail = `all ${a.leaf_count} decisions present and unchanged; root on ${a.ledger} in tx ${short(ev.onChain!.txId)}`;
  }

  return {
    anchor: summarise(a),
    verified,
    present: items.length - missing.length,
    missing,
    changed,
    root_ok: ev.rootOk,
    on_chain: ev.onChain ?? null,
    on_chain_error: ev.onChainError,
    detail,
  };
}

// ── Reads for the API ─────────────────────────────────────────────────────────

export interface LedgerSummary {
  status: ReturnType<typeof ledgerStatus>;
  decisions: number;
  /** Decisions in no batch yet. */
  unbatched: number;
  /** Decisions by the state of the batch they are in. */
  by_anchor_status: { ANCHORED: number; PENDING: number; FAILED: number };
  anchors: { ANCHORED: number; PENDING: number; FAILED: number };
  last_anchor: AnchorSummary | null;
}

export async function ledgerSummary(): Promise<LedgerSummary> {
  const [counts, perStatus, [last]] = await Promise.all([
    sql<{ decisions: number; unbatched: number }[]>`
      SELECT
        (SELECT count(*)::int FROM policy_decisions) AS decisions,
        (SELECT count(*)::int FROM policy_decisions d
           WHERE NOT EXISTS (SELECT 1 FROM ledger_anchor_items i WHERE i.decision_id = d.id)) AS unbatched`,
    sql<{ status: AnchorRow['status']; anchors: number; decisions: number }[]>`
      SELECT status, count(*)::int AS anchors, coalesce(sum(leaf_count), 0)::int AS decisions
      FROM ledger_anchors GROUP BY status`,
    sql<AnchorRow[]>`SELECT * FROM ledger_anchors WHERE status = 'ANCHORED' ORDER BY anchored_at DESC, id DESC LIMIT 1`,
  ]);
  const anchors = { ANCHORED: 0, PENDING: 0, FAILED: 0 };
  const byAnchorStatus = { ANCHORED: 0, PENDING: 0, FAILED: 0 };
  for (const s of perStatus) {
    anchors[s.status] = s.anchors;
    byAnchorStatus[s.status] = s.decisions;
  }
  return {
    status: ledgerStatus(),
    decisions: counts[0]?.decisions ?? 0,
    unbatched: counts[0]?.unbatched ?? 0,
    by_anchor_status: byAnchorStatus,
    anchors,
    last_anchor: last ? summarise(last) : null,
  };
}

export async function recentAnchors(limit = 20): Promise<AnchorSummary[]> {
  const rows = await sql<AnchorRow[]>`SELECT * FROM ledger_anchors ORDER BY created_at DESC, id DESC LIMIT ${limit}`;
  return rows.map(summarise);
}

/** Puts a FAILED batch back in the queue with fresh attempts — after the cause is fixed. */
export async function retryAnchor(id: string): Promise<AnchorSummary> {
  const [row] = await sql<AnchorRow[]>`
    UPDATE ledger_anchors SET status = 'PENDING', attempts = 0, last_error = NULL
    WHERE id = ${id} AND status = 'FAILED'
    RETURNING *`;
  if (row) return summarise(row);
  const [exists] = await sql<{ status: string }[]>`SELECT status FROM ledger_anchors WHERE id = ${id}`;
  if (!exists) throw new NotFoundError('ledger anchor', id);
  throw new ValidationError(`anchor is ${exists.status}, only a FAILED anchor can be retried`, { id });
}
