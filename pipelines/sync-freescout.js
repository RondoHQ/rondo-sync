require('dotenv/config');

const { createSyncLogger } = require('../lib/logger');
const { formatDuration, formatTimestamp } = require('../lib/utils');
const { RunTracker } = require('../lib/run-tracker');
const { runPipelineCli } = require('../lib/pipeline-cli');
const { runSubmit: runFreescoutSubmit } = require('../steps/submit-freescout-sync');
const { runSyncFreescoutIdsToRondoClub } = require('../steps/sync-freescout-ids-to-rondo-club');
const { checkCredentials: checkFreescoutCredentials } = require('../lib/freescout-client');

/**
 * Print summary report for FreeScout sync
 */
function printSummary(logger, stats) {
  const divider = '========================================';
  const minorDivider = '----------------------------------------';

  logger.log('');
  logger.log(divider);
  logger.log('FREESCOUT SYNC SUMMARY');
  logger.log(divider);
  logger.log('');
  logger.log(`Completed: ${stats.completedAt}`);
  logger.log(`Duration: ${stats.duration}`);
  logger.log('');

  logger.log('CUSTOMER SYNC');
  logger.log(minorDivider);
  logger.log(`Total customers: ${stats.total}`);
  logger.log(`Synced: ${stats.synced}`);
  if (stats.created > 0) {
    logger.log(`  Created: ${stats.created}`);
  }
  if (stats.updated > 0) {
    logger.log(`  Updated: ${stats.updated}`);
  }
  if (stats.skipped > 0) {
    logger.log(`  Skipped (unchanged): ${stats.skipped}`);
  }
  if (stats.deleted > 0) {
    logger.log(`  Deleted: ${stats.deleted}`);
  }
  if (stats.rondoClubSynced > 0) {
    logger.log(`FreeScout IDs synced to Rondo Club: ${stats.rondoClubSynced}`);
  }
  if (stats.errors.length > 0) {
    logger.log(`Errors: ${stats.errors.length}`);
  }
  logger.log('');

  logger.log(divider);
}

/**
 * Run FreeScout sync pipeline (daily)
 * - Sync Rondo Club members to FreeScout customers
 */
async function runFreescoutSync(options = {}) {
  const { verbose = false, force = false } = options;

  const logger = createSyncLogger({ verbose, prefix: 'freescout' });
  const startTime = Date.now();

  const tracker = new RunTracker('freescout');
  tracker.startRun();

  const stats = {
    completedAt: '',
    duration: '',
    total: 0,
    synced: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    deleted: 0,
    rondoClubSynced: 0,
    errors: []
  };

  try {
    // Check credentials
    const creds = checkFreescoutCredentials();
    if (!creds.configured) {
      logger.error('FreeScout credentials not configured');
      logger.error('Required: FREESCOUT_API_KEY and FREESCOUT_URL in .env');
      tracker.endRun('failure', stats);
      stats.completedAt = formatTimestamp();
      stats.duration = formatDuration(Date.now() - startTime);
      printSummary(logger, stats);
      logger.close();
      return { success: false, stats, error: 'Credentials not configured' };
    }

    // Run FreeScout sync
    logger.log('Starting FreeScout customer sync');
    const freescoutStepId = tracker.startStep('freescout-sync');
    try {
      const result = await runFreescoutSubmit({ logger, verbose, force });
      stats.total = result.total || 0;
      stats.synced = result.synced || 0;
      stats.created = result.created || 0;
      stats.updated = result.updated || 0;
      stats.skipped = result.skipped || 0;
      stats.deleted = result.deleted || 0;
      stats.errors = (result.errors || []).map(e => ({
        knvb_id: e.knvb_id,
        message: e.message,
        system: 'freescout'
      }));
      tracker.endStep(freescoutStepId, {
        outcome: 'success',
        created: stats.created,
        updated: stats.updated,
        skipped: stats.skipped,
        failed: stats.errors.length
      });
      tracker.recordErrors('freescout-sync', freescoutStepId, stats.errors);
    } catch (err) {
      logger.error(`FreeScout sync failed: ${err.message}`);
      stats.errors.push({
        message: `FreeScout sync failed: ${err.message}`,
        system: 'freescout'
      });
      tracker.endStep(freescoutStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'freescout-sync',
        stepId: freescoutStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Sync FreeScout IDs back to Rondo Club
    logger.log('Syncing FreeScout IDs to Rondo Club');
    const rondoClubStepId = tracker.startStep('sync-freescout-ids-to-rondo-club');
    try {
      const rcResult = await runSyncFreescoutIdsToRondoClub({ logger, verbose });
      stats.rondoClubSynced = rcResult.synced || 0;
      const rcErrors = (rcResult.errors || []).map(e => ({
        knvb_id: e.knvb_id,
        message: e.message,
        system: 'rondo-club'
      }));
      stats.errors.push(...rcErrors);
      tracker.endStep(rondoClubStepId, {
        outcome: 'success',
        updated: rcResult.synced,
        skipped: rcResult.skipped,
        failed: rcErrors.length
      });
      tracker.recordErrors('sync-freescout-ids-to-rondo-club', rondoClubStepId, rcErrors);
    } catch (err) {
      logger.error(`FreeScout ID sync to Rondo Club failed: ${err.message}`);
      stats.errors.push({
        message: `FreeScout ID sync to Rondo Club failed: ${err.message}`,
        system: 'rondo-club'
      });
      tracker.endStep(rondoClubStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'sync-freescout-ids-to-rondo-club',
        stepId: rondoClubStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Complete
    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - startTime);

    const success = stats.errors.length === 0;
    const outcome = stats.errors.length === 0 ? 'success' : 'partial';

    tracker.endRun(outcome, stats);

    printSummary(logger, stats);
    logger.log(`Log file: ${logger.getLogPath()}`);
    logger.close();

    return { success, stats };
  } catch (err) {
    const errorMsg = err.message || String(err);
    logger.error(`Fatal error: ${errorMsg}`);

    tracker.endRun('failure', stats);

    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - startTime);
    printSummary(logger, stats);

    logger.close();

    return { success: false, stats, error: errorMsg };
  }
}

module.exports = { runFreescoutSync };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');

  runPipelineCli(runFreescoutSync({ verbose, force }));
}
