/**
 * Spotting recurring charges.
 *
 * A subscription or a bill is the same merchant, at a steady rhythm, for a
 * similar amount. Finding them matters because they are the spending people
 * forget they have: individually small, collectively large, and renewed
 * without anyone deciding to.
 *
 * Pure and deterministic like the rest of the app: no model, just intervals.
 */

import { countedCents, type Transaction } from '@/types/models';
import { daysBetween } from '@/lib/dates';

export type Cadence = 'weekly' | 'every 2 weeks' | 'monthly' | 'every 2 months' | 'quarterly' | 'yearly';

const CADENCES: ReadonlyArray<{ name: Cadence; min: number; max: number; perYear: number }> = [
  { name: 'weekly', min: 6, max: 8, perYear: 52 },
  { name: 'every 2 weeks', min: 13, max: 15, perYear: 26 },
  { name: 'monthly', min: 26, max: 35, perYear: 12 },
  { name: 'every 2 months', min: 55, max: 66, perYear: 6 },
  { name: 'quarterly', min: 84, max: 98, perYear: 4 },
  { name: 'yearly', min: 350, max: 380, perYear: 1 },
];

export interface RecurringCharge {
  merchant: string;
  cadence: Cadence;
  /** The usual charge, in cents (positive). */
  typicalCents: number;
  /** True when every charge was the same amount: a subscription rather than a bill. */
  fixedAmount: boolean;
  count: number;
  firstDate: string;
  lastDate: string;
  /** What this costs over a year at the current rhythm, in cents. */
  yearlyCents: number;
  categoryId: string | null;
  ids: string[];
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
};

/** Test one group of charges from a single merchant for a steady rhythm. */
function detect(merchant: string, rows: Transaction[], fixedAmount: boolean): RecurringCharge | null {
  if (rows.length < 3) return null;
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));

  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i]!.date, sorted[i - 1]!.date));
  const typicalGap = median(gaps);
  const cadence = CADENCES.find((c) => typicalGap >= c.min && typicalGap <= c.max);
  if (!cadence) return null;

  // Nearly every gap has to fit the rhythm. A weekly grocery run drifts; a bill
  // does not. One skipped period (a gap twice as long) is forgiven.
  const fits = gaps.filter((g) => (g >= cadence.min && g <= cadence.max) || (g >= cadence.min * 2 && g <= cadence.max * 2));
  if (fits.length / gaps.length < 0.8) return null;

  const amounts = sorted.map((t) => -countedCents(t));
  const typicalCents = median(amounts);
  if (!fixedAmount) {
    // A bill may swing with the season: heating can cost several times more in
    // January than in July. Over a long steady run that is allowed, up to
    // eightfold between the smallest and largest. A short run has to stay
    // within 35% of typical, because three charges prove much less.
    const steady =
      sorted.length >= 6
        ? Math.max(...amounts) <= Math.min(...amounts) * 8
        : amounts.every((a) => Math.abs(a - typicalCents) <= typicalCents * 0.35);
    if (!steady) return null;
  }

  return {
    merchant,
    cadence: cadence.name,
    typicalCents,
    fixedAmount,
    count: sorted.length,
    firstDate: sorted[0]!.date,
    lastDate: sorted[sorted.length - 1]!.date,
    yearlyCents: typicalCents * cadence.perYear,
    categoryId: sorted[sorted.length - 1]!.categoryId,
    ids: sorted.map((t) => t.id),
  };
}

/**
 * Find recurring charges, costliest first.
 *
 * Charges of exactly the same amount are tested together first, which is what
 * separates two subscriptions billed by the same merchant (a $2.99 and a $9.99
 * charge from one app store). Whatever is left is then tested as one bill whose
 * amount varies.
 */
export function detectRecurring(transactions: readonly Transaction[]): RecurringCharge[] {
  const byMerchant = new Map<string, Transaction[]>();
  for (const t of transactions) {
    if (countedCents(t) >= 0) continue;
    const list = byMerchant.get(t.merchant) ?? [];
    list.push(t);
    byMerchant.set(t.merchant, list);
  }

  const found: RecurringCharge[] = [];
  for (const [merchant, rows] of byMerchant) {
    const byAmount = new Map<number, Transaction[]>();
    for (const t of rows) {
      const list = byAmount.get(t.amountCents) ?? [];
      list.push(t);
      byAmount.set(t.amountCents, list);
    }

    const leftover: Transaction[] = [];
    for (const group of byAmount.values()) {
      const hit = detect(merchant, group, true);
      if (hit) found.push(hit);
      else leftover.push(...group);
    }
    const varying = detect(merchant, leftover, false);
    if (varying) found.push(varying);
  }

  return found.sort((a, b) => b.yearlyCents - a.yearlyCents || a.merchant.localeCompare(b.merchant));
}

/** What all recurring charges add up to per month, in cents. */
export function recurringMonthlyCents(charges: readonly RecurringCharge[]): number {
  return Math.round(charges.reduce((sum, c) => sum + c.yearlyCents, 0) / 12);
}
