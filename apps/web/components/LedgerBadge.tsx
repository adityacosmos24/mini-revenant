/**
 * `drunix` / `simulated` — where an anchor lives.
 *
 * The same discipline as SourceBadge: evidence carries its provenance. A root
 * on Drunix is held by a ledger the operator does not control alone; a root in
 * the simulated ledger sits in the database it attests to, and the badge says
 * so rather than letting the two read the same.
 */
export function LedgerBadge({ ledger }: { ledger: string | null | undefined }) {
  if (!ledger) return null;
  const strong = ledger === 'drunix';
  return (
    <span
      className="mono"
      title={
        strong
          ? 'Anchored on NPCI Drunix — a permissioned ledger outside this database'
          : 'Simulated ledger — a table in this database. Shows the flow; proves nothing to a third party'
      }
      style={{
        display: 'inline-block',
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 4,
        border: `1px solid ${strong ? 'var(--accent)' : 'var(--border-strong)'}`,
        color: strong ? 'var(--accent)' : 'var(--text-secondary)',
        background: strong ? 'var(--accent-subtle)' : 'transparent',
        letterSpacing: '0.02em',
        verticalAlign: 'middle',
      }}
    >
      {ledger}
    </span>
  );
}
