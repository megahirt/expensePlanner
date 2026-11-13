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
import { beforeAll, describe, expect, it } from 'vitest';
import { parseCsvText, rowsToTransactions } from '@/adapters/csv';
import { detectMapping } from '@/adapters/csv/detect';
import { parseOrdersPage } from '@/adapters/amazon/parse';
import { runImport } from '@/lib/import';
import { clearAllData, countTransactions, getAllTransactions } from '@/lib/db';
import { headerHash } from '@/lib/ids';
import { applyFilters, emptyFilters, totals } from '@/lib/filter';
import { applyLink, candidateToLink, proposeLinks, unsettledReturns } from '@/dedupe/match';
import { DEFAULT_CATEGORIES, defaultRules } from '@/categorize/defaults';
import { effectiveCents, type Transaction } from '@/types/models';
import {
  DEMO_ACCOUNTS,
  DEMO_AMAZON_FILE,
  DEMO_DIR,
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

  it('categorizes most rows with the starter rules, and leaves real work to do', () => {
    const categorized = all.filter((t) => t.categoryId).length / all.length;
    expect(categorized).toBeGreaterThan(0.7);
    expect(categorized).toBeLessThan(0.97);
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
    expect(after).toBeLessThan(before);
    expect(before - after).toBeGreaterThan(manifest.amazon.faceValueCents * 0.8);
  });
});
