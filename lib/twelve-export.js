/** Read-only Twelve export analysis. Amounts are integer cents, never floats. */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { parse } = require('csv-parse/sync');

const MAX_BYTES = 128 * 1024 * 1024;
const HEADERS = {
  transactions: ['Transaction Id', 'Main transaction id', 'Date created', 'Transaction type', 'Amount', 'Paid', 'Discount', 'Deposit paid', 'Deposit intake', 'No sale type', 'Revenue type', 'Summation sign'],
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

function analyse({ transactions, products, raw, from, to }) {
  const range = period(from, to);
  const days = new Map();
  const main = new Map();
  const details = new Map();
  const productsByKey = new Map();
  const byDay = day => {
    if (!days.has(day)) days.set(day, {
      day, productGrossCents: 0, productCount: 0, businessclubCents: 0,
      cashRevenueCandidateCents: 0, paymentCents: {}, transactionTypes: {},
      noSale: {}, issues: [], rawProductRows: 0, productRows: 0
    });
    return days.get(day);
  };
  const rowDay = (row, field) => {
    const time = timestamp(row[field]);
    if (time.day < from || time.day >= to) throw new Error('Export contains rows outside its declared period');
    return time;
  };
  const addIssue = (day, issue) => { if (!day.issues.includes(issue)) day.issues.push(issue); };
  const paymentNames = {
    'Revenue pin': 'Omzet pin', 'Revenue cash': 'Omzet contant',
    'Revenue token': 'Omzet betaalpas', 'Revenue tokens': 'Omzet munten',
    'Revenue tab': 'Omzet rekening'
  };
  for (const row of transactions) {
    const time = rowDay(row, 'Date created');
    const day = byDay(time.day);
    const id = row['Transaction Id'];
    if (id) {
      if (main.has(id)) throw new Error('Duplicate main transaction ID; do not concatenate overlapping exports');
      main.set(id, row);
    } else if (!row['Main transaction id']) throw new Error('Transaction has no ID or parent ID');
    const type = row['Transaction type'];
    const revenue = flag(row['Revenue type']);
    const noSale = flag(row['No sale type']);
    const direction = sign(row['Summation sign']);
    const amount = number(row.Amount, 100, true);
    const paid = number(row.Paid, 100, true);
    const discount = number(row.Discount, 100, true);
    const depositPaid = number(row['Deposit paid'], 100, true);
    const depositIntake = number(row['Deposit intake'], 100, true);
    const entry = day.transactionTypes[type] ||= { rows: 0, amountCents: 0, paidCents: 0, discountCents: 0, depositPaidCents: 0, depositIntakeCents: 0 };
    entry.rows++; entry.amountCents += amount * direction; entry.paidCents += paid;
    entry.discountCents += discount; entry.depositPaidCents += depositPaid; entry.depositIntakeCents += depositIntake;
    if (!revenue) continue; // Top-ups and withdrawals are not sales.
    if (noSale) {
      if (type === 'Virtual discount') {
        // PDF account-card revenue is net of its separate virtual discount row.
        day.paymentCents['Omzet betaalpas'] = (day.paymentCents['Omzet betaalpas'] || 0) - discount;
        day.cashRevenueCandidateCents -= discount;
      }
      continue;
    }
    const payment = paymentNames[type];
    if (!payment) {
      addIssue(day, `Revenue type requires reconciliation: ${type}`);
      continue;
    }
    // Observed PDF rule: coins report their tendered value, other payment methods
    // report product value. Keep this a candidate until compared to a real PDF.
    const value = (type === 'Revenue tokens' ? paid : amount) * direction;
    day.paymentCents[payment] = (day.paymentCents[payment] || 0) + value;
    day.cashRevenueCandidateCents += value;
  }
  for (const row of transactions) {
    const parent = row['Main transaction id'];
    if (parent && !main.has(parent)) addIssue(byDay(timestamp(row['Date created']).day), 'Subtransaction parent is absent');
  }
  const lineKey = row => JSON.stringify([row['Transaction Id'], row['Product Id'], row.Count, number(row.Total)]);
  for (const row of products) {
    const time = rowDay(row, 'Date created');
    const day = byDay(time.day);
    const gross = number(row.Total);
    const count = number(row.Count, 1);
    const transaction = main.get(row['Transaction Id']);
    if (!transaction || transaction['Transaction type'] !== row['Transaction type'] || timestamp(transaction['Date created']).day !== time.day) {
      addIssue(day, 'Product transaction is missing or inconsistent');
    }
    day.productGrossCents += gross; day.productCount += count; day.productRows++;
    if (row['Transaction type'] === 'Businessclub') day.businessclubCents += gross;
    const key = lineKey(row);
    productsByKey.set(key, (productsByKey.get(key) || 0) + 1);
  }
  for (const row of raw) {
    const time = rowDay(row, 'Date');
    const day = byDay(time.day);
    const noSale = flag(row['No Sale']);
    const transaction = main.get(row['Transaction Id']);
    if (!transaction || transaction['Transaction type'] !== row['Payment type'] || flag(transaction['No sale type']) !== noSale) {
      addIssue(day, 'Raw transaction identity or no-sale flag is inconsistent');
    }
    sign(row['Summation sign']); // No-sale raw signs are -1, NOT a product reversal.
    const gross = number(row.Total);
    const count = number(row.Count, 1);
    const vatRate = number(row['BTW Value'], 100);
    if (vatRate < 0 || vatRate > 10000) throw new Error('Invalid VAT rate');
    day.rawProductRows++;
    const key = lineKey(row);
    if (!productsByKey.get(key)) addIssue(day, 'Raw product line has no matching product export line');
    else productsByKey.set(key, productsByKey.get(key) - 1);
    if (!noSale) continue;
    const type = row['Payment type'];
    const category = day.noSale[type] ||= { grossCents: 0, productCount: 0, transactionIds: [] };
    category.grossCents += gross; category.productCount += count;
    if (!category.transactionIds.includes(row['Transaction Id'])) category.transactionIds.push(row['Transaction Id']);
    const id = row['Transaction Id'];
    let detail = details.get(id);
    if (!detail) {
      detail = { transactionId: id, day: time.day, localTime: time.local, category: type, terminal: row.Terminal, products: [] };
      details.set(id, detail);
    } else if (detail.category !== type || detail.localTime !== time.local || detail.terminal !== row.Terminal) {
      throw new Error('Inconsistent no-sale transaction details');
    }
    detail.products.push({ id: row['Product Id'], name: row.Product, count, grossCents: gross, vatRate: vatRate / 100 });
  }
  for (const row of products) {
    if (productsByKey.get(lineKey(row)) > 0) addIssue(byDay(timestamp(row['Date created']).day), 'Product export has lines absent from the combined raw export');
  }
  return {
    range, counts: { transactions: transactions.length, mainTransactions: main.size, products: products.length, raw: raw.length },
    days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
    noSaleTransactions: [...details.values()],
    limitations: ['Candidate totals are not an import payload.', 'VAT totals, cashflow, account mutations and invoice eligibility have not been reconciled.', 'A day with no rows is unverified, not confirmed zero revenue.']
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
