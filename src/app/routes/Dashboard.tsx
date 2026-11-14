/**
 * Dashboard.
 *
 * Answers the three questions worth asking at a glance — how much this month,
 * where is it going, and is that unusual — and makes every answer clickable
 * through to the underlying rows, because a number you cannot interrogate is
 * just a number.
 */

import { useMemo, useState } from 'react';
import { formatCents } from '@/lib/money';
import { monthKey, monthStart, todayIso } from '@/lib/dates';
import {
  applyFilters,
  emptyFilters,
  spendByCategory,
  spendByMerchant,
  spendByMonth,
  totals,
  type Bucket,
  type Filters,
} from '@/lib/filter';
import { detectRecurring, recurringMonthlyCents } from '@/lib/recurring';
import { useStore } from '../store';
import { RankedBars, SpendOverTime, StatTile, compactMoney } from '../components/charts';

interface Props {
  onDrillDown: (filters: Filters) => void;
  onCategorize: () => void;
}

export function DashboardRoute({ onDrillDown, onCategorize }: Props) {
  const { transactions, categories, settings, workspace, switchWorkspace } = useStore();
  const currency = settings.currency;

  const categoryNames = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name] as const)),
    [categories],
  );

  const spendable = useMemo(() => applyFilters(transactions, emptyFilters()), [transactions]);

  const today = todayIso();

  /**
   * Anchor the headline figures to the newest month that actually has data.
   *
   * Someone who imports last month's statement, or comes back after a break,
   * would otherwise open the dashboard to a row of $0.00 tiles and reasonably
   * conclude the tool was broken. When the anchor is not the current month the
   * tiles say which month they are describing.
   */
  const anchor = useMemo(() => {
    const currentKey = monthKey(today);
    const latest = spendable.reduce<string | null>(
      (max, t) => (max === null || t.date > max ? t.date : max),
      null,
    );
    const hasCurrent = spendable.some((t) => monthKey(t.date) === currentKey);
    const key = hasCurrent || !latest ? currentKey : monthKey(latest);
    // Within the anchor month, compare up to the same day so a part-finished
    // month is not measured against a whole one.
    const throughDay = hasCurrent || !latest ? Number(today.slice(8, 10)) : 31;
    return { key, isCurrent: key === currentKey, throughDay };
  }, [spendable, today]);

  const previousKey = monthKey(monthStart(`${anchor.key}-01`, 1));
  const yearStart = `${anchor.key.slice(0, 4)}-01-01`;

  const stats = useMemo(() => {
    const inMonth = (key: string) => spendable.filter((t) => monthKey(t.date) === key);
    const anchorTotal = totals(inMonth(anchor.key));
    const previousTotal = totals(inMonth(previousKey));
    const ytd = totals(spendable.filter((t) => t.date >= yearStart && t.date <= `${anchor.key}-31`));

    const previousSoFar = totals(
      inMonth(previousKey).filter((t) => Number(t.date.slice(8, 10)) <= anchor.throughDay),
    );

    return { anchorTotal, previousTotal, ytd, previousSoFar };
  }, [spendable, anchor, previousKey, yearStart]);

  const months = useMemo(() => spendByMonth(spendable).slice(-14), [spendable]);
  const byCategory = useMemo(() => spendByCategory(spendable, categoryNames).slice(0, 10), [spendable, categoryNames]);
  const byMerchant = useMemo(() => spendByMerchant(spendable, 10), [spendable]);

  const recurring = useMemo(() => detectRecurring(spendable), [spendable]);
  const [showAllRecurring, setShowAllRecurring] = useState(false);

  const uncategorized = useMemo(
    () => spendable.filter((t) => !t.categoryId && t.amountCents < 0),
    [spendable],
  );

  if (transactions.length === 0) {
    return (
      <div className="card empty">
        <h2>No data yet</h2>
        <p className="dim">Import a bank CSV or your Amazon orders and this fills in.</p>
        {workspace === 'real' && (
          <>
            <p className="dim">
              Or look around first with a made-up household's year of spending. It is kept apart from
              your own data.
            </p>
            <button className="primary" onClick={() => void switchWorkspace('demo')}>
              Try the demo household
            </button>
          </>
        )}
      </div>
    );
  }

  const delta = stats.anchorTotal.spentCents - stats.previousSoFar.spentCents;
  const deltaPct =
    stats.previousSoFar.spentCents > 0
      ? Math.round((delta / stats.previousSoFar.spentCents) * 100)
      : null;

  const monthName = (key: string) =>
    new Date(`${key}-01T00:00:00Z`).toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    });

  const drillToMonth = (bucket: Bucket) =>
    onDrillDown({
      ...emptyFilters(),
      from: `${bucket.key}-01`,
      to: `${bucket.key}-31`,
      direction: 'out',
    });

  const drillToCategory = (bucket: Bucket) =>
    onDrillDown({ ...emptyFilters(), categoryIds: [bucket.key], direction: 'out' });

  const drillToMerchant = (bucket: Bucket) =>
    onDrillDown({ ...emptyFilters(), search: bucket.label, direction: 'out' });

  return (
    <div className="stack">
      <div>
        <h1>Dashboard</h1>
        <p className="subtitle">
          Everything below counts only money actually spent — cancelled orders and refunds are
          already taken out, and so is money moved between your own accounts, such as paying off a
          card.
        </p>
      </div>

      <div className="stat-row">
        <StatTile
          label={anchor.isCurrent ? 'This month' : monthName(anchor.key)}
          value={formatCents(-stats.anchorTotal.spentCents, currency)}
          sub={
            anchor.isCurrent
              ? `${stats.anchorTotal.count} transactions`
              : `${stats.anchorTotal.count} transactions · your most recent month`
          }
        />
        <StatTile
          label={anchor.isCurrent ? `vs. the same ${anchor.throughDay} days of ${monthName(previousKey)}` : `vs. ${monthName(previousKey)}`}
          value={deltaPct === null ? '—' : `${delta >= 0 ? '+' : ''}${deltaPct}%`}
          sub={
            deltaPct === null
              ? 'Nothing to compare against yet'
              : `${formatCents(-stats.previousSoFar.spentCents, currency)} then`
          }
          tone={delta > 0 ? 'up' : delta < 0 ? 'down' : 'neutral'}
        />
        <StatTile
          label={`${monthName(previousKey)}, in full`}
          value={formatCents(-stats.previousTotal.spentCents, currency)}
          sub={`${stats.previousTotal.count} transactions`}
        />
        <StatTile
          label={anchor.isCurrent ? 'This year so far' : `${anchor.key.slice(0, 4)} to date`}
          value={formatCents(-stats.ytd.spentCents, currency)}
          sub={
            stats.ytd.receivedCents > 0
              ? `${compactMoney(stats.ytd.receivedCents, currency)} came in`
              : undefined
          }
        />
      </div>

      {uncategorized.length > 0 && (
        <button
          className="callout warn nudge"
          onClick={onCategorize}
        >
          <strong>{uncategorized.length} transactions have no category</strong>
          <span className="dim">
            {' '}
            worth {formatCents(-totals(uncategorized).spentCents, currency)} — categorize them by
            merchant to make these charts honest.
          </span>
        </button>
      )}

      <section className="card">
        <h2>Spending by month</h2>
        <SpendOverTime data={months} currency={currency} onSelect={drillToMonth} />
        <p className="dim chart-note">Select a month to see what made it up.</p>
      </section>

      <div className="two-up">
        <section className="card">
          <h2>Where it goes</h2>
          <RankedBars
            data={byCategory}
            currency={currency}
            onSelect={drillToCategory}
            emptyLabel="Nothing categorized yet."
          />
        </section>

        <section className="card">
          <h2>Top merchants</h2>
          <RankedBars data={byMerchant} currency={currency} onSelect={drillToMerchant} />
        </section>
      </div>

      {recurring.length > 0 && (
        <section className="card recurring">
          <h2>Recurring charges</h2>
          <p className="dim">
            {recurring.length} subscriptions and bills, about{' '}
            <strong>{formatCents(recurringMonthlyCents(recurring), currency)} a month</strong>. Found by
            looking for the same merchant charging at a steady rhythm.
          </p>
          <table className="preview">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>How often</th>
                <th className="right">Usual charge</th>
                <th className="right">Per year</th>
              </tr>
            </thead>
            <tbody>
              {(showAllRecurring ? recurring : recurring.slice(0, 8)).map((r) => (
                <tr key={`${r.merchant}-${r.typicalCents}`} className="recurring-row">
                  <td>
                    <button
                      className="link"
                      onClick={() => onDrillDown({ ...emptyFilters(), search: r.merchant, direction: 'out' })}
                    >
                      {r.merchant}
                    </button>
                  </td>
                  <td className="dim">{r.cadence}</td>
                  <td className="right num">
                    {formatCents(r.typicalCents, currency)}
                    {!r.fixedAmount && <span className="dim"> varies</span>}
                  </td>
                  <td className="right num">{formatCents(r.yearlyCents, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {recurring.length > 8 && (
            <div className="actions left">
              <button className="link" onClick={() => setShowAllRecurring((v) => !v)}>
                {showAllRecurring ? 'Show fewer' : `Show all ${recurring.length}`}
              </button>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
