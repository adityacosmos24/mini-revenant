# Ledger anchoring on NPCI Drunix

Revenant can anchor its policy log to [Drunix](https://github.com/npci/drunix),
NPCI's open-source permissioned blockchain (Apache-2.0, a fork of Hyperledger
Fabric 2.5). The feature is **optional and off by default**
(`LEDGER_PROVIDER=none`). Every other stage of the pipeline works the same with
it off.

## What goes on the ledger, and why

`policy_decisions` is append-only by convention: nothing in the code updates
it, but anyone with database access could. The anchorer (`apps/api/src/app/anchor.ts`)
does three things:

1. It takes decisions that aren't in a batch yet, in insertion order. It hashes
   each one into a leaf, `SHA-256(0x00 ‖ canonical JSON of the whole row)`, and
   commits up to `LEDGER_BATCH_SIZE` leaves as one batch. Each batch has a
   Merkle root (RFC 6962 construction, `apps/api/src/domain/merkle.ts`).
2. It sends **only the root** to the ledger, along with the leaf count and the
   simulated time range. It never sends a decision, an amount or a customer.
3. It checks each decision on request: the leaf is re-hashed from the row as it
   is now, proven into its root, and the root is looked up on the ledger.
   `/audit/:paymentId` does this for every policy decision. To check a whole
   batch, use `GET /api/v1/ledger/anchors/:id/verify`; it also catches deleted
   decisions.

If a decision is edited, deleted or back-dated after anchoring, either its leaf
or its batch's root stops matching what the ledger holds, and the check names
which one.

## Layout

```
ledger/chaincode/         the `revenant-anchor` contract (TypeScript, fabric-contract-api 2.5)
  src/anchor.ts           Anchor(root, leafCount, firstDecidedAt, lastDecidedAt) · GetAnchor(root)
apps/api/src/lib/drunix.ts        Fabric Gateway client adapter (@hyperledger/fabric-gateway)
apps/api/src/sim/ledger.ts        the simulated ledger, a table in this database
apps/api/src/app/anchor.ts        batch → submit → verify
```

The contract is idempotent by root. Anchoring a root that already exists with
the same metadata returns the original record and writes nothing. The same
root with different metadata is refused. The contract is also deterministic:
it uses only its arguments, the transaction id, the submitter's MSP and the
transaction timestamp, so every endorsing peer computes the same write set.

## Multi-organisation network design

The guarantee holds only if the operator can't write to the ledger alone. A
ledger where every peer is run by the same party proves no more than the
database does. The network is designed around that.

| Organisation | Role | Runs |
|---|---|---|
| **PSP** (operates Revenant) | Submits anchors | Lite Peers (endorse, run the Fabric Gateway the anchorer connects to), a Committing Peer |
| **Acquiring bank** | Co-endorses; verifies decisions on its merchants' payments | Lite Peer, Committing Peer |
| **Independent auditor** | Co-endorses; verifies any decision on request | Lite Peer, Committing Peer |
| **Merchant / aggregator** *(optional)* | Verifies its own decisions | Lite Peer, or read-only through another org |

**Endorsement policy.** Every anchor needs the PSP plus at least one other
organisation:

```
AND('PSPMSP.peer', OR('AcquirerMSP.peer', 'AuditorMSP.peer', 'MerchantMSP.peer'))
```

A root therefore can't appear on the ledger, or be replaced, without a second
organisation's peer executing the contract and signing the result. The Fabric
Gateway client builds the endorsement plan from service discovery, so the
anchorer's code doesn't change as organisations join.

**On the two-org test network,** you don't need an explicit policy to show
this. In Fabric 2.5's sample channel configuration, the default chaincode
endorsement policy is `MAJORITY Endorsement`, which with two organisations
means both must endorse every anchor. To set the policy explicitly, Fabric's
`network.sh deployCC` accepts `-ccep "AND('Org1MSP.peer','Org2MSP.peer')"`.
Check `./network.sh -h` on Drunix's copy.

**Why Drunix's architecture fits:**

- **Lite Peer / Committing Peer separation.** Endorsement doesn't need local
  ledger storage. Each organisation can run light endorsers close to its own
  services, and keep committing peers, which hold the ledger, separate.
- **Stateless validation service.** Validation scales horizontally as more
  organisations, and more PSPs anchoring their own logs, join one channel.
- **Ledger size.** Anchoring is one transaction per batch of up to 256
  decisions, so the load stays small even at national scale.

**Planned, not built:**

- **Private data collections (KeyDB transient store).** Share each decision's
  leaf hash only with the acquirer or auditor of that merchant, so they can
  verify their own decisions from the ledger without asking the operator and
  without seeing anyone else's.
- **YugabyteDB state database.** A SQL-capable state store would let auditors
  query anchors by organisation and time range directly. Today the contract
  only needs key lookups by root, which LevelDB serves.

## Try it without a network

```bash
LEDGER_PROVIDER=simulated bun dev
```

This anchors to the `sim_ledger` table. It runs every code path and every check
end to end, but the "ledger" is in the same database as the decisions, so it
proves nothing to a third party. The UI labels it `simulated`.

## Run it on Drunix

Drunix splits Fabric's peer into a **Lite Peer** (endorses, and keeps Fabric's
Gateway service) and a **Committing Peer** (validates and commits). The client
is therefore the standard Fabric Gateway SDK, connected to a Lite Peer, the
same way Drunix's own `asset-transfer-basic/application-gateway-typescript`
sample does it.

Prerequisites are those of `drunix-network/test-network`: Docker, bash 4+, and
the Drunix binaries in `drunix-network/bin`.

```bash
git clone https://github.com/npci/drunix.git
cd drunix/drunix-network/test-network

# Two orgs, each with a Lite Peer, a Committing Peer and a validation service.
./network.sh up createChannel

# Deploy the contract from this repo. deployCC runs `npm install && npm run build`
# in the chaincode directory for TypeScript.
./network.sh deployCC -ccn revenant-anchor \
  -ccp /path/to/mini-revenant/ledger/chaincode -ccl typescript
```

Then point the API at Org1's Lite Peer in `.env`. All paths are absolute:

```bash
ORG1=/path/to/drunix/drunix-network/test-network/organizations/peerOrganizations/org1.example.com

LEDGER_PROVIDER=drunix
DRUNIX_PEER_ENDPOINT=localhost:7051
DRUNIX_PEER_HOST_ALIAS=peer0.org1.example.com
DRUNIX_TLS_CERT_PATH=$ORG1/peers/peer0.org1.example.com/tls/ca.crt
DRUNIX_MSP_ID=Org1MSP
DRUNIX_CERT_PATH=$ORG1/users/User1@org1.example.com/msp/signcerts
DRUNIX_KEY_PATH=$ORG1/users/User1@org1.example.com/msp/keystore
DRUNIX_CHANNEL=mychannel
DRUNIX_CHAINCODE=revenant-anchor
```

`.env` does not expand `$ORG1`; write the full path into each line.

`/ready` reports `checks.ledger` with the target, or with the reason the ledger
is off. The Policy page shows how many decisions are anchored, pending and
failed, plus the last block. A ledger that is down or misconfigured never
blocks a decision. Batches stay `PENDING`, the anchorer backs off
exponentially, and after eight transient failures a batch is `FAILED`. You can
re-queue it with `POST /api/v1/ledger/anchors/:id/retry`.

### Check the contract by hand

```bash
source ./scripts/envVar.sh && setGlobals 1 0     # Org1, Lite Peer (bash 4+)
peer chaincode query -C mychannel -n revenant-anchor \
  -c '{"function":"GetAnchor","Args":["<root from GET /api/v1/ledger/anchors>"]}'
```

## What has and has not been verified

- **Verified here:**
  - The contract compiles under strict TypeScript against `fabric-contract-api`
    and `fabric-shim` 2.5.8.
  - It was exercised against an in-memory ledger stub: first write, idempotent
    repeat, conflicting repeat, invalid input, and reads.
  - The Fabric Gateway client loads and signs under Bun, and fails fast with
    gRPC `UNAVAILABLE` when no peer is listening.
  - The simulated ledger and every verification path are covered by
    `apps/api/test/ledger.integration.test.ts` against real Postgres.
- **Not verified here:** a round trip against a running Drunix network. Drunix
  documents backward compatibility with Fabric 2.5.x and ships the Fabric
  Gateway service, but this has not been run against it. Specifically
  unproven:
  - the deployCC TypeScript path on Drunix's peers;
  - endorsement on a Lite Peer;
  - commit status through the Committing Peer.
- **Reset:** `sim/reset`, `bun seed` and `bun sim:clear` empty the local anchor
  tables, but a real ledger keeps its roots. That is harmless: a root only
  matches the exact decisions it was built from.
