require('dotenv/config');

const { createSyncLogger } = require('../lib/logger');
const { parseCliArgs } = require('../lib/utils');
const { SponsitSession } = require('../lib/sponsit-session');
const { fetchSponsitContacts } = require('../lib/sponsit-client');
const { openDb, replaceSnapshot } = require('../lib/sponsit-db');

async function runSponsitDownload(options = {}) {
  const {
    logger: providedLogger,
    verbose = false,
    detailConcurrency = Number(process.env.SPONSIT_DETAIL_CONCURRENCY || 3),
    session: providedSession = null,
    db: providedDb = null,
    onProgress = null
  } = options;
  const logger = providedLogger || createSyncLogger({ verbose, prefix: 'sponsit' });
  const session = providedSession || new SponsitSession({ logger, verbose });
  const db = providedDb || openDb();
  const ownsSession = !providedSession;
  const ownsDb = !providedDb;

  try {
    logger.log('Downloading Sponsit contacts...');
    const contacts = await fetchSponsitContacts({
      session,
      logger,
      detailConcurrency,
      onProgress
    });

    // Only replace the local mirror after a complete snapshot was downloaded.
    const snapshot = replaceSnapshot(db, contacts);
    logger.log(`Sponsit contacts stored: ${snapshot.totals.contacts}`);
    logger.log(`Current sponsors: ${snapshot.totals.activeSponsors}`);
    logger.log(`Contact people: ${snapshot.totals.people}`);
    logger.log(`Proposed Rondo sponsor records: ${snapshot.totals.rondoCandidates}`);

    return {
      success: true,
      count: snapshot.totals.contacts,
      people: snapshot.totals.people,
      activeSponsors: snapshot.totals.activeSponsors,
      rondoCandidates: snapshot.totals.rondoCandidates,
      snapshot
    };
  } catch (error) {
    logger.error(`Sponsit download failed: ${error.message}`);
    return {
      success: false,
      count: 0,
      people: 0,
      activeSponsors: 0,
      rondoCandidates: 0,
      error: error.message
    };
  } finally {
    if (ownsSession) await session.close();
    if (ownsDb) db.close();
    if (!providedLogger) logger.close();
  }
}

module.exports = { runSponsitDownload };

if (require.main === module) {
  const { verbose } = parseCliArgs();
  runSponsitDownload({ verbose }).then((result) => {
    if (!result.success) process.exitCode = 1;
  });
}
