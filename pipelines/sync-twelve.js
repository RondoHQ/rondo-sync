/** Normal Twelve browser login -> validated snapshots -> idempotent daily Rondo reports. */
require('dotenv/config');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { TwelveBrowser } = require('../lib/twelve-browser');
const { runDownload } = require('../steps/download-twelve');
const { loadSnapshot } = require('../tools/compare-twelve');
const { analyse, nextDate } = require('../lib/twelve-export');
const { reportForDay, currentRange } = require('../lib/twelve-report');
const { rondoClubRequestWithRetry } = require('../lib/rondo-club-client');
const { RunTracker } = require('../lib/run-tracker');
const { orderedReads } = require('../lib/twelve-read-queue');
const { runPipelineCli } = require('../lib/pipeline-cli');

async function runTwelveSync({ from, to, snapshot, dryRun = false, log = console.log } = {}) {
  const tracker = new RunTracker('twelve');
  tracker.startRun();
  const step = tracker.startStep('twelve-reports');
  const stats = { created: 0, updated: 0, skipped: 0, failed: 0 };
  let browser;
  try {
    if (!!from !== !!to || (snapshot && (from || to))) throw new Error('Use --snapshot, --from with --to, or the default recent range');
    const range = from ? { from, to } : currentRange();
    const checkpoint = path.join('data', 'twelve-last-success.json');
    if (!from && !snapshot && fs.existsSync(checkpoint)) {
      const previous = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
      if (/^\d{4}-\d{2}-\d{2}$/.test(previous.from) && previous.from < range.from) range.from = previous.from;
    }
    const downloaded = snapshot ? null : await runDownload({ ...range, log });
    const directory = snapshot || downloaded.directory;
    const input = loadSnapshot(directory);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (String(manifest.clientId) !== process.env.TWELVE_CLIENT_ID) throw new Error('Snapshot client does not match the configured Twelve club');
    const analysis = analyse(input);
    if (analysis.days.some(d => d.issues.length)) throw new Error('Export reconciliation failed; no reports were imported');
    browser = new TwelveBrowser({ username: process.env.TWELVE_USERNAME, password: process.env.TWELVE_PASSWORD, clientId: process.env.TWELVE_CLIENT_ID });
    await browser.open();
    const readers = [browser];
    // A bounded pool speeds the one-off historical import; Rondo writes remain sequential.
    for (let i = 1; i < Math.min(4, analysis.days.length); i++) readers.push(await browser.newReader());
    const rawByDay = new Map();
    const { timestamp } = require('../lib/twelve-export');
    for (const row of input.raw) { const day = timestamp(row.Date).day; if (!rawByDay.has(day)) rawByDay.set(day, []); rawByDay.get(day).push(row); }
    const prepared = orderedReads(analysis.days, readers, async (day, reader) => {
      const date = day.day;
      const chunk = manifest.chunks.find(c => c.from <= date && c.to > date);
      const financePath = path.join(directory, `finance-${date}.json`);
      let financial;
      // Reuse only immutable, closed-day financial reads from this snapshot.
      // Reconciliation catches any source correction since its CSV download.
      if (fs.existsSync(financePath)) financial = JSON.parse(fs.readFileSync(financePath, 'utf8'));
      else {
        const cutoff = input.cutoff && input.cutoff < `${nextDate(date)} 06:00` ? input.cutoff : undefined;
        financial = await reader.financialReport(date, nextDate(date), cutoff);
        fs.writeFileSync(financePath, JSON.stringify(financial), { mode: 0o600, flag: 'wx' });
      }
      const data = reportForDay({ day, raw: rawByDay.get(date) || [], noSaleTransactions: analysis.noSaleTransactions,
        financial, observedAt: manifest.startedAt, cutoff: input.cutoff, clientId: manifest.clientId,
        audit: Object.fromEntries(Object.entries(chunk.files).map(([kind, file]) => [kind, file.sha256])) });
      const json = JSON.stringify(data);
      fs.writeFileSync(path.join(directory, `report-${date}.json`), json, { mode: 0o600 });
      return { date, json };
    });
    for await (const { date, json } of prepared) {
      if (dryRun) { stats.skipped++; log(`Twelve ${date}: validated (dry run)`); continue; }
      const result = (await rondoClubRequestWithRetry('rondo/v1/twelve/import', 'POST', { report_json: json })).body;
      if (!Number.isInteger(result.id) || result.hash !== crypto.createHash('sha256').update(json).digest('hex') || !['created', 'updated', 'unchanged'].includes(result.status)) throw new Error('Rondo did not confirm the imported report');
      stats[result.status === 'unchanged' ? 'skipped' : result.status]++;
      log(`Twelve ${date}: ${result.status}, report ${result.id}`);
      tracker.updateStep(step, { current: stats.created + stats.updated + stats.skipped, total: analysis.days.length, label: date });
    }
    if (!dryRun && !snapshot && !from) {
      fs.writeFileSync(`${checkpoint}.tmp`, JSON.stringify({ from: nextDate(input.to, -2) }), { mode: 0o600 });
      fs.renameSync(`${checkpoint}.tmp`, checkpoint);
    }
    tracker.endStep(step, { outcome: 'success', ...stats });
    tracker.endRun('success', stats);
    log(`Twelve complete: ${JSON.stringify(stats)}; snapshot ${directory}`);
    return { success: true, stats, directory };
  } catch (error) {
    // Browser call logs may contain session URLs. Keep stored errors to one line.
    const message = error.message.split('\n')[0];
    stats.failed++;
    log(`Twelve failed: ${message}`);
    tracker.recordErrors('twelve-reports', step, [{ message }]);
    tracker.endStep(step, { outcome: 'failure', ...stats });
    tracker.endRun('failure', stats);
    return { success: false, stats, error: message };
  } finally { if (browser) await browser.close(); }
}
module.exports = { runTwelveSync };
if (require.main === module) {
  const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, snapshot: { type: 'string' }, 'dry-run': { type: 'boolean' }, verbose: { type: 'boolean' } } });
  runPipelineCli(runTwelveSync({ ...values, dryRun: values['dry-run'] }));
}
