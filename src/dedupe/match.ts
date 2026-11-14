/**
 * Cross-source matching.
 *
 * Two problems, one mechanism.
 *
 * The first is double counting. An Amazon order and the card charge that paid
 * for it are the same expense; importing both and summing them says the
 * household spent twice what it did. Amazon supplies the item detail, the card
 * supplies the authoritative amount and date, and only one of them may count.
 *
 * The second is settling refunds. Amazon frequently marks an item returned
 * without saying how much came back, and the credit that later appears on the
 * card is the ground truth. Matching the two both confirms the return happened
 * and supplies the real figure.
 *
 * Nothing here merges anything automatically. Matches are *proposed*, with the
 * reasoning attached, and the user confirms. A wrong automatic merge silently
 * deletes an expense, which is far worse than a review queue.
 */

import { daysBetween } from '@/lib/dates';
import { randomId } from '@/lib/ids';
import { effectiveCents, type Transaction, type TransactionLink } from '@/types/models';

/** How far apart a card charge and an order may be and still be the same purchase. */
const PURCHASE_WINDOW_DAYS = 4;
/** Refund credits lag much further behind the return than a charge does. */
const REFUND_WINDOW_DAYS = 30;

export interface Candidate {
  /** The row that will count toward totals — the card charge. */
  canonical: Transaction;
  /** The row that supplies detail but must not be counted again. */
  linked: Transaction;
  kind: TransactionLink['kind'];
  confidence: number;
  /** Plain-language reason, shown in the review queue. */
  reason: string;
}

function isAmazonRow(t: Transaction): boolean {
  return t.sourceId === 'amazon' || t.merchant === 'Amazon';
}

/** A card charge that looks like it paid Amazon. */
function isAmazonCardCharge(t: Transaction): boolean {
  return t.sourceId !== 'amazon' && t.merchant === 'Amazon' && t.amountCents < 0;
}

/** A credit on a card that looks like an Amazon refund. */
function isAmazonCardCredit(t: Transaction): boolean {
  return t.sourceId !== 'amazon' && t.merchant === 'Amazon' && t.amountCents > 0;
}

/**
 * Propose links between Amazon orders and card rows.
 *
 * Matching is on exact amount within a date window, because Amazon charges the
 * exact order total and an approximate-amount match would be guessing with
 * someone's money. Where several rows could pair, the closest in date wins and
 * confidence drops, so an ambiguous case reaches the user looking ambiguous.
 */
export function proposeLinks(
  transactions: readonly Transaction[],
  existingLinks: readonly TransactionLink[] = [],
): Candidate[] {
  const alreadyLinked = new Set<string>();
  for (const link of existingLinks) {
    if (link.status === 'rejected') continue;
    alreadyLinked.add(link.canonicalId);
    alreadyLinked.add(link.linkedId);
  }

  const amazonOrders = transactions.filter(
    (t) => isAmazonRow(t) && t.sourceId === 'amazon' && !alreadyLinked.has(t.id),
  );
  const cardCharges = transactions.filter((t) => isAmazonCardCharge(t) && !alreadyLinked.has(t.id));
  const cardCredits = transactions.filter((t) => isAmazonCardCredit(t) && !alreadyLinked.has(t.id));

  const candidates: Candidate[] = [];
  const claimedCharges = new Set<string>();
  const claimedCredits = new Set<string>();

  for (const order of amazonOrders) {
    // --- Same purchase: the card charge for this order ---
    if (order.status !== 'cancelled') {
      const matches = cardCharges
        .filter(
          (charge) =>
            !claimedCharges.has(charge.id) &&
            Math.abs(charge.amountCents) === Math.abs(order.amountCents) &&
            daysBetween(charge.date, order.date) <= PURCHASE_WINDOW_DAYS,
        )
        .sort((a, b) => daysBetween(a.date, order.date) - daysBetween(b.date, order.date));

      const best = matches[0];
      if (best) {
        claimedCharges.add(best.id);
        const gap = daysBetween(best.date, order.date);
        candidates.push({
          canonical: best,
          linked: order,
          kind: 'same_purchase',
          // Several equally-good matches means we are choosing arbitrarily, so
          // the queue should say so rather than look confident.
          confidence: matches.length === 1 ? (gap <= 1 ? 0.95 : 0.85) : 0.6,
          reason:
            matches.length === 1
              ? `Same amount, ${gap === 0 ? 'same day' : `${gap} day${gap === 1 ? '' : 's'} apart`}`
              : `${matches.length} card charges match this amount — closest one shown`,
        });
      }
    }

    // --- Refund settlement: the credit that came back for a return ---
    const awaitingRefund =
      (order.status === 'returned' || order.status === 'refunded' || order.status === 'return_started') &&
      order.refundedCents === 0;

    if (awaitingRefund) {
      const credit = cardCredits
        .filter(
          (c) =>
            !claimedCredits.has(c.id) &&
            c.date >= order.date &&
            daysBetween(c.date, order.date) <= REFUND_WINDOW_DAYS &&
            // A refund never exceeds what was charged.
            c.amountCents <= Math.abs(order.amountCents),
        )
        .sort((a, b) => daysBetween(a.date, order.date) - daysBetween(b.date, order.date))[0];

      if (credit) {
        claimedCredits.add(credit.id);
        candidates.push({
          canonical: credit,
          linked: order,
          kind: 'refund_settlement',
          confidence: credit.amountCents === Math.abs(order.amountCents) ? 0.9 : 0.7,
          reason:
            credit.amountCents === Math.abs(order.amountCents)
              ? 'A card credit for the full order amount arrived after the return'
              : 'A card credit arrived after the return, for less than the order total',
        });
      }
    }
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

/** Amazon rows marked returned where no refund ever showed up. */
export function unsettledReturns(
  transactions: readonly Transaction[],
  links: readonly TransactionLink[],
  today: string,
): Transaction[] {
  const settled = new Set(
    links.filter((l) => l.kind === 'refund_settlement' && l.status === 'confirmed').map((l) => l.linkedId),
  );

  return transactions.filter((t) => {
    if (t.sourceId !== 'amazon') return false;
    if (settled.has(t.id)) return false;
    if (t.refundedCents > 0) return false;
    const returning = t.status === 'returned' || t.status === 'refunded' || t.status === 'return_started';
    // Give a refund a fortnight to arrive before calling it worth chasing.
    return returning && daysBetween(today, t.date) > 14;
  });
}

export function candidateToLink(candidate: Candidate, status: TransactionLink['status']): TransactionLink {
  return {
    id: randomId('link'),
    canonicalId: candidate.canonical.id,
    linkedId: candidate.linked.id,
    kind: candidate.kind,
    confidence: candidate.confidence,
    status,
    createdAt: Date.now(),
  };
}

/**
 * Apply a confirmed link to the two transactions.
 *
 * For a purchase, the Amazon row is marked superseded: it keeps its items and
 * stays browsable and searchable, but counts as zero so the purchase is
 * counted once, under the card charge that actually moved the money.
 *
 * For a refund, the credit is what tells us how much really came back, so it
 * settles the order's `refundedCents` and is itself superseded — otherwise the
 * refund would be subtracted once from the order and again as income.
 */
export function applyLink(
  candidate: Candidate,
): { canonical: Transaction; linked: Transaction } {
  if (candidate.kind === 'same_purchase') {
    const order = candidate.linked;
    let canonical = candidate.canonical;
    // The card only says "AMZN Mktp"; the order says what was bought. Once the
    // two are known to be one purchase, the charge (which is the half that
    // counts) takes the order's category, unless the user set the charge's
    // category by hand.
    const orderKnows = order.categoryId && (order.categorySource === 'items' || order.categorySource === 'manual');
    if (orderKnows && canonical.categorySource !== 'manual') {
      canonical = {
        ...canonical,
        categoryId: order.categoryId,
        categorySource: 'linked',
        categoryReason: `It paid for an Amazon order: ${order.description}`,
      };
    }
    return { canonical, linked: { ...order, supersededBy: candidate.canonical.id } };
  }

  const refundCents = Math.min(candidate.canonical.amountCents, Math.abs(candidate.linked.amountCents));
  return {
    canonical: { ...candidate.canonical, supersededBy: candidate.linked.id },
    linked: { ...candidate.linked, refundedCents: refundCents },
  };
}

/** Undo a link, restoring both rows to counting for themselves. */
export function unapplyLink(
  link: TransactionLink,
  transactions: readonly Transaction[],
): Transaction[] {
  const changed: Transaction[] = [];
  const canonical = transactions.find((t) => t.id === link.canonicalId);
  const linked = transactions.find((t) => t.id === link.linkedId);

  if (link.kind === 'same_purchase') {
    if (linked?.supersededBy === link.canonicalId) {
      const { supersededBy: _drop, ...rest } = linked;
      changed.push(rest as Transaction);
    }
    // Hand the charge's category back to the ordinary rules.
    if (canonical?.categorySource === 'linked') {
      const { categoryReason: _reason, ...rest } = canonical;
      changed.push({ ...rest, categoryId: null, categorySource: 'default' } as Transaction);
    }
  } else {
    if (canonical?.supersededBy === link.linkedId) {
      const { supersededBy: _drop, ...rest } = canonical;
      changed.push(rest as Transaction);
    }
    if (linked) changed.push({ ...linked, refundedCents: 0 });
  }

  return changed;
}

export { effectiveCents };
