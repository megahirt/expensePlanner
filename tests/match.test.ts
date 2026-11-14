import { describe, expect, it } from 'vitest';
import { applyLink, candidateToLink, proposeLinks, unapplyLink, unsettledReturns } from '@/dedupe/match';
import { totals } from '@/lib/filter';
import type { Transaction, TransactionLink } from '@/types/models';

function txn(over: Partial<Transaction> = {}): Transaction {
  return {
    id: Math.random().toString(36).slice(2),
    sourceId: 'csv:visa',
    accountLabel: 'Visa …4242',
    date: '2025-03-04',
    description: 'AMZN Mktp US*RT4G82OI3',
    merchant: 'Amazon',
    amountCents: -7842,
    currency: 'USD',
    categoryId: 'cat-shopping',
    categorySource: 'rule',
    status: 'delivered',
    refundedCents: 0,
    batchId: 'b',
    importedAt: 1,
    ...over,
  };
}

const order = (over: Partial<Transaction> = {}) =>
  txn({ sourceId: 'amazon', accountLabel: 'Amazon', description: 'Echo Dot', ...over });

describe('proposeLinks: the same purchase seen twice', () => {
  it('pairs an Amazon order with the card charge that paid for it', () => {
    const charge = txn({ id: 'charge', date: '2025-03-05', amountCents: -7842 });
    const amazonOrder = order({ id: 'order', date: '2025-03-04', amountCents: -7842 });

    const [candidate] = proposeLinks([charge, amazonOrder]);

    expect(candidate?.canonical.id).toBe('charge');
    expect(candidate?.linked.id).toBe('order');
    expect(candidate?.kind).toBe('same_purchase');
    expect(candidate?.confidence).toBeGreaterThan(0.8);
  });

  it('makes the card charge canonical, since it is what moved the money', () => {
    const charge = txn({ id: 'charge', amountCents: -7842 });
    const amazonOrder = order({ id: 'order', amountCents: -7842 });

    const { linked } = applyLink(proposeLinks([charge, amazonOrder])[0]!);
    expect(linked.supersededBy).toBe('charge');
  });

  it('counts a linked purchase once instead of twice', () => {
    // The whole point: importing both sources must not double the spend.
    const charge = txn({ id: 'charge', amountCents: -7842 });
    const amazonOrder = order({ id: 'order', amountCents: -7842 });
    expect(totals([charge, amazonOrder]).spentCents).toBe(15684);

    const { canonical, linked } = applyLink(proposeLinks([charge, amazonOrder])[0]!);
    expect(totals([canonical, linked]).spentCents).toBe(7842);
  });

  it('will not pair amounts that merely look close', () => {
    // Amazon charges the exact order total, so an approximate match would be
    // guessing with someone's money.
    const charge = txn({ amountCents: -7800 });
    const amazonOrder = order({ amountCents: -7842 });
    expect(proposeLinks([charge, amazonOrder])).toHaveLength(0);
  });

  it('will not pair across a long gap', () => {
    const charge = txn({ date: '2025-04-20', amountCents: -7842 });
    const amazonOrder = order({ date: '2025-03-04', amountCents: -7842 });
    expect(proposeLinks([charge, amazonOrder])).toHaveLength(0);
  });

  it('flags an ambiguous match as low confidence rather than picking silently', () => {
    const a = txn({ id: 'a', date: '2025-03-05', amountCents: -5000 });
    const b = txn({ id: 'b', date: '2025-03-06', amountCents: -5000 });
    const amazonOrder = order({ id: 'o', date: '2025-03-04', amountCents: -5000 });

    const [candidate] = proposeLinks([a, b, amazonOrder]);
    expect(candidate?.confidence).toBeLessThan(0.7);
    expect(candidate?.reason).toContain('2 card charges match');
  });

  it('never proposes a charge for a cancelled order', () => {
    // A cancelled order was never charged, so any same-amount charge nearby is
    // a different purchase entirely.
    const charge = txn({ amountCents: -12999 });
    const cancelled = order({ amountCents: -12999, status: 'cancelled' });
    expect(proposeLinks([charge, cancelled])).toHaveLength(0);
  });

  it('does not re-propose something already linked', () => {
    const charge = txn({ id: 'charge', amountCents: -7842 });
    const amazonOrder = order({ id: 'order', amountCents: -7842 });
    const existing: TransactionLink = {
      id: 'l1',
      canonicalId: 'charge',
      linkedId: 'order',
      kind: 'same_purchase',
      confidence: 0.9,
      status: 'confirmed',
      createdAt: 1,
    };
    expect(proposeLinks([charge, amazonOrder], [existing])).toHaveLength(0);
  });

  it('proposes again if the user rejected the link', () => {
    const charge = txn({ id: 'charge', amountCents: -7842 });
    const amazonOrder = order({ id: 'order', amountCents: -7842 });
    const rejected: TransactionLink = {
      id: 'l1',
      canonicalId: 'charge',
      linkedId: 'order',
      kind: 'same_purchase',
      confidence: 0.9,
      status: 'rejected',
      createdAt: 1,
    };
    expect(proposeLinks([charge, amazonOrder], [rejected])).toHaveLength(1);
  });
});

describe('proposeLinks: settling a refund', () => {
  it('matches a card credit to a return Amazon gave no amount for', () => {
    // Amazon often says "returned" without saying how much came back. The card
    // credit is the ground truth.
    const returned = order({ id: 'order', date: '2025-03-01', amountCents: -4550, status: 'returned' });
    const credit = txn({ id: 'credit', date: '2025-03-12', amountCents: 4550 });

    const candidate = proposeLinks([returned, credit]).find((c) => c.kind === 'refund_settlement');
    expect(candidate?.canonical.id).toBe('credit');
    expect(candidate?.linked.id).toBe('order');
  });

  it('writes the real refunded amount onto the order', () => {
    const returned = order({ id: 'order', date: '2025-03-01', amountCents: -8900, status: 'returned' });
    // $82 back on an $89 order: a restocking fee was kept.
    const credit = txn({ id: 'credit', date: '2025-03-12', amountCents: 8200 });

    const candidate = proposeLinks([returned, credit]).find((c) => c.kind === 'refund_settlement')!;
    const { linked, canonical } = applyLink(candidate);

    expect(linked.refundedCents).toBe(8200);
    // The credit itself must not also count as income, or the refund would be
    // subtracted twice.
    expect(canonical.supersededBy).toBe('order');
    expect(totals([canonical, linked]).spentCents).toBe(700);
    expect(totals([canonical, linked]).receivedCents).toBe(0);
  });

  it('ignores a credit that predates the return', () => {
    const returned = order({ date: '2025-03-10', amountCents: -4550, status: 'returned' });
    const credit = txn({ date: '2025-03-01', amountCents: 4550 });
    expect(proposeLinks([returned, credit]).filter((c) => c.kind === 'refund_settlement')).toHaveLength(0);
  });

  it('ignores a credit larger than the order, which cannot be its refund', () => {
    const returned = order({ date: '2025-03-01', amountCents: -4550, status: 'returned' });
    const credit = txn({ date: '2025-03-05', amountCents: 9999 });
    expect(proposeLinks([returned, credit]).filter((c) => c.kind === 'refund_settlement')).toHaveLength(0);
  });

  it('leaves an order alone once Amazon stated the refund itself', () => {
    const settled = order({ date: '2025-03-01', amountCents: -8900, status: 'returned', refundedCents: 8200 });
    const credit = txn({ date: '2025-03-10', amountCents: 8200 });
    expect(proposeLinks([settled, credit]).filter((c) => c.kind === 'refund_settlement')).toHaveLength(0);
  });
});

describe('unsettledReturns', () => {
  it('flags a return whose refund never arrived — money worth chasing', () => {
    const stuck = order({ id: 'stuck', date: '2025-03-01', status: 'returned' });
    expect(unsettledReturns([stuck], [], '2025-04-15').map((t) => t.id)).toEqual(['stuck']);
  });

  it('gives a recent return time to settle before nagging', () => {
    const recent = order({ date: '2025-04-10', status: 'returned' });
    expect(unsettledReturns([recent], [], '2025-04-15')).toHaveLength(0);
  });

  it('says nothing about returns that were settled', () => {
    const paid = order({ id: 'paid', date: '2025-03-01', status: 'returned', refundedCents: 4550 });
    expect(unsettledReturns([paid], [], '2025-04-15')).toHaveLength(0);
  });
});

describe('unapplyLink', () => {
  it('restores both rows so a wrong link is fully reversible', () => {
    const charge = txn({ id: 'charge', amountCents: -7842 });
    const amazonOrder = order({ id: 'order', amountCents: -7842 });
    const candidate = proposeLinks([charge, amazonOrder])[0]!;
    const link = candidateToLink(candidate, 'confirmed');
    const { canonical, linked } = applyLink(candidate);

    const restored = unapplyLink(link, [canonical, linked]);
    expect(restored[0]?.supersededBy).toBeUndefined();
    expect(totals([canonical, ...restored]).spentCents).toBe(15684);
  });

  it('clears a settled refund amount when the refund link is undone', () => {
    const returned = order({ id: 'order', date: '2025-03-01', amountCents: -8900, status: 'returned' });
    const credit = txn({ id: 'credit', date: '2025-03-12', amountCents: 8200 });
    const candidate = proposeLinks([returned, credit]).find((c) => c.kind === 'refund_settlement')!;
    const link = candidateToLink(candidate, 'confirmed');
    const { canonical, linked } = applyLink(candidate);

    const restored = unapplyLink(link, [canonical, linked]);
    const order2 = restored.find((t) => t.id === 'order');
    expect(order2?.refundedCents).toBe(0);
  });
});

describe('a matched card charge takes the order\'s category', () => {
  const pair = (orderOver: Partial<Transaction> = {}, chargeOver: Partial<Transaction> = {}) => {
    const charge = txn({ id: 'charge', date: '2025-03-05', ...chargeOver });
    const amazonOrder = order({
      id: 'order',
      description: 'Dog Food Salmon Recipe 30 lb',
      categoryId: 'cat-household',
      categorySource: 'items',
      ...orderOver,
    });
    return proposeLinks([charge, amazonOrder])[0]!;
  };

  it('moves the money to what was actually bought', () => {
    // The charge is the half that counts toward totals, and all it says is
    // "AMZN Mktp". Without this, every Amazon purchase would stay in Shopping
    // however well the order itself was understood.
    const { canonical } = applyLink(pair());

    expect(canonical.categoryId).toBe('cat-household');
    expect(canonical.categorySource).toBe('linked');
    expect(canonical.categoryReason).toBe('It paid for an Amazon order: Dog Food Salmon Recipe 30 lb');
  });

  it('respects a category the user set on the order by hand', () => {
    const { canonical } = applyLink(pair({ categoryId: 'cat-gifts', categorySource: 'manual' }));
    expect(canonical.categoryId).toBe('cat-gifts');
  });

  it('never overrides a category the user set on the charge', () => {
    const { canonical } = applyLink(pair({}, { categoryId: 'cat-kids', categorySource: 'manual' }));
    expect(canonical.categoryId).toBe('cat-kids');
    expect(canonical.categorySource).toBe('manual');
  });

  it('leaves the charge alone when the order was only filed by the generic Amazon rule', () => {
    const { canonical } = applyLink(pair({ categoryId: 'cat-shopping', categorySource: 'rule' }));
    expect(canonical.categorySource).toBe('rule');
  });

  it('gives the category back when the match is undone', () => {
    const candidate = pair();
    const { canonical, linked } = applyLink(candidate);
    const restored = unapplyLink(candidateToLink(candidate, 'confirmed'), [canonical, linked]);

    const charge = restored.find((t) => t.id === 'charge');
    expect(charge?.categorySource).toBe('default');
    expect(charge?.categoryId).toBeNull();
    expect(charge?.categoryReason).toBeUndefined();
  });
});
