/** Read-only proof stage: immutable exports only; no Rondo writes or scheduling. */
require('dotenv/config');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { TwelveBrowser, EXPORTS, chunks } = require('../lib/twelve-browser');
const { readExport, analyse, period } = require('../lib/twelve-export');

async function runDownload({ from, to, output = 'data/twelve', chunkDays = 31, session, log = console.log } = {}) {
  const ranges = chunks(from, to, chunkDays);
  const browser = session || new TwelveBrowser({ username: process.env.TWELVE_USERNAME, password: process.env.TWELVE_PASSWORD, clientId: process.env.TWELVE_CLIENT_ID });
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(path.join(output, 'snapshot-'));
  await fs.chmod(root, 0o700);
  const manifest = { version: 1, status: 'incomplete', clientId: process.env.TWELVE_CLIENT_ID, range: period(from, to), startedAt: new Date().toISOString(), chunks: [] };
  const saveManifest = async () => {
    await fs.writeFile(path.join(root, 'manifest.tmp'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    await fs.rename(path.join(root, 'manifest.tmp'), path.join(root, 'manifest.json'));
  };
  await saveManifest();
  try {
    await browser.open();
    for (const range of ranges) {
      const dir = path.join(root, `${range.from}_${range.to}`);
      await fs.mkdir(dir, { mode: 0o700 });
      const expectedRows = await browser.setPeriod(range.from, range.to);
      const files = {};
      const rows = {};
      for (const item of EXPORTS) {
        const filename = path.join(dir, item.filename);
        await browser.download(item.kind, filename);
        await fs.chmod(filename, 0o600);
        rows[item.kind] = readExport(filename, item.kind);
        files[item.kind] = { path: path.relative(root, filename), sha256: crypto.createHash('sha256').update(await fs.readFile(filename)).digest('hex'), rows: rows[item.kind].length };
      }
      if (rows.raw.length !== expectedRows) throw new Error('Raw export row count differs from the Twelve screen');
      const analysis = analyse({ ...rows, ...range });
      manifest.chunks.push({ ...range, expectedRows, files, daysWithIssues: analysis.days.filter(d => d.issues.length).length });
      await saveManifest();
      log(`Twelve ${range.from}–${range.to}: ${rows.transactions.length} transaction rows, ${rows.raw.length} raw product rows`);
    }
    manifest.status = 'complete'; manifest.completedAt = new Date().toISOString();
    await saveManifest();
    return { success: true, directory: path.resolve(root), manifest };
  } catch (error) {
    // An incomplete manifest is never accepted by the comparison tool.
    log(`Twelve snapshot incomplete: ${path.resolve(root)}`);
    throw error;
  } finally {
    await browser.close();
  }
}

module.exports = { runDownload };
if (require.main === module) {
  const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, output: { type: 'string' }, 'chunk-days': { type: 'string' } } });
  runDownload({ from: values.from, to: values.to, output: values.output, chunkDays: values['chunk-days'] ? Number(values['chunk-days']) : 31 })
    .then(result => console.log(`Complete snapshot: ${result.directory}`))
    .catch(error => { console.error(`Twelve download failed: ${error.message.replace(/\n[\s\S]*/, '')}`); process.exitCode = 1; });
}
