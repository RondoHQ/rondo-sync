const { test } = require('node:test');
const assert = require('node:assert/strict');
const { financialRows, reportForDay, currentRange } = require('../lib/twelve-report');
const head = ['Transaction type', 'Amount', 'Net amount', 'Hoog', 'Laag', 'Number of transactions', ''];
const financial = () => ({
  revenue: [[['BTW Type', ...head.slice(1)], ['Laag (Excl. No Sale)', '10.90', '10.00', '0.00', '0.90', '', ''], ['Turnover (excl. no-sale)', '10.90', '10.00', '0.00', '0.90', '2', '']], [[...head], ['Revenue pin', '10.90', '10.00', '0.00', '0.90', '2', ''], ['Subtotal', '10.90', '10.00', '0.00', '0.90', '', '']]],
  nosale: [[[...head], ['Businessclub', '1.09', '1.00', '0.00', '0.09', '1', ''], ['Subtotal', '1.09', '1.00', '0.00', '0.09', '', '']]]
});
const input = () => ({ day: { day: '2026-09-29', issues: [], cashRevenueCandidateCents: 1090, productGrossCents: 1199, productCount: 3, productRevenue: [{product:'Coffee',cashCents:1090,businessclubCents:109}], noSale: { Businessclub: { grossCents: 109, transactionIds: ['x'] } } },
  raw: [{ Date: '29-09-2026 12:00', 'Payment type': 'Revenue pin', 'BTW Value': '9.0000', Product: 'Coffee', Total: '10.90', Count: '2' }, { Date: '29-09-2026 13:00', 'Payment type': 'Businessclub', 'BTW Value': '9.0000', Product: 'Coffee ', Total: '1.09', Count: '1' }], noSaleTransactions: [{ transactionId: 'x', day: '2026-09-29', category: 'Businessclub', grossCents: 109 }], financial: financial(), observedAt: '2026-10-01T07:00:00.000Z', clientId: '123', audit: {} });
test('preserves source VAT and requires daily revenue and no-sale amounts/counts to reconcile', () => {
  const p = input(), r = reportForDay(p);
  assert.equal(r.omzet.find(r => r.section === 'categorie').netto, 1);
  assert.equal(r.producten[0].bruto, 11.99);
  assert.equal(r.producten[0].netto, 11);
  assert.equal(r.source.complete, true);
  p.day.cashRevenueCandidateCents++; assert.throws(() => reportForDay(p), /disagrees/);
  const q = input(); q.day.noSale.Businessclub.transactionIds.push('y'); assert.throws(() => reportForDay(q), /disagrees/);
});
test('handles optional zero-VAT column and excludes card-network subtotals without double counting', () => {
  const data = financial();
  for (const table of data.revenue) for (const [i, row] of table.entries()) row.splice(5, 0, i === 0 ? 'Geen BTW' : '0.00');
  data.revenue[1].splice(2, 0, ['Visa', '10.90', '', '', '', '', '2', '']);
  data.revenue[1].splice(2, 0, ['REPRINT', '0.00', '', '', '', '', '1', '']);
  data.revenue[1].splice(2, 0, ['??', '0.00', '', '', '', '', '', '']);
  const rows = financialRows(data.revenue, 'revenue');
  assert.equal(rows.filter(r => r.section === 'betaalmethode').length, 1);
  assert.equal(rows.find(r => r.section === 'totaal').transacties, 2);
  data.revenue[1][1][5] = '0.10'; assert.throws(() => financialRows(data.revenue, 'revenue'), /zero-VAT/);
});
test('rejects missing tables, malformed amounts, unexpected categories and source issues', () => {
  assert.throws(() => financialRows([], 'revenue'));
  const p = input(); p.financial.nosale[0][1][2] = ''; assert.throws(() => reportForDay(p));
  const q = input(); q.day.issues.push('Missing row'); assert.throws(() => reportForDay(q), /Source issues/);
  const r = input(); r.financial.nosale[0][1][0] = 'Unknown'; assert.throws(() => reportForDay(r));
});
test('manual payment details with blank VAT do not duplicate revenue or change source totals', () => {
  for (const zeroVatColumn of [false, true]) {
    const p = input();
    if (zeroVatColumn) {
      for (const table of p.financial.revenue) for (const [i, row] of table.entries()) row.splice(5, 0, i === 0 ? 'Geen BTW' : '0.00');
    }
    const expected = reportForDay(p).omzet;
    const detail = ['MANUAL', '10.90', '', '', '', '2', ''];
    if (zeroVatColumn) detail.splice(5, 0, '');
    p.financial.revenue[1].splice(2, 0, detail);
    assert.deepEqual(reportForDay(p).omzet, expected);
    p.day.cashRevenueCandidateCents++;
    assert.throws(() => reportForDay(p), /Revenue overview disagrees/);
  }
});
test('manual rows retain strict validation outside fully blank payment VAT details', () => {
  const complete = financial();
  complete.revenue[1][1][0] = 'MANUAL';
  assert.equal(financialRows(complete.revenue, 'revenue').find(r => r.label === 'MANUAL').bedrag, 10.9);
  for (const [kind, index, label] of [['revenue', 0, 'MANUAL'], ['nosale', 0, 'MANUAL'], ['revenue', 1, 'Revenue pin'], ['revenue', 1, 'Unknown']]) {
    const data = financial();
    data[kind][index].push([label, '10.90', '', '', '', '2', '']);
    assert.throws(() => financialRows(data[kind], kind), /Invalid Twelve numeric field/);
  }
  const partial = financial();
  partial.revenue[1].push(['MANUAL', '10.90', '10.00', '', '', '2', '']);
  assert.throws(() => financialRows(partial.revenue, 'revenue'), /Invalid Twelve numeric field/);
});
test('current day is provisional and Amsterdam cutoff follows DST and 06:00 boundary', () => {
  assert.deepEqual(currentRange(new Date('2026-10-25T04:15:00Z')), { from: '2026-10-17', to: '2026-10-25', cutoff: '2026-10-25 05:15' });
  const p = input(); p.cutoff = '2026-09-29 14:15'; const r = reportForDay(p); assert.equal(r.source.complete, false); assert.equal(r.source.coverage_end, p.cutoff);
});

test('rejects missing or mismatched product revenue allocations', () => {
 const p = input(); delete p.day.productRevenue; assert.throws(() => reportForDay(p), /Product revenue/);
 const q = input(); q.day.productRevenue[0].cashCents++; assert.throws(() => reportForDay(q), /Product revenue/);
});
