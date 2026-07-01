require('dotenv/config');

const { createSyncLogger } = require('../lib/logger');
const { formatDuration, formatTimestamp } = require('../lib/utils');
const { RunTracker } = require('../lib/run-tracker');
const { runPipelineCli } = require('../lib/pipeline-cli');
const { runDownloadConversations } = require('../steps/download-freescout-conversations');
const { runPrepareActivities } = require('../steps/prepare-freescout-activities');
const { runSubmitActivities } = require('../steps/submit-freescout-activities');
const { checkCredentials: checkFreescoutCredentials } = require('../lib/freescout-client');

/**
 * Print summary report for FreeScout conversations sync
 */
function printSummary(logger, stats) {
  const divider = '========================================';
  const minorDivider = '----------------------------------------';

  logger.log('');
  logger.log(divider);
  logger.log('FREESCOUT CONVERSATIONS SYNC SUMMARY');
  logger.log(divider);
  logger.log('');
  logger.log(`Completed: ${stats.completedAt}`);
  logger.log(`Duration: ${stats.duration}`);
  logger.log('');

  logger.log('CONVERSATION DOWNLOAD');
  logger.log(minorDivider);
  logger.log(`Customers processed: ${stats.download.totalCustomers}`);
  logger.log(`Conversations found: ${stats.download.totalConversations}`);
  if (stats.download.newConversations > 0) {
    logger.log(`  New conversations: ${stats.download.newConversations}`);
  }
  if (stats.download.errors.length > 0) {
    logger.log(`  Errors: ${stats.download.errors.length}`);
  }
  logger.log('');

  logger.log('ACTIVITY PREPARATION');
  logger.log(minorDivider);
  logger.log(`Total conversations: ${stats.prepare.total}`);
  logger.log(`Activities prepared: ${stats.prepare.prepared}`);
  if (stats.prepare.skipped > 0) {
    logger.log(`  Skipped (no Rondo Club ID): ${stats.prepare.skipped}`);
  }
  logger.log('');

  logger.log('ACTIVITY SUBMISSION');
  logger.log(minorDivider);
  logger.log(`Total activities: ${stats.submit.total}`);
  logger.log(`Created: ${stats.submit.created}`);
  if (stats.submit.skipped > 0) {
    logger.log(`  Skipped (already synced): ${stats.submit.skipped}`);
  }
  if (stats.submit.failed > 0) {
    logger.log(`  Failed: ${stats.submit.failed}`);
  }
  logger.log('');

  // Errors section
  const allErrors = [...stats.download.errors, ...stats.submit.errors];
  if (allErrors.length > 0) {
    logger.log('ERRORS');
    logger.log(minorDivider);
    allErrors.slice(0, 10).forEach(err => {
      logger.log(`- ${err.message}`);
      if (err.conversationId) {
        logger.log(`  Conversation ID: ${err.conversationId}`);
      }
    });
    if (allErrors.length > 10) {
      logger.log(`... and ${allErrors.length - 10} more errors`);
    }
    logger.log('');
  }

  logger.log(divider);
}

/**
 * Run FreeScout conversations sync pipeline
 * - Download conversations from FreeScout
 * - Prepare activity payloads
 * - Submit to Rondo Club Activities API
 */
async function runFreescoutConversationsSync(options = {}) {
  const { verbose = false, force = false } = options;

  const logger = createSyncLogger({ verbose, prefix: 'freescout-conversations' });
  const startTime = Date.now();

  const tracker = new RunTracker('freescout-conversations');
  tracker.startRun();

  const stats = {
    completedAt: '',
    duration: '',
    download: {
      totalCustomers: 0,
      totalConversations: 0,
      newConversations: 0,
      errors: []
    },
    prepare: {
      total: 0,
      prepared: 0,
      skipped: 0
    },
    submit: {
      total: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      errors: []
    }
  };

  try {
    // Check FreeScout credentials
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

    // Step 1: Download conversations
    logger.log('Downloading FreeScout conversations');
    const downloadStepId = tracker.startStep('conversations-download');
    try {
      const downloadResult = await runDownloadConversations({ logger, verbose, force });
      stats.download.totalCustomers = downloadResult.totalCustomers || 0;
      stats.download.totalConversations = downloadResult.totalConversations || 0;
      stats.download.newConversations = downloadResult.newConversations || 0;
      if (!downloadResult.success) {
        stats.download.errors.push({
          message: 'Download step completed with errors'
        });
      }
      tracker.endStep(downloadStepId, {
        outcome: downloadResult.success ? 'success' : 'partial',
        created: stats.download.totalConversations
      });
    } catch (err) {
      logger.error(`Conversation download failed: ${err.message}`);
      stats.download.errors.push({
        message: `Conversation download failed: ${err.message}`,
        system: 'download'
      });
      tracker.endStep(downloadStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'conversations-download',
        stepId: downloadStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Step 2: Prepare activity payloads
    logger.log('Preparing activity payloads');
    const prepareStepId = tracker.startStep('activities-prepare');
    let prepareResult;
    try {
      prepareResult = await runPrepareActivities({ logger, verbose });
      stats.prepare.total = prepareResult.total || 0;
      stats.prepare.prepared = prepareResult.prepared || 0;
      stats.prepare.skipped = prepareResult.skipped || 0;
      tracker.endStep(prepareStepId, {
        outcome: prepareResult.success ? 'success' : 'failure',
        created: stats.prepare.prepared
      });
      if (!prepareResult.success) {
        throw new Error('Preparation step failed');
      }
    } catch (err) {
      logger.error(`Activity preparation failed: ${err.message}`);
      tracker.endStep(prepareStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'activities-prepare',
        stepId: prepareStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
      // Can't continue without prepared activities
      throw err;
    }

    // Step 3: Submit to Rondo Club
    logger.log('Submitting activities to Rondo Club');
    const submitStepId = tracker.startStep('activities-submit');
    try {
      const submitResult = await runSubmitActivities({
        logger,
        verbose,
        activities: prepareResult.activities
      });
      stats.submit.total = submitResult.total || 0;
      stats.submit.created = submitResult.created || 0;
      stats.submit.skipped = submitResult.skipped || 0;
      stats.submit.failed = submitResult.failed || 0;
      stats.submit.errors = (submitResult.errors || []).map(e => ({
        conversationId: e.conversationId,
        personId: e.personId,
        message: e.message,
        system: 'submit'
      }));
      tracker.endStep(submitStepId, {
        outcome: submitResult.success ? 'success' : 'partial',
        created: stats.submit.created,
        failed: stats.submit.failed
      });
      tracker.recordErrors('activities-submit', submitStepId, stats.submit.errors);
    } catch (err) {
      logger.error(`Activity submission failed: ${err.message}`);
      stats.submit.errors.push({
        message: `Activity submission failed: ${err.message}`,
        system: 'submit'
      });
      tracker.endStep(submitStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'activities-submit',
        stepId: submitStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Complete
    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - startTime);

    const totalErrors = stats.download.errors.length + stats.submit.errors.length;
    const success = totalErrors === 0 && stats.submit.failed === 0;
    const outcome = success ? 'success' : 'partial';

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

module.exports = { runFreescoutConversationsSync };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');

  runPipelineCli(runFreescoutConversationsSync({ verbose, force }));
}
