/**
 * Filter controls for the transactions table.
 *
 * Filters are lifted state owned by the route, so a chart click on the
 * dashboard can navigate here with filters already applied and the two views
 * always agree about what is being shown.
 */

import { formatCents, parseMoneyToCents } from '@/lib/money';
import type { Filters } from '@/lib/filter';
import { hasActiveFilters } from '@/lib/filter';
import type { Category, SourceRecord } from '@/types/models';

interface Props {
  filters: Filters;
  onChange: (next: Filters) => void;
  categories: readonly Category[];
  sources: readonly SourceRecord[];
  resultCount: number;
  totalCount: number;
}

export function FilterBar({ filters, onChange, categories, sources, resultCount, totalCount }: Props) {
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    onChange({ ...filters, [key]: value });

  const parseAmount = (raw: string): number | null => {
    if (!raw.trim()) return null;
    try {
      return Math.abs(parseMoneyToCents(raw));
    } catch {
      return null;
    }
  };

  return (
    <div className="filterbar">
      <input
        className="search"
        type="search"
        placeholder="Search merchant, description, note or item…"
        value={filters.search}
        onChange={(e) => set('search', e.target.value)}
      />

      <div className="filter-row">
        <label className="field inline">
          <span>From</span>
          <input type="date" value={filters.from ?? ''} onChange={(e) => set('from', e.target.value || null)} />
        </label>
        <label className="field inline">
          <span>To</span>
          <input type="date" value={filters.to ?? ''} onChange={(e) => set('to', e.target.value || null)} />
        </label>

        <label className="field inline">
          <span>Account</span>
          <select
            value={filters.sourceIds[0] ?? ''}
            onChange={(e) => set('sourceIds', e.target.value ? [e.target.value] : [])}
          >
            <option value="">All accounts</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field inline">
          <span>Category</span>
          <select
            value={filters.categoryIds[0] ?? ''}
            onChange={(e) => set('categoryIds', e.target.value ? [e.target.value] : [])}
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="field inline">
          <span>Direction</span>
          <select
            value={filters.direction}
            onChange={(e) => set('direction', e.target.value as Filters['direction'])}
          >
            <option value="all">Everything</option>
            <option value="out">Money out</option>
            <option value="in">Money in</option>
          </select>
        </label>

        <label className="field inline narrow">
          <span>Min</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            defaultValue={filters.minCents !== null ? (filters.minCents / 100).toFixed(2) : ''}
            onBlur={(e) => set('minCents', parseAmount(e.target.value))}
          />
        </label>
        <label className="field inline narrow">
          <span>Max</span>
          <input
            type="text"
            inputMode="decimal"
            placeholder="any"
            defaultValue={filters.maxCents !== null ? (filters.maxCents / 100).toFixed(2) : ''}
            onBlur={(e) => set('maxCents', parseAmount(e.target.value))}
          />
        </label>
      </div>

      <div className="filter-row">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filters.uncategorizedOnly}
            onChange={(e) => set('uncategorizedOnly', e.target.checked)}
          />
          Uncategorized only
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={filters.showNonSpend}
            onChange={(e) => set('showNonSpend', e.target.checked)}
          />
          Show returned &amp; cancelled
        </label>

        <span className="result-count dim">
          {resultCount === totalCount
            ? `${totalCount.toLocaleString()} transactions`
            : `${resultCount.toLocaleString()} of ${totalCount.toLocaleString()}`}
        </span>

        {hasActiveFilters(filters) && (
          <button className="link" onClick={() => onChange({ ...filters, ...clearedFilters() })}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}

function clearedFilters() {
  return {
    search: '',
    from: null,
    to: null,
    sourceIds: [],
    categoryIds: [],
    minCents: null,
    maxCents: null,
    showNonSpend: false,
    direction: 'all' as const,
    uncategorizedOnly: false,
  };
}

export { formatCents };
