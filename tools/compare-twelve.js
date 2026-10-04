/** Offline analysis, optionally reading PDF totals from Rondo via GET only. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { readExport, analyse, compare, period } = require('../lib/twelve-export');

function loadSnapshot(directory) {
  const root = path.resolve(directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.status !== 'complete' || !manifest.chunks?.length) throw new Error('Snapshot is incomplete or unsupported');
  const range = period(manifest.range.from, manifest.range.to);
  const rows = { transactions: [], products: [], raw: [] };
  let cursor = range.from;
  for (const chunk of manifest.chunks) {
    if (chunk.from !== cursor || chunk.to <= chunk.from || chunk.to > range.to) throw new Error('Snapshot has overlapping or missing date ranges');
    cursor = chunk.to;
    const chunkRows = {};
    for (const kind of Object.keys(rows)) {
      const file = chunk.files[kind];
      const filename = path.resolve(root, file.path);
      if (!filename.startsWith(`${root}${path.sep}`)) throw new Error('Snapshot file escapes its directory');
      const hash = crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
      if (hash !== file.sha256) throw new Error('Snapshot file checksum mismatch');
      chunkRows[kind] = readExport(filename, kind);
      if (chunkRows[kind].length !== file.rows) throw new Error('Snapshot row count mismatch');
      rows[kind].push(...chunkRows[kind]);
    }
    if (chunkRows.raw.length !== chunk.expectedRows) throw new Error('Snapshot raw count differs from screen count');
    analyse({ ...chunkRows, from: chunk.from, to: chunk.to, cutoff: chunk.to === range.to ? manifest.range.cutoff : undefined });
  }
  if (cursor !== range.to) throw new Error('Snapshot does not cover the complete date range');
  return { ...rows, from: range.from, to: range.to, cutoff: manifest.range.cutoff };
}

function renderComparison(analysis, comparison) {
  const lines = [
    `Twelve vergelijking: ${analysis.range.start} t/m ${analysis.range.end} (einde exclusief, Europe/Amsterdam)`,
    `${analysis.counts.mainTransactions} hoofdtransacties, ${analysis.counts.products} productregels, ${analysis.noSaleTransactions.length} no-sale-transacties.`,
    `${comparison.matched}/${comparison.compared} beschikbare PDF-dagen gelijk op de vijf gecontroleerde velden.`,
    '', 'Datum       Uitkomst           Verschillen (export minus PDF)'
  ];
  for (const row of comparison.checks) {
    const differences = row.comparisons.filter(c => c.delta).map(c => `${c.field}: ${c.unit === 'cents' ? (c.delta / 100).toFixed(2) + ' EUR' : c.delta}`).join(', ');
    lines.push(`${row.day}  ${row.status.padEnd(18)} ${differences || 'geen'}${row.issues?.length ? '; ' + row.issues.join('; ') : ''}`);
  }
  lines.push('', `${comparison.missingPdfDays.length} exportdagen hebben geen meegeleverde PDF-referentie.`,
    `${analysis.days.filter(d => d.issues.length).length} exportdagen bevatten bronverschillen of nog niet ondersteunde transactiesoorten.`,
    'Dit is geen importbestand. BTW-totalen, kasstroom, rekeningmutaties en facturatie zijn nog niet vergeleken.',
    'Ontbrekende dagen zijn onbekend; er worden geen nulomzetten aangevuld.',
    'Gedeeltelijke no-sales tonen het bedrag en de categorie; de specifieke verbruikte producten zijn onbekend.',
    'Het PDF-restbedrag bevat ook kortingen en muntverschillen.');
  return lines.join('\n') + '\n';
}

async function runComparison(options) {
  let input;
  if (options.snapshot) {
    if (options.transactions || options.products || options.raw || options.from || options.to) throw new Error('Use either a snapshot or explicit files and dates');
    input = loadSnapshot(options.snapshot);
  } else {
    period(options.from, options.to);
    if (!options.transactions || !options.products || !options.raw) throw new Error('Supply all three exports');
    input = Object.fromEntries(['transactions', 'products', 'raw'].map(kind => [kind, readExport(options[kind], kind)]));
    Object.assign(input, { from: options.from, to: options.to });
  }
  if (!!options.reports === !!options.fetchRondo) throw new Error('Supply exactly one of --reports or --fetch-rondo');
  let reference;
  if (options.fetchRondo) {
    const { rondoClubRequestWithRetry } = require('../lib/rondo-club-client');
    reference = (await rondoClubRequestWithRetry('rondo/v1/twelve/reports?limit=365', 'GET')).body;
  } else {
    reference = JSON.parse(fs.readFileSync(options.reports, 'utf8'));
  }
  const analysis = analyse(input);
  const comparison = compare(analysis, reference.reports);
  const output = path.resolve(options.output || 'data/twelve-comparisons');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(output, 'comparison-'));
  fs.chmodSync(directory, 0o700);
  for (const [name, content] of [
    ['analysis.json', JSON.stringify(analysis, null, 2)],
    ['comparison.json', JSON.stringify(comparison, null, 2)],
    ['reference.json', JSON.stringify(reference, null, 2)],
    ['comparison.txt', renderComparison(analysis, comparison)]
  ]) fs.writeFileSync(path.join(directory, name), content, { mode: 0o600 });
  return { directory, analysis, comparison, success: comparison.compared > 0 && comparison.matched === comparison.compared && !analysis.days.some(d => d.issues.length) };
}

module.exports = { loadSnapshot, runComparison, renderComparison };
if (require.main === module) {
  const options = Object.fromEntries(['snapshot', 'from', 'to', 'transactions', 'products', 'raw', 'reports', 'output'].map(k => [k, { type: 'string' }]));
  options['fetch-rondo'] = { type: 'boolean', default: false };
  const { values } = parseArgs({ options });
  runComparison({ ...values, fetchRondo: values['fetch-rondo'] })
    .then(result => {
      console.log(renderComparison(result.analysis, result.comparison));
      console.log(`Private comparison files: ${result.directory}`);
      if (!result.success) process.exitCode = 2;
    })
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
