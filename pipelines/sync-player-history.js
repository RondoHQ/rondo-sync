require('dotenv/config');

const { createSyncLogger } = require('../lib/logger');
const { formatDuration, formatTimestamp } = require('../lib/utils');
const { RunTracker } = require('../lib/run-tracker');
const { runSync: runPlayerHistorySync } = require('../steps/submit-rondo-club-player-history');

function printSummary(logger, stats) {
  const divider = '========================================';
  const minorDivider = '----------------------------------------';

  logger.log('');
  logger.log(divider);
  logger.log('PLAYER HISTORY SYNC SUMMARY');
  logger.log(divider);
  logger.log('');
  logger.log(`Completed: ${stats.completedAt}`);
  logger.log(`Duration: ${stats.duration}`);
  logger.log('');

  logger.log('MEMBERSHIP DOWNLOAD + SYNC');
  logger.log(minorDivider);
  logger.log(`Members processed: ${stats.history.total}`);
  logger.log(`Membership pages fetched: ${stats.history.downloaded}`);
  logger.log(`Members updated: ${stats.history.synced}`);
  logger.log(`Work history rows created: ${stats.history.created}`);
  if (stats.history.skippedNoTeamMatch > 0) {
    logger.log(`Skipped (unknown team mapping): ${stats.history.skippedNoTeamMatch}`);
  }
  if (stats.history.skippedDuplicate > 0) {
    logger.log(`Skipped (already exists): ${stats.history.skippedDuplicate}`);
  }
  logger.log('');

  if (stats.history.errors.length > 0) {
    logger.log(`ERRORS (${stats.history.errors.length})`);
    logger.log(minorDivider);
    for (const error of stats.history.errors) {
      logger.log(`- ${error.knvb_id || 'system'}: ${error.message}`);
    }
    logger.log('');
  }

  logger.log(divider);
}

async function runPlayerHistoryPipeline(options = {}) {
  const { verbose = false } = options;
  const logger = createSyncLogger({ verbose, prefix: 'player-history' });
  const tracker = new RunTracker('player-history');
  tracker.startRun();
  const start = Date.now();

  const stats = {
    completedAt: '',
    duration: '',
    history: {
      total: 0,
      downloaded: 0,
      synced: 0,
      created: 0,
      skippedNoTeamMatch: 0,
      skippedDuplicate: 0,
      errors: []
    }
  };

  try {
    const stepId = tracker.startStep('player-history-sync');
    try {
      const res = await runPlayerHistorySync({ verbose, logger });
      stats.history.total = res.total || 0;
      stats.history.downloaded = res.downloaded || 0;
      stats.history.synced = res.synced || 0;
      stats.history.created = res.created || 0;
      stats.history.skippedNoTeamMatch = res.skippedNoTeamMatch || 0;
      stats.history.skippedDuplicate = res.skippedDuplicate || 0;
      stats.history.errors = res.errors || [];

      tracker.endStep(stepId, {
        outcome: res.success ? 'success' : 'failure',
        created: stats.history.created,
        updated: stats.history.synced,
        skipped: stats.history.skippedDuplicate,
        failed: stats.history.errors.length
      });
      tracker.recordErrors('player-history-sync', stepId, stats.history.errors);
    } catch (err) {
      stats.history.errors.push({ message: err.message });
      tracker.endStep(stepId, { outcome: 'failure', failed: 1 });
      tracker.recordError({
        stepName: 'player-history-sync',
        stepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - start);
    const success = stats.history.errors.length === 0;
    tracker.endRun(success ? 'success' : 'partial', stats);

    printSummary(logger, stats);
    logger.log(`Log file: ${logger.getLogPath()}`);
    logger.close();

    return { success, stats };
  } catch (err) {
    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - start);
    tracker.endRun('failure', stats);
    printSummary(logger, stats);
    logger.close();
    return { success: false, stats, error: err.message };
  }
}

module.exports = { runPlayerHistoryPipeline };

if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  runPlayerHistoryPipeline({ verbose })
    .then((result) => {
      if (!result.success) process.exitCode = 1;
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
