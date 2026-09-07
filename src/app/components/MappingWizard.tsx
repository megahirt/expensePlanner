/**
 * Column-mapping wizard.
 *
 * Shows what we detected and lets the user correct it against a live preview of
 * their own rows. Detection is a proposal, never a silent decision — reading a
 * sign convention backwards would invert every number in the file, and the only
 * reliable check is a human glancing at three real rows and seeing that the
 * grocery run is money out.
 */

import { useMemo, useState } from 'react';
import { SUPPORTED_FORMATS } from '@/lib/dates';
import { formatCents } from '@/lib/money';
import { rowsToTransactions, type ParsedCsv } from '@/adapters/csv';
import type { ColumnMapping } from '@/types/models';

interface Props {
  parsed: ParsedCsv;
  fileName: string;
  initial: ColumnMapping | null;
  notes: string[];
  missing: string[];
  onCancel: () => void;
  onConfirm: (mapping: ColumnMapping, rememberAs: string) => void;
}

const BLANK: ColumnMapping = {
  date: '',
  description: '',
  dateFormat: 'MM/DD/YYYY',
  positiveMeansSpend: false,
  currency: 'USD',
};

export function MappingWizard({ parsed, fileName, initial, notes, missing, onCancel, onConfirm }: Props) {
  const [mapping, setMapping] = useState<ColumnMapping>(initial ?? BLANK);
  const [accountName, setAccountName] = useState(initial?.defaultAccountLabel ?? '');
  const [useDebitCredit, setUseDebitCredit] = useState(Boolean(initial?.debit || initial?.credit));

  const set = <K extends keyof ColumnMapping>(key: K, value: ColumnMapping[K]) =>
    setMapping((m) => ({ ...m, [key]: value }));

  const effective = useMemo<ColumnMapping>(() => {
    const next: ColumnMapping = { ...mapping, defaultAccountLabel: accountName || 'Imported' };
    if (useDebitCredit) delete next.amount;
    else {
      delete next.debit;
      delete next.credit;
    }
    return next;
  }, [mapping, accountName, useDebitCredit]);

  // Preview the first few rows through the real parser, so what the user
  // approves is literally what will be imported.
  const preview = useMemo(() => {
    const sample = parsed.records.slice(0, 6);
    try {
      return rowsToTransactions(sample, effective);
    } catch {
      return { rows: [], errors: ['Mapping is incomplete'] };
    }
  }, [parsed.records, effective]);

  const ready =
    Boolean(effective.date) &&
    Boolean(effective.description) &&
    (useDebitCredit ? Boolean(effective.debit || effective.credit) : Boolean(effective.amount)) &&
    preview.rows.length > 0;

  return (
    <div className="wizard">
      <div className="wizard-head">
        <h2>Map the columns in {fileName}</h2>
        <p className="subtitle">
          {parsed.records.length.toLocaleString()} rows found. Check the preview below, then import.
          This mapping is remembered for future files with the same columns.
        </p>
      </div>

      {notes.length > 0 && (
        <ul className="notes">
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {missing.length > 0 && (
        <div className="callout warn">
          Could not work out: {missing.join(', ')}. Please choose the right columns below.
        </div>
      )}

      <div className="field-grid">
        <ColumnSelect
          label="Date"
          value={effective.date}
          headers={parsed.headers}
          onChange={(v) => set('date', v)}
        />
        <label className="field">
          <span>Date format</span>
          <select value={effective.dateFormat} onChange={(e) => set('dateFormat', e.target.value)}>
            {SUPPORTED_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <ColumnSelect
          label="Description"
          value={effective.description}
          headers={parsed.headers}
          onChange={(v) => set('description', v)}
        />
        <label className="field">
          <span>Account name</span>
          <input
            value={accountName}
            placeholder="e.g. Schwab Checking …1234"
            onChange={(e) => setAccountName(e.target.value)}
          />
        </label>
      </div>

      <fieldset className="amount-shape">
        <legend>How are amounts stored?</legend>
        <label className="radio">
          <input
            type="radio"
            checked={!useDebitCredit}
            onChange={() => setUseDebitCredit(false)}
          />
          One amount column
        </label>
        <label className="radio">
          <input type="radio" checked={useDebitCredit} onChange={() => setUseDebitCredit(true)} />
          Separate debit and credit columns
        </label>

        {useDebitCredit ? (
          <div className="field-grid">
            <ColumnSelect
              label="Debit (money out)"
              value={effective.debit ?? ''}
              headers={parsed.headers}
              onChange={(v) => set('debit', v)}
              allowNone
            />
            <ColumnSelect
              label="Credit (money in)"
              value={effective.credit ?? ''}
              headers={parsed.headers}
              onChange={(v) => set('credit', v)}
              allowNone
            />
          </div>
        ) : (
          <div className="field-grid">
            <ColumnSelect
              label="Amount"
              value={effective.amount ?? ''}
              headers={parsed.headers}
              onChange={(v) => set('amount', v)}
            />
            <label className="field">
              <span>Sign convention</span>
              <select
                value={effective.positiveMeansSpend ? 'positive' : 'negative'}
                onChange={(e) => set('positiveMeansSpend', e.target.value === 'positive')}
              >
                <option value="negative">Negative numbers are money out</option>
                <option value="positive">Positive numbers are money out</option>
              </select>
            </label>
          </div>
        )}
      </fieldset>

      <h2>Preview</h2>
      <div className="table-scroll">
        <table className="preview">
          <thead>
            <tr>
              <th>Date</th>
              <th>Merchant</th>
              <th>Description</th>
              <th className="right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((r, i) => (
              <tr key={i}>
                <td className="num">{r.date}</td>
                <td>{r.merchant}</td>
                <td className="dim">{r.description}</td>
                <td className={`right num ${r.amountCents < 0 ? 'out' : 'in'}`}>
                  {formatCents(r.amountCents, r.currency ?? 'USD')}
                </td>
              </tr>
            ))}
            {preview.rows.length === 0 && (
              <tr>
                <td colSpan={4} className="dim">
                  Nothing readable yet — choose the columns above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {preview.errors.length > 0 && (
        <div className="callout warn">
          {preview.errors.length} of the first {Math.min(6, parsed.records.length)} rows could not be
          read: {preview.errors[0]}
        </div>
      )}

      <div className="actions">
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          disabled={!ready}
          onClick={() => onConfirm(effective, accountName || fileName)}
        >
          Import {parsed.records.length.toLocaleString()} rows
        </button>
      </div>
    </div>
  );
}

function ColumnSelect({
  label,
  value,
  headers,
  onChange,
  allowNone,
}: {
  label: string;
  value: string;
  headers: string[];
  onChange: (v: string) => void;
  allowNone?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allowNone ? '(none)' : 'Choose a column…'}</option>
        {headers.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
    </label>
  );
}
