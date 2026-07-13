require('dotenv/config');

const { createSyncLogger } = require('../lib/logger');
const { formatDuration, formatTimestamp, parseCliArgs } = require('../lib/utils');
const { RunTracker } = require('../lib/run-tracker');
const { runPipelineCli } = require('../lib/pipeline-cli');
const { runSponsitDownload } = require('../steps/download-sponsit-contacts');

function printSummary(logger, stats) {
  logger.section('Sponsit contact import summary');
  logger.log(`Completed: ${stats.completedAt}`);
  logger.log(`Duration: ${stats.duration}`);
  logger.log(`Contacts stored: ${stats.contacts}`);
  logger.log(`Current sponsors: ${stats.activeSponsors}`);
  logger.log(`Contact people: ${stats.people}`);
  logger.log(`Proposed Rondo sponsor records: ${stats.rondoCandidates}`);
  if (stats.errors.length) logger.log(`Errors: ${stats.errors.length}`);
  logger.log('Rondo writes: disabled (read-only import)');
}

async function runSponsitSync(options = {}) {
  const { verbose = false } = options;
  const logger = createSyncLogger({ verbose, prefix: 'sponsit' });
  const tracker = new RunTracker('sponsit');
  const startedAt = Date.now();
  const stats = {
    completedAt: '',
    duration: '',
    contacts: 0,
    activeSponsors: 0,
    people: 0,
    rondoCandidates: 0,
    errors: []
  };

  tracker.startRun();
  const stepId = tracker.startStep('sponsit-download');

  try {
    const result = await runSponsitDownload({
      logger,
      verbose,
      onProgress: (current, total) => {
        tracker.updateStep(stepId, { current, total, label: 'contacts' });
      }
    });

    stats.contacts = result.count || 0;
    stats.activeSponsors = result.activeSponsors || 0;
    stats.people = result.people || 0;
    stats.rondoCandidates = result.rondoCandidates || 0;
    if (!result.success) {
      stats.errors.push({
        message: result.error || 'Unknown Sponsit download error',
        system: 'sponsit-download'
      });
    }

    tracker.endStep(stepId, {
      outcome: result.success ? 'success' : 'failure',
      created: result.snapshot?.contacts?.created || 0,
      updated: result.snapshot?.contacts?.updated || 0,
      skipped: result.snapshot?.contacts?.unchanged || 0,
      failed: stats.errors.length,
      detail: {
        contacts: stats.contacts,
        people: stats.people,
        activeSponsors: stats.activeSponsors,
        rondoCandidates: stats.rondoCandidates
      }
    });
    tracker.recordErrors('sponsit-download', stepId, stats.errors);

    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - startedAt);
    const success = stats.errors.length === 0;
    tracker.endRun(success ? 'success' : 'failure', stats);
    printSummary(logger, stats);
    logger.log(`Log file: ${logger.getLogPath()}`);
    logger.close();
    return success
      ? { success: true, stats }
      : { success: false, stats, error: stats.errors[0].message };
  } catch (error) {
    stats.errors.push({ message: error.message, system: 'sponsit-download' });
    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - startedAt);
    tracker.endStep(stepId, { outcome: 'failure', failed: 1 });
    tracker.recordError({
      stepName: 'sponsit-download',
      stepId,
      errorMessage: error.message,
      errorStack: error.stack
    });
    tracker.endRun('failure', stats);
    logger.error(`Fatal Sponsit import error: ${error.message}`);
    printSummary(logger, stats);
    logger.close();
    return { success: false, stats, error: error.message };
  }
}

module.exports = { runSponsitSync };

if (require.main === module) {
  const { verbose } = parseCliArgs();
  runPipelineCli(runSponsitSync({ verbose }));
}
