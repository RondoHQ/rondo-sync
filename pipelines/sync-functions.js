require('dotenv/config');

const { createSyncLogger } = require('../lib/logger');
const { formatDuration, formatTimestamp } = require('../lib/utils');
const { RunTracker } = require('../lib/run-tracker');
const { runFunctionsDownload } = require('../steps/download-functions-from-sportlink');
const { runSync: runCommissiesSync } = require('../steps/submit-rondo-club-commissies');
const { runSync: runCommissieWorkHistorySync } = require('../steps/submit-rondo-club-commissie-work-history');
const { runSyncFreeFieldsToRondoClub } = require('../steps/sync-free-fields-to-rondo-club');
const { runCapabilitySync } = require('../steps/submit-capability-sync');

/**
 * Print summary report for functions sync
 */
function printSummary(logger, stats) {
  const divider = '========================================';
  const minorDivider = '----------------------------------------';

  logger.log('');
  logger.log(divider);
  logger.log('FUNCTIONS SYNC SUMMARY');
  logger.log(divider);
  logger.log('');
  logger.log(`Completed: ${stats.completedAt}`);
  logger.log(`Duration: ${stats.duration}`);
  logger.log('');

  logger.log('FUNCTIONS DOWNLOAD');
  logger.log(minorDivider);
  logger.log(`Members processed: ${stats.download.total}`);
  logger.log(`Functions found: ${stats.download.functionsCount}`);
  logger.log(`Committee memberships found: ${stats.download.committeesCount}`);
  logger.log('');

  logger.log('COMMISSIES SYNC TO RONDO CLUB');
  logger.log(minorDivider);
  if (stats.commissies.total > 0) {
    logger.log(`Commissies synced: ${stats.commissies.synced}/${stats.commissies.total}`);
    if (stats.commissies.created > 0) {
      logger.log(`  Created: ${stats.commissies.created}`);
    }
    if (stats.commissies.updated > 0) {
      logger.log(`  Updated: ${stats.commissies.updated}`);
    }
    if (stats.commissies.skipped > 0) {
      logger.log(`  Skipped: ${stats.commissies.skipped} (unchanged)`);
    }
    if (stats.commissies.deleted > 0) {
      logger.log(`  Deleted: ${stats.commissies.deleted} (orphan commissies)`);
    }
  } else {
    logger.log('Commissies synced: 0 changes');
  }
  logger.log('');

  logger.log('COMMISSIE WORK HISTORY SYNC');
  logger.log(minorDivider);
  if (stats.workHistory.total > 0) {
    logger.log(`Members synced: ${stats.workHistory.synced}/${stats.workHistory.total}`);
    if (stats.workHistory.created > 0) {
      logger.log(`  Work history entries added: ${stats.workHistory.created}`);
    }
    if (stats.workHistory.ended > 0) {
      logger.log(`  Work history entries ended: ${stats.workHistory.ended}`);
    }
    if (stats.workHistory.skipped > 0) {
      logger.log(`  Skipped: ${stats.workHistory.skipped} (not yet in Rondo Club)`);
    }
  } else {
    logger.log('Work history synced: 0 changes');
  }
  logger.log('');

  logger.log('FREE FIELDS SYNC (VOG, FREESCOUT ID, FINANCIAL BLOCK)');
  logger.log(minorDivider);
  if (stats.freeFields.total > 0) {
    logger.log(`Members processed: ${stats.freeFields.total}`);
    logger.log(`  Synced: ${stats.freeFields.synced}`);
    if (stats.freeFields.skipped > 0) {
      logger.log(`  Skipped: ${stats.freeFields.skipped} (unchanged)`);
    }
  } else {
    logger.log('Free fields synced: 0 changes');
  }
  logger.log('');

  logger.log('CAPABILITY SYNC');
  logger.log(minorDivider);
  if (stats.capabilitySync.total > 0) {
    logger.log(`Members processed: ${stats.capabilitySync.total}`);
    logger.log(`  Synced: ${stats.capabilitySync.synced}`);
    if (stats.capabilitySync.skipped > 0) {
      logger.log(`  Skipped: ${stats.capabilitySync.skipped} (no WP user)`);
    }
  } else {
    logger.log('Capability sync: 0 changes');
  }
  logger.log('');

  const allErrors = [
    ...stats.download.errors,
    ...stats.commissies.errors,
    ...stats.workHistory.errors,
    ...stats.freeFields.errors,
    ...stats.capabilitySync.errors
  ];
  if (allErrors.length > 0) {
    logger.log(`ERRORS (${allErrors.length})`);
    logger.log(minorDivider);
    allErrors.forEach(error => {
      const identifier = error.knvb_id || error.commissie_name || 'system';
      const system = error.system ? ` [${error.system}]` : '';
      logger.log(`- ${identifier}${system}: ${error.message}`);
    });
    logger.log('');
  }

  logger.log(divider);
}

/**
 * Run functions sync pipeline
 * - Download functions and committees from Sportlink
 * - Sync commissies to Rondo Club
 * - Sync commissie work history
 *
 * Daily: processes only members with recent updates (recentOnly=true)
 * Weekly: full sync of all tracked members (recentOnly=false with --all flag)
 */
async function runFunctionsSync(options = {}) {
  const { verbose = false, force = false, withInvoice = false, all = false, days = 2 } = options;

  const logger = createSyncLogger({ verbose, prefix: 'functions' });
  const startTime = Date.now();

  const tracker = new RunTracker(all ? 'functions-full' : 'functions');
  tracker.startRun();

  const stats = {
    completedAt: '',
    duration: '',
    download: {
      total: 0,
      functionsCount: 0,
      committeesCount: 0,
      errors: []
    },
    commissies: {
      total: 0,
      synced: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      deleted: 0,
      errors: []
    },
    workHistory: {
      total: 0,
      synced: 0,
      created: 0,
      ended: 0,
      skipped: 0,
      errors: []
    },
    freeFields: {
      total: 0,
      synced: 0,
      skipped: 0,
      errors: []
    },
    capabilitySync: {
      total: 0,
      synced: 0,
      skipped: 0,
      errors: []
    }
  };

  try {
    // Step 1: Download functions from Sportlink
    const syncMode = all ? 'full sync' : 'recent updates';
    logger.verbose(`Downloading functions from Sportlink (${syncMode})...`);
    const downloadStepId = tracker.startStep('functions-download');
    try {
      const downloadResult = await runFunctionsDownload({ logger, verbose, withInvoice, recentOnly: !all, days });
      stats.download.total = downloadResult.total || 0;
      stats.download.functionsCount = downloadResult.functionsCount || 0;
      stats.download.committeesCount = downloadResult.committeesCount || 0;
      if (!downloadResult.success) {
        stats.download.errors.push({
          message: downloadResult.error || 'Unknown error',
          system: 'functions-download'
        });
      }
      if (downloadResult.errors?.length > 0) {
        stats.download.errors.push(...downloadResult.errors.map(e => ({
          knvb_id: e.knvb_id,
          message: e.message,
          system: 'functions-download'
        })));
      }
      tracker.endStep(downloadStepId, {
        outcome: downloadResult.success ? 'success' : 'failure',
        created: stats.download.total,
        failed: stats.download.errors.length
      });
      tracker.recordErrors('functions-download', downloadStepId, stats.download.errors);
    } catch (err) {
      logger.error(`Functions download failed: ${err.message}`);
      stats.download.errors.push({
        message: `Functions download failed: ${err.message}`,
        system: 'functions-download'
      });
      tracker.endStep(downloadStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'functions-download',
        stepId: downloadStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Step 2: Sync commissies to Rondo Club
    logger.verbose('Syncing commissies to Rondo Club...');
    const commissieStepId = tracker.startStep('commissie-sync');
    try {
      // Pass enableOrphanDetection flag instead of stale currentCommissieNames
      // The sync function will get fresh commissie names AFTER updating tracking table
      const commissieResult = await runCommissiesSync({ logger, verbose, force, enableOrphanDetection: true });
      stats.commissies.total = commissieResult.total;
      stats.commissies.synced = commissieResult.synced;
      stats.commissies.created = commissieResult.created;
      stats.commissies.updated = commissieResult.updated;
      stats.commissies.skipped = commissieResult.skipped;
      stats.commissies.deleted = commissieResult.deleted || 0;
      if (commissieResult.errors?.length > 0) {
        stats.commissies.errors = commissieResult.errors.map(e => ({
          commissie_name: e.commissie_name,
          message: e.message,
          system: 'commissie-sync'
        }));
      }
      tracker.endStep(commissieStepId, {
        outcome: 'success',
        created: stats.commissies.created,
        updated: stats.commissies.updated,
        skipped: stats.commissies.skipped,
        failed: stats.commissies.errors.length
      });
      tracker.recordErrors('commissie-sync', commissieStepId, stats.commissies.errors);
    } catch (err) {
      logger.error(`Commissie sync failed: ${err.message}`);
      stats.commissies.errors.push({
        message: `Commissie sync failed: ${err.message}`,
        system: 'commissie-sync'
      });
      tracker.endStep(commissieStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'commissie-sync',
        stepId: commissieStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Step 3: Sync commissie work history
    logger.verbose('Syncing commissie work history to Rondo Club...');
    const workHistoryStepId = tracker.startStep('commissie-work-history-sync');
    try {
      const workHistoryResult = await runCommissieWorkHistorySync({ logger, verbose, force });
      stats.workHistory.total = workHistoryResult.total;
      stats.workHistory.synced = workHistoryResult.synced;
      stats.workHistory.created = workHistoryResult.created;
      stats.workHistory.ended = workHistoryResult.ended;
      stats.workHistory.skipped = workHistoryResult.skipped;
      if (workHistoryResult.errors?.length > 0) {
        stats.workHistory.errors = workHistoryResult.errors.map(e => ({
          knvb_id: e.knvb_id,
          message: e.message,
          system: 'commissie-work-history-sync'
        }));
      }
      tracker.endStep(workHistoryStepId, {
        outcome: 'success',
        created: stats.workHistory.created,
        updated: stats.workHistory.ended,
        skipped: stats.workHistory.skipped,
        failed: stats.workHistory.errors.length
      });
      tracker.recordErrors('commissie-work-history-sync', workHistoryStepId, stats.workHistory.errors);
    } catch (err) {
      logger.error(`Commissie work history sync failed: ${err.message}`);
      stats.workHistory.errors.push({
        message: `Commissie work history sync failed: ${err.message}`,
        system: 'commissie-work-history-sync'
      });
      tracker.endStep(workHistoryStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'commissie-work-history-sync',
        stepId: workHistoryStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Step 4: Sync free fields (VOG, FreeScout ID, financial block) to person records
    logger.verbose('Syncing free fields to Rondo Club person records...');
    const freeFieldsStepId = tracker.startStep('free-fields-sync');
    try {
      const freeFieldsResult = await runSyncFreeFieldsToRondoClub({ logger, verbose, force });
      stats.freeFields.total = freeFieldsResult.total;
      stats.freeFields.synced = freeFieldsResult.synced;
      stats.freeFields.skipped = freeFieldsResult.skipped;
      if (freeFieldsResult.errors?.length > 0) {
        stats.freeFields.errors = freeFieldsResult.errors.map(e => ({
          knvb_id: e.knvb_id,
          message: e.message,
          system: 'free-fields-sync'
        }));
      }
      tracker.endStep(freeFieldsStepId, {
        outcome: 'success',
        updated: stats.freeFields.synced,
        skipped: stats.freeFields.skipped,
        failed: stats.freeFields.errors.length
      });
      tracker.recordErrors('free-fields-sync', freeFieldsStepId, stats.freeFields.errors);
    } catch (err) {
      logger.error(`Free fields sync failed: ${err.message}`);
      stats.freeFields.errors.push({
        message: `Free fields sync failed: ${err.message}`,
        system: 'free-fields-sync'
      });
      tracker.endStep(freeFieldsStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'free-fields-sync',
        stepId: freeFieldsStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Step 5: Sync capabilities (Functies -> WP roles) for all tracked members
    logger.verbose('Syncing capabilities for tracked members...');
    const capabilitySyncStepId = tracker.startStep('capability-sync');
    try {
      const capabilityResult = await runCapabilitySync({ logger, verbose });
      stats.capabilitySync.total = capabilityResult.total;
      stats.capabilitySync.synced = capabilityResult.synced;
      stats.capabilitySync.skipped = capabilityResult.skipped;
      if (capabilityResult.errors?.length > 0) {
        stats.capabilitySync.errors = capabilityResult.errors.map(e => ({
          knvb_id: e.knvb_id,
          message: e.message,
          system: 'capability-sync'
        }));
      }
      tracker.endStep(capabilitySyncStepId, {
        outcome: capabilityResult.success ? 'success' : 'partial',
        updated: stats.capabilitySync.synced,
        skipped: stats.capabilitySync.skipped,
        failed: stats.capabilitySync.errors.length
      });
      tracker.recordErrors('capability-sync', capabilitySyncStepId, stats.capabilitySync.errors);
    } catch (err) {
      logger.error(`Capability sync failed: ${err.message}`);
      stats.capabilitySync.errors.push({
        message: `Capability sync failed: ${err.message}`,
        system: 'capability-sync'
      });
      tracker.endStep(capabilitySyncStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'capability-sync',
        stepId: capabilitySyncStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Complete
    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - startTime);

    const totalErrors = stats.download.errors.length + stats.commissies.errors.length + stats.workHistory.errors.length + stats.freeFields.errors.length + stats.capabilitySync.errors.length;
    const success = totalErrors === 0;
    const outcome = totalErrors === 0 ? 'success' : 'partial';

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

module.exports = { runFunctionsSync };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');
  const withInvoice = process.argv.includes('--with-invoice');
  const all = process.argv.includes('--all');
  const daysIdx = process.argv.indexOf('--days');
  const days = daysIdx !== -1 ? parseInt(process.argv[daysIdx + 1], 10) || 2 : 2;

  runFunctionsSync({ verbose, force, withInvoice, all, days })
    .then(result => {
      if (!result.success) {
        process.exitCode = 1;
      }
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
