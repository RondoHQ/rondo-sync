#!/usr/bin/env node
/** Source inventory/checks only: no newsletters, photos, VOG emails or welcome sends. */
require('dotenv/config');
const { requireProductionServer } = require('../lib/server-check');
const { SportlinkSession } = require('../lib/sportlink-session');
const { createSyncLogger } = require('../lib/logger');
const { runDownload } = require('../steps/download-data-from-sportlink');
const { runSourceChecks } = require('../steps/sync-onboarding-sources');

async function main() {
  requireProductionServer({ scriptName: 'Onboarding source checks' });
  const idIndex = process.argv.indexOf('--knvb-id');
  const checkIds = idIndex >= 0 ? [process.argv[idIndex + 1]] : [];
  if (checkIds.length && !/^[a-zA-Z0-9_-]{1,40}$/.test(checkIds[0] || '')) throw new Error('A KNVB ID is required after --knvb-id');
  const logger = createSyncLogger({ verbose: false, prefix: 'onboarding-source-checks' });
  const session = new SportlinkSession({ logger });
  try {
    const source = await runDownload({ logger, session, page: await session.getPage() });
    if (!source.success || !source.sourceComplete) throw new Error('Incomplete Sportlink search: inventory unchanged');
    const result = await runSourceChecks({ ...source, page: await session.getPage(), logger, checkIds, inventoryOnly: process.argv.includes('--inventory-only') });
    logger.log(JSON.stringify(result));
    process.exitCode = result.errors.length ? 2 : 0;
  } finally {
    await session.close();
    logger.close();
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main };
