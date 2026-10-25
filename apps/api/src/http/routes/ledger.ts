import { Hono } from 'hono';
import { anchorOnce, ledgerSummary, proveDecision, recentAnchors, retryAnchor, verifyBatch } from '../../app/anchor.ts';
import { log } from '../../lib/logger.ts';
import type { AppEnv } from '../app.ts';

export const ledger = new Hono<AppEnv>();

/** Provider, counts by batch state, and the last anchor. Works with the ledger off. */
ledger.get('/api/v1/ledger', async (c) => c.json(await ledgerSummary()));

ledger.get('/api/v1/ledger/anchors', async (c) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 20)));
  return c.json({ anchors: await recentAnchors(limit) });
});

/** Recomputed on request: every leaf from its row, the root from the leaves, the root on the ledger. */
ledger.get('/api/v1/ledger/anchors/:id/verify', async (c) => c.json(await verifyBatch(c.req.param('id'))));

/** One decision's inclusion proof, checked against the ledger now. */
ledger.get('/api/v1/ledger/decisions/:id', async (c) => c.json(await proveDecision(c.req.param('id'))));

/** Run one batch-and-submit pass now rather than waiting for the next tick. */
ledger.post('/api/v1/ledger/anchor', async (c) => {
  const result = await anchorOnce();
  log.info('ledger pass requested', { ...result });
  return c.json(result);
});

/** Re-queue a FAILED batch once its cause is fixed. */
ledger.post('/api/v1/ledger/anchors/:id/retry', async (c) => c.json(await retryAnchor(c.req.param('id'))));
