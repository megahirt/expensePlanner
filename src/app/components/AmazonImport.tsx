/**
 * Amazon import panel.
 *
 * Two ways in. The normal one drives a real browser tab through your order
 * history. The second — pasting the HTML of a saved orders page — exists
 * because Amazon changes its markup without warning: when that happens you can
 * see exactly what the parser makes of a real page, and the selectors can be
 * repaired against it without anyone needing your Amazon credentials.
 */

import { useState } from 'react';
import { AMAZON_HOST_PERMISSION, selectableYears } from '@/background/amazon';
import { parseOrdersPage } from '@/adapters/amazon/parse';
import { runImport, summarizeImport } from '@/lib/import';
import type { ImportStats } from '@/types/models';
import { useStore } from '../store';

type Phase = 'idle' | 'running' | 'done' | 'error';

export function AmazonImport() {
  const { rules, categories, refresh, saveSource } = useStore();
  const [years, setYears] = useState<number[]>([selectableYears()[0]!]);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<string>('');
  const [stats, setStats] = useState<ImportStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [pasted, setPasted] = useState('');

  const importRows = async (rows: Parameters<typeof runImport>[0], label: string) => {
    // Register Amazon as a source so it appears in the account filter alongside
    // the imported bank files.
    await saveSource({ id: 'amazon', label: 'Amazon', kind: 'scraper', adapterId: 'amazon' });

    const outcome = await runImport(rows, {
      sourceId: 'amazon',
      adapterId: 'amazon',
      label,
      rules,
      categories,
    });
    setStats(outcome.stats);
    await refresh();
  };

  const runScrape = async () => {
    setPhase('running');
    setError(null);
    setStale(false);
    setStats(null);
    setProgress('Asking for permission to read your Amazon orders…');

    try {
      // Host access is requested here, at the moment it is used, rather than
      // being held from install. Until you press this button the extension has
      // no access to any website at all.
      const granted = await chrome.permissions.request({ origins: [AMAZON_HOST_PERMISSION] });
      if (!granted) {
        setPhase('idle');
        setProgress('');
        setError('Permission declined, so nothing was read.');
        return;
      }

      setProgress('Opening your Amazon orders…');
      const { scrapeAmazonYears } = await import('@/background/amazon');
      const result = await scrapeAmazonYears(years, (p) => setProgress(p.message));

      if (result.staleSelectors && result.rows.length === 0) {
        setStale(true);
        setPhase('error');
        return;
      }

      await importRows(result.rows, `Amazon ${years.join(', ')}`);
      setPhase('done');
      setProgress('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  const runPaste = async () => {
    setError(null);
    setStale(false);
    setStats(null);
    try {
      const doc = new DOMParser().parseFromString(pasted, 'text/html');
      const result = parseOrdersPage(doc);
      if (result.rows.length === 0) {
        setStale(Boolean(result.staleSelectors));
        setError(
          result.staleSelectors
            ? 'That page looks like an order list, but nothing could be read from it.'
            : 'No orders found in that HTML.',
        );
        setPhase('error');
        return;
      }
      await importRows(result.rows, 'Amazon (pasted page)');
      setPhase('done');
      setPasted('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    }
  };

  return (
    <section className="card">
      <h2>Amazon orders</h2>
      <p className="dim">
        Reads your order history for the years you pick, including which items were returned or
        cancelled so they do not count as spending. Amazon has no CSV export, which is why this reads
        the pages directly.
      </p>

      <div className="year-picker">
        {selectableYears().map((year) => (
          <label key={year} className={`chip ${years.includes(year) ? 'on' : ''}`}>
            <input
              type="checkbox"
              checked={years.includes(year)}
              onChange={(e) =>
                setYears((prev) =>
                  e.target.checked ? [...prev, year].sort((a, b) => b - a) : prev.filter((y) => y !== year),
                )
              }
            />
            {year}
          </label>
        ))}
      </div>

      <div className="actions left">
        <button className="primary" disabled={phase === 'running' || years.length === 0} onClick={() => void runScrape()}>
          {phase === 'running' ? 'Reading Amazon…' : 'Import from Amazon'}
        </button>
        <button className="link" onClick={() => setShowPaste((s) => !s)}>
          {showPaste ? 'Hide' : 'Paste a saved page instead'}
        </button>
      </div>

      {progress && <div className="callout">{progress}</div>}

      {stale && (
        <div className="callout warn">
          <strong>Amazon&rsquo;s page layout appears to have changed.</strong>
          <p>
            The page loaded but no orders could be read from it, so nothing was imported — rather
            than quietly telling you that you had no orders. To fix it: open your Amazon orders page,
            save it (Ctrl/Cmd+S) or copy its HTML, and paste it below. That shows exactly what the
            parser sees, and the selectors in{' '}
            <code>src/adapters/amazon/selectors.ts</code> can be updated against it.
          </p>
        </div>
      )}

      {error && !stale && <div className="callout danger">{error}</div>}

      {stats && (
        <div className="callout ok">
          <div>{summarizeImport(stats)}</div>
        </div>
      )}

      {showPaste && (
        <div className="stack">
          <label className="field">
            <span>Paste the HTML of an Amazon orders page</span>
            <textarea
              rows={6}
              value={pasted}
              placeholder="&lt;!doctype html&gt;…"
              onChange={(e) => setPasted(e.target.value)}
            />
          </label>
          <div className="actions left">
            <button className="primary" disabled={!pasted.trim()} onClick={() => void runPaste()}>
              Read this page
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
