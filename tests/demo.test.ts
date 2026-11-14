/**
 * The demo household: a year of made-up data across every kind of source.
 *
 * These tests do two jobs. They keep the committed demo files honest (they must
 * match the generator, and read back as what the generator intended), and they
 * are the one place the whole pipeline is exercised at realistic scale: four
 * differently-shaped bank exports plus an Amazon history, imported together.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCsvText, rowsToTransactions } from '@/adapters/csv';
import { detectMapping } from '@/adapters/csv/detect';
import { parseOrdersPage } from '@/adapters/amazon/parse';
import { runImport } from '@/lib/import';
import {
  clearAllData,
  countTransactions,
  getAllTransactions,
  getSources,
  putCategories,
  putRules,
  setActiveWorkspace,
} from '@/lib/db';
import { loadDemoData, type DemoIndex } from '@/lib/demo';
import { headerHash } from '@/lib/ids';
import { applyFilters, emptyFilters, totals } from '@/lib/filter';
import { detectRecurring } from '@/lib/recurring';
import { applyLink, candidateToLink, proposeLinks, unsettledReturns } from '@/dedupe/match';
import { DEFAULT_CATEGORIES, defaultRules } from '@/categorize/defaults';
import { effectiveCents, type Transaction } from '@/types/models';
import {
  DEMO_ACCOUNTS,
  DEMO_AMAZON_FILE,
  DEMO_DIR,
  DEMO_INDEX_FILE,
  DEMO_YEAR,
  generateDemoData,
} from '../scripts/generate-demo-data.mjs';

const { files, manifest } = generateDemoData();
const onDisk = (name: string) => readFileSync(join(DEMO_DIR, name), 'utf8');

/** Read a demo CSV exactly the way the Import screen does, with no hand-fixing. */
function readCsv(file: string, label: string) {
  const parsed = parseCsvText(onDisk(file));
  const detection = detectMapping(parsed.headers, parsed.rows, { accountLabel: label });
  if (!detection.mapping) throw new Error(`${file}: mapping not detected (${detection.missing.join(', ')})`);
  return { parsed, mapping: detection.mapping, ...rowsToTransactions(parsed.records, detection.mapping) };
}

function readAmazon() {
  const doc = new DOMParser().parseFromString(onDisk(DEMO_AMAZON_FILE), 'text/html');
  return parseOrdersPage(doc);
}

const RULES = defaultRules();

async function importEverything() {
  let added = 0;
  for (const { file, label } of DEMO_ACCOUNTS) {
    const { parsed, rows, errors } = readCsv(file, label);
    const outcome = await runImport(
      rows,
      {
        sourceId: `csv:${headerHash(parsed.headers).slice(0, 12)}`,
        adapterId: 'csv',
        label: file,
        rules: RULES,
        categories: DEFAULT_CATEGORIES,
      },
      errors,
    );
    added += outcome.stats.added;
  }
  const amazon = await runImport(readAmazon().rows, {
    sourceId: 'amazon',
    adapterId: 'amazon',
    label: 'Amazon demo',
    rules: RULES,
    categories: DEFAULT_CATEGORIES,
  });
  return added + amazon.stats.added;
}

describe('demo files', () => {
  it('match what the generator produces', () => {
    // If this fails, the generator changed without the files being rebuilt:
    // run `npm run demo:data` and commit the result.
    for (const [name, content] of Object.entries(files)) {
      expect(onDisk(name), name).toBe(content);
    }
  });

  it('are generated identically every time', () => {
    expect(generateDemoData().files).toEqual(files);
  });

  it('cover every month of the year in every account', () => {
    for (const { file, label } of DEMO_ACCOUNTS) {
      const { rows } = readCsv(file, label);
      const months = new Set(rows.map((r) => r.date.slice(0, 7)));
      expect(months.size, file).toBe(12);
      expect(rows.every((r) => r.date.startsWith(`${DEMO_YEAR}-`)), file).toBe(true);
    }
    const amazonMonths = new Set(readAmazon().rows.map((r) => r.date.slice(0, 7)));
    expect(amazonMonths.size).toBe(12);
  });

  it('never overdraw the checking account', () => {
    expect(manifest.accounts['schwab-checking.csv']!.lowestBalanceCents).toBeGreaterThan(0);
  });
});

describe('demo bank exports', () => {
  it.each(DEMO_ACCOUNTS)('$file maps itself and reads every row', ({ file, label }) => {
    const { rows, errors } = readCsv(file, label);
    const expected = manifest.accounts[file]!;

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(expected.rows);
    expect(rows.every((r) => r.accountLabel === label)).toBe(true);
  });

  it.each(DEMO_ACCOUNTS)('$file has money in and money out the right way round', ({ file, label }) => {
    // Each file writes amounts differently: separate columns, negative spend,
    // positive spend. Reading any of them backwards flips every number, so the
    // totals are checked against what the generator set out to write.
    const { rows } = readCsv(file, label);
    const expected = manifest.accounts[file]!;
    const out = rows.filter((r) => r.amountCents < 0).reduce((sum, r) => sum - r.amountCents, 0);
    const into = rows.filter((r) => r.amountCents > 0).reduce((sum, r) => sum + r.amountCents, 0);

    expect(out).toBe(expected.outCents);
    expect(into).toBe(expected.inCents);
  });

  it('each have their own column layout, so each is remembered separately', () => {
    const hashes = DEMO_ACCOUNTS.map(({ file }) => headerHash(parseCsvText(onDisk(file)).headers));
    expect(new Set(hashes).size).toBe(DEMO_ACCOUNTS.length);
  });

  it('read the positive-is-spending card correctly', () => {
    const { mapping } = readCsv('amex-blue-cash.csv', 'Amex');
    expect(mapping.positiveMeansSpend).toBe(true);
    expect(readCsv('chase-sapphire.csv', 'Chase').mapping.positiveMeansSpend).toBe(false);
  });
});

describe('demo Amazon history', () => {
  it('reads every order', () => {
    const result = readAmazon();
    expect(result.staleSelectors).toBeUndefined();
    expect(result.warnings).toBeUndefined();
    expect(result.rows).toHaveLength(manifest.amazon.orders);
    expect(new Set(result.rows.map((r) => r.externalId)).size).toBe(manifest.amazon.orders);
    expect(result.rows.reduce((sum, r) => sum - r.amountCents, 0)).toBe(manifest.amazon.faceValueCents);
  });

  it('reads cancellations and stated refunds', () => {
    const rows = readAmazon().rows;
    expect(rows.filter((r) => r.status === 'cancelled')).toHaveLength(manifest.amazon.cancelled);

    for (const { order, cents } of manifest.amazon.explicitRefunds) {
      expect(rows.find((r) => r.externalId === order)?.refundedCents, order).toBe(cents);
    }
  });

  it('does not guess a refund Amazon did not state', () => {
    const rows = readAmazon().rows;
    const waiting = [...manifest.amazon.refundSettlements.map((s) => s.order), ...manifest.amazon.unsettledReturns];
    for (const order of waiting) {
      const row = rows.find((r) => r.externalId === order);
      expect(row?.refundedCents, order).toBe(0);
      expect(['returned', 'return_started'], order).toContain(row?.status);
    }
  });
});

describe('demo household, imported together', () => {
  let all: Transaction[];

  beforeAll(async () => {
    await clearAllData();
    const added = await importEverything();
    expect(added).toBe(manifest.totalRows);
    all = await getAllTransactions();
  });

  it('adds nothing when every file is imported a second time', async () => {
    expect(await importEverything()).toBe(0);
    expect(await countTransactions()).toBe(manifest.totalRows);
  });

  it('categorizes nearly everything, and says why each time', () => {
    const categorized = all.filter((t) => t.categoryId);
    expect(categorized.length / all.length).toBeGreaterThan(0.9);
    expect(categorized.every((t) => t.categoryReason)).toBe(true);

    // Every source of knowledge earns its place on realistic data.
    const sources = new Set(categorized.map((t) => t.categorySource));
    expect([...sources].sort()).toEqual(['bank', 'directory', 'items', 'keyword', 'rule']);
  });

  it('leaves the genuinely unknowable for a person to decide', () => {
    // Cash, paper checks and payments to people say nothing about what they
    // were for. Guessing would be worse than asking.
    const unknown = new Set(all.filter((t) => !t.categoryId).map((t) => t.merchant));
    expect(unknown).toContain('Check Paid');
    expect(unknown).toContain('Venmo Payment');
    expect(unknown.size).toBeLessThan(10);
  });

  it('files Amazon orders by what was in them, not all under Shopping', () => {
    const orders = all.filter((t) => t.sourceId === 'amazon');
    const byItems = orders.filter((t) => t.categorySource === 'items');
    expect(byItems.length / orders.length).toBeGreaterThan(0.6);
    expect(new Set(byItems.map((t) => t.categoryId)).size).toBeGreaterThanOrEqual(4);

    const dogFood = orders.find((t) => t.items?.length === 1 && /dog food/i.test(t.items[0]!.name));
    expect(dogFood?.categoryId).toBe('cat-household');
  });

  it('finds the subscriptions and bills', () => {
    const recurring = detectRecurring(all);
    const names = recurring.map((r) => r.merchant);

    for (const expected of ['Netflix.com', 'Spotify Usa', 'Rocket Mortgage Loan Pmt', 'Verizon Wireless Payments']) {
      expect(names, expected).toContain(expected);
    }
    // One merchant billing two different subscriptions is two findings.
    expect(recurring.filter((r) => r.merchant === 'Apple.com Bill').map((r) => r.typicalCents).sort()).toEqual([299, 999]);
    // A bill that swings with the season still counts, and says its amount varies.
    expect(recurring.find((r) => r.merchant === 'Puget Sound Energy Billpay')?.fixedAmount).toBe(false);
    // Habits are not subscriptions, however often they happen.
    expect(names).not.toContain('Starbucks');
    expect(names).not.toContain('Safeway');
    // Moving money to savings every month is not a charge.
    expect(names.some((n) => /transfer/i.test(n))).toBe(false);
  });

  it('does not count paying off a card, or moving savings, as spending', () => {
    const isOwnMoney = (t: Transaction) =>
      /AUTOPAY|EPAYMENT|Payment Thank You|TRANSFER (TO|FROM)/i.test(t.description);
    const moved = all.filter(isOwnMoney);

    // Twelve payments on each card seen from both sides, plus fifteen savings
    // transfers seen from both sides.
    expect(moved).toHaveLength(12 * 4 + 15 * 2);
    expect(moved.every((t) => t.categoryId === 'cat-transfer')).toBe(true);

    const t = totals(all);
    expect(t.transferCents).toBe(moved.reduce((sum, m) => sum + Math.abs(m.amountCents), 0));

    // Checking pays the cards, so its own spending is everything it sent out
    // that was not a transfer. Before this was handled, the card payments made
    // the household look like it spent tens of thousands more than it did.
    const checkingOut = manifest.accounts['schwab-checking.csv']!.outCents;
    const checking = totals(all.filter((r) => r.accountLabel.startsWith('Schwab')));
    expect(checking.spentCents).toBeLessThan(checkingOut * 0.6);
  });

  it('counts paying a person as spending, because that money really left', () => {
    const paid = all.filter((t) => /^(ZELLE PAYMENT TO|VENMO PAYMENT)/.test(t.description));
    expect(paid.length).toBeGreaterThan(20);
    expect(paid.every((t) => t.categoryId !== 'cat-transfer')).toBe(true);
  });

  it('proposes the card charge for every Amazon order that was charged', () => {
    const purchases = proposeLinks(all).filter((c) => c.kind === 'same_purchase');

    expect(purchases).toHaveLength(manifest.amazon.purchaseLinks);
    expect(new Set(purchases.map((c) => c.canonical.id)).size).toBe(purchases.length);
    for (const c of purchases) {
      expect(c.linked.sourceId).toBe('amazon');
      expect(c.canonical.sourceId).not.toBe('amazon');
      expect(Math.abs(c.canonical.amountCents)).toBe(Math.abs(c.linked.amountCents));
    }
    // The same item bought twice in three days is flagged as a guess, and
    // nothing else is.
    expect(purchases.filter((c) => c.confidence < 0.8)).toHaveLength(manifest.amazon.ambiguousPurchaseLinks);
    // Some orders went on the second card, so matching is not tied to one account.
    expect(new Set(purchases.map((c) => c.canonical.accountLabel)).size).toBe(2);
  });

  it('settles each unstated refund with the credit that paid it', () => {
    const settlements = proposeLinks(all).filter((c) => c.kind === 'refund_settlement');

    expect(settlements).toHaveLength(manifest.amazon.refundSettlements.length);
    for (const { order, cents } of manifest.amazon.refundSettlements) {
      const match = settlements.find((c) => c.linked.externalId === order);
      expect(match?.canonical.amountCents, order).toBe(cents);
    }
  });

  it('lists the returns whose refund never arrived', () => {
    const today = `${DEMO_YEAR + 1}-02-01`;
    const numbers = (rows: Transaction[]) => rows.map((t) => t.externalId).sort();
    const settled = manifest.amazon.refundSettlements.map((s) => s.order);
    const missing = manifest.amazon.unsettledReturns;

    // Before review, every return with no stated refund is still open.
    expect(numbers(unsettledReturns(all, [], today))).toEqual([...settled, ...missing].sort());

    // Confirming the credits that did arrive leaves only the ones worth chasing.
    const confirmed = proposeLinks(all)
      .filter((c) => c.kind === 'refund_settlement')
      .map((c) => candidateToLink(c, 'confirmed'));
    expect(numbers(unsettledReturns(all, confirmed, today))).toEqual([...missing].sort());
  });

  it('counts each Amazon purchase once after the review queue is confirmed', () => {
    const before = totals(applyFilters(all, emptyFilters())).spentCents;

    const byId = new Map(all.map((t) => [t.id, t]));
    for (const candidate of proposeLinks(all)) {
      const current = {
        ...candidate,
        canonical: byId.get(candidate.canonical.id)!,
        linked: byId.get(candidate.linked.id)!,
      };
      const { canonical, linked } = applyLink(current);
      byId.set(canonical.id, canonical);
      byId.set(linked.id, linked);
    }
    const linkedUp = [...byId.values()];
    const after = totals(applyFilters(linkedUp, emptyFilters())).spentCents;

    // What drops out is exactly the Amazon side of every charged order: those
    // dollars were counted twice, once from the order and once from the card.
    const amazonStillCounted = linkedUp
      .filter((t) => t.sourceId === 'amazon')
      .reduce((sum, t) => sum - effectiveCents(t), 0);
    expect(amazonStillCounted).toBe(0);

    // The card only ever said "AMZN Mktp". Once matched, the charge takes on
    // what the order was for, so the money shows up under the right category.
    const charges = linkedUp.filter((t) => t.sourceId !== 'amazon' && t.merchant === 'Amazon' && t.amountCents < 0);
    const inherited = charges.filter((t) => t.categorySource === 'linked');
    expect(inherited.length / charges.length).toBeGreaterThan(0.6);
    expect(inherited.every((t) => t.categoryReason?.startsWith('It paid for an Amazon order'))).toBe(true);
    expect(new Set(inherited.map((t) => t.categoryId)).size).toBeGreaterThanOrEqual(4);
    expect(after).toBeLessThan(before);
    expect(before - after).toBeGreaterThan(manifest.amazon.faceValueCents * 0.8);
  });
});

describe('demo household, loaded by the app into its own database', () => {
  // The real database still holds the rows the previous block imported, which
  // is what makes "untouched" below a real claim.
  beforeAll(async () => {
    await setActiveWorkspace('demo');
    await clearAllData();
    await putCategories(DEFAULT_CATEGORIES);
    await putRules(defaultRules());
  });

  afterAll(async () => {
    await setActiveWorkspace('real');
  });

  it('ships an index naming every file the loader needs', () => {
    const index = JSON.parse(onDisk(DEMO_INDEX_FILE)) as DemoIndex;
    expect(index.accounts).toEqual(DEMO_ACCOUNTS);
    expect(index.amazon).toBe(DEMO_AMAZON_FILE);
    expect(index.year).toBe(DEMO_YEAR);
  });

  it('loads every row, with each account named', async () => {
    const result = await loadDemoData(async (name) => onDisk(name));
    expect(result.added).toBe(manifest.totalRows);
    expect(await countTransactions()).toBe(manifest.totalRows);

    const labels = (await getSources()).map((s) => s.label).sort();
    expect(labels).toEqual(['Amazon', ...DEMO_ACCOUNTS.map((a) => a.label)].sort());
  });

  it('adds nothing when loaded a second time', async () => {
    const result = await loadDemoData(async (name) => onDisk(name));
    expect(result.added).toBe(0);
    expect(await countTransactions()).toBe(manifest.totalRows);
  });

  it('can be wiped without touching the real data', async () => {
    await clearAllData();
    expect(await countTransactions()).toBe(0);

    await setActiveWorkspace('real');
    expect(await countTransactions()).toBe(manifest.totalRows);
    expect(await getSources()).toEqual([]);
  });
});
