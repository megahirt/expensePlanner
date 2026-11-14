/**
 * Import screen: drop a file, confirm the mapping, see exactly what happened.
 *
 * The import history below the drop zone is not decoration — it is what makes
 * importing safe to experiment with. Every run is listed with its counts and an
 * Undo that removes only the rows that run created.
 */

import { useCallback, useRef, useState } from 'react';
import { parseCsvText, rowsToTransactions, type ParsedCsv } from '@/adapters/csv';
import { detectMapping } from '@/adapters/csv/detect';
import { headerHash } from '@/lib/ids';
import { findSourceByHeaderHash } from '@/lib/db';
import { runImport, summarizeImport } from '@/lib/import';
import type { ColumnMapping, ImportStats, SourceRecord } from '@/types/models';
import { useStore } from '../store';
import { MappingWizard } from '../components/MappingWizard';
import { AmazonImport } from '../components/AmazonImport';

interface Pending {
  parsed: ParsedCsv;
  fileName: string;
  mapping: ColumnMapping | null;
  notes: string[];
  missing: string[];
  hash: string;
}

export function ImportRoute() {
  const { rules, categories, batches, refresh, undoBatch, saveSource, workspace } = useStore();
  const [pending, setPending] = useState<Pending | null>(null);
  const [result, setResult] = useState<{ stats: ImportStats; label: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleFile = useCallback(async (file: File) => {
    setError(null);
    setResult(null);
    try {
      const text = await file.text();
      const parsed = parseCsvText(text);
      if (parsed.headers.length === 0 || parsed.records.length === 0) {
        setError(`${file.name} does not look like a CSV with a header row and data.`);
        return;
      }

      const hash = headerHash(parsed.headers);
      const saved = await findSourceByHeaderHash(hash);

      // A file whose columns we have seen before maps itself. This is what makes
      // the second and every later import from a bank a two-click operation.
      if (saved?.mapping) {
        setPending({
          parsed,
          fileName: file.name,
          mapping: saved.mapping,
          notes: [`Using your saved mapping for "${saved.label}".`],
          missing: [],
          hash,
        });
        return;
      }

      const detection = detectMapping(parsed.headers, parsed.rows);
      setPending({
        parsed,
        fileName: file.name,
        mapping: detection.mapping,
        notes: detection.notes,
        missing: detection.missing,
        hash,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const confirmImport = useCallback(
    async (mapping: ColumnMapping, rememberAs: string) => {
      if (!pending) return;
      setError(null);
      try {
        const sourceId = `csv:${pending.hash.slice(0, 12)}`;
        const source: SourceRecord = {
          id: sourceId,
          label: rememberAs,
          kind: 'file',
          adapterId: 'csv',
          headerHash: pending.hash,
          mapping,
        };
        await saveSource(source);

        const { rows, errors } = rowsToTransactions(pending.parsed.records, mapping);
        const outcome = await runImport(
          rows,
          { sourceId, adapterId: 'csv', label: pending.fileName, rules, categories, source },
          errors,
        );

        setResult({ stats: outcome.stats, label: pending.fileName });
        setPending(null);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [pending, rules, categories, refresh, saveSource],
  );

  if (pending) {
    return (
      <MappingWizard
        parsed={pending.parsed}
        fileName={pending.fileName}
        initial={pending.mapping}
        notes={pending.notes}
        missing={pending.missing}
        onCancel={() => setPending(null)}
        onConfirm={confirmImport}
      />
    );
  }

  return (
    <div className="stack">
      <div>
        <h1>Import</h1>
        <p className="subtitle">
          Drop a CSV export from your bank or card. Importing the same range twice is safe — rows you
          already have are recognised and skipped.
        </p>
      </div>

      {workspace === 'demo' && (
        <div className="callout warn">
          You are in the demo household. Anything imported now is added to the demo, not to your own
          data. Switch to your data first if this is a real statement.
        </div>
      )}

      <div
        className={`dropzone ${dragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) void handleFile(file);
        }}
        onClick={() => fileInput.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') fileInput.current?.click();
        }}
      >
        <strong>Drop a CSV here</strong>
        <span className="dim">or click to choose a file</span>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,.tsv,.txt,text/csv"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void handleFile(file);
            e.target.value = '';
          }}
        />
      </div>

      {error && <div className="callout danger">{error}</div>}

      <AmazonImport />

      {result && (
        <div className="callout ok">
          <strong>{result.label}</strong>
          <div>{summarizeImport(result.stats)}</div>
          {result.stats.errors.length > 0 && (
            <details>
              <summary>{result.stats.errors.length} rows could not be read</summary>
              <ul>
                {result.stats.errors.slice(0, 20).map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      <section className="card">
        <h2>Import history</h2>
        {batches.length === 0 ? (
          <p className="dim">Nothing imported yet.</p>
        ) : (
          <table className="preview">
            <thead>
              <tr>
                <th>When</th>
                <th>File</th>
                <th className="right">Added</th>
                <th className="right">Already had</th>
                <th className="right">Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => (
                <tr key={b.id}>
                  <td className="num dim">{new Date(b.startedAt).toLocaleString()}</td>
                  <td>{b.label}</td>
                  <td className="right num">{b.stats.added}</td>
                  <td className="right num dim">{b.stats.duplicates}</td>
                  <td className="right num dim">{b.stats.updated}</td>
                  <td className="right">
                    <button onClick={() => void undoBatch(b.id)}>Undo</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
