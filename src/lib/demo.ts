/**
 * Loads the made-up demo household into whichever database is active.
 *
 * The demo files ship with the extension (public/demo/) and go through exactly
 * the code a person's own files do: the CSV parser, column detection, and
 * `runImport`. Nothing is pre-digested, so the demo shows the app as it really
 * behaves, and nothing in Review is confirmed on the user's behalf.
 *
 * The caller is responsible for having switched to the demo workspace first;
 * the store does that, and is the only caller in the app.
 */

import { parseCsvText, rowsToTransactions } from '@/adapters/csv';
import { detectMapping } from '@/adapters/csv/detect';
import { parseOrdersPage } from '@/adapters/amazon/parse';
import { getCategories, getRules, putSource } from '@/lib/db';
import { headerHash } from '@/lib/ids';
import { runImport } from '@/lib/import';
import type { SourceRecord } from '@/types/models';

export const DEMO_INDEX_FILE = 'index.json';

export interface DemoIndex {
  year: number;
  accounts: Array<{ file: string; label: string }>;
  amazon: string;
}

/** Reads one demo file by name. The app fetches it; tests read it from disk. */
export type DemoFileReader = (name: string) => Promise<string>;

/** Reads the demo files the build copied next to the app page. */
export const fetchDemoFile: DemoFileReader = async (name) => {
  const response = await fetch(`./demo/${name}`);
  if (!response.ok) throw new Error(`Could not read demo file ${name}`);
  return response.text();
};

export interface DemoLoadResult {
  added: number;
  files: number;
}

export async function loadDemoData(readFile: DemoFileReader = fetchDemoFile): Promise<DemoLoadResult> {
  const index = JSON.parse(await readFile(DEMO_INDEX_FILE)) as DemoIndex;
  const [rules, categories] = await Promise.all([getRules(), getCategories()]);
  let added = 0;

  for (const { file, label } of index.accounts) {
    const parsed = parseCsvText(await readFile(file));
    const detection = detectMapping(parsed.headers, parsed.rows, { accountLabel: label });
    if (!detection.mapping) {
      throw new Error(`Demo file ${file}: columns not recognised (${detection.missing.join(', ')})`);
    }

    const hash = headerHash(parsed.headers);
    const sourceId = `csv:${hash.slice(0, 12)}`;
    const source: SourceRecord = {
      id: sourceId,
      label,
      kind: 'file',
      adapterId: 'csv',
      headerHash: hash,
      mapping: detection.mapping,
    };
    await putSource(source);

    const { rows, errors } = rowsToTransactions(parsed.records, detection.mapping);
    const outcome = await runImport(
      rows,
      { sourceId, adapterId: 'csv', label: file, rules, categories, source },
      errors,
    );
    added += outcome.stats.added;
  }

  await putSource({ id: 'amazon', label: 'Amazon', kind: 'scraper', adapterId: 'amazon' });
  const doc = new DOMParser().parseFromString(await readFile(index.amazon), 'text/html');
  const amazon = await runImport(parseOrdersPage(doc).rows, {
    sourceId: 'amazon',
    adapterId: 'amazon',
    label: `Amazon ${index.year} (demo)`,
    rules,
    categories,
  });
  added += amazon.stats.added;

  return { added, files: index.accounts.length + 1 };
}
