import * as grpc from '@grpc/grpc-js';
import { connect, hash, signers, type Contract } from '@hyperledger/fabric-gateway';
import { createPrivateKey } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { LedgerConflictError, samePayload, type AnchorPayload, type AnchorReceipt, type LedgerPort, type OnChainAnchor } from './ledger.ts';

/**
 * The Drunix adapter.
 *
 * Drunix (github.com/npci/drunix) is NPCI's fork of Hyperledger Fabric 2.5. It
 * splits the peer into a Lite Peer that endorses and a Committing Peer that
 * validates and commits, and keeps Fabric's Gateway service on the Lite Peer
 * (`internal/pkg/gateway`), forwarding commit-status requests to the
 * Committing Peer. So the client is the stock Fabric Gateway SDK, connected to
 * a Lite Peer exactly as Drunix's own `asset-transfer-basic/
 * application-gateway-typescript` sample does — no Drunix-specific client.
 *
 * Imported dynamically by app/anchor.ts, so the gRPC stack is only loaded when
 * `LEDGER_PROVIDER=drunix`.
 */

export interface DrunixOptions {
  endpoint: string;
  hostAlias: string;
  tlsCertPath: string;
  mspId: string;
  certPath: string;
  keyPath: string;
  channel: string;
  chaincode: string;
  /** Endorse and submit. Commit status gets four times this. */
  timeoutMs: number;
}

/**
 * Reads on the request path (the audit page verifies against the ledger) must
 * fail fast: the dashboard's own fetch gives up at 8 s, and a ledger that
 * cannot answer in 3 s is reported as unavailable rather than waited on.
 */
const READ_DEADLINE_MS = 3000;

/** The record the chaincode stores, as JSON. Parsed, never trusted. */
const OnChain = z.object({
  root: z.string().regex(/^[0-9a-f]{64}$/),
  leafCount: z.number().int().positive(),
  firstDecidedAt: z.string(),
  lastDecidedAt: z.string(),
  txId: z.string().min(1),
  anchoredAt: z.string(),
  submitter: z.string().nullable(),
});

const utf8 = new TextDecoder();

/** Fabric's MSP layout puts one file in `signcerts/` and one in `keystore/`. Accept either the file or the directory. */
async function readFileOrFirstInDir(p: string): Promise<Buffer> {
  const s = await stat(p);
  if (!s.isDirectory()) return readFile(p);
  const files = (await readdir(p)).filter((f) => !f.startsWith('.')).sort();
  if (files.length === 0) throw new Error(`${p} is an empty directory`);
  return readFile(path.join(p, files[0]!));
}

function parseRecord(bytes: Uint8Array): OnChainAnchor | null {
  const text = utf8.decode(bytes).trim();
  if (text.length === 0) return null;
  return OnChain.parse(JSON.parse(text));
}

/** Block numbers are a uint64 on the wire; anything past 2^53 is refused, not rounded. */
function blockNumber(n: bigint): number {
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`block number ${n} exceeds safe integer range`);
  return Number(n);
}

export async function connectDrunix(o: DrunixOptions): Promise<LedgerPort> {
  const [tlsRootCert, credentials, keyPem] = await Promise.all([
    readFile(o.tlsCertPath),
    readFileOrFirstInDir(o.certPath),
    readFileOrFirstInDir(o.keyPath),
  ]);

  const client = new grpc.Client(o.endpoint, grpc.credentials.createSsl(tlsRootCert), {
    'grpc.ssl_target_name_override': o.hostAlias,
  });

  const gateway = connect({
    client,
    identity: { mspId: o.mspId, credentials },
    signer: signers.newPrivateKeySigner(createPrivateKey(keyPem)),
    hash: hash.sha256,
    evaluateOptions: () => ({ deadline: Date.now() + READ_DEADLINE_MS }),
    endorseOptions: () => ({ deadline: Date.now() + o.timeoutMs }),
    submitOptions: () => ({ deadline: Date.now() + o.timeoutMs }),
    commitStatusOptions: () => ({ deadline: Date.now() + 4 * o.timeoutMs }),
  });

  const contract: Contract = gateway.getNetwork(o.channel).getContract(o.chaincode);

  async function getAnchor(root: string): Promise<OnChainAnchor | null> {
    return parseRecord(await contract.evaluate('GetAnchor', { arguments: [root] }));
  }

  return {
    name: 'drunix',

    async anchor(p: AnchorPayload): Promise<AnchorReceipt> {
      // A crash between commit and our own UPDATE leaves the root on the
      // ledger and the anchor PENDING here. Read first, so the retry
      // reconciles instead of spending an endorsement on a no-op.
      const existing = await getAnchor(p.root);
      if (existing) {
        if (!samePayload(existing, p)) {
          throw new LedgerConflictError(`root ${p.root.slice(0, 12)}… is already anchored with different metadata (tx ${existing.txId})`);
        }
        return { txId: existing.txId, blockNumber: null };
      }

      const submitted = await contract.submitAsync('Anchor', {
        arguments: [p.root, String(p.leafCount), p.firstDecidedAt, p.lastDecidedAt],
      });
      const status = await submitted.getStatus();
      if (!status.successful) {
        // MVCC_READ_CONFLICT here means another writer anchored the same root
        // first; the next attempt reads it back above and reconciles.
        throw new Error(`transaction ${status.transactionId} failed to commit with status code ${String(status.code)}`);
      }
      const record = parseRecord(submitted.getResult());
      if (record && !samePayload(record, p)) {
        throw new LedgerConflictError(`ledger returned a different anchor than was submitted (tx ${status.transactionId})`);
      }
      // Another writer anchored the same root between our read and our
      // submit: the chaincode answered with the original record and this
      // transaction wrote nothing. The receipt points at the original.
      if (record && record.txId !== status.transactionId) {
        return { txId: record.txId, blockNumber: null };
      }
      return { txId: status.transactionId, blockNumber: blockNumber(status.blockNumber) };
    },

    getAnchor,

    async close(): Promise<void> {
      gateway.close();
      client.close();
    },
  };
}
