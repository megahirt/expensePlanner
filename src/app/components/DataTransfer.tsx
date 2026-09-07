/**
 * Export, backup and merge.
 *
 * Downloading uses a blob URL and an anchor click, which works from an
 * extension page and keeps the file on the user's machine — nothing is uploaded
 * anywhere to produce it.
 */

import { useRef, useState } from 'react';
import { buildCsv, csvFileName } from '@/transfer/exportCsv';
import { backupFileName, buildBackup, parseBackup } from '@/transfer/backup';
import { looksLikeOurExport, mergeBackup, mergeOurCsv, transactionsFromOurCsv } from '@/transfer/merge';
import { parseCsvText } from '@/adapters/csv';
import { summarizeImport } from '@/lib/import';
import { applyFilters, type Filters } from '@/lib/filter';
import { useStore } from '../store';

function download(contents: string, fileName: string, mime: string): void {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoke on the next tick so the download has certainly started.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DataTransfer({ filters }: { filters: Filters }) {
  const { transactions, categories, rules, sources, links, batches, settings, refresh } = useStore();
  const [explodeItems, setExplodeItems] = useState(false);
  const [filteredOnly, setFilteredOnly] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const rowsToExport = filteredOnly ? applyFilters(transactions, filters) : transactions;

  const exportCsv = () => {
    setError(null);
    const csv = buildCsv(rowsToExport, {
      explodeItems,
      profileLabel: settings.profileLabel,
      categories,
    });
    download(csv, csvFileName(), 'text/csv');
    setMessage(`Exported ${rowsToExport.length.toLocaleString()} transactions to CSV.`);
  };

  const exportBackup = () => {
    setError(null);
    const json = buildBackup({
      profileLabel: settings.profileLabel,
      transactions,
      categories,
      rules,
      sources,
      links,
      batches,
      settings,
    });
    download(json, backupFileName(), 'application/json');
    setMessage(`Backed up ${transactions.length.toLocaleString()} transactions, plus your rules and categories.`);
  };

  const handleMergeFile = async (file: File) => {
    setError(null);
    setMessage(null);
    try {
      const text = await file.text();

      if (file.name.toLowerCase().endsWith('.json') || text.trimStart().startsWith('{')) {
        const backup = parseBackup(text);
        const result = await mergeBackup(backup, { categories, rules });
        await refresh();

        const parts = [summarizeImport(result.stats)];
        if (result.categoriesAdded > 0) parts.push(`${result.categoriesAdded} new categories`);
        if (result.rulesAdded > 0) parts.push(`${result.rulesAdded} new rules`);
        if (result.ruleConflicts.length > 0) {
          parts.push(
            `${result.ruleConflicts.length} rules kept as yours because they conflicted — check Settings if that is not what you wanted`,
          );
        }
        setMessage(parts.join(' · '));
        return;
      }

      const parsed = parseCsvText(text);
      if (!looksLikeOurExport(parsed.headers)) {
        setError(
          'That looks like a bank CSV rather than an expensePlanner export. Use the Import screen for bank files.',
        );
        return;
      }

      const { transactions: incoming, errors } = transactionsFromOurCsv(text, categories);
      const { stats } = await mergeOurCsv(incoming, `Merged from ${file.name}`, errors);
      await refresh();
      setMessage(summarizeImport(stats));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <section className="card">
      <h2>Export, back up and merge</h2>
      <p className="dim">
        Everything here happens on this computer. Nothing is uploaded to produce a file, and nothing
        leaves unless you send it somewhere yourself.
      </p>

      <div className="transfer-grid">
        <div>
          <h3>One CSV of everything</h3>
          <p className="dim">
            Every source in one flat file, with your categories, notes and what each row is actually
            worth after refunds — so a spreadsheet sees the work you did, not just raw descriptions.
          </p>
          <label className="checkbox">
            <input type="checkbox" checked={explodeItems} onChange={(e) => setExplodeItems(e.target.checked)} />
            One row per Amazon item instead of per order
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={filteredOnly} onChange={(e) => setFilteredOnly(e.target.checked)} />
            Only what the Transactions filters currently show
          </label>
          <div className="actions left">
            <button className="primary" onClick={exportCsv} disabled={rowsToExport.length === 0}>
              Export {rowsToExport.length.toLocaleString()} rows to CSV
            </button>
          </div>
        </div>

        <div>
          <h3>Full backup</h3>
          <p className="dim">
            The real backup: transactions plus your rules, categories, links and import history. A CSV
            alone cannot restore your rule set. Worth doing before resetting a Chrome profile.
          </p>
          <div className="actions left">
            <button onClick={exportBackup} disabled={transactions.length === 0}>
              Download backup
            </button>
          </div>
        </div>

        <div>
          <h3>Merge another install</h3>
          <p className="dim">
            Bring in a CSV or backup exported from another copy of expensePlanner — the other half of
            a household, or your own machine. It goes through the same duplicate checking as any
            import, so anything you already have is recognised and skipped, and it can be undone from
            the import history.
          </p>
          <div className="actions left">
            <button onClick={() => fileInput.current?.click()}>Choose a file to merge…</button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.json,text/csv,application/json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleMergeFile(file);
                e.target.value = '';
              }}
            />
          </div>
        </div>
      </div>

      {message && <div className="callout ok transfer-result">{message}</div>}
      {error && <div className="callout danger transfer-result">{error}</div>}
    </section>
  );
}
