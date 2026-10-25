import { createHash } from 'node:crypto';
import { canonicalise } from './policy.ts';

/**
 * Merkle commitments over the policy log.
 *
 * PURE. Hashes in, hashes out — no database, no clock, no ledger. The app
 * layer batches decisions, this module turns a batch into one root, and only
 * the root goes to the ledger. Any single decision can later be shown to be
 * part of an anchored batch with a proof of ⌈log₂ n⌉ hashes, without
 * revealing any other decision in the batch.
 *
 * The construction follows RFC 6962 (Certificate Transparency) in the two
 * places that matter for tamper evidence:
 *
 *  - **Domain separation.** Leaves are hashed as `H(0x00 ‖ data)` and interior
 *    nodes as `H(0x01 ‖ left ‖ right)`. Without the prefixes an interior node
 *    is indistinguishable from a leaf, and a forger can present two hashes as
 *    one "decision" (a second-preimage attack on the tree).
 *  - **No duplication.** An odd node at the end of a level is promoted
 *    unchanged, never paired with itself. Duplicating it lets two different
 *    leaf lists produce the same root (the Bitcoin CVE-2012-2459 shape).
 *
 * Every hash is lowercase hex, SHA-256.
 */

export type Hex = string;

export interface ProofStep {
  /** Which side the sibling sits on when the two are combined. */
  side: 'left' | 'right';
  hash: Hex;
}

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);
const HEX_64 = /^[0-9a-f]{64}$/;

export function leafHash(data: string): Hex {
  return createHash('sha256').update(LEAF_PREFIX).update(data, 'utf8').digest('hex');
}

export function nodeHash(left: Hex, right: Hex): Hex {
  return createHash('sha256')
    .update(NODE_PREFIX)
    .update(Buffer.from(left, 'hex'))
    .update(Buffer.from(right, 'hex'))
    .digest('hex');
}

function assertLeaves(leaves: readonly Hex[]): void {
  if (leaves.length === 0) throw new Error('a Merkle tree needs at least one leaf');
  for (const l of leaves) {
    if (!HEX_64.test(l)) throw new Error(`not a SHA-256 hex digest: ${l.slice(0, 16)}…`);
  }
}

function nextLevel(level: readonly Hex[]): Hex[] {
  const up: Hex[] = [];
  for (let i = 0; i < level.length; i += 2) {
    const right = level[i + 1];
    // The odd node out is promoted, not duplicated (see the module comment).
    up.push(right === undefined ? level[i]! : nodeHash(level[i]!, right));
  }
  return up;
}

export function merkleRoot(leaves: readonly Hex[]): Hex {
  assertLeaves(leaves);
  let level: Hex[] = [...leaves];
  while (level.length > 1) level = nextLevel(level);
  return level[0]!;
}

/** The sibling path from leaf `index` to the root, bottom first. */
export function merkleProof(leaves: readonly Hex[], index: number): ProofStep[] {
  assertLeaves(leaves);
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) {
    throw new Error(`leaf index ${index} is outside a tree of ${leaves.length}`);
  }
  const proof: ProofStep[] = [];
  let level: Hex[] = [...leaves];
  let i = index;
  while (level.length > 1) {
    const isRight = i % 2 === 1;
    const sibling = isRight ? level[i - 1] : level[i + 1];
    // A promoted node has no sibling at this level and contributes no step.
    if (sibling !== undefined) proof.push({ side: isRight ? 'left' : 'right', hash: sibling });
    level = nextLevel(level);
    i = Math.floor(i / 2);
  }
  return proof;
}

/** Folds a proof back up to a root and compares. Never throws on bad input. */
export function verifyProof(leaf: Hex, proof: readonly ProofStep[], root: Hex): boolean {
  if (!HEX_64.test(leaf) || !HEX_64.test(root)) return false;
  let acc = leaf;
  for (const step of proof) {
    if (!HEX_64.test(step.hash)) return false;
    acc = step.side === 'left' ? nodeHash(step.hash, acc) : nodeHash(acc, step.hash);
  }
  return acc === root;
}

// ── What a leaf commits to ────────────────────────────────────────────────────

/**
 * Every column of a `policy_decisions` row, with `decided_at` as an ISO
 * string. The leaf covers the verdict, the twelve rule results and the stored
 * input — not just `input_hash` — so a row whose verdict or reasons were
 * edited no longer matches its leaf even if the hash column was left alone.
 */
export interface DecisionRecord {
  id: string;
  case_id: string;
  proposed_action: string;
  verdict: string;
  reasons: unknown;
  policy_version: string;
  input_hash: string;
  decided_at: string;
}

/**
 * Canonical JSON (keys sorted at every depth) of exactly the fields above —
 * extra properties on the object passed in are ignored, so a joined row
 * hashes the same as a bare one.
 */
export function decisionLeaf(d: DecisionRecord): Hex {
  return leafHash(
    canonicalise({
      id: d.id,
      case_id: d.case_id,
      proposed_action: d.proposed_action,
      verdict: d.verdict,
      reasons: d.reasons,
      policy_version: d.policy_version,
      input_hash: d.input_hash,
      decided_at: d.decided_at,
    }),
  );
}
