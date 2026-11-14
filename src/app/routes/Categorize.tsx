/**
 * Categorize: clear the uncategorized pile a merchant at a time.
 *
 * Hundreds of uncategorized rows are usually a few dozen merchants. Listing
 * those, biggest first, turns an afternoon of row-by-row clicking into a few
 * minutes: pick a category once and every row from that merchant follows, now
 * and on future imports.
 *
 * Whatever reaches this screen is what the automatic steps could not place, so
 * the only help offered here is a *suggestion*, drawn from merchants already
 * categorized, which does nothing until it is clicked.
 */

import { useMemo, useState } from 'react';
import { formatCents } from '@/lib/money';
import { emptyFilters, type Filters } from '@/lib/filter';
import { detectRecurring } from '@/lib/recurring';
import { suggestFromSimilar } from '@/categorize/similar';
import { effectiveCents, isTransfer, type CategorySource, type Transaction } from '@/types/models';
import { useCategoryMap, useStore } from '../store';
import { CategoryPicker } from '../components/CategoryPicker';

interface Group {
  merchant: string;
  rows: Transaction[];
  outCents: number;
  inCents: number;
  example: string;
}

/** How each automatic source is described in the summary line. */
const SOURCE_LABELS: Array<[CategorySource, string]> = [
  ['manual', 'set by you'],
  ['rule', 'by a rule'],
  ['bank', "by your bank's own category"],
  ['directory', 'recognised as a well-known merchant'],
  ['keyword', 'by a word in the name'],
  ['items', 'by what the Amazon order contained'],
  ['linked', 'from a matched Amazon order'],
  ['imported', 'from another install'],
];

export function CategorizeRoute({ onDrillDown }: { onDrillDown: (f: Filters) => void }) {
  const { transactions, categories, settings, categorizeMerchant, bulkCategorize } = useStore();
  const categoryMap = useCategoryMap();
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const currency = settings.currency;

  const groups = useMemo<Group[]>(() => {
    const byMerchant = new Map<string, Group>();
    for (const t of transactions) {
      // Rows worth nothing (cancelled, fully refunded, the linked half of a
      // pair) do not affect any total, so they are not worth anyone's time.
      if (t.categoryId || effectiveCents(t) === 0) continue;
      const group = byMerchant.get(t.merchant) ?? { merchant: t.merchant, rows: [], outCents: 0, inCents: 0, example: t.description };
      group.rows.push(t);
      const cents = effectiveCents(t);
      if (cents < 0) group.outCents += -cents;
      else group.inCents += cents;
      byMerchant.set(t.merchant, group);
    }
    return [...byMerchant.values()].sort(
      (a, b) => b.outCents + b.inCents - (a.outCents + a.inCents) || a.merchant.localeCompare(b.merchant),
    );
  }, [transactions]);

  /** Merchants already settled, each with its most common category. */
  const known = useMemo(() => {
    const tally = new Map<string, Map<string, number>>();
    for (const t of transactions) {
      if (!t.categoryId || isTransfer(t)) continue;
      const counts = tally.get(t.merchant) ?? new Map<string, number>();
      counts.set(t.categoryId, (counts.get(t.categoryId) ?? 0) + 1);
      tally.set(t.merchant, counts);
    }
    const result = new Map<string, string>();
    for (const [merchant, counts] of tally) {
      result.set(merchant, [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0]);
    }
    return result;
  }, [transactions]);

  const recurring = useMemo(() => {
    const cadence = new Map<string, string>();
    for (const r of detectRecurring(transactions)) if (!cadence.has(r.merchant)) cadence.set(r.merchant, r.cadence);
    return cadence;
  }, [transactions]);

  const sources = useMemo(() => {
    const counts = new Map<CategorySource, number>();
    for (const t of transactions) {
      if (t.categoryId) counts.set(t.categorySource, (counts.get(t.categorySource) ?? 0) + 1);
    }
    return SOURCE_LABELS.filter(([source]) => counts.has(source)).map(([source, label]) => ({
      source,
      label,
      count: counts.get(source)!,
    }));
  }, [transactions]);

  const totalRows = groups.reduce((sum, g) => sum + g.rows.length, 0);
  const totalOut = groups.reduce((sum, g) => sum + g.outCents, 0);
  const categorizedCount = transactions.filter((t) => t.categoryId).length;

  const assign = async (group: Group, categoryId: string) => {
    setBusy(group.merchant);
    if (remember) await categorizeMerchant(group.merchant, categoryId);
    else await bulkCategorize(group.rows.map((t) => t.id), categoryId);
    const name = categoryMap.get(categoryId)?.name ?? 'that category';
    setDone(
      `${group.rows.length} ${group.rows.length === 1 ? 'row' : 'rows'} from ${group.merchant} filed under ${name}` +
        (remember ? ', and future ones will be too.' : '.'),
    );
    setBusy(null);
  };

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Categorize</h1>
          <p className="subtitle">
            {groups.length === 0
              ? 'Everything has a category.'
              : `${totalRows.toLocaleString()} rows from ${groups.length} ${groups.length === 1 ? 'merchant' : 'merchants'} have no category, worth ${formatCents(totalOut, currency)} of spending. Biggest first.`}
          </p>
        </div>
      </div>

      {done && <div className="callout ok">{done}</div>}

      {groups.length > 0 && (
        <section className="card">
          <div className="actions left">
            <label className="checkbox">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember each choice as a rule, so future imports categorize themselves
            </label>
          </div>
          <div className="table-scroll">
            <table className="preview categorize">
              <thead>
                <tr>
                  <th>Merchant</th>
                  <th className="right">Rows</th>
                  <th className="right">Amount</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((group) => {
                  const suggestion = suggestFromSimilar(group.merchant, known);
                  const suggested = suggestion ? categoryMap.get(suggestion.categoryId) : undefined;
                  const cadence = recurring.get(group.merchant);
                  return (
                    <tr key={group.merchant} className="merchant-group">
                      <td>
                        <button
                          className="link merchant-name"
                          title="Show these transactions"
                          onClick={() => onDrillDown({ ...emptyFilters(), search: group.merchant, uncategorizedOnly: true })}
                        >
                          {group.merchant}
                        </button>
                        {cadence && <span className="pill">{cadence}</span>}
                        <div className="dim example">{group.example}</div>
                      </td>
                      <td className="right num">{group.rows.length}</td>
                      <td className="right num">
                        {group.outCents > 0 && <div className="out">{formatCents(-group.outCents, currency)}</div>}
                        {group.inCents > 0 && <div className="in">+{formatCents(group.inCents, currency)}</div>}
                      </td>
                      <td>
                        <div className="actions left">
                          {suggested && suggestion && (
                            <button
                              className="primary suggestion"
                              disabled={busy !== null}
                              title={`Looks like ${suggestion.similarTo}, which is ${suggested.name}`}
                              onClick={() => void assign(group, suggested.id)}
                            >
                              {suggested.name}?
                            </button>
                          )}
                          <CategoryPicker
                            categories={categories}
                            value={null}
                            placeholder={suggested ? 'Something else…' : 'Choose…'}
                            onChange={(categoryId) => {
                              if (categoryId) void assign(group, categoryId);
                            }}
                          />
                        </div>
                        {suggested && suggestion && (
                          <div className="dim example">Looks like {suggestion.similarTo}</div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {categorizedCount > 0 && (
        <section className="card">
          <h2>How the other {categorizedCount.toLocaleString()} were categorized</h2>
          <p className="dim">
            All of it worked out on this computer from lists that ship with the extension. Open any
            transaction to see the reason for its category.
          </p>
          <ul className="source-list">
            {sources.map(({ source, label, count }) => (
              <li key={source}>
                <span className="num">{count.toLocaleString()}</span> {label}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
