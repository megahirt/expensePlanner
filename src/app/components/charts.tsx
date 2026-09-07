/**
 * Charts.
 *
 * Hand-rolled SVG rather than a charting library: every chart here is
 * single-series magnitude, which is a few dozen lines of geometry, and it keeps
 * full control over the mark specs (rounded data-ends, surface gaps, recessive
 * axes) plus about 100KB out of the bundle.
 *
 * Amounts are drawn as positive magnitudes: every chart here is explicitly
 * spending, so a minus sign on every axis tick and every row would be noise
 * repeating what the heading already says. Signed amounts stay where direction
 * actually varies — the stat tiles and the transactions table.
 *
 * Colour: one hue, because none of these charts encode identity by colour —
 * the axis or the row label names the thing, and the bar length is the value.
 * That sidesteps colour-vision separation entirely. The two steps below are
 * validated against their own surfaces: #008300 passes lightness, chroma and
 * 3:1 contrast on the light surface, #199e70 the same on the dark one.
 */

import { useId, useState } from 'react';
import { formatCents } from '@/lib/money';
import type { Bucket } from '@/lib/filter';

const BAR_RADIUS = 4;
const GAP = 2;

export interface ChartProps {
  data: readonly Bucket[];
  onSelect?: (bucket: Bucket) => void;
  currency?: string;
}

/** Compact money for axis and inline labels: $1.2k rather than $1,234.56. */
export function compactMoney(cents: number, currency = 'USD'): string {
  const dollars = Math.abs(cents) / 100;
  if (dollars >= 10_000) return `${cents < 0 ? '-' : ''}$${Math.round(dollars / 1000)}k`;
  if (dollars >= 1000) return `${cents < 0 ? '-' : ''}$${(dollars / 1000).toFixed(1)}k`;
  return formatCents(cents, currency).replace(/\.00$/, '');
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (value <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}

/** Month labels: "Jan", with the year shown when it changes. */
function monthLabel(key: string, previous: string | undefined): string {
  const [year, month] = key.split('-');
  const name = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    Number(month) - 1
  ];
  const showYear = !previous || previous.slice(0, 4) !== year;
  return showYear ? `${name} ’${year?.slice(2) ?? ''}` : (name ?? key);
}

/**
 * Spend over time.
 *
 * Bars rather than a line: monthly spend is a set of discrete totals, not a
 * continuous signal, and a line would imply values between the months that do
 * not exist.
 */
export function SpendOverTime({ data, onSelect, currency = 'USD' }: ChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();

  if (data.length === 0) return <p className="dim">Nothing to chart yet.</p>;

  const width = 720;
  const height = 220;
  const padding = { top: 12, right: 8, bottom: 26, left: 52 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const max = niceMax(Math.max(...data.map((d) => d.spentCents)));
  const slot = plotW / data.length;
  const barW = Math.max(3, Math.min(34, slot - GAP * 2));

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={titleId} preserveAspectRatio="xMidYMid meet">
        <title id={titleId}>Spending by month</title>

        {ticks.map((tick) => {
          const y = padding.top + plotH - (tick / max) * plotH;
          return (
            <g key={tick}>
              <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="grid" />
              <text x={padding.left - 8} y={y + 4} className="axis" textAnchor="end">
                {compactMoney(tick, currency)}
              </text>
            </g>
          );
        })}

        {data.map((bucket, i) => {
          const barH = max > 0 ? (bucket.spentCents / max) * plotH : 0;
          const x = padding.left + i * slot + (slot - barW) / 2;
          const y = padding.top + plotH - barH;
          const active = hover === i;
          return (
            <g key={bucket.key}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(barH, 1)}
                rx={BAR_RADIUS}
                className={`bar ${active ? 'active' : ''}`}
              />
              {/* A hit target taller than the bar, so short months are easy to reach. */}
              <rect
                x={padding.left + i * slot}
                y={padding.top}
                width={slot}
                height={plotH}
                fill="transparent"
                className={onSelect ? 'hit' : undefined}
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                onClick={() => onSelect?.(bucket)}
              >
                <title>{`${bucket.label}: ${formatCents(bucket.spentCents, currency)} across ${bucket.count} transactions`}</title>
              </rect>
              <text
                x={padding.left + i * slot + slot / 2}
                y={height - 8}
                className="axis"
                textAnchor="middle"
              >
                {monthLabel(bucket.key, data[i - 1]?.key)}
              </text>
              {active && (
                <text x={padding.left + i * slot + slot / 2} y={y - 6} className="value" textAnchor="middle">
                  {compactMoney(bucket.spentCents, currency)}
                </text>
              )}
            </g>
          );
        })}

        <line
          x1={padding.left}
          x2={width - padding.right}
          y1={padding.top + plotH}
          y2={padding.top + plotH}
          className="axis-line"
        />
      </svg>
    </figure>
  );
}

/**
 * A ranked horizontal bar list.
 *
 * Sorted descending with the value written on every row, which is what makes a
 * pie chart unnecessary: reading "which is biggest, and by how much" off angles
 * is guesswork, and off a sorted list with numbers it is immediate.
 */
export function RankedBars({
  data,
  onSelect,
  currency = 'USD',
  emptyLabel = 'Nothing to show yet.',
}: ChartProps & { emptyLabel?: string }) {
  if (data.length === 0) return <p className="dim">{emptyLabel}</p>;

  const max = Math.max(...data.map((d) => d.spentCents), 1);
  const total = data.reduce((sum, d) => sum + d.spentCents, 0);

  return (
    <ul className="ranked">
      {data.map((bucket) => {
        const share = total > 0 ? Math.round((bucket.spentCents / total) * 100) : 0;
        const Row = onSelect ? 'button' : 'div';
        return (
          <li key={bucket.key}>
            <Row
              className="ranked-row"
              {...(onSelect ? { onClick: () => onSelect(bucket), type: 'button' as const } : {})}
            >
              <span className="ranked-label" title={bucket.label}>
                {bucket.label}
              </span>
              <span className="ranked-track">
                <span className="ranked-fill" style={{ width: `${(bucket.spentCents / max) * 100}%` }} />
              </span>
              <span className="ranked-value num">{formatCents(bucket.spentCents, currency)}</span>
              <span className="ranked-share num dim">{share}%</span>
            </Row>
          </li>
        );
      })}
    </ul>
  );
}

/** A headline number. Not a chart — one value needs no plot. */
export function StatTile({
  label,
  value,
  sub,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'neutral' | 'up' | 'down';
}) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value num ${tone}`}>{value}</div>
      {sub && <div className="stat-sub dim">{sub}</div>}
    </div>
  );
}
