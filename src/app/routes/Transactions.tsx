/**
 * The transactions browser.
 *
 * The screen you actually live in: everything from every source in one list,
 * filterable, sortable, and editable in place.
 *
 * Rendering is windowed — only the rows near the viewport are in the DOM — so
 * the table stays responsive at tens of thousands of rows without pagination,
 * which matters because scanning a year of spending is the whole point.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { formatCents } from '@/lib/money';
import { applyFilters, emptyFilters, sortTransactions, totals, type Filters, type Sort, type SortKey } from '@/lib/filter';
import { effectiveCents, isNonSpend, type Transaction } from '@/types/models';
import { useStore } from '../store';
import { FilterBar } from '../components/FilterBar';
import { CategoryPicker } from '../components/CategoryPicker';
import { TransactionDetail } from '../components/TransactionDetail';

const ROW_HEIGHT = 38;
const OVERSCAN = 12;

interface Props {
  filters: Filters;
  onFiltersChange: (f: Filters) => void;
}

export function TransactionsRoute({ filters, onFiltersChange }: Props) {
  const { transactions, categories, sources, bulkCategorize } = useStore();
  const [sort, setSort] = useState<Sort>({ key: 'date', direction: 'desc' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [detailId, setDetailId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);

  const categoryNames = useMemo(
    () => new Map(categories.map((c) => [c.id, c.name] as const)),
    [categories],
  );
  const categoryColors = useMemo(
    () => new Map(categories.map((c) => [c.id, c.color ?? 'var(--text-faint)'] as const)),
    [categories],
  );

  const visible = useMemo(() => {
    const filtered = applyFilters(transactions, filters);
    return sortTransactions(filtered, sort, categoryNames);
  }, [transactions, filters, sort, categoryNames]);

  const summary = useMemo(() => totals(visible), [visible]);

  const toggleSort = useCallback((key: SortKey) => {
    setSort((s) => (s.key === key ? { key, direction: s.direction === 'asc' ? 'desc' : 'asc' } : { key, direction: 'desc' }));
  }, []);

  const toggleSelected = useCallback((id: string, shiftKey: boolean, index: number, lastIndex: number | null) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastIndex !== null) {
        const [from, to] = index < lastIndex ? [index, lastIndex] : [lastIndex, index];
        for (let i = from; i <= to; i++) {
          const row = visible[i];
          if (row) next.add(row.id);
        }
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [visible]);

  const lastClicked = useRef<number | null>(null);

  // Windowing: render only what is near the viewport.
  const viewportHeight = viewportRef.current?.clientHeight ?? 700;
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(visible.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const window = visible.slice(first, last);

  const detail = detailId ? transactions.find((t) => t.id === detailId) ?? null : null;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Transactions</h1>
          <p className="subtitle">
            {formatCents(summary.spentCents)} out
            {summary.receivedCents > 0 && <> · {formatCents(summary.receivedCents)} in</>} across{' '}
            {summary.count.toLocaleString()} matching {summary.count === 1 ? 'row' : 'rows'}
          </p>
        </div>
      </div>

      <FilterBar
        filters={filters}
        onChange={onFiltersChange}
        categories={categories}
        sources={sources}
        resultCount={visible.length}
        totalCount={transactions.length}
      />

      {selected.size > 0 && (
        <div className="bulkbar">
          <strong>{selected.size} selected</strong>
          <CategoryPicker
            categories={categories}
            value={null}
            placeholder="Set category for all…"
            onChange={(categoryId) => {
              void bulkCategorize([...selected], categoryId);
              setSelected(new Set());
            }}
          />
          <button className="link" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      {visible.length === 0 ? (
        <div className="card empty">
          <h2>Nothing to show</h2>
          <p className="dim">
            {transactions.length === 0
              ? 'Import a CSV to get started.'
              : 'No transactions match these filters.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap card">
          <div className="thead">
            <div className="cell check">
              <input
                type="checkbox"
                aria-label="Select all matching"
                checked={selected.size > 0 && selected.size === visible.length}
                ref={(el) => {
                  if (el) el.indeterminate = selected.size > 0 && selected.size < visible.length;
                }}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(visible.map((t) => t.id)) : new Set())
                }
              />
            </div>
            <SortHeader label="Date" col="date" sort={sort} onClick={toggleSort} className="date" />
            <SortHeader label="Merchant" col="merchant" sort={sort} onClick={toggleSort} className="merchant" />
            <div className="cell desc">Description</div>
            <SortHeader label="Account" col="source" sort={sort} onClick={toggleSort} className="account" />
            <SortHeader label="Category" col="category" sort={sort} onClick={toggleSort} className="category" />
            <SortHeader label="Amount" col="amount" sort={sort} onClick={toggleSort} className="amount right" />
          </div>

          <div
            className="tbody"
            ref={viewportRef}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            <div style={{ height: visible.length * ROW_HEIGHT, position: 'relative' }}>
              <div style={{ transform: `translateY(${first * ROW_HEIGHT}px)` }}>
                {window.map((t, i) => (
                  <Row
                    key={t.id}
                    t={t}
                    index={first + i}
                    selected={selected.has(t.id)}
                    categoryName={t.categoryId ? categoryNames.get(t.categoryId) : undefined}
                    categoryColor={t.categoryId ? categoryColors.get(t.categoryId) : undefined}
                    onToggle={(shiftKey, index) => {
                      toggleSelected(t.id, shiftKey, index, lastClicked.current);
                      lastClicked.current = index;
                    }}
                    onOpen={() => setDetailId(t.id)}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {detail && <TransactionDetail transaction={detail} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function SortHeader({
  label,
  col,
  sort,
  onClick,
  className,
}: {
  label: string;
  col: SortKey;
  sort: Sort;
  onClick: (k: SortKey) => void;
  className: string;
}) {
  const active = sort.key === col;
  return (
    <button
      className={`cell sortable ${className} ${active ? 'active' : ''}`}
      onClick={() => onClick(col)}
      aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {label}
      {active && <span className="caret">{sort.direction === 'asc' ? '▲' : '▼'}</span>}
    </button>
  );
}

function Row({
  t,
  index,
  selected,
  categoryName,
  categoryColor,
  onToggle,
  onOpen,
}: {
  t: Transaction;
  index: number;
  selected: boolean;
  categoryName: string | undefined;
  categoryColor: string | undefined;
  onToggle: (shiftKey: boolean, index: number) => void;
  onOpen: () => void;
}) {
  const cents = effectiveCents(t);
  const muted = isNonSpend(t);

  return (
    <div className={`trow ${selected ? 'selected' : ''} ${muted ? 'muted' : ''}`} style={{ height: ROW_HEIGHT }}>
      <div className="cell check">
        <input
          type="checkbox"
          aria-label={`Select ${t.merchant}`}
          checked={selected}
          onChange={() => undefined}
          onClick={(e) => onToggle(e.shiftKey, index)}
        />
      </div>
      <div className="cell date num">{t.date}</div>
      <button className="cell merchant linky" onClick={onOpen} title={t.description}>
        {t.merchant}
        {t.items && t.items.length > 0 && <span className="pill">{t.items.length} items</span>}
        {muted && <span className="pill warn">{t.supersededBy ? 'linked' : t.status}</span>}
      </button>
      <div className="cell desc dim" title={t.description}>
        {t.description}
      </div>
      <div className="cell account dim">{t.accountLabel}</div>
      <div className="cell category">
        {categoryName ? (
          <span className="cat">
            <i style={{ background: categoryColor }} />
            {categoryName}
          </span>
        ) : (
          <span className="dim">—</span>
        )}
      </div>
      <div className={`cell amount right num ${cents < 0 ? 'out' : cents > 0 ? 'in' : 'dim'}`}>
        {formatCents(t.amountCents, t.currency)}
        {t.refundedCents > 0 && t.status !== 'cancelled' && (
          <span className="pill">−{formatCents(t.refundedCents, t.currency)} back</span>
        )}
      </div>
    </div>
  );
}

export { emptyFilters };
