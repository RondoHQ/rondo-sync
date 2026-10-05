/** Read-only Twelve analysis. Source money is cents; allocations use exact fractions. */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { parse } = require('csv-parse/sync');

const MAX_BYTES = 128 * 1024 * 1024;
const HEADERS = {
  transactions: ['Transaction Id', 'Main transaction id', 'Date created', 'Transaction type', 'Amount', 'Paid', 'No Sale', 'Discount', 'Deposit paid', 'Deposit intake', 'No sale type', 'Revenue type', 'Summation sign'],
  products: ['Transaction Id', 'Product Id', 'Date created', 'Transaction type', 'Product', 'Count', 'Total'],
  raw: ['Transaction Id', 'Date', 'Payment type', 'Terminal', 'Product Id', 'Product', 'Count', 'Total', 'BTW Value', 'No Sale', 'Summation sign']
};

function dateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
    throw new Error('Expected a valid YYYY-MM-DD date');
  }
  return value;
}

function nextDate(value, days = 1) {
  const date = new Date(`${dateOnly(value)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function period(from, to) {
  dateOnly(from); dateOnly(to);
  if (from >= to) throw new Error('The exclusive end date must follow the start date');
  return { from, to, start: `${from} 06:00`, end: `${to} 06:00`, timezone: 'Europe/Amsterdam' };
}

// Twelve exports wall-clock dates in the club timezone. Subtract a calendar day
// before 06:00, not 24 elapsed hours: that also handles DST transition nights.
function timestamp(value) {
  const match = /^(\d{2})-(\d{2})-(\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value || '');
  if (!match || +match[4] > 23 || +match[5] > 59 || +(match[6] || 0) > 59) throw new Error('Invalid Twelve timestamp');
  const date = dateOnly(`${match[3]}-${match[2]}-${match[1]}`);
  return { local: `${date} ${match[4]}:${match[5]}`, day: +match[4] < 6 ? nextDate(date, -1) : date };
}

function number(value, scale = 100, blank = false) {
  if (value === '' && blank) return 0;
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(String(value))) throw new Error('Invalid Twelve numeric field');
  const scaled = Number(value) * scale;
  const result = Math.round(Math.abs(scaled)) * (scaled < 0 ? -1 : 1);
  if (!Number.isSafeInteger(result)) throw new Error('Twelve numeric field exceeds safe range');
  // Monetary exports sometimes use four decimal places, but must represent cents.
  if (Math.abs(scaled - result) > 0.000001) throw new Error('Unexpected fractional monetary amount or quantity');
  return result;
}

function csv(buffer, kind) {
  if (!HEADERS[kind]) throw new Error('Unknown Twelve export kind');
  if (buffer.length > MAX_BYTES) throw new Error('Twelve export is too large; use smaller date ranges');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  let headerSeen = false;
  const rows = parse(text, {
    bom: true, delimiter: ';', skip_empty_lines: true,
    columns(headers) {
      headerSeen = true;
      if (new Set(headers).size !== headers.length || HEADERS[kind].some(h => !headers.includes(h))) {
        throw new Error(`Unexpected Twelve ${kind} columns; export all columns in English`);
      }
      return headers;
    }
  });
  if (!headerSeen) throw new Error('Twelve CSV has no header');
  return rows;
}

function readExport(filename, kind) {
  if (fs.statSync(filename).size > MAX_BYTES) throw new Error('Twelve export is too large');
  let buffer = fs.readFileSync(filename);
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) {
    if (kind !== 'raw') throw new Error('Only the combined raw export may be a ZIP');
    // Use Python's standard ZIP reader: CRC checks, a fixed entry, a size bound,
    // and no extraction to disk (no archive paths can overwrite local files).
    buffer = execFileSync('python3', ['-c',
      'import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n n="export_raw_transactiondata.csv"\n assert z.namelist()==[n], "Unexpected ZIP contents"\n assert z.getinfo(n).file_size<=int(sys.argv[2]), "ZIP too large"\n sys.stdout.buffer.write(z.read(n))',
      filename, String(MAX_BYTES)], { maxBuffer: MAX_BYTES, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return csv(buffer, kind);
}

function flag(value) {
  if (!['0', '1', 'True', 'False'].includes(value)) throw new Error('Invalid Twelve boolean field');
  return value === '1' || value === 'True';
}

function sign(value) {
  if (!['1', '-1'].includes(value)) throw new Error('Invalid Twelve summation sign');
  return Number(value);
}

// Accumulate rational cents so allocation fractions are rounded only at the
// report boundary. Reducing each sum avoids floating-point and row-order drift.
class MoneyTotal {
  constructor() { this.n = 0n; this.d = 1n; }
  add(n, d = 1n) {
    n = BigInt(n); d = BigInt(d);
    if (d === 0n) throw new Error('Zero monetary allocation denominator');
    if (d < 0n) { n = -n; d = -d; }
    let numerator = this.n * d + n * this.d;
    let denominator = this.d * d;
    let a = numerator < 0n ? -numerator : numerator, b = denominator;
    while (b) { const rest = a % b; a = b; b = rest; }
    this.n = numerator / a; this.d = denominator / a;
  }
  cents() {
    const abs = this.n < 0n ? -this.n : this.n;
    const rounded = (abs * 2n + this.d) / (2n * this.d);
    const value = Number(this.n < 0n ? -rounded : rounded);
    if (!Number.isSafeInteger(value)) throw new Error('Monetary total exceeds safe range');
    return value;
  }
}

// Round product allocations with a deterministic largest-remainder distribution,
// preserving the independently reconciled daily total down to the cent.
function roundedProducts(totals, field, expected, allocatedTarget = false) {
  const rows = totals.map(entry => {
    const { n, d } = entry[field];
    const floor = n >= 0n ? n / d : -((-n + d - 1n) / d);
    return { entry, cents: Number(floor), remainder: n - floor * d, denominator: d };
  });
  const sum = new MoneyTotal();
  for (const entry of totals) sum.add(entry[field].n, entry[field].d);
  if (!allocatedTarget && sum.cents() !== expected) throw new Error('Product revenue allocations do not reconcile');
  const remaining = expected - rows.reduce((total, row) => total + row.cents, 0);
  if (remaining < 0 || remaining > rows.length) throw new Error('Invalid product rounding remainder');
  rows.sort((a, b) => {
    const difference = b.remainder * a.denominator - a.remainder * b.denominator;
    return difference > 0n ? 1 : difference < 0n ? -1 : a.entry.product.localeCompare(b.entry.product);
  });
  rows.forEach((row, index) => { row.entry[`${field}Cents`] = row.cents + (index < remaining ? 1 : 0); });
}

const SHARED = 'Virtual mainrecord for shared payment';
const CANCELLATION = 'Revenue cancelation (removed from tab)';
const SETTLEMENTS = new Set(['Tab paid with cash', 'Tab paid with PIN']);

function analyse({ transactions, products, raw, from, to, cutoff }) {
  const range = period(from, to);
  if (cutoff && (!/^\d{4}-\d{2}-\d{2} [0-2]\d:[0-5]\d$/.test(cutoff) || cutoff <= range.start || cutoff > range.end || +cutoff.slice(11, 13) > 23)) throw new Error('Invalid snapshot cutoff');
  const days = new Map(), main = new Map(), children = new Map();
  const details = new Map(), productTotals = new Map(), productsByKey = new Map();
  const rawProducts = new Map(), money = new Map(), settlementTotals = new Map(), noSaleMoney = new Map();
  const productRevenue = new Map(), baskets = new Map();
  const byDay = day => {
    if (!days.has(day)) days.set(day, {
      day, productGrossCents: 0, productCount: 0, businessclubCents: 0,
      cashRevenueCandidateCents: 0, paymentCents: {}, transactionTypes: {},
      noSale: {}, issues: [], rawProductRows: 0, productRows: 0,
      settlementProductRows: 0, settlementProductCents: 0
    });
    return days.get(day);
  };
  const rowDay = (row, field) => {
    const time = timestamp(row[field]);
    if (time.day < from || time.day >= to || (cutoff && time.local >= cutoff)) throw new Error('Export contains rows outside its declared period');
    return time;
  };
  const addIssue = (day, issue) => { if (!day.issues.includes(issue)) day.issues.push(issue); };
  const addMoney = (day, payment, n, d = 1n) => {
    if (!money.has(day.day)) money.set(day.day, { total: new MoneyTotal(), payments: new Map() });
    const sums = money.get(day.day);
    if (!sums.payments.has(payment)) sums.payments.set(payment, new MoneyTotal());
    sums.total.add(n, d); sums.payments.get(payment).add(n, d);
  };
  const addNoSaleMoney = (day, category, n, d = 1n) => {
    if (!noSaleMoney.has(day.day)) noSaleMoney.set(day.day, new Map());
    const categories = noSaleMoney.get(day.day);
    if (!categories.has(category)) categories.set(category, new MoneyTotal());
    categories.get(category).add(n, d);
  };
  const addProductRevenue = (day, id, field, numerator, denominator = 1n) => {
    if (!productRevenue.has(day.day)) productRevenue.set(day.day, new Map());
    const totals = productRevenue.get(day.day);
    if (!baskets.has(id)) baskets.set(id, { id, day: day.day, localTime: timestamp(main.get(id)['Date created']).local,
      kind: main.get(id)['Transaction type'] === CANCELLATION ? 'correction' : 'sale', products: new Map() });
    const basket = baskets.get(id);
    for (const product of rawProducts.get(id) || []) {
      const name = product.name.trim();
      if (!totals.has(name)) totals.set(name, { product: name, cash: new MoneyTotal(), businessclub: new MoneyTotal() });
      totals.get(name)[field].add(BigInt(product.grossCents) * BigInt(numerator), denominator);
      if (!basket.products.has(name)) basket.products.set(name, { product: id, name, cash: new MoneyTotal(), businessclub: new MoneyTotal() });
      basket.products.get(name)[field].add(BigInt(product.grossCents) * BigInt(numerator), denominator);
    }
  };
  const paymentNames = {
    'Revenue pin': 'Omzet pin', 'Revenue cash': 'Omzet contant',
    'Revenue token': 'Omzet betaalpas', 'Revenue tokens': 'Omzet munten',
    'Revenue tab': 'Omzet rekening', [CANCELLATION]: 'Annulering bon'
  };
  for (const row of transactions) {
    const time = rowDay(row, 'Date created'), day = byDay(time.day);
    const id = row['Transaction Id'], parent = row['Main transaction id'];
    if (id) {
      if (main.has(id)) throw new Error('Duplicate main transaction ID; do not concatenate overlapping exports');
      main.set(id, row);
    } else if (!parent) throw new Error('Transaction has no ID or parent ID');
    if (parent) { if (!children.has(parent)) children.set(parent, []); children.get(parent).push(row); }
    flag(row['Revenue type']); flag(row['No sale type']);
    const direction = sign(row['Summation sign']);
    const entry = day.transactionTypes[row['Transaction type']] ||= { rows: 0, amountCents: 0, paidCents: 0, discountCents: 0, depositPaidCents: 0, depositIntakeCents: 0 };
    entry.rows++; entry.amountCents += number(row.Amount, 100, true) * direction;
    for (const [field, key] of [['Paid', 'paidCents'], ['Discount', 'discountCents'], ['Deposit paid', 'depositPaidCents'], ['Deposit intake', 'depositIntakeCents']]) entry[key] += number(row[field], 100, true);
    number(row['No Sale'], 100, true);
  }
  for (const row of transactions) {
    const parent = row['Main transaction id'];
    if (parent && (!main.has(parent) || timestamp(main.get(parent)['Date created']).day !== timestamp(row['Date created']).day)) {
      addIssue(byDay(timestamp(row['Date created']).day), 'Subtransaction parent is absent or on a different business day');
    }
  }
  const lineKey = (row, count, gross) => JSON.stringify([row['Transaction Id'], row['Product Id'], count, gross]);
  for (const row of products) {
    const time = rowDay(row, 'Date created'), day = byDay(time.day);
    const gross = number(row.Total), count = number(row.Count, 1);
    const transaction = main.get(row['Transaction Id']);
    if (!transaction || transaction['Transaction type'] !== row['Transaction type'] || timestamp(transaction['Date created']).day !== time.day) addIssue(day, 'Product transaction is missing or inconsistent');
    day.productRows++;
    // These rows repeat the original tab products at settlement time. They are
    // deliberately absent from the raw sale export and are not new turnover.
    if (SETTLEMENTS.has(row['Transaction type'])) {
      day.settlementProductRows++; day.settlementProductCents += gross;
      const id = row['Transaction Id'];
      settlementTotals.set(id, (settlementTotals.get(id) || 0) + gross);
      continue;
    }
    day.productGrossCents += gross; day.productCount += count;
    if (row['Transaction type'] === 'Businessclub') day.businessclubCents += gross;
    const id = row['Transaction Id'];
    productTotals.set(id, (productTotals.get(id) || 0) + gross);
    const key = lineKey(row, count, gross);
    const entry = productsByKey.get(key) || { count: 0, day };
    entry.count++; productsByKey.set(key, entry);
  }
  for (const row of raw) {
    const time = rowDay(row, 'Date'), day = byDay(time.day);
    const noSale = flag(row['No Sale']), direction = sign(row['Summation sign']);
    const transaction = main.get(row['Transaction Id']);
    if (!transaction || transaction['Transaction type'] !== row['Payment type'] || flag(transaction['No sale type']) !== noSale || timestamp(transaction['Date created']).day !== time.day) addIssue(day, 'Raw transaction identity or no-sale flag is inconsistent');
    // Raw cancellation amounts/counts are unsigned, unlike the product export.
    // Normal no-sale rows also have sign -1, but represent positive consumption.
    const multiplier = row['Payment type'] === CANCELLATION ? direction : 1;
    const gross = number(row.Total) * multiplier, count = number(row.Count, 1) * multiplier;
    const vatRate = number(row['BTW Value'], 100);
    if (vatRate < 0 || vatRate > 10000) throw new Error('Invalid VAT rate');
    day.rawProductRows++;
    const entry = productsByKey.get(lineKey(row, count, gross));
    if (!entry?.count) addIssue(day, 'Raw product line has no matching product export line');
    else entry.count--;
    const product = { id: row['Product Id'], name: row.Product, count, grossCents: gross, vatRate: vatRate / 100 };
    const id = row['Transaction Id'];
    if (!rawProducts.has(id)) rawProducts.set(id, []);
    rawProducts.get(id).push(product);
    if (!noSale) continue;
    const type = row['Payment type'];
    const category = day.noSale[type] ||= { grossCents: 0, productCount: 0, transactionIds: [], partialProductCountUnknown: false };
    category.grossCents += gross; category.productCount += count;
    if (!category.transactionIds.includes(id)) category.transactionIds.push(id);
    let detail = details.get(id);
    if (!detail) {
      detail = { transactionId: id, day: time.day, localTime: time.local, category: type, terminal: row.Terminal, partial: false, grossCents: 0, products: [] };
      details.set(id, detail);
    } else if (detail.category !== type || detail.localTime !== time.local || detail.terminal !== row.Terminal) throw new Error('Inconsistent no-sale transaction details');
    detail.grossCents += gross; detail.products.push(product);
  }
  for (const entry of productsByKey.values()) if (entry.count) addIssue(entry.day, 'Product export has lines absent from the combined raw export');

  for (const row of transactions) {
    const time = timestamp(row['Date created']), day = byDay(time.day);
    const type = row['Transaction type'], id = row['Transaction Id'];
    if (!flag(row['Revenue type'])) continue;
    const parentId = row['Main transaction id'], parent = main.get(parentId);
    const isSharedChild = parent?.['Transaction type'] === SHARED;
    const amount = number(row.Amount, 100, true), paid = number(row.Paid, 100, true);
    const deposit = number(row['Deposit paid'], 100, true);
    if (number(row['Deposit intake'], 100, true)) addIssue(day, 'Deposit intake requires reconciliation');
    if (flag(row['No sale type'])) {
      // Paid already includes discounts. Virtual discount rows can exist both
      // on the shared parent and on its children; never subtract them again.
      if (isSharedChild && id) {
        const value = number(row['No Sale']) - deposit;
        const category = day.noSale[type] ||= { grossCents: 0, productCount: 0, transactionIds: [], partialProductCountUnknown: false };
        category.grossCents += value; category.partialProductCountUnknown = true;
        addNoSaleMoney(day, type, value);
        if (!category.transactionIds.includes(id)) category.transactionIds.push(id);
        if (type === 'Businessclub') {
          day.businessclubCents += value;
          if (productTotals.get(parentId)) addProductRevenue(day, parentId, 'businessclub', value, BigInt(productTotals.get(parentId)));
          else if (value) addIssue(day, 'Cannot allocate shared businessclub amount to zero product value');
        }
        // Twelve assigns an amount, not specific products, to each partial
        // payment. Keep the basket as context without inventing consumption.
        details.set(id, { transactionId: id, parentTransactionId: parentId, day: time.day, localTime: time.local, category: type, partial: true, grossCents: value, productCount: null, products: [], sharedProducts: rawProducts.get(parentId) || [] });
      } else if (id && !productTotals.has(id)) {
        addIssue(day, 'No-sale transaction has no product lines');
      } else if (id) {
        const value = number(row['No Sale']) - deposit;
        if (!amount) {
          if (productTotals.get(id) !== 0 || value !== 0) addIssue(day, 'Zero-amount no-sale cannot be allocated');
          addNoSaleMoney(day, type, 0);
        } else {
          const numerator = BigInt(productTotals.get(id)) * BigInt(value);
          addNoSaleMoney(day, type, numerator, BigInt(amount));
          if (type === 'Businessclub') addProductRevenue(day, id, 'businessclub', value, BigInt(amount));
          const allocated = new MoneyTotal(); allocated.add(numerator, BigInt(amount));
          const detail = details.get(id);
          // Preserve original basket prices; expose the separately accounted value.
          if (detail && allocated.cents() !== detail.grossCents) detail.accountedCents = allocated.cents();
        }
      }
      continue;
    }
    if (SETTLEMENTS.has(type)) {
      if (settlementTotals.get(id) !== amount) addIssue(day, 'Tab settlement does not match its repeated product lines');
      continue;
    }
    if (type === SHARED) {
      const parts = children.get(id) || [];
      const funded = parts.reduce((sum, part) => sum + number(part.Paid, 100, true) + number(part['No Sale'], 100, true) + number(part.Discount, 100, true), 0);
      if (!parts.length || !productTotals.has(id) || funded !== amount + deposit) addIssue(day, 'Shared payment is missing products or does not balance');
      continue;
    }
    const payment = paymentNames[type];
    if (!payment) { addIssue(day, `Revenue type requires reconciliation: ${type}`); continue; }
    if (type !== CANCELLATION && sign(row['Summation sign']) !== 1) addIssue(day, 'Unexpected payment summation sign');
    if (type === CANCELLATION) {
      if (sign(row['Summation sign']) !== -1 || !productTotals.has(id) || productTotals.get(id) !== -amount) addIssue(day, 'Cancellation does not match reversed products');
      addMoney(day, payment, -BigInt(amount));
      addProductRevenue(day, id, 'cash', 1);
    } else if (isSharedChild) {
      if (productTotals.has(id) || row.Amount !== '') addIssue(day, 'Shared payment child unexpectedly contains product amounts');
      addMoney(day, payment, paid - deposit);
      if (productTotals.get(parentId)) addProductRevenue(day, parentId, 'cash', paid - deposit, BigInt(productTotals.get(parentId)));
      else if (paid !== deposit) addIssue(day, 'Cannot allocate shared payment to zero product value');
    } else if (!productTotals.has(id)) {
      addIssue(day, 'Revenue transaction has no product lines');
    } else if (amount === 0) {
      if (productTotals.get(id) !== 0 || paid !== deposit) addIssue(day, 'Zero-amount transaction cannot be allocated');
      addProductRevenue(day, id, 'cash', 0);
    } else {
      // Some terminals include deposit in Amount; others do not. Allocate the
      // actual paid share (net of deposit) over the exported product value.
      // Coin value is allocated before the separate token over/undervalue adjustment.
      const allocatedPaid = type === 'Revenue tokens' ? paid : paid - deposit;
      addMoney(day, payment, BigInt(productTotals.get(id)) * BigInt(allocatedPaid), BigInt(amount));
      addProductRevenue(day, id, 'cash', allocatedPaid, BigInt(amount));
    }
  }
  for (const day of days.values()) {
    for (const [category, total] of noSaleMoney.get(day.day) || []) {
      if (day.noSale[category]) day.noSale[category].grossCents = total.cents();
    }
    day.businessclubCents = day.noSale.Businessclub?.grossCents || 0;
    const sums = money.get(day.day);
    if (sums) {
      day.cashRevenueCandidateCents = sums.total.cents();
      day.paymentCents = Object.fromEntries([...sums.payments].map(([key, value]) => [key, value.cents()]));
    }
    const revenues = [...(productRevenue.get(day.day)?.values() || [])].sort((a, b) => a.product.localeCompare(b.product));
    try {
      roundedProducts(revenues, 'cash', day.cashRevenueCandidateCents);
      roundedProducts(revenues, 'businessclub', day.businessclubCents);
      const dayBaskets = [...baskets.values()].filter(basket => basket.day === day.day);
      for (const revenue of revenues) {
        const entries = dayBaskets.flatMap(basket => basket.products.has(revenue.product) ? [basket.products.get(revenue.product)] : []);
        // The daily product rounding already assigned each cent. Distribute that
        // exact target across its baskets, with stable transaction-ID tie breaks.
        roundedProducts(entries, 'cash', revenue.cashCents, true);
        roundedProducts(entries, 'businessclub', revenue.businessclubCents, true);
      }
      day.activity = { version: 1, transactions: dayBaskets.sort((a, b) => a.localTime.localeCompare(b.localTime) || a.id.localeCompare(b.id)).map(basket => ({
        id: basket.id, localTime: basket.localTime, kind: basket.kind,
        products: [...basket.products.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, cashCents, businessclubCents }) => ({ name, cashCents, businessclubCents }))
      })) };
      day.productRevenue = revenues.map(({ product, cashCents, businessclubCents }) => ({ product, cashCents, businessclubCents }));
    } catch (error) { addIssue(day, error.message); }
  }
  return {
    range, counts: { transactions: transactions.length, mainTransactions: main.size, products: products.length, raw: raw.length },
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    noSaleTransactions: [...details.values()],
    limitations: ['Candidate totals are not an import payload.', 'VAT totals, cashflow, account mutations and invoice eligibility have not been reconciled.', 'A day with no rows is unverified, not confirmed zero revenue.', 'Partial no-sale payments identify an amount; individual consumed products are unknown.']
  };
}

function compare(analysis, reports) {
  if (!Array.isArray(reports) || !reports.length) throw new Error('No PDF-derived report references supplied');
  const source = new Map(analysis.days.map(day => [day.day, day]));
  const seen = new Set();
  const checks = [];
  for (const report of reports) {
    const day = String(report.period_start || '').slice(0, 10);
    dateOnly(day);
    if (day < analysis.range.from || day >= analysis.range.to) continue;
    if (seen.has(day)) throw new Error('Duplicate reference report date');
    seen.add(day);
    const actual = source.get(day);
    if (!actual) { checks.push({ day, status: 'missing_export', comparisons: [] }); continue; }
    const validPeriod = report.period_start === `${day} 06:00:00` && report.period_end === `${nextDate(day)} 06:00:00`;
    const fields = {
      omzet_incl_nosale: actual.productGrossCents,
      producten: actual.productCount,
      businessclub: actual.businessclubCents,
      kassaomzet: actual.cashRevenueCandidateCents,
      overig_verbruik: actual.productGrossCents - actual.businessclubCents - actual.cashRevenueCandidateCents
    };
    const comparisons = Object.entries(fields).map(([field, actualValue]) => {
      const expected = number(report[field], field === 'producten' ? 1 : 100);
      return { field, actual: actualValue, expected, delta: actualValue - expected, unit: field === 'producten' ? 'count' : 'cents' };
    });
    const status = !validPeriod ? 'period_mismatch' : actual.issues.length ? 'source_incomplete' : comparisons.some(c => c.delta) ? 'different' : 'matched';
    checks.push({ day, reportId: report.id, status, comparisons, issues: actual.issues });
  }
  const missingPdfDays = analysis.days.map(d => d.day).filter(d => !seen.has(d));
  return { checks, missingPdfDays, matched: checks.filter(c => c.status === 'matched').length, compared: checks.length, fullPdfParity: false };
}

module.exports = { HEADERS, MAX_BYTES, dateOnly, nextDate, period, timestamp, number, csv, readExport, analyse, compare };
