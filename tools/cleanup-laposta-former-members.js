require('dotenv/config');

const { requireProductionServer } = require('../lib/server-check');
const { SportlinkSession } = require('../lib/sportlink-session');
const { runDownload } = require('../steps/download-data-from-sportlink');
const { runDownloadInactive } = require('../steps/download-inactive-members');
const { syncFormerMembersToLaposta } = require('../steps/sync-former-members-to-laposta');

async function runCleanup(options = {}) {
  const logger = options.logger || { log: console.error, verbose() {}, error: console.error };
  const session = new SportlinkSession({ logger });
  let active;
  let inactive;
  try {
    const page = await session.getPage();
    active = await runDownload({ page, session, logger });
    if (!active.success || active.sourceComplete !== true) throw new Error('Active Sportlink download incomplete; cleanup aborted');
    inactive = await runDownloadInactive({ page, logger });
  } finally {
    await session.close();
  }
  return syncFormerMembersToLaposta(active, inactive, { apply: options.apply === true, logger });
}

module.exports = { runCleanup };

if (require.main === module) {
  requireProductionServer({ scriptName: 'Former-member Laposta cleanup' });
  runCleanup({ apply: process.argv.includes('--apply') }).then(result => {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2));
    if (result.errors.length) process.exitCode = 1;
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
