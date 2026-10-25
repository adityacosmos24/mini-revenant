/*
 * SPDX-License-Identifier: Apache-2.0
 */
import { Context, Contract, Info, Returns, Transaction } from 'fabric-contract-api';

/**
 * `revenant-anchor` — Merkle roots of Revenant's policy log.
 *
 * The ledger holds roots, never decisions: a root, how many decisions it
 * covers, and their simulated time range. Anyone on the channel can confirm a
 * root exists and when it was written; proving a single decision belongs to it
 * needs the decision and its inclusion proof, which only the operator holds.
 *
 * Deterministic on purpose. Every endorsing peer must compute the same write
 * set, so the record is built only from the arguments, the transaction id, the
 * submitter's MSP and the transaction timestamp — never `Date.now()` or
 * randomness — and serialised with a fixed key order.
 *
 * Idempotent by root, matching the client's contract (apps/api/src/lib/ledger.ts):
 * anchoring a root that exists with the same metadata returns the original
 * record and writes nothing; with different metadata it is refused.
 */

interface AnchorRecord {
  root: string;
  leafCount: number;
  firstDecidedAt: string;
  lastDecidedAt: string;
  txId: string;
  anchoredAt: string;
  submitter: string | null;
}

const ROOT = /^[0-9a-f]{64}$/;
const KEY_TYPE = 'anchor';

function isoOrThrow(name: string, value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`${name} is not a timestamp: ${value}`);
  return new Date(ms).toISOString();
}

function txTime(ctx: Context): string {
  const ts = ctx.stub.getTxTimestamp();
  const seconds = Number(ts.seconds.toString());
  return new Date(seconds * 1000 + Math.floor(ts.nanos / 1_000_000)).toISOString();
}

function serialise(r: AnchorRecord): string {
  // Fixed key order: identical bytes on every endorser.
  return JSON.stringify({
    root: r.root,
    leafCount: r.leafCount,
    firstDecidedAt: r.firstDecidedAt,
    lastDecidedAt: r.lastDecidedAt,
    txId: r.txId,
    anchoredAt: r.anchoredAt,
    submitter: r.submitter,
  });
}

@Info({ title: 'RevenantAnchor', description: 'Merkle roots of the Revenant policy log' })
export class AnchorContract extends Contract {
  @Transaction()
  @Returns('string')
  public async Anchor(ctx: Context, root: string, leafCount: number, firstDecidedAt: string, lastDecidedAt: string): Promise<string> {
    if (!ROOT.test(root)) throw new Error('root must be 64 lowercase hex characters (SHA-256)');
    const count = Number(leafCount);
    if (!Number.isInteger(count) || count <= 0) throw new Error(`leafCount must be a positive integer, got ${String(leafCount)}`);
    const first = isoOrThrow('firstDecidedAt', firstDecidedAt);
    const last = isoOrThrow('lastDecidedAt', lastDecidedAt);
    if (Date.parse(first) > Date.parse(last)) throw new Error('firstDecidedAt is after lastDecidedAt');

    const key = ctx.stub.createCompositeKey(KEY_TYPE, [root]);
    const existing = await ctx.stub.getState(key);
    if (existing.length > 0) {
      const prior = JSON.parse(Buffer.from(existing).toString('utf8')) as AnchorRecord;
      if (prior.leafCount !== count || prior.firstDecidedAt !== first || prior.lastDecidedAt !== last) {
        throw new Error(`root ${root} is already anchored with different metadata (tx ${prior.txId})`);
      }
      return serialise(prior);
    }

    const record: AnchorRecord = {
      root,
      leafCount: count,
      firstDecidedAt: first,
      lastDecidedAt: last,
      txId: ctx.stub.getTxID(),
      anchoredAt: txTime(ctx),
      submitter: ctx.clientIdentity.getMSPID(),
    };
    const bytes = serialise(record);
    await ctx.stub.putState(key, Buffer.from(bytes, 'utf8'));
    ctx.stub.setEvent('AnchorRecorded', Buffer.from(bytes, 'utf8'));
    return bytes;
  }

  /** The record as JSON, or an empty string when the root is not on the ledger. */
  @Transaction(false)
  @Returns('string')
  public async GetAnchor(ctx: Context, root: string): Promise<string> {
    if (!ROOT.test(root)) throw new Error('root must be 64 lowercase hex characters (SHA-256)');
    const bytes = await ctx.stub.getState(ctx.stub.createCompositeKey(KEY_TYPE, [root]));
    return bytes.length > 0 ? Buffer.from(bytes).toString('utf8') : '';
  }
}
