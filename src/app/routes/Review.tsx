/**
 * Review queue.
 *
 * Nothing here happens automatically. A wrong automatic merge silently deletes
 * an expense and there is no way for the user to notice, so every proposal is
 * shown with both rows side by side and the reason for the match, and waits for
 * a decision.
 */

import { useMemo, useState } from 'react';
import { formatCents } from '@/lib/money';
import { todayIso } from '@/lib/dates';
import { applyLink, candidateToLink, proposeLinks, unapplyLink, unsettledReturns, type Candidate } from '@/dedupe/match';
import { deleteLink, putLink, putTransaction, upsertTransactions } from '@/lib/db';
import { emptyFilters, type Filters } from '@/lib/filter';
import { useStore } from '../store';

export function ReviewRoute({ onDrillDown }: { onDrillDown: (f: Filters) => void }) {
  const { transactions, links, settings, refresh, rerunRules } = useStore();
  const [busy, setBusy] = useState<string | null>(null);

  const candidates = useMemo(() => proposeLinks(transactions, links), [transactions, links]);
  const confirmed = useMemo(() => links.filter((l) => l.status === 'confirmed'), [links]);
  const stuck = useMemo(
    () => unsettledReturns(transactions, links, todayIso()),
    [transactions, links],
  );

  const confirm = async (candidate: Candidate) => {
    setBusy(candidate.linked.id);
    const { canonical, linked } = applyLink(candidate);
    // Written directly rather than through the import upsert, because these are
    // decisions about existing rows, not incoming source facts.
    await putTransaction(canonical);
    await putTransaction(linked);
    await putLink(candidateToLink(candidate, 'confirmed'));
    await refresh();
    setBusy(null);
  };

  const reject = async (candidate: Candidate) => {
    setBusy(candidate.linked.id);
    // Remembered as rejected so the same pair is not proposed again next time.
    await putLink(candidateToLink(candidate, 'rejected'));
    await refresh();
    setBusy(null);
  };

  const undo = async (linkId: string) => {
    const link = links.find((l) => l.id === linkId);
    if (!link) return;
    setBusy(linkId);
    const restored = unapplyLink(link, transactions);
    if (restored.length > 0) await upsertTransactions(restored);
    for (const t of restored) await putTransaction(t);
    await deleteLink(linkId);
    // A charge that had borrowed its category from the order needs one of its own again.
    await rerunRules();
    setBusy(null);
  };

  const nothingToDo = candidates.length === 0 && stuck.length === 0 && confirmed.length === 0;

  if (nothingToDo) {
    return (
      <div className="card empty">
        <h2>Nothing needs reviewing</h2>
        <p className="dim">
          Once you have both Amazon orders and the card they were paid with, this is where the two get
          matched up so a purchase is not counted twice.
        </p>
      </div>
    );
  }

  return (
    <div className="stack">
      <div>
        <h1>Review</h1>
        <p className="subtitle">
          An Amazon order and the card charge that paid for it are one expense. Counting both would
          double your spending, so they get matched here — never automatically.
        </p>
      </div>

      {candidates.length > 0 && (
        <section className="card">
          <h2>{candidates.length} possible {candidates.length === 1 ? 'match' : 'matches'}</h2>
          <div className="candidates">
            {candidates.map((c) => (
              <div className="candidate" key={`${c.canonical.id}-${c.linked.id}`}>
                <div className="candidate-head">
                  <span className={`pill ${c.confidence >= 0.8 ? '' : 'warn'}`}>
                    {c.kind === 'same_purchase' ? 'Same purchase' : 'Refund settlement'} ·{' '}
                    {Math.round(c.confidence * 100)}% sure
                  </span>
                  <span className="dim">{c.reason}</span>
                </div>

                <div className="candidate-rows">
                  <div className="candidate-row">
                    <div className="dim">
                      {c.kind === 'same_purchase' ? 'Counts as the expense' : 'The refund credit'}
                    </div>
                    <strong>{c.canonical.accountLabel}</strong>
                    <div className="num">
                      {c.canonical.date} · {formatCents(c.canonical.amountCents, c.canonical.currency)}
                    </div>
                    <div className="dim small">{c.canonical.description}</div>
                  </div>

                  <div className="candidate-join">↔</div>

                  <div className="candidate-row">
                    <div className="dim">
                      {c.kind === 'same_purchase' ? 'Supplies the item detail' : 'The returned order'}
                    </div>
                    <strong>{c.linked.accountLabel}</strong>
                    <div className="num">
                      {c.linked.date} · {formatCents(c.linked.amountCents, c.linked.currency)}
                    </div>
                    <div className="dim small">{c.linked.description}</div>
                  </div>
                </div>

                <div className="actions left">
                  <button className="primary" disabled={busy !== null} onClick={() => void confirm(c)}>
                    {c.kind === 'same_purchase' ? 'Yes, one purchase' : 'Yes, that is the refund'}
                  </button>
                  <button disabled={busy !== null} onClick={() => void reject(c)}>
                    No, they are separate
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {stuck.length > 0 && (
        <section className="card">
          <h2>Returns with no refund yet</h2>
          <p className="dim">
            These were marked returned on Amazon more than two weeks ago, and no matching credit has
            turned up on any card you have imported. Either the refund has not been issued, or the
            statement covering it has not been imported.
          </p>
          <table className="preview">
            <thead>
              <tr>
                <th>Returned</th>
                <th>Order</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {stuck.map((t) => (
                <tr key={t.id}>
                  <td className="num dim">{t.date}</td>
                  <td>{t.description}</td>
                  <td className="right num">{formatCents(t.amountCents, t.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="actions left">
            <button
              className="link"
              onClick={() =>
                onDrillDown({ ...emptyFilters(), showNonSpend: true, sourceIds: ['amazon'] })
              }
            >
              Show these in Transactions
            </button>
          </div>
        </section>
      )}

      {confirmed.length > 0 && (
        <section className="card">
          <h2>Matched</h2>
          <p className="dim">
            Each of these counts once. Undo any of them and both rows go back to counting for
            themselves.
          </p>
          <table className="preview">
            <thead>
              <tr>
                <th>Kind</th>
                <th>Counted as</th>
                <th>Linked to</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {confirmed.map((link) => {
                const canonical = transactions.find((t) => t.id === link.canonicalId);
                const linked = transactions.find((t) => t.id === link.linkedId);
                return (
                  <tr key={link.id}>
                    <td className="dim">
                      {link.kind === 'same_purchase' ? 'Same purchase' : 'Refund'}
                    </td>
                    <td>
                      {canonical
                        ? `${canonical.date} · ${formatCents(canonical.amountCents, canonical.currency)} · ${canonical.accountLabel}`
                        : '(row removed)'}
                    </td>
                    <td className="dim">{linked ? linked.description : '(row removed)'}</td>
                    <td className="right">
                      <button disabled={busy !== null} onClick={() => void undo(link.id)}>
                        Undo
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <p className="dim small">
        Profile: {settings.profileLabel}. Matching only ever looks at data already on this computer.
      </p>
    </div>
  );
}
