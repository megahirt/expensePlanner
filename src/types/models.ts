/**
 * Core data model.
 *
 * Two invariants matter more than anything else here:
 *
 * 1. Money is ALWAYS integer cents, never a float. `12.30 - 12.10 !== 0.2` in
 *    IEEE-754, and a budgeting tool that disagrees with your bank by a penny is
 *    a tool you stop trusting. See `lib/money.ts`.
 *
 * 2. Transaction ids are CONTENT-ADDRESSED (see `lib/ids.ts`). Re-importing a
 *    file that overlaps one you already imported produces the same ids, so the
 *    overlap is skipped rather than double-counted. This is what makes the
 *    "download the last 90 days every month" workflow safe.
 */

/** Status of an order or line item. Drives whether it counts toward spend. */
export type ItemStatus =
  | 'ordered'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'return_started'
  | 'returned'
  | 'refunded'
  | 'unknown';

/** Statuses that represent money that was never spent, or came back. */
export const NON_SPEND_STATUSES: ReadonlySet<ItemStatus> = new Set<ItemStatus>([
  'cancelled',
  'returned',
  'refunded',
]);

/** Where a category assignment came from. Manual always outranks a rule. */
export type CategorySource = 'manual' | 'rule' | 'default' | 'imported';

/** A single item within an order (Amazon gives us this; bank CSVs do not). */
export interface LineItem {
  name: string;
  quantity: number;
  /** Unit price times quantity, in cents. Positive. */
  amountCents: number;
  status: ItemStatus;
  /** The literal status text scraped from the page, kept so unrecognised
   *  wording is visible in the UI instead of silently becoming 'unknown'. */
  statusRaw?: string;
  /** How much of `amountCents` has been refunded. Often less than the full
   *  price: restocking fees and outbound shipping are frequently not refunded. */
  refundedCents: number;
  /** True when the item is marked returned but no refund amount is known yet. */
  refundPending?: boolean;
  productUrl?: string;
  asin?: string;
}

/** A normalized transaction. The unit of everything the app displays. */
export interface Transaction {
  /** Deterministic content hash — see `lib/ids.ts`. */
  id: string;
  /** Which adapter/source produced this, e.g. 'amazon' or 'csv:schwab-checking'. */
  sourceId: string;
  /** Human label for the account, e.g. "Schwab Checking …1234". */
  accountLabel: string;
  /** Posted date, ISO `YYYY-MM-DD` in local terms (no timezone games). */
  date: string;
  /** Raw description exactly as the source gave it. */
  description: string;
  /** Normalized merchant, used for rule matching and grouping. */
  merchant: string;
  /** Signed, in cents. Negative = money out. Positive = money in (refund/credit). */
  amountCents: number;
  currency: string;
  categoryId: string | null;
  categorySource: CategorySource;
  status: ItemStatus;
  statusRaw?: string;
  /** Portion of this transaction refunded, in cents (always >= 0). */
  refundedCents: number;
  /** Stable id from the source when it has one (OFX FITID, Amazon order id). */
  externalId?: string;
  /** Per-item detail, when the source provides it. */
  items?: LineItem[];
  notes?: string;
  tags?: string[];
  /** Original source row/payload, so a parser bug is recoverable without re-importing. */
  raw?: Record<string, unknown>;
  /** Which import batch created this row (enables undo). */
  batchId: string;
  importedAt: number;
  /** Set when this row is the non-canonical half of a confirmed link — it stays
   *  browsable but is excluded from totals so a purchase isn't counted twice. */
  supersededBy?: string;
}

/** A user-defined or seeded spending category. */
export interface Category {
  id: string;
  name: string;
  /** Optional parent for a two-level hierarchy (e.g. Food > Groceries). */
  parentId?: string | null;
  color?: string;
  /** Seeded categories can be renamed but are recreated if missing. */
  builtin?: boolean;
  archived?: boolean;
}

export type RuleMatcher =
  | { kind: 'merchant_contains'; value: string }
  | { kind: 'description_contains'; value: string }
  | { kind: 'regex'; value: string; field: 'merchant' | 'description' }
  | { kind: 'amount_between'; minCents: number; maxCents: number }
  | { kind: 'source_is'; value: string };

/** A categorization rule. Ordered; first match wins. */
export interface Rule {
  id: string;
  /** Lower runs first. */
  order: number;
  /** All matchers must match (AND). */
  matchers: RuleMatcher[];
  categoryId: string;
  enabled: boolean;
  /** True when the rule was created by the "always categorize X as Y" prompt. */
  learned?: boolean;
  createdAt: number;
  note?: string;
}

/** A registered source (a CSV mapping profile, or a scraper). */
export interface SourceRecord {
  id: string;
  label: string;
  kind: 'file' | 'scraper';
  adapterId: string;
  /** For CSV profiles: hash of the header row, used to auto-apply the mapping. */
  headerHash?: string;
  mapping?: ColumnMapping;
  lastImportAt?: number;
}

/** How a CSV's columns map onto our model. */
export interface ColumnMapping {
  date: string;
  description: string;
  /** Either a single signed amount column… */
  amount?: string;
  /** …or separate debit/credit columns. */
  debit?: string;
  credit?: string;
  accountLabel?: string;
  /** Column holding a stable unique id, if the export has one. */
  externalId?: string;
  /** Date format hint, e.g. 'MM/DD/YYYY'. Detected, user-confirmable. */
  dateFormat: string;
  /** When true, a positive number in `amount` means money OUT and is negated. */
  positiveMeansSpend: boolean;
  /** Fixed account label when the file has no account column. */
  defaultAccountLabel?: string;
  currency: string;
}

/** Link between two transactions representing the same real-world money movement. */
export interface TransactionLink {
  id: string;
  /** The row that counts toward totals (usually the card charge). */
  canonicalId: string;
  /** The row that supplies detail but must not be double-counted. */
  linkedId: string;
  kind: 'same_purchase' | 'refund_settlement';
  confidence: number;
  status: 'proposed' | 'confirmed' | 'rejected';
  createdAt: number;
}

/** One import run, so it can be summarized and undone. */
export interface ImportBatch {
  id: string;
  sourceId: string;
  adapterId: string;
  label: string;
  startedAt: number;
  finishedAt?: number;
  stats: ImportStats;
  /** Ids this batch actually created, so undo removes only those. */
  createdIds: string[];
  /** Prior values of rows this batch updated, so undo can restore them. */
  updatedBefore?: Array<Pick<Transaction, 'id'> & Partial<Transaction>>;
}

export interface ImportStats {
  read: number;
  added: number;
  duplicates: number;
  updated: number;
  needsReview: number;
  skipped: number;
  errors: string[];
}

export function emptyStats(): ImportStats {
  return { read: 0, added: 0, duplicates: 0, updated: 0, needsReview: 0, skipped: 0, errors: [] };
}

export interface Settings {
  id: 'settings';
  currency: string;
  showReturnedAndCancelled: boolean;
  /** Profile label written into exports so a merged household view can tell
   *  whose data a row came from. */
  profileLabel: string;
  schemaVersion: number;
}

export function defaultSettings(): Settings {
  return {
    id: 'settings',
    currency: 'USD',
    showReturnedAndCancelled: false,
    profileLabel: 'me',
    schemaVersion: 1,
  };
}

/**
 * The amount of a transaction that actually counts as spend, in cents.
 *
 * Cancelled orders never hit a card, returned/refunded money came back, and a
 * linked duplicate is already counted under its canonical row. Everything that
 * sums money must go through this rather than reading `amountCents` directly.
 */
export function effectiveCents(t: Transaction): number {
  if (t.supersededBy) return 0;
  if (t.status === 'cancelled') return 0;
  const sign = t.amountCents < 0 ? -1 : 1;
  const magnitude = Math.abs(t.amountCents) - t.refundedCents;
  return magnitude <= 0 ? 0 : sign * magnitude;
}

/**
 * The category for money moving between the household's own accounts: paying a
 * credit card from checking, or shifting money into savings.
 */
export const TRANSFER_CATEGORY_ID = 'cat-transfer';

/** True when a row is money moving between the household's own accounts. */
export function isTransfer(t: Transaction): boolean {
  return t.categoryId === TRANSFER_CATEGORY_ID;
}

/**
 * What a transaction contributes to spending and income totals, in cents.
 *
 * `effectiveCents` answers "how much money did this row really move"; this
 * answers "how much of that was spent or earned". They differ for transfers. A
 * card payment is the same money as the purchases already listed on the card,
 * so once two accounts are imported, counting it would count every card
 * purchase twice: once when it was bought and again when the bill was paid.
 *
 * Transfers are identified by category rather than guessed from descriptions,
 * so the rule is visible and correctable like any other categorization: move a
 * row out of the category and it counts again.
 */
export function countedCents(t: Transaction): number {
  return isTransfer(t) ? 0 : effectiveCents(t);
}

/**
 * True when a row contributes nothing at all, and so is hidden unless "show
 * returned and cancelled" is on.
 *
 * Defined by what the row is worth, not by its status label. A $89 keyboard
 * refunded at $82 is *marked* returned, but $7 of it was genuinely spent (the
 * restocking fee), so hiding it would quietly understate what the household
 * paid. Only rows worth exactly nothing — cancelled orders, fully refunded
 * ones, and the non-canonical half of a linked pair — drop out of view.
 */
export function isNonSpend(t: Transaction): boolean {
  return effectiveCents(t) === 0;
}

/** True when a row carries a return, cancellation or link worth flagging. */
export function hasReturnActivity(t: Transaction): boolean {
  return NON_SPEND_STATUSES.has(t.status) || t.refundedCents > 0 || Boolean(t.supersededBy);
}
