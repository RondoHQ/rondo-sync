/** The Rondo contract combines reconciled export details with Twelve's own VAT tables. */
const { number, nextDate, timestamp } = require('./twelve-export');
const crypto = require('node:crypto');
const money = cents => cents / 100;
const labels = {
  'Turnover (excl. no-sale)': 'Omzet (excl. no-sale)',
  'Revenue pin': 'Omzet pin', 'Revenue cash': 'Omzet contant',
  'Revenue token': 'Omzet betaalpas', 'Revenue tokens': 'Omzet munten',
  'Revenue account': 'Omzet rekening', 'Revenue tab': 'Omzet rekening',
  'Revenue cancelation (removed from tab)': 'Annulering bon',
  'Discount from accounts': 'Korting via rekeningen',
  'Token over/undervalue': 'Munten over/onderwaarde', 'Tokens over/under value': 'Munten over/onderwaarde', 'Subtotal': 'Subtotaal'
};
function financialRows(tables, kind) {
  if (!Array.isArray(tables) || tables.length !== (kind === 'revenue' ? 2 : 1)) throw new Error('Unexpected Twelve financial tables');
  return tables.flatMap((table, index) => {
    if (table[0]?.[0] !== (kind === 'revenue' && index === 0 ? 'BTW Type' : 'Transaction type') || table[0]?.[1] !== 'Amount' || table[0]?.[2] !== 'Net amount' || table[0]?.[3] !== 'Hoog' || table[0]?.[4] !== 'Laag') throw new Error('Unexpected Twelve financial columns');
    if (table.length < 2) throw new Error('Missing Twelve financial rows');
    const countIndex = table[0].indexOf('Number of transactions');
    if (![5, 6].includes(countIndex) || (countIndex === 6 && table[0][5] !== 'Geen BTW')) throw new Error('Unexpected transaction count column');
    return table.slice(1).filter(cells => !(kind === 'revenue' && index === 1 && ['Maestro', 'MasterCard', 'Visa', 'V-PAY', 'REPRINT', '??'].includes(cells[0]) && cells.slice(2, countIndex).every(v => v === ''))).map(cells => {
      if (cells.length < 6 || !cells[0]) throw new Error('Incomplete Twelve financial row');
      const label = labels[cells[0]] || cells[0].replace('(Excl. No Sale)', '(Excl. no-sale)');
      const section = cells[0] === 'Subtotal' ? 'subtotaal' : kind === 'nosale' ? 'categorie' : index === 1 ? 'betaalmethode' : cells[0] === 'Turnover (excl. no-sale)' ? 'totaal' : 'btw_type';
      const [bedrag, netto, hoog, laag] = cells.slice(1, 5).map(v => money(number(v.replace(/,/g, ''))));
      if (countIndex === 6 && number(cells[5]) !== 0) throw new Error('Unexpected nonzero tax in zero-VAT column');
      const transacties = cells[countIndex] === '' ? 0 : number(cells[countIndex].replace(/,/g, ''), 1);
      if (Math.abs(Math.round((bedrag - netto - hoog - laag) * 100)) > 1) throw new Error('Twelve VAT row does not balance');
      return { section, label, bedrag, netto, hoog, laag, transacties };
    });
  });
}
function reportForDay({ day, raw, noSaleTransactions, financial, observedAt, cutoff, clientId, audit }) {
  if (day.issues.length) throw new Error(`Source issues on ${day.day}: ${day.issues.join('; ')}`);
  const omzet = [...financialRows(financial.revenue, 'revenue'), ...financialRows(financial.nosale, 'nosale')];
  const total = omzet.filter(r => r.section === 'totaal');
  if (total.length !== 1 || number(total[0].bedrag) !== day.cashRevenueCandidateCents) throw new Error(`Revenue overview disagrees with exports on ${day.day}`);
  for (const [name, category] of Object.entries(day.noSale)) {
    const row = omzet.find(r => r.section === 'categorie' && r.label === name);
    if (!row || number(row.bedrag) !== category.grossCents || row.transacties !== category.transactionIds.length) throw new Error(`No-sale overview disagrees with exports on ${day.day}: ${name}`);
  }
  for (const row of omzet.filter(r => r.section === 'categorie')) {
    if (!day.noSale[row.label] && !['Korting via rekeningen', 'Munten over/onderwaarde'].includes(row.label) && row.bedrag !== 0) throw new Error(`Unknown no-sale category on ${day.day}: ${row.label}`);
  }
  const grouped = new Map();
  for (const r of raw) {
    if (timestamp(r.Date).day !== day.day) continue;
    const sign = r['Payment type'] === 'Revenue cancelation (removed from tab)' ? -1 : 1;
    const rate = number(r['BTW Value'], 1);
    if (![0, 9, 21].includes(rate)) throw new Error('Unsupported product VAT rate');
    const key = JSON.stringify([r.Product.trim(), rate]);
    const p = grouped.get(key) || { product: r.Product.trim(), rate, cents: 0, aantal: 0 };
    p.cents += number(r.Total) * sign; p.aantal += number(r.Count, 1) * sign;
    grouped.set(key, p);
  }
  const producten = [...grouped.values()].sort((a, b) => a.product.localeCompare(b.product) || a.rate - b.rate).map(p => {
    const net = Math.round(Math.abs(p.cents) * 100 / (100 + p.rate)) * (p.cents < 0 ? -1 : 1);
    return { product: p.product, bruto: money(p.cents), netto: money(net), btw: money(p.cents - net), aantal: p.aantal, btw_groep: p.rate === 21 ? 'Hoog 21%' : p.rate === 9 ? 'Laag 9%' : 'Geen BTW 0%' };
  });
  if (producten.reduce((n, p) => n + number(p.bruto), 0) !== day.productGrossCents || producten.reduce((n, p) => n + p.aantal, 0) !== day.productCount) throw new Error('Product totals do not match');
  const end = `${nextDate(day.day)} 06:00`;
  return {
    club: 'Twelve', period_start: `${day.day} 06:00`, period_end: end, omzet, producten,
    producten_totaal: { bruto: money(day.productGrossCents), aantal: day.productCount },
    no_sale_transactions: noSaleTransactions.filter(r => r.day === day.day),
    source: { type: 'twelve_browser', client_id: String(clientId), observed_at: observedAt,
      coverage_end: cutoff && cutoff < end ? cutoff : end, complete: !cutoff || cutoff >= end,
      audit, finance_sha256: crypto.createHash('sha256').update(JSON.stringify(financial)).digest('hex') }
  };
}
function currentRange(now = new Date()) {
  // Exclude the minute currently being written; all exports share one cutoff.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(p => [p.type, p.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const day = +parts.hour < 6 ? nextDate(date, -1) : date;
  return { from: nextDate(day, -7), to: nextDate(day), cutoff: `${date} ${parts.hour}:${parts.minute}` };
}
module.exports = { financialRows, reportForDay, currentRange };
