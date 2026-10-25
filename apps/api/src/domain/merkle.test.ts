import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import {
  decisionLeaf,
  leafHash,
  merkleProof,
  merkleRoot,
  nodeHash,
  verifyProof,
  type DecisionRecord,
} from './merkle.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const leaves = (n: number) => Array.from({ length: n }, (_, i) => leafHash(`decision-${i}`));

const decision: DecisionRecord = {
  id: 'pd_0001',
  case_id: 'case_1',
  proposed_action: 'route_alternate_gateway',
  verdict: 'ALLOW',
  reasons: { rules: [{ rule: 1, passed: true }, { rule: 2, passed: true }], input: { amountPaise: 480_000 } },
  policy_version: 'v1.0.0',
  input_hash: 'a'.repeat(64),
  decided_at: '2026-07-28T14:30:00.000Z',
};

describe('the tree', () => {
  test('one leaf is its own root, with an empty proof', () => {
    const [l] = leaves(1);
    expect(merkleRoot([l!])).toBe(l!);
    expect(merkleProof([l!], 0)).toEqual([]);
    expect(verifyProof(l!, [], l!)).toBe(true);
  });

  test('two leaves combine as H(0x01 ‖ left ‖ right)', () => {
    const [a, b] = leaves(2);
    const expected = createHash('sha256')
      .update(Buffer.from([0x01]))
      .update(Buffer.from(a!, 'hex'))
      .update(Buffer.from(b!, 'hex'))
      .digest('hex');
    expect(merkleRoot([a!, b!])).toBe(expected);
    expect(nodeHash(a!, b!)).toBe(expected);
  });

  test('leaves and interior nodes carry different prefixes (0x00 and 0x01)', () => {
    // Pinned byte for byte: if either prefix were dropped or shared, a pair of
    // hashes could be passed off as a single decision.
    expect(leafHash('x')).toBe(createHash('sha256').update(Buffer.from([0x00])).update('x').digest('hex'));
    expect(leafHash('x')).not.toBe(sha('x'));
    const [a, b] = leaves(2);
    const asLeaf = createHash('sha256').update(Buffer.from([0x00])).update(Buffer.from(a! + b!, 'hex')).digest('hex');
    expect(nodeHash(a!, b!)).not.toBe(asLeaf);
  });

  test('an odd node is promoted, not duplicated', () => {
    const [a, b, c] = leaves(3);
    expect(merkleRoot([a!, b!, c!])).toBe(nodeHash(nodeHash(a!, b!), c!));
    // Duplicating the last leaf would make [a,b,c] and [a,b,c,c] collide.
    expect(merkleRoot([a!, b!, c!])).not.toBe(merkleRoot([a!, b!, c!, c!]));
  });

  test('order matters', () => {
    const [a, b] = leaves(2);
    expect(merkleRoot([a!, b!])).not.toBe(merkleRoot([b!, a!]));
  });

  test('deterministic', () => {
    expect(merkleRoot(leaves(37))).toBe(merkleRoot(leaves(37)));
  });

  test('refuses an empty batch and anything that is not a digest', () => {
    expect(() => merkleRoot([])).toThrow(/at least one leaf/);
    expect(() => merkleRoot(['not-hex'])).toThrow(/not a SHA-256/);
    expect(() => merkleProof(leaves(3), 3)).toThrow(/outside a tree of 3/);
    expect(() => merkleProof(leaves(3), -1)).toThrow(/outside/);
  });
});

describe('proofs', () => {
  test('every leaf of every tree size from 1 to 33 proves into its root', () => {
    for (let n = 1; n <= 33; n += 1) {
      const ls = leaves(n);
      const root = merkleRoot(ls);
      for (let i = 0; i < n; i += 1) {
        const proof = merkleProof(ls, i);
        expect(proof.length).toBeLessThanOrEqual(Math.ceil(Math.log2(n)));
        expect(verifyProof(ls[i]!, proof, root)).toBe(true);
      }
    }
  });

  test('a changed leaf, a proof for the wrong index, or a different root all fail', () => {
    const ls = leaves(10);
    const root = merkleRoot(ls);
    const proof = merkleProof(ls, 4);
    expect(verifyProof(leafHash('tampered'), proof, root)).toBe(false);
    expect(verifyProof(ls[5]!, proof, root)).toBe(false);
    expect(verifyProof(ls[4]!, proof, merkleRoot(leaves(11)))).toBe(false);
  });

  test('a tampered step fails rather than throwing', () => {
    const ls = leaves(8);
    const root = merkleRoot(ls);
    const proof = merkleProof(ls, 2);
    const flipped = proof.map((s, i) => (i === 0 ? { ...s, side: s.side === 'left' ? ('right' as const) : ('left' as const) } : s));
    expect(verifyProof(ls[2]!, flipped, root)).toBe(false);
    expect(verifyProof(ls[2]!, [{ side: 'left', hash: 'zz' }], root)).toBe(false);
    expect(verifyProof('nope', proof, root)).toBe(false);
  });
});

describe('a decision leaf', () => {
  test('is independent of key order at every depth', () => {
    const reordered: DecisionRecord = {
      decided_at: decision.decided_at,
      input_hash: decision.input_hash,
      policy_version: decision.policy_version,
      reasons: { input: { amountPaise: 480_000 }, rules: [{ passed: true, rule: 1 }, { passed: true, rule: 2 }] },
      verdict: decision.verdict,
      proposed_action: decision.proposed_action,
      case_id: decision.case_id,
      id: decision.id,
    };
    expect(decisionLeaf(reordered)).toBe(decisionLeaf(decision));
  });

  test('ignores columns it does not commit to, such as a join', () => {
    expect(decisionLeaf({ ...decision, payment_id: 'pay_1', amount_paise: 1 } as DecisionRecord)).toBe(decisionLeaf(decision));
  });

  test('changes when the verdict, a rule result, the input, the hash or the time changes', () => {
    const base = decisionLeaf(decision);
    expect(decisionLeaf({ ...decision, verdict: 'DENY' })).not.toBe(base);
    expect(decisionLeaf({ ...decision, reasons: { ...(decision.reasons as object), rules: [{ rule: 1, passed: false }, { rule: 2, passed: true }] } })).not.toBe(base);
    expect(decisionLeaf({ ...decision, reasons: { ...(decision.reasons as object), input: { amountPaise: 480_001 } } })).not.toBe(base);
    expect(decisionLeaf({ ...decision, input_hash: 'b'.repeat(64) })).not.toBe(base);
    expect(decisionLeaf({ ...decision, decided_at: '2026-07-28T14:30:00.001Z' })).not.toBe(base);
  });
});
