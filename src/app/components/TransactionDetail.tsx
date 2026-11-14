/**
 * Detail panel for a single transaction.
 *
 * Where a manual category, note and tags are set, and where Amazon's per-item
 * breakdown is shown — including which items were returned and how much came
 * back, so a partly-returned order is legible rather than just a smaller number.
 */

import { useEffect, useState } from 'react';
import { formatCents } from '@/lib/money';
import { effectiveCents, type Transaction } from '@/types/models';
import { useStore } from '../store';
import { CategoryPicker } from './CategoryPicker';

export function TransactionDetail({ transaction, onClose }: { transaction: Transaction; onClose: () => void }) {
  const { categories, editTransaction, rules, saveRule } = useStore();
  const [notes, setNotes] = useState(transaction.notes ?? '');
  const [offerRule, setOfferRule] = useState<string | null>(null);

  // Escape closes the panel, as people expect of anything that slides over a page.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    setNotes(transaction.notes ?? '');
    setOfferRule(null);
  }, [transaction.id, transaction.notes]);

  const spent = effectiveCents(transaction);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Transaction detail">
        <header>
          <div>
            <h2>{transaction.merchant}</h2>
            <p className="dim">
              {transaction.date} · {transaction.accountLabel}
            </p>
          </div>
          <button className="link" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <dl className="detail-grid">
          <dt>Amount</dt>
          <dd className={`num ${transaction.amountCents < 0 ? 'out' : 'in'}`}>
            {formatCents(transaction.amountCents, transaction.currency)}
          </dd>
          {transaction.refundedCents > 0 && (
            <>
              <dt>Refunded</dt>
              <dd className="num in">{formatCents(transaction.refundedCents, transaction.currency)}</dd>
              <dt>Counts as</dt>
              <dd className="num">{formatCents(spent, transaction.currency)}</dd>
            </>
          )}
          {transaction.status === 'cancelled' && (
            <>
              <dt>Counts as</dt>
              <dd className="num">$0.00 — cancelled, never charged</dd>
            </>
          )}
          <dt>Status</dt>
          <dd>
            {transaction.status}
            {transaction.statusRaw && transaction.statusRaw !== transaction.status && (
              <span className="dim"> ({transaction.statusRaw})</span>
            )}
          </dd>
          <dt>Description</dt>
          <dd className="dim">{transaction.description}</dd>
          {transaction.externalId && (
            <>
              <dt>Source id</dt>
              <dd className="dim num">{transaction.externalId}</dd>
            </>
          )}
        </dl>

        <label className="field">
          <span>Category</span>
          <CategoryPicker
            categories={categories}
            value={transaction.categoryId}
            onChange={(categoryId) => {
              void editTransaction(transaction.id, { categoryId });
              // Offer to turn this one decision into a standing rule, so the
              // same merchant categorizes itself from now on.
              if (categoryId) setOfferRule(categoryId);
            }}
          />
        </label>

        {transaction.categoryId && (
          <p className="dim category-reason">
            {transaction.categorySource === 'manual'
              ? 'You set this category.'
              : transaction.categoryReason
                ? `Why: ${transaction.categoryReason}.`
                : 'Set automatically.'}
          </p>
        )}

        {offerRule && (
          <div className="callout ok">
            <div>
              Always categorize <strong>{transaction.merchant}</strong> this way?
            </div>
            <div className="actions">
              <button className="link" onClick={() => setOfferRule(null)}>
                Just this one
              </button>
              <button
                className="primary"
                onClick={() => {
                  const maxOrder = rules.reduce((m, r) => Math.max(m, r.order), 0);
                  void saveRule({
                    id: `rule-learned-${Date.now()}`,
                    order: maxOrder + 1,
                    matchers: [{ kind: 'merchant_contains', value: transaction.merchant }],
                    categoryId: offerRule,
                    enabled: true,
                    learned: true,
                    createdAt: Date.now(),
                  });
                  setOfferRule(null);
                }}
              >
                Create rule
              </button>
            </div>
          </div>
        )}

        <label className="field">
          <span>Note</span>
          <textarea
            rows={3}
            value={notes}
            placeholder="e.g. split with Sam, reimbursable"
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => {
              if (notes !== (transaction.notes ?? '')) void editTransaction(transaction.id, { notes });
            }}
          />
        </label>

        {transaction.items && transaction.items.length > 0 && (
          <section>
            <h2>Items</h2>
            <table className="preview">
              <thead>
                <tr>
                  <th>Item</th>
                  <th className="right">Qty</th>
                  <th className="right">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {transaction.items.map((item, i) => {
                  const returned = item.refundedCents > 0 || item.status === 'cancelled';
                  return (
                    <tr key={`${item.name}-${i}`} className={returned ? 'muted' : ''}>
                      <td>{item.name}</td>
                      <td className="right num">{item.quantity}</td>
                      <td className="right num">{formatCents(item.amountCents, transaction.currency)}</td>
                      <td>
                        {item.status}
                        {item.refundPending && <span className="pill warn">refund pending</span>}
                        {item.refundedCents > 0 && (
                          <span className="pill">{formatCents(item.refundedCents, transaction.currency)} back</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
      </aside>
    </div>
  );
}
