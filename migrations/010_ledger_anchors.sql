--
-- Tamper evidence for the policy log, anchored on a permissioned ledger
-- (NPCI Drunix, a Hyperledger Fabric 2.5 fork) — optional, off by default.
--
-- `policy_decisions` is append-only by convention: nothing in this codebase
-- updates it, but anyone with write access to the database could. Batches of
-- decisions are hashed into a Merkle tree and only the root leaves this
-- database. Once a root is on a ledger the operator does not control alone,
-- editing, deleting or back-dating a decision breaks either its leaf or its
-- batch's root, and verification says which.
--
-- Nothing personal goes on the ledger: the root, the leaf count and the
-- simulated time range. The decisions stay here.

CREATE TABLE ledger_anchors (
  id                TEXT PRIMARY KEY,
  ledger            TEXT NOT NULL CHECK (ledger IN ('simulated','drunix')),
  merkle_root       TEXT NOT NULL CHECK (merkle_root ~ '^[0-9a-f]{64}$'),
  leaf_count        INT NOT NULL CHECK (leaf_count > 0),
  first_decided_at  TIMESTAMPTZ NOT NULL,
  last_decided_at   TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ANCHORED','FAILED')),
  attempts          INT NOT NULL DEFAULT 0,
  tx_id             TEXT,
  block_number      BIGINT,                      -- null when the ledger did not report one
  last_error        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  anchored_at       TIMESTAMPTZ,
  CHECK (status <> 'ANCHORED' OR tx_id IS NOT NULL)
);
CREATE INDEX ledger_anchors_pending ON ledger_anchors (created_at, id) WHERE status = 'PENDING';
CREATE INDEX ledger_anchors_created ON ledger_anchors (created_at DESC);

-- One anchor per decision, by constraint (invariant 2). Deliberately no
-- foreign key to policy_decisions: a decision deleted after anchoring must
-- surface as a missing leaf when its batch is verified, not vanish quietly
-- with its evidence.
CREATE TABLE ledger_anchor_items (
  decision_id  TEXT PRIMARY KEY,
  anchor_id    TEXT NOT NULL REFERENCES ledger_anchors(id) ON DELETE CASCADE,
  leaf_index   INT NOT NULL CHECK (leaf_index >= 0),
  leaf_hash    TEXT NOT NULL CHECK (leaf_hash ~ '^[0-9a-f]{64}$'),
  UNIQUE (anchor_id, leaf_index)
);

-- `LEDGER_PROVIDER=simulated`: stands in for the ledger the way sim/gateway.ts
-- stands in for the processor. It shares a database with what it attests to,
-- so it demonstrates the flow and the checks — it proves nothing to a third
-- party, and the UI labels it accordingly.
CREATE TABLE sim_ledger (
  block_number     BIGSERIAL PRIMARY KEY,
  tx_id            TEXT NOT NULL UNIQUE,
  root             TEXT NOT NULL UNIQUE,         -- the ledger key: anchoring a root twice is a no-op
  leaf_count       INT NOT NULL,
  first_decided_at TIMESTAMPTZ NOT NULL,
  last_decided_at  TIMESTAMPTZ NOT NULL,
  committed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
