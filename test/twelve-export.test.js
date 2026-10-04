const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { HEADERS, csv, readExport, timestamp, number, period, analyse, compare } = require('../lib/twelve-export');
const { chunks, TwelveBrowser } = require('../lib/twelve-browser');
const { runDownload } = require('../steps/download-twelve');
const { loadSnapshot, runComparison } = require('../tools/compare-twelve');

function tx(id, type, amount, overrides = {}) {
  return { 'Transaction Id': id, 'Main transaction id': '', 'Date created': '01-10-2026 21:00', 'Transaction type': type, Amount: amount, Paid: amount, 'No Sale': '', Discount: '', 'Deposit paid': '', 'Deposit intake': '', 'No sale type': '0', 'Revenue type': '1', 'Summation sign': '1', ...overrides };
}
function product(id, type, total, overrides = {}) {
  return { 'Transaction Id': id, 'Product Id': '20', 'Date created': '01-10-2026 21:00', 'Transaction type': type, Product: 'Drink', Count: '1', Total: total, ...overrides };
}
function rawProduct(row, noSale = false) {
  return { ...row, Date: row['Date created'], 'Payment type': row['Transaction type'], Terminal: 'Bar', 'BTW Value': '9.0000', 'No Sale': noSale ? 'True' : 'False', 'Summation sign': noSale ? '-1' : '1' };
}
function fixture() {
  const transactions = [
    tx('1', 'Revenue pin', '10.00', { Paid: '10.15', 'Deposit paid': '0.15' }),
    tx('2', 'Revenue tokens', '2.35', { Paid: '2.80', 'Deposit paid': '0.15' }),
    tx('', 'Token over/undervalue', '', { 'Main transaction id': '2', Paid: '-0.30', 'No sale type': '1' }),
    tx('3', 'Businessclub', '4.00', { Paid: '', 'No sale type': '1' }),
    tx('4', 'Bestuur', '6.00', { Paid: '', 'No sale type': '1' }),
    tx('5', 'Revenue token', '3.00', { Paid: '2.50' }),
    tx('', 'Virtual discount', '', { 'Main transaction id': '5', Discount: '0.50', 'No sale type': '1' }),
    tx('6', 'Top up pin', '50.00', { 'Revenue type': '0' })
  ];
  const products = [product('1', 'Revenue pin', '10.00'), product('2', 'Revenue tokens', '2.35'), product('3', 'Businessclub', '4.00'), product('4', 'Bestuur', '6.00'), product('5', 'Revenue token', '3.00')];
  const raw = products.map(p => rawProduct(p, ['3', '4'].includes(p['Transaction Id'])));
  return { from: '2026-10-01', to: '2026-10-02', transactions, products, raw };
}
function csvFile(rows, kind) {
  return Buffer.from('\uFEFF' + HEADERS[kind].join(';') + '\r\n' + rows.map(row => HEADERS[kind].map(h => `"${String(row[h] ?? '').replaceAll('"', '""')}"`).join(';')).join('\r\n'));
}
function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'twelve-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function reference(overrides = {}) {
  return { id: 42, period_start: '2026-10-01 06:00:00', period_end: '2026-10-02 06:00:00', omzet_incl_nosale: 25.35, producten: 5, businessclub: 4, kassaomzet: 15.30, overig_verbruik: 6.05, ...overrides };
}

test('business dates use local 06:00 including DST, leap days and year rollover', () => {
  assert.equal(timestamp('25-10-2026 02:30').day, '2026-10-24');
  assert.equal(timestamp('29-03-2026 05:59').day, '2026-03-28');
  assert.equal(timestamp('29-03-2026 06:00').day, '2026-03-29');
  assert.equal(timestamp('01-01-2026 01:00').day, '2025-12-31');
  assert.throws(() => timestamp('29-02-2025 10:00'));
  assert.throws(() => timestamp('01-10-2026 24:00'));
  assert.throws(() => period('2026-10-02', '2026-10-01'));
  assert.deepEqual(chunks('2026-01-01', '2026-02-03'), [{ from: '2026-01-01', to: '2026-02-01' }, { from: '2026-02-01', to: '2026-02-03' }]);
});

test('strict numeric and CSV parsing rejects truncation, HTML, invalid or missing fields', () => {
  assert.equal(number('2.3500'), 235);
  assert.equal(number('-0.30'), -30);
  for (const value of ['', 'NaN', '2,35', '1.0001']) assert.throws(() => number(value));
  assert.equal(number('', 100, true), 0);
  for (const content of ['', '<html>Login</html>', 'Transaction Id;Total\n1;2.50']) assert.throws(() => csv(Buffer.from(content), 'products'));
  const content = csvFile([product('1', 'Revenue pin', '2.35', { Product: 'Drink; "special"' })], 'products');
  assert.equal(csv(content, 'products')[0].Product, 'Drink; "special"');
  assert.throws(() => csv(Buffer.concat([content, Buffer.from(';extra')]), 'products'));
});

test('candidate revenue excludes top-ups, keeps coin tender and deducts card discounts once', () => {
  const analysis = analyse(fixture());
  const day = analysis.days[0];
  assert.equal(day.cashRevenueCandidateCents, 1530);
  assert.equal(day.productGrossCents, 2535);
  assert.equal(day.productCount, 5);
  assert.equal(day.businessclubCents, 400);
  assert.equal(day.noSale.Bestuur.grossCents, 600); // Raw -1 is not a refund.
  assert.equal(day.noSale.Bestuur.transactionIds.length, 1);
  assert.equal(analysis.noSaleTransactions[0].products[0].vatRate, 9);
  assert.deepEqual(day.issues, []);
  const result = compare(analysis, [reference()]);
  assert.equal(result.matched, 1);
  assert.equal(result.fullPdfParity, false); // Five fields do not prove VAT/cashflow parity.
});

test('product lines do not multiply a transaction total, no-sale counts transactions once', () => {
  const input = fixture();
  input.products.push(product('4', 'Bestuur', '2.00', { 'Product Id': '21' }));
  input.raw.push(rawProduct(input.products.at(-1), true));
  const result = analyse(input);
  assert.equal(result.days[0].noSale.Bestuur.transactionIds.length, 1);
  assert.equal(result.days[0].noSale.Bestuur.grossCents, 800);
  assert.equal(result.noSaleTransactions.find(d => d.transactionId === '4').products.length, 2);
  assert.equal(result.days[0].cashRevenueCandidateCents, 1530);
});

test('overlapping snapshots, malformed flags and out-of-range rows fail closed', () => {
  let input = fixture(); input.transactions.push(input.transactions[0]);
  assert.throws(() => analyse(input), /Duplicate/);
  input = fixture(); input.transactions[0]['Revenue type'] = '';
  assert.throws(() => analyse(input), /boolean/);
  input = fixture(); input.raw[0].Date = '02-10-2026 06:00';
  assert.throws(() => analyse(input), /outside/);
});

test('missing joins, raw lines and exceptional revenue types prevent a matched result', () => {
  const input = fixture();
  input.raw.pop();
  input.transactions.push(tx('7', 'Unrecognised revenue action', '2.00'));
  const result = analyse(input);
  assert.ok(result.days[0].issues.some(i => i.includes('absent')));
  assert.ok(result.days[0].issues.some(i => i.includes('reconciliation')));
  assert.equal(compare(result, [reference()]).checks[0].status, 'source_incomplete');
});

test('comparison reports actual differences, mismatched periods and missing days, never fills zeros', () => {
  const analysis = analyse(fixture());
  assert.equal(compare(analysis, [reference({ kassaomzet: 15.31 })]).checks[0].comparisons.find(c => c.field === 'kassaomzet').delta, -1);
  assert.equal(compare(analysis, [reference({ period_start: '2026-10-01 00:00:00' })]).checks[0].status, 'period_mismatch');
  const empty = analyse({ ...fixture(), transactions: [], products: [], raw: [] });
  assert.equal(compare(empty, [reference()]).checks[0].status, 'missing_export');
  assert.throws(() => compare(analysis, []));
  assert.throws(() => compare(analysis, [reference(), reference()]), /Duplicate/);
});

test('ZIP reader only accepts the expected file and verifies its content', t => {
  const dir = temp(t); const file = path.join(dir, 'raw.zip');
  const input = path.join(dir, 'raw.csv'); fs.writeFileSync(input, csvFile(fixture().raw, 'raw'));
  execFileSync('python3', ['-c', 'import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],"w",zipfile.ZIP_DEFLATED) as z: z.write(sys.argv[2],"export_raw_transactiondata.csv")', file, input]);
  assert.equal(readExport(file, 'raw').length, 5);
  execFileSync('python3', ['-c', 'import zipfile,sys\nwith zipfile.ZipFile(sys.argv[1],"a") as z: z.writestr("../other.csv","bad")', file]);
  assert.throws(() => readExport(file, 'raw'));
});

function fakeSession({ badCount = false, fail = false } = {}) {
  const input = fixture();
  return { closed: false, async open() {}, async close() { this.closed = true; }, async setPeriod() { return badCount ? 6 : 5; }, async download(kind, filename) { if (fail) throw new Error('network failure'); fs.writeFileSync(filename, csvFile(input[kind], kind)); } };
}

test('downloader saves private, checksum-verified snapshots and offline comparison output', async t => {
  const dir = temp(t); const session = fakeSession();
  const result = await runDownload({ from: '2026-10-01', to: '2026-10-02', output: dir, session, log() {} });
  assert.equal(session.closed, true);
  assert.equal(result.manifest.status, 'complete');
  assert.equal(fs.statSync(result.directory).mode & 0o777, 0o700);
  const file = path.join(result.directory, result.manifest.chunks[0].files.raw.path);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(loadSnapshot(result.directory).raw.length, 5);
  const reports = path.join(dir, 'reports.json'); fs.writeFileSync(reports, JSON.stringify({ reports: [reference()] }));
  const compared = await runComparison({ snapshot: result.directory, reports, output: dir });
  assert.equal(compared.success, true);
  fs.appendFileSync(file, '\n');
  assert.throws(() => loadSnapshot(result.directory), /checksum/);
});

test('a failed download or wrong screen count leaves an explicitly incomplete snapshot and closes browser', async t => {
  for (const options of [{ fail: true }, { badCount: true }]) {
    const dir = temp(t); const session = fakeSession(options);
    await assert.rejects(runDownload({ from: '2026-10-01', to: '2026-10-02', output: dir, session, log() {} }));
    assert.equal(session.closed, true);
    const snapshot = path.join(dir, fs.readdirSync(dir)[0]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(snapshot, 'manifest.json'))).status, 'incomplete');
    assert.throws(() => loadSnapshot(snapshot), /incomplete/);
  }
});

test('login failure closes Chromium and does not reveal the password or Playwright call log', async () => {
  let closed = false;
  const session = new TwelveBrowser({ username: 'test', password: 'private-test-password', clientId: '123', launch: async () => ({ newContext: async () => { throw new Error('private-test-password'); }, close: async () => { closed = true; } }) });
  await assert.rejects(session.open(), e => e.message === 'Twelve browser login failed; no files were accepted');
  assert.equal(closed, true);
});

function sample(transactions, products, raw = products.map(p => rawProduct(p))) {
  return { from: '2026-10-01', to: '2026-10-02', transactions, products, raw };
}

test('tab settlement repeats products without recording a second sale, even on a later day', () => {
  const sale = product('10', 'Revenue tab', '10.00');
  const settlement = product('11', 'Tab paid with cash', '10.00', { 'Date created': '02-10-2026 12:00' });
  const input = sample([
    tx('10', 'Revenue tab', '10.00'),
    tx('11', 'Tab paid with cash', '10.00', { 'Date created': '02-10-2026 12:00' })
  ], [sale, settlement], [rawProduct(sale)]);
  input.to = '2026-10-03';
  const result = analyse(input);
  assert.equal(result.days[0].cashRevenueCandidateCents, 1000);
  assert.equal(result.days[1].cashRevenueCandidateCents, 0);
  assert.equal(result.days[1].productGrossCents, 0);
  assert.equal(result.days[1].productCount, 0);
  assert.equal(result.days[1].settlementProductCents, 1000);
  assert.deepEqual(result.days.flatMap(d => d.issues), []);
  input.products[1].Total = '9.00';
  assert.ok(analyse(input).days[1].issues.some(i => i.includes('settlement')));
});

test('normalizes cancellation signs once while keeping ordinary no-sale consumption positive', () => {
  const type = 'Revenue cancelation (removed from tab)';
  const cancelled = product('9', type, '-7.00', { Count: '-2' });
  const raw = rawProduct(product('9', type, '7.00', { Count: '2' }));
  raw['Summation sign'] = '-1';
  const input = sample([tx('9', type, '7.00', { Paid: '-7.00', 'Summation sign': '-1' })], [cancelled], [raw]);
  const day = analyse(input).days[0];
  assert.equal(day.productGrossCents, -700);
  assert.equal(day.productCount, -2);
  assert.equal(day.cashRevenueCandidateCents, -700);
  assert.deepEqual(day.issues, []);
  input.raw[0]['Summation sign'] = '1';
  assert.ok(analyse(input).days[0].issues.length);
});

function sharedSample(category = 'Bestuur') {
  const parent = tx('10', 'Virtual mainrecord for shared payment', '10.00', { Paid: '', 'Deposit paid': '0.15' });
  const card = tx('11', 'Revenue token', '', { 'Main transaction id': '10', Paid: '5.70', 'Deposit paid': '0.10' });
  const noSale = tx('12', category, '', { 'Main transaction id': '10', Paid: '', 'No Sale': '4.15', 'No sale type': '1', 'Deposit paid': '0.05' });
  const discount = parentId => tx('', 'Virtual discount', '', { 'Main transaction id': parentId, Paid: '', Discount: '0.30', 'No sale type': '1' });
  return sample([parent, card, noSale, discount('10'), discount('11')], [product('10', parent['Transaction type'], '10.00')]);
}

test('shared payments count their paid parts, not the parent or repeated discounts', () => {
  const input = sharedSample();
  const result = analyse(input), day = result.days[0];
  assert.equal(day.cashRevenueCandidateCents, 560);
  assert.equal(day.productGrossCents, 1000);
  assert.equal(day.noSale.Bestuur.grossCents, 410);
  assert.equal(day.noSale.Bestuur.partialProductCountUnknown, true);
  assert.deepEqual(day.issues, []);
  const detail = result.noSaleTransactions[0];
  assert.equal(detail.partial, true);
  assert.equal(detail.productCount, null);
  assert.deepEqual(detail.products, []); // Do not claim the whole basket was consumed.
  assert.equal(detail.sharedProducts.length, 1);
  assert.equal(detail.parentTransactionId, '10');
  assert.equal(analyse(sharedSample('Businessclub')).days[0].businessclubCents, 410);
  assert.equal(analyse({ ...input, transactions: [...input.transactions].reverse() }).days[0].cashRevenueCandidateCents, 560);
});

test('incomplete shared payments remain issues instead of silently losing the missing amount', () => {
  const input = sharedSample();
  input.transactions = input.transactions.filter(t => t['Transaction Id'] !== '12');
  assert.ok(analyse(input).days[0].issues.some(i => i.includes('does not balance')));
  const missingProducts = sharedSample(); missingProducts.products = []; missingProducts.raw = [];
  assert.ok(analyse(missingProducts).days[0].issues.some(i => i.includes('missing products')));
});

test('deposit-inclusive terminal amounts are allocated over product value before rounding', () => {
  const input = sample([tx('1', 'Revenue pin', '1.00', { Paid: '1.00', 'Deposit paid': '0.10' })], [product('1', 'Revenue pin', '0.90')]);
  const day = analyse(input).days[0];
  assert.equal(day.productGrossCents, 90);
  assert.equal(day.cashRevenueCandidateCents, 81); // 90 * (100 - 10) / 100
  assert.deepEqual(day.issues, []);
});

test('fractional cents are rounded after summation and do not depend on input order', () => {
  const input = sample(['1', '2', '3'].map(id => tx(id, 'Revenue pin', '0.03', { Paid: '0.02' })), ['1', '2', '3'].map(id => product(id, 'Revenue pin', '0.02')));
  assert.equal(analyse(input).days[0].cashRevenueCandidateCents, 4); // 3 * 4/3, not 3 * round(4/3)
  assert.equal(analyse({ ...input, transactions: [...input.transactions].reverse() }).days[0].paymentCents['Omzet pin'], 4);
});

test('missing product lines and unsupported deposit refunds cannot become clean comparisons', () => {
  const input = fixture(); input.transactions.push(tx('missing', 'Bestuur', '2.00', { 'No sale type': '1', 'No Sale': '2.00' }));
  assert.ok(analyse(input).days[0].issues.some(i => i.includes('No-sale transaction has no product')));
  input.transactions[0]['Deposit intake'] = '0.15';
  assert.ok(analyse(input).days[0].issues.some(i => i.includes('Deposit intake')));
});

test('backdating filters survives Twelve adjusting start when an intermediate end is earlier', async () => {
  const values = {};
  for (const [side, date] of [['begin', [2026, 9, 29]], ['end', [2026, 10, 4]]]) {
    for (const [index, part] of ['y', 'm', 'd'].entries()) values[`#report_date_${side}_${part}`] = String(date[index]);
    for (const [part, value] of [['h', '6'], ['n', '0'], ['s', '0']]) values[`select[name="report_time_${side}_${part}"]`] = value;
  }
  const date = side => ['y', 'm', 'd'].map(part => values[`#report_date_${side}_${part}`].padStart(part === 'y' ? 4 : 2, '0')).join('-');
  const session = new TwelveBrowser({ username: 'test', password: 'test', clientId: '123' });
  session.reportPage = async () => {};
  session.page = {
    locator(selector) { return {
      async selectOption(value) {
        values[selector] = value;
        if (date('end') < date('begin')) for (const part of ['y', 'm', 'd']) values[`#report_date_begin_${part}`] = values[`#report_date_end_${part}`];
      },
      async inputValue() { return values[selector]; },
      async innerText() { return 'There are 12 records'; }
    }; },
    async waitForEvent() {},
    getByRole() { return { last() { return { async click() {} }; } }; }
  };
  assert.equal(await session.setPeriod('2026-08-22', '2026-08-23'), 12);
  assert.equal(date('begin'), '2026-08-22');
  assert.equal(date('end'), '2026-08-23');
});
