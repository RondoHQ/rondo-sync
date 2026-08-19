require('dotenv/config');

const { createSyncLogger } = require('../lib/logger');
const { formatDuration, formatTimestamp } = require('../lib/utils');
const { RunTracker } = require('../lib/run-tracker');
const { runPipelineCli } = require('../lib/pipeline-cli');
const { runTeamDownload } = require('../steps/download-teams-from-sportlink');
const { runSync: runTeamSync } = require('../steps/submit-rondo-club-teams');
const { runSync: runWorkHistorySync } = require('../steps/submit-rondo-club-work-history');
const { runSync: runPlayerHistorySync } = require('../steps/submit-rondo-club-player-history');

/**
 * Print summary report for team sync
 */
function printSummary(logger, stats) {
  const divider = '========================================';
  const minorDivider = '----------------------------------------';

  logger.log('');
  logger.log(divider);
  logger.log('TEAM SYNC SUMMARY');
  logger.log(divider);
  logger.log('');
  logger.log(`Completed: ${stats.completedAt}`);
  logger.log(`Duration: ${stats.duration}`);
  logger.log('');

  logger.log('TEAM DOWNLOAD');
  logger.log(minorDivider);
  logger.log(`Teams downloaded: ${stats.download.teamCount}`);
  logger.log(`Team members downloaded: ${stats.download.memberCount}`);
  logger.log('');

  logger.log('TEAM SYNC TO RONDO CLUB');
  logger.log(minorDivider);
  if (stats.teams.total > 0) {
    logger.log(`Teams synced: ${stats.teams.synced}/${stats.teams.total}`);
    if (stats.teams.created > 0) {
      logger.log(`  Created: ${stats.teams.created}`);
    }
    if (stats.teams.updated > 0) {
      logger.log(`  Updated: ${stats.teams.updated}`);
    }
    if (stats.teams.skipped > 0) {
      logger.log(`  Skipped: ${stats.teams.skipped} (unchanged)`);
    }
  } else {
    logger.log('Teams synced: 0 changes');
  }
  logger.log('');

  logger.log('WORK HISTORY SYNC');
  logger.log(minorDivider);
  if (stats.workHistory.total > 0) {
    logger.log(`Members synced: ${stats.workHistory.synced}/${stats.workHistory.total}`);
    if (stats.workHistory.created > 0) {
      logger.log(`  Team assignments added: ${stats.workHistory.created}`);
    }
    if (stats.workHistory.ended > 0) {
      logger.log(`  Team assignments ended: ${stats.workHistory.ended}`);
    }
    if (stats.workHistory.skipped > 0) {
      logger.log(`  Skipped: ${stats.workHistory.skipped} (not yet in Rondo Club)`);
    }
  } else {
    logger.log('Work history synced: 0 changes');
  }
  logger.log('');

  logger.log('PLAYER HISTORY DETAIL SYNC');
  logger.log(minorDivider);
  logger.log(`Sportlink details fetched: ${stats.playerHistory.downloaded}/${stats.playerHistory.total}`);
  logger.log(`Members updated: ${stats.playerHistory.synced}`);
  if (stats.playerHistory.created > 0) {
    logger.log(`  Work history rows created: ${stats.playerHistory.created}`);
  }
  if (stats.playerHistory.reconciled > 0) {
    logger.log(`  Work history rows reconciled: ${stats.playerHistory.reconciled}`);
  }
  if (stats.playerHistory.skippedUnchanged > 0) {
    logger.log(`  Skipped: ${stats.playerHistory.skippedUnchanged} (team data unchanged)`);
  }
  if (stats.playerHistory.skippedQuarantined > 0) {
    logger.log(`  Skipped: ${stats.playerHistory.skippedQuarantined} (quarantined)`);
  }
  logger.log('');

  const allErrors = [
    ...stats.download.errors,
    ...stats.teams.errors,
    ...stats.workHistory.errors,
    ...stats.playerHistory.errors
  ];
  if (allErrors.length > 0) {
    logger.log(`ERRORS (${allErrors.length})`);
    logger.log(minorDivider);
    allErrors.forEach(error => {
      const identifier = error.knvb_id || error.team_name || 'system';
      const system = error.system ? ` [${error.system}]` : '';
      logger.log(`- ${identifier}${system}: ${error.message}`);
    });
    logger.log('');
  }

  logger.log(divider);
}

/**
 * Run team sync pipeline (weekly)
 * - Download teams from Sportlink (with player/staff roles)
 * - Sync teams to Rondo Club
 * - Sync work history, then enrich it with Sportlink relation dates
 *
 * Uses cached member data from last people sync (hourly download)
 */
async function runTeamsSync(options = {}) {
  const { verbose = false, force = false } = options;

  const logger = createSyncLogger({ verbose, prefix: 'teams' });
  const startTime = Date.now();

  const tracker = new RunTracker('teams');
  tracker.startRun();

  const stats = {
    completedAt: '',
    duration: '',
    download: {
      teamCount: 0,
      memberCount: 0,
      errors: []
    },
    teams: {
      total: 0,
      synced: 0,
      created: 0,
      updated: 0,
      skipped: 0,
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
    playerHistory: {
      total: 0,
      downloaded: 0,
      synced: 0,
      created: 0,
      reconciled: 0,
      textFallback: 0,
      skippedDuplicate: 0,
      skippedUnchanged: 0,
      skippedQuarantined: 0,
      errors: []
    }
  };

  try {
    // Step 1: Download teams from Sportlink
    logger.verbose('Downloading teams from Sportlink...');
    const downloadStepId = tracker.startStep('team-download');
    try {
      const teamDownloadResult = await runTeamDownload({ logger, verbose });
      stats.download.teamCount = teamDownloadResult.teamCount || 0;
      stats.download.memberCount = teamDownloadResult.memberCount || 0;
      if (!teamDownloadResult.success) {
        stats.download.errors.push({
          message: teamDownloadResult.error || 'Unknown error',
          system: 'team-download'
        });
      }
      tracker.endStep(downloadStepId, {
        outcome: teamDownloadResult.success ? 'success' : 'failure',
        created: stats.download.teamCount,
        failed: stats.download.errors.length
      });
      tracker.recordErrors('team-download', downloadStepId, stats.download.errors);
    } catch (err) {
      logger.error(`Team download failed: ${err.message}`);
      stats.download.errors.push({
        message: `Team download failed: ${err.message}`,
        system: 'team-download'
      });
      tracker.endStep(downloadStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'team-download',
        stepId: downloadStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Step 2: Sync teams to Rondo Club
    logger.verbose('Syncing teams to Rondo Club...');
    const teamSyncStepId = tracker.startStep('team-sync');
    try {
      // Get sportlink IDs for orphan detection (teams we just downloaded)
      const { openDb, getAllTeamsForSync } = require('../lib/rondo-club-db');
      const db = openDb();
      const allTeams = getAllTeamsForSync(db);
      const currentSportlinkIds = allTeams.filter(t => t.sportlink_id).map(t => t.sportlink_id);
      db.close();

      const teamResult = await runTeamSync({ logger, verbose, force, currentSportlinkIds });
      stats.teams.total = teamResult.total;
      stats.teams.synced = teamResult.synced;
      stats.teams.created = teamResult.created;
      stats.teams.updated = teamResult.updated;
      stats.teams.skipped = teamResult.skipped;
      stats.teams.deleted = teamResult.deleted || 0;
      if (teamResult.errors?.length > 0) {
        stats.teams.errors = teamResult.errors.map(e => ({
          team_name: e.team_name,
          message: e.message,
          system: 'team-sync'
        }));
      }
      tracker.endStep(teamSyncStepId, {
        outcome: 'success',
        created: stats.teams.created,
        updated: stats.teams.updated,
        skipped: stats.teams.skipped,
        failed: stats.teams.errors.length
      });
      tracker.recordErrors('team-sync', teamSyncStepId, stats.teams.errors);
    } catch (err) {
      logger.error(`Team sync failed: ${err.message}`);
      stats.teams.errors.push({
        message: `Team sync failed: ${err.message}`,
        system: 'team-sync'
      });
      tracker.endStep(teamSyncStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'team-sync',
        stepId: teamSyncStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Step 3: Sync work history
    logger.verbose('Syncing work history to Rondo Club...');
    const workHistoryStepId = tracker.startStep('work-history-sync');
    try {
      const workHistoryResult = await runWorkHistorySync({ logger, verbose, force });
      stats.workHistory.total = workHistoryResult.total;
      stats.workHistory.synced = workHistoryResult.synced;
      stats.workHistory.created = workHistoryResult.created;
      stats.workHistory.ended = workHistoryResult.ended;
      stats.workHistory.skipped = workHistoryResult.skipped;
      if (workHistoryResult.errors?.length > 0) {
        stats.workHistory.errors = workHistoryResult.errors.map(e => ({
          knvb_id: e.knvb_id,
          message: e.message,
          system: 'work-history-sync'
        }));
      }
      tracker.endStep(workHistoryStepId, {
        outcome: 'success',
        created: stats.workHistory.created,
        updated: stats.workHistory.ended,
        skipped: stats.workHistory.skipped,
        failed: stats.workHistory.errors.length
      });
      tracker.recordErrors('work-history-sync', workHistoryStepId, stats.workHistory.errors);
    } catch (err) {
      logger.error(`Work history sync failed: ${err.message}`);
      stats.workHistory.errors.push({
        message: `Work history sync failed: ${err.message}`,
        system: 'work-history-sync'
      });
      tracker.endStep(workHistoryStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'work-history-sync',
        stepId: workHistoryStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Step 4: Enrich work history with RelationStart/RelationEnd from member details.
    // The fast team-roster endpoint does not include these dates.
    logger.verbose('Syncing dated player history to Rondo Club...');
    const playerHistoryStepId = tracker.startStep('player-history-sync');
    try {
      const playerHistoryResult = await runPlayerHistorySync({ logger, verbose, force });
      stats.playerHistory = {
        total: playerHistoryResult.total,
        downloaded: playerHistoryResult.downloaded,
        synced: playerHistoryResult.synced,
        created: playerHistoryResult.created,
        reconciled: playerHistoryResult.reconciled,
        textFallback: playerHistoryResult.textFallback,
        skippedDuplicate: playerHistoryResult.skippedDuplicate,
        skippedUnchanged: playerHistoryResult.skippedUnchanged,
        skippedQuarantined: playerHistoryResult.skippedQuarantined,
        errors: (playerHistoryResult.errors || []).map(error => ({
          knvb_id: error.knvb_id,
          message: error.message,
          system: 'player-history-sync'
        }))
      };
      tracker.endStep(playerHistoryStepId, {
        outcome: stats.playerHistory.errors.length === 0 ? 'success' : 'partial',
        created: stats.playerHistory.created,
        updated: stats.playerHistory.reconciled,
        skipped: stats.playerHistory.skippedUnchanged + stats.playerHistory.skippedQuarantined,
        failed: stats.playerHistory.errors.length
      });
      tracker.recordErrors('player-history-sync', playerHistoryStepId, stats.playerHistory.errors);
    } catch (err) {
      logger.error(`Player history detail sync failed: ${err.message}`);
      stats.playerHistory.errors.push({
        message: `Player history detail sync failed: ${err.message}`,
        system: 'player-history-sync'
      });
      tracker.endStep(playerHistoryStepId, { outcome: 'failure' });
      tracker.recordError({
        stepName: 'player-history-sync',
        stepId: playerHistoryStepId,
        errorMessage: err.message,
        errorStack: err.stack
      });
    }

    // Complete
    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - startTime);

    const totalErrors = stats.download.errors.length + stats.teams.errors.length + stats.workHistory.errors.length + stats.playerHistory.errors.length;
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

module.exports = { runTeamsSync };

// CLI entry point
if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');

  runPipelineCli(runTeamsSync({ verbose, force }));
}
