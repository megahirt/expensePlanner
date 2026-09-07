import { describe, expect, it } from 'vitest';
import { assignOccurrences, hash128, headerHash, normalizeMerchant, transactionId } from '@/lib/ids';

describe('hash128', () => {
  it('is deterministic and well distributed', () => {
    expect(hash128('abc')).toBe(hash128('abc'));
    expect(hash128('abc')).toHaveLength(32);
    expect(hash128('abc')).not.toBe(hash128('abd'));
  });
});

describe('transactionId', () => {
  const base = {
    sourceId: 'csv:schwab',
    date: '2025-03-04',
    amountCents: -4599,
    description: 'TRADER JOES #123 SEATTLE WA',
  };

  it('is stable across imports of the same row', () => {
    expect(transactionId(base)).toBe(transactionId({ ...base }));
  });

  it('changes when any identifying field changes', () => {
    expect(transactionId({ ...base, amountCents: -4600 })).not.toBe(transactionId(base));
    expect(transactionId({ ...base, date: '2025-03-05' })).not.toBe(transactionId(base));
    expect(transactionId({ ...base, sourceId: 'csv:chase' })).not.toBe(transactionId(base));
  });

  it('prefers a stable external id when the source has one', () => {
    const withExt = { ...base, externalId: 'FITID-999' };
    // Same external id, reworded description => still the same transaction,
    // which is what survives a bank restating its descriptions between exports.
    expect(transactionId(withExt)).toBe(
      transactionId({ ...withExt, description: 'TRADER JOES 123 SEATTLE' }),
    );
  });

  it('ignores description punctuation and case', () => {
    expect(transactionId({ ...base, description: 'trader joes  #123, seattle wa' })).toBe(
      transactionId(base),
    );
  });

  it('cannot be fooled by field-boundary ambiguity', () => {
    const a = transactionId({ ...base, sourceId: 'ab', description: 'c' });
    const b = transactionId({ ...base, sourceId: 'a', description: 'bc' });
    expect(a).not.toBe(b);
  });
});

describe('assignOccurrences', () => {
  it('keeps genuinely repeated identical charges distinct', () => {
    // Two $5 coffees, same shop, same day. Both are real; collapsing them would
    // quietly lose an expense.
    const rows = ['coffee', 'coffee', 'lunch', 'coffee'];
    expect(assignOccurrences(rows, (r) => r)).toEqual([0, 1, 0, 2]);
  });

  it('numbers repeats identically on re-import, so ids still match', () => {
    const rows = ['coffee', 'coffee', 'lunch'];
    expect(assignOccurrences(rows, (r) => r)).toEqual(assignOccurrences([...rows], (r) => r));
  });
});

describe('normalizeMerchant', () => {
  it('strips the noise that varies between identical purchases', () => {
    expect(normalizeMerchant('TRADER JOES #123 SEATTLE WA')).toBe('Trader Joes');
    expect(normalizeMerchant('SQ *BLUE BOTTLE COFFEE')).toBe('Blue Bottle Coffee');
    expect(normalizeMerchant('TST* THE DINER 206-555-1234 WA')).toBe('The Diner');
    expect(normalizeMerchant('SAFEWAY STORE 01234 03/04')).toBe('Safeway');
  });

  it('groups one merchant across locations by dropping known city names', () => {
    // Without this, every branch becomes its own merchant and a rule written
    // for one shop silently misses the same shop in the next town.
    expect(normalizeMerchant('STARBUCKS STORE 08812 SEATTLE WA')).toBe('Starbucks');
    expect(normalizeMerchant('STARBUCKS STORE 00221 BELLEVUE WA')).toBe('Starbucks');
    expect(normalizeMerchant('CHIPOTLE 1420 SAN FRANCISCO CA')).toBe('Chipotle');
  });

  it('keeps trailing words that are not places', () => {
    // Position alone cannot tell a city from part of a name; recognising the
    // word is what keeps these intact.
    expect(normalizeMerchant('THE DINER WA')).toBe('The Diner');
    expect(normalizeMerchant('BLUE BOTTLE COFFEE CA')).toBe('Blue Bottle Coffee');
  });

  it('never strips a merchant down to nothing', () => {
    // A shop genuinely called "Chicago" keeps its name.
    expect(normalizeMerchant('CHICAGO IL')).toBe('Chicago');
  });

  it('collapses Amazon aliases onto one merchant', () => {
    expect(normalizeMerchant('AMZN Mktp US*RT4G82OI3')).toBe('Amazon');
    expect(normalizeMerchant('AMAZON.COM*2H4JK9DL1')).toBe('Amazon');
    expect(normalizeMerchant('Amazon Prime Video')).toBe('Amazon Prime Video');
    expect(normalizeMerchant('AMAZON WEB SERVICES AWS')).toBe('Amazon Web Services');
  });

  it('never returns an empty merchant', () => {
    expect(normalizeMerchant('###')).toBe('###');
    expect(normalizeMerchant('')).toBe('Unknown');
  });
});

describe('headerHash', () => {
  it('ignores case and padding so the same export always matches its profile', () => {
    expect(headerHash(['Date', 'Description', 'Amount'])).toBe(
      headerHash([' date ', 'DESCRIPTION', 'amount']),
    );
    expect(headerHash(['Date', 'Amount'])).not.toBe(headerHash(['Date', 'Description', 'Amount']));
  });
});
