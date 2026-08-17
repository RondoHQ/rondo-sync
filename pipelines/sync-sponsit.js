require('dotenv/config');

const { createSyncLogger } = require('../lib/logger');
const { formatDuration, formatTimestamp, parseCliArgs } = require('../lib/utils');
const { RunTracker } = require('../lib/run-tracker');
const { runPipelineCli } = require('../lib/pipeline-cli');
const { runSponsitDownload } = require('../steps/download-sponsit-contacts');
const { runSponsitRondoSync } = require('../steps/sync-sponsit-to-rondo-club');
const { runSponsitLapostaSync } = require('../steps/sync-sponsit-to-laposta');

function printSummary(logger, stats) {
  logger.section('Sponsit sync summary');
  logger.log(`Completed: ${stats.completedAt}`);
  logger.log(`Duration: ${stats.duration}`);
  logger.log(`Contacts stored: ${stats.download.contacts}`);
  logger.log(`Current sponsors: ${stats.download.activeSponsors}`);
  logger.log(`Contact people: ${stats.download.people}`);
  logger.log(`Rondo Club: ${stats.rondoClub.companiesCreated} companies created, ${stats.rondoClub.companiesUpdated} updated, ${stats.rondoClub.companiesArchived} archived; ${stats.rondoClub.peopleCreated} people created, ${stats.rondoClub.peopleUpdated} updated`);
  logger.log(`Laposta: ${stats.laposta.created} created, ${stats.laposta.updated} updated, ${stats.laposta.unsubscribed} unsubscribed, ${stats.laposta.unchanged} unchanged, ${stats.laposta.skippedOptOut} opted out`);
  logger.log(`Quarantined: ${stats.laposta.quarantined}`);
  if (stats.errors.length) logger.log(`Errors: ${stats.errors.length}`);
}

async function runSponsitSync(options = {}) {
  const { verbose = false } = options;
  const logger = createSyncLogger({ verbose, prefix: 'sponsit' });
  const tracker = new RunTracker('sponsit');
  const startedAt = Date.now();
  const stats = {
    completedAt: '',
    duration: '',
    download: {
      contacts: 0,
      activeSponsors: 0,
      people: 0,
      rondoCandidates: 0
    },
    rondoClub: {
      companies: 0,
      people: 0,
      relations: 0,
      companiesCreated: 0,
      companiesUpdated: 0,
      companiesArchived: 0,
      peopleCreated: 0,
      peopleUpdated: 0,
      unchanged: 0,
      quarantined: 0
    },
    laposta: {
      candidates: 0,
      created: 0,
      updated: 0,
      unsubscribed: 0,
      unchanged: 0,
      skippedOptOut: 0,
      quarantined: 0
    },
    errors: []
  };

  tracker.startRun();

  try {
    const downloadStepId = tracker.startStep('sponsit-download');
    const result = await runSponsitDownload({
      logger,
      verbose,
      onProgress: (current, total) => {
        tracker.updateStep(downloadStepId, { current, total, label: 'contacts' });
      }
    });

    stats.download.contacts = result.count || 0;
    stats.download.activeSponsors = result.activeSponsors || 0;
    stats.download.people = result.people || 0;
    stats.download.rondoCandidates = result.rondoCandidates || 0;
    if (!result.success) {
      const error = { message: result.error || 'Unknown Sponsit download error', system: 'sponsit-download' };
      stats.errors.push(error);
      tracker.endStep(downloadStepId, { outcome: 'failure', failed: 1 });
      tracker.recordErrors('sponsit-download', downloadStepId, [error]);
      throw new Error(error.message);
    }

    tracker.endStep(downloadStepId, {
      outcome: 'success',
      created: result.snapshot?.contacts?.created || 0,
      updated: result.snapshot?.contacts?.updated || 0,
      skipped: result.snapshot?.contacts?.unchanged || 0,
      detail: {
        contacts: stats.download.contacts,
        people: stats.download.people,
        activeSponsors: stats.download.activeSponsors,
        rondoCandidates: stats.download.rondoCandidates
      }
    });

    const rondoStepId = tracker.startStep('rondo-club-sync');
    try {
      const rondoResult = await runSponsitRondoSync({ apply: true, verbose });
      const summary = rondoResult.summary || {};
      const applied = rondoResult.applied || {};
      stats.rondoClub = {
        companies: summary.companies || 0,
        people: summary.people || 0,
        relations: summary.relations || 0,
        companiesCreated: applied.companiesCreated || 0,
        companiesUpdated: applied.companiesUpdated || 0,
        companiesArchived: applied.companiesArchived || 0,
        peopleCreated: applied.peopleCreated || 0,
        peopleUpdated: applied.peopleUpdated || 0,
        unchanged: (summary.peopleUnchanged || 0) + (summary.companiesUnchanged || 0),
        quarantined: summary.quarantined || 0
      };
      const errors = applied.errors || [];
      stats.errors.push(...errors.map((error) => ({ ...error, system: 'rondo-club' })));
      tracker.endStep(rondoStepId, {
        outcome: errors.length ? 'failure' : 'success',
        created: stats.rondoClub.companiesCreated + stats.rondoClub.peopleCreated,
        updated: stats.rondoClub.companiesUpdated + stats.rondoClub.companiesArchived + stats.rondoClub.peopleUpdated,
        skipped: stats.rondoClub.unchanged + stats.rondoClub.quarantined,
        failed: errors.length,
        detail: summary
      });
      tracker.recordErrors('rondo-club-sync', rondoStepId, errors);
    } catch (error) {
      const pipelineError = { message: error.message, system: 'rondo-club' };
      stats.errors.push(pipelineError);
      tracker.endStep(rondoStepId, { outcome: 'failure', failed: 1 });
      tracker.recordErrors('rondo-club-sync', rondoStepId, [pipelineError]);
    }

    const lapostaStepId = tracker.startStep('laposta-sync');
    try {
      const lapostaResult = await runSponsitLapostaSync({ apply: true, verbose });
      const summary = lapostaResult.summary || {};
      const errors = lapostaResult.errors || [];
      stats.laposta = {
        candidates: summary.candidates || 0,
        created: summary.create || 0,
        updated: summary.update || 0,
        unsubscribed: summary.unsubscribe || 0,
        unchanged: summary.unchanged || 0,
        skippedOptOut: summary.skipOptOut || 0,
        quarantined: summary.quarantined || 0
      };
      stats.errors.push(...errors.map((error) => ({ ...error, system: 'laposta' })));
      tracker.endStep(lapostaStepId, {
        outcome: errors.length ? 'failure' : 'success',
        created: stats.laposta.created,
        updated: stats.laposta.updated + stats.laposta.unsubscribed,
        skipped: stats.laposta.unchanged + stats.laposta.skippedOptOut + stats.laposta.quarantined,
        failed: errors.length,
        detail: summary
      });
      tracker.recordErrors('laposta-sync', lapostaStepId, errors);
    } catch (error) {
      const pipelineError = { message: error.message, system: 'laposta' };
      stats.errors.push(pipelineError);
      tracker.endStep(lapostaStepId, { outcome: 'failure', failed: 1 });
      tracker.recordErrors('laposta-sync', lapostaStepId, [pipelineError]);
    }

    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - startedAt);
    const success = stats.errors.length === 0;
    tracker.endRun(success ? 'success' : 'partial', stats);
    printSummary(logger, stats);
    logger.log(`Log file: ${logger.getLogPath()}`);
    logger.close();
    return success
      ? { success: true, stats }
      : { success: false, stats, error: stats.errors[0].message };
  } catch (error) {
    if (!stats.errors.some((item) => item.message === error.message)) {
      stats.errors.push({ message: error.message, system: 'sponsit' });
    }
    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - startedAt);
    tracker.endRun('failure', stats);
    logger.error(`Fatal Sponsit sync error: ${error.message}`);
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
