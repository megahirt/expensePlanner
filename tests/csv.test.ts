import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { detectMapping } from '@/adapters/csv/detect';
import { parseCsvText, rowsToTransactions } from '@/adapters/csv';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

describe('parseCsvText', () => {
  it('reads quoted fields and strips a UTF-8 BOM', () => {
    // Excel writes a BOM; left in place it becomes part of the first header
    // name and every mapping lookup silently misses.
    const parsed = parseCsvText('\uFEFFDate,Amount\n2025-01-01,"1,234.56"\n');
    expect(parsed.headers).toEqual(['Date', 'Amount']);
    expect(parsed.records[0]).toEqual({ Date: '2025-01-01', Amount: '1,234.56' });
  });

  it('sniffs tab-separated files', () => {
    const parsed = parseCsvText('Date\tAmount\n2025-01-01\t10.00\n');
    expect(parsed.headers).toEqual(['Date', 'Amount']);
    expect(parsed.delimiter).toBe('\t');
  });
});

describe('detectMapping', () => {
  it('recognises separate withdrawal and deposit columns', () => {
    const parsed = parseCsvText(fixture('schwab-checking.csv'));
    const { mapping, missing } = detectMapping(parsed.headers, parsed.rows);

    expect(missing).toEqual([]);
    expect(mapping?.debit).toBe('Withdrawal');
    expect(mapping?.credit).toBe('Deposit');
    expect(mapping?.date).toBe('Date');
    expect(mapping?.description).toBe('Description');
    expect(mapping?.dateFormat).toBe('MM/DD/YYYY');
  });

  it('reads a signed amount column with negatives as spending', () => {
    const parsed = parseCsvText(fixture('generic-signed.csv'));
    const { mapping } = detectMapping(parsed.headers, parsed.rows);

    expect(mapping?.amount).toBe('Amount');
    expect(mapping?.positiveMeansSpend).toBe(false);
  });

  it('infers the flipped sign convention some card exports use', () => {
    // Here spending is written positive. Guessing wrong would invert every
    // number in the file, so the wizard shows this as a confirmable toggle.
    const parsed = parseCsvText(fixture('positive-is-spend.csv'));
    const { mapping, notes } = detectMapping(parsed.headers, parsed.rows);

    expect(mapping?.positiveMeansSpend).toBe(true);
    expect(notes.join(' ')).toContain('positive');
  });

  it('reports what it could not work out instead of guessing', () => {
    const parsed = parseCsvText('Foo,Bar\n1,2\n');
    const { mapping, missing } = detectMapping(parsed.headers, parsed.rows);

    expect(mapping).toBeNull();
    expect(missing).toContain('date');
    expect(missing).toContain('description');
    expect(missing).toContain('amount');
  });
});

describe('rowsToTransactions', () => {
  it('turns debit/credit columns into signed cents', () => {
    const parsed = parseCsvText(fixture('schwab-checking.csv'));
    const { mapping } = detectMapping(parsed.headers, parsed.rows);
    const { rows, errors } = rowsToTransactions(parsed.records, mapping!);

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({
      date: '2025-03-04',
      amountCents: -4599,
      merchant: 'Trader Joes',
    });
    // A deposit is money in, so it stays positive.
    expect(rows[2]?.amountCents).toBe(245000);
  });

  it('flips the sign when the export writes spending as positive', () => {
    const parsed = parseCsvText(fixture('positive-is-spend.csv'));
    const { mapping } = detectMapping(parsed.headers, parsed.rows);
    const { rows } = rowsToTransactions(parsed.records, mapping!);

    expect(rows[0]?.amountCents).toBe(-14288);
    // …and the card payment, written negative, becomes money in.
    expect(rows[3]?.amountCents).toBe(50000);
  });

  it('collects unreadable rows instead of dropping or aborting', () => {
    // Importing 2 of 3 rows and saying so beats failing the file outright, and
    // beats pretending the file only ever had 2 rows.
    const text = 'Date,Description,Amount\n2025-01-01,A,10.00\nnot-a-date,B,5.00\n2025-01-03,C,7.00\n';
    const parsed = parseCsvText(text);
    const { mapping } = detectMapping(parsed.headers, parsed.rows);
    expect(mapping).not.toBeNull();
    const { rows, errors } = rowsToTransactions(parsed.records, mapping!);

    expect(rows).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Row 3');
  });
});
