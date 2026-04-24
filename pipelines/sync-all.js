require('dotenv/config');

const { requireProductionServer } = require('../lib/server-check');
const { createSyncLogger } = require('../lib/logger');
const { formatDuration, formatTimestamp } = require('../lib/utils');
const { RunTracker } = require('../lib/run-tracker');
const { SportlinkSession } = require('../lib/sportlink-session');
const { runDownload } = require('../steps/download-data-from-sportlink');
const { runTeamDownload } = require('../steps/download-teams-from-sportlink');
const { runPrepare } = require('../steps/prepare-laposta-members');
const { runSubmit } = require('../steps/submit-laposta-list');
const { runSync: runRondoClubSync } = require('../steps/submit-rondo-club-sync');
const { runSyncLapostaDeliverabilityTasks } = require('../steps/sync-laposta-deliverability-tasks');
const { runSync: runTeamSync } = require('../steps/submit-rondo-club-teams');
const { runSync: runWorkHistorySync } = require('../steps/submit-rondo-club-work-history');
const { runPhotoDownload } = require('../steps/download-photos-from-api');
const { runPhotoSync } = require('../steps/upload-photos-to-rondo-club');
const { runFunctionsDownload } = require('../steps/download-functions-from-sportlink');
const { runSync: runCommissieSync } = require('../steps/submit-rondo-club-commissies');
const { runSync: runCommissieWorkHistorySync } = require('../steps/submit-rondo-club-commissie-work-history');
const { runSubmit: runFreescoutSubmit } = require('../steps/submit-freescout-sync');
const { checkCredentials: checkFreescoutCredentials } = require('../lib/freescout-client');
const { runFreescoutConversationsSync } = require('./sync-freescout-conversations');
const { runDisciplineSync: runDisciplinePipelineSync } = require('./sync-discipline');
const { openDb } = require('../lib/rondo-club-db');

/**
 * Parse CLI arguments
 * @param {string[]} argv - Process arguments
 * @returns {{ verbose: boolean, force: boolean, dryRun: boolean }}
 */
function parseArgs(argv) {
  return {
    verbose: argv.includes('--verbose'),
    force: argv.includes('--force'),
    dryRun: argv.includes('--dry-run')
  };
}

/**
 * Print summary report
 * @param {Object} logger - Logger instance
 * @param {Object} stats - Collected statistics
 */
function printSummary(logger, stats) {
  const divider = '========================================';
  const minorDivider = '----------------------------------------';

  logger.log('');
  logger.log(divider);
  logger.log('SPORTLINK SYNC SUMMARY');
  logger.log(divider);
  logger.log('');
  logger.log(`Completed: ${stats.completedAt}`);
  logger.log(`Duration: ${stats.duration}`);
  logger.log('');

  logger.log('TOTALS');
  logger.log(minorDivider);
  logger.log(`Members downloaded: ${stats.downloaded}`);
  logger.log(`Members prepared: ${stats.prepared} (${stats.excluded} excluded as duplicates)`);
  logger.log(`Members synced: ${stats.synced} (${stats.added} added, ${stats.updated} updated)`);
  logger.log(`Errors: ${stats.errors.length}`);
  logger.log('');

  logger.log('PER-LIST BREAKDOWN');
  logger.log(minorDivider);
  stats.lists.forEach(list => {
    if (list.listId) {
      logger.log(`List ${list.index}: ${list.total} members, ${list.synced} synced (${list.added} added, ${list.updated} updated)`);
    } else {
      logger.log(`List ${list.index}: not configured`);
    }
  });
  logger.log('');

  logger.log('LAPOSTA DELIVERABILITY');
  logger.log(minorDivider);
  logger.log(`Events scanned: ${stats.lapostaDeliverability.scanned}`);
  logger.log(`Pending events: ${stats.lapostaDeliverability.pending}`);
  logger.log(`Tasks created: ${stats.lapostaDeliverability.created}`);
  if (stats.lapostaDeliverability.unresolved > 0) {
    logger.log(`Unmatched emails: ${stats.lapostaDeliverability.unresolved}`);
  }
  logger.log('');

  logger.log('RONDO CLUB SYNC');
  logger.log(minorDivider);
  logger.log(`Persons synced: ${stats.rondoClub.synced}/${stats.rondoClub.total} (${stats.rondoClub.created} created, ${stats.rondoClub.updated} updated)`);
  logger.log(`Skipped: ${stats.rondoClub.skipped} (unchanged)`);
  if (stats.rondoClub.deleted > 0) {
    logger.log(`Deleted: ${stats.rondoClub.deleted}`);
  }
  logger.log('');

  logger.log('TEAM SYNC');
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

  logger.log('FUNCTIONS & COMMISSIES SYNC');
  logger.log(minorDivider);
  if (stats.functions.total > 0) {
    logger.log(`Functions downloaded: ${stats.functions.downloaded}/${stats.functions.total} members`);
    if (stats.functions.functionsCount > 0) {
      logger.log(`  Club functions found: ${stats.functions.functionsCount}`);
    }
    if (stats.functions.committeesCount > 0) {
      logger.log(`  Committee memberships found: ${stats.functions.committeesCount}`);
    }
  } else {
    logger.log('Functions downloaded: 0 changes');
  }
  if (stats.commissies.total > 0) {
    logger.log(`Commissies synced: ${stats.commissies.synced}/${stats.commissies.total}`);
    if (stats.commissies.created > 0) {
      logger.log(`  Created: ${stats.commissies.created}`);
    }
    if (stats.commissies.updated > 0) {
      logger.log(`  Updated: ${stats.commissies.updated}`);
    }
    if (stats.commissies.deleted > 0) {
      logger.log(`  Deleted: ${stats.commissies.deleted}`);
    }
  } else {
    logger.log('Commissies synced: 0 changes');
  }
  if (stats.commissieWorkHistory.total > 0) {
    logger.log(`Commissie work history: ${stats.commissieWorkHistory.synced}/${stats.commissieWorkHistory.total}`);
    if (stats.commissieWorkHistory.created > 0) {
      logger.log(`  Commissie assignments added: ${stats.commissieWorkHistory.created}`);
    }
    if (stats.commissieWorkHistory.ended > 0) {
      logger.log(`  Commissie assignments ended: ${stats.commissieWorkHistory.ended}`);
    }
    if (stats.commissieWorkHistory.skipped > 0) {
      logger.log(`  Skipped: ${stats.commissieWorkHistory.skipped} (not yet in Rondo Club)`);
    }
  } else {
    logger.log('Commissie work history: 0 changes');
  }
  logger.log('');

  logger.log('PHOTO SYNC');
  logger.log(minorDivider);
  const photoDownloadText = stats.photos.download.total > 0
    ? `${stats.photos.download.downloaded}/${stats.photos.download.total}`
    : '0 changes';
  logger.log(`Photos downloaded: ${photoDownloadText}`);
  if (stats.photos.download.failed > 0) {
    logger.log(`  Failed: ${stats.photos.download.failed}`);
  }

  const photoUploadText = stats.photos.upload.total > 0
    ? `${stats.photos.upload.synced}/${stats.photos.upload.total}`
    : '0 changes';
  logger.log(`Photos uploaded: ${photoUploadText}`);
  if (stats.photos.upload.skipped > 0) {
    logger.log(`  Skipped: ${stats.photos.upload.skipped}`);
  }

  const photoDeleteText = stats.photos.delete.total > 0
    ? `${stats.photos.delete.deleted}/${stats.photos.delete.total}`
    : '0 changes';
  logger.log(`Photos deleted: ${photoDeleteText}`);

  logger.log(`Coverage: ${stats.photos.coverage.members_with_photos} of ${stats.photos.coverage.total_members} members have photos`);
  logger.log('');

  logger.log('FREESCOUT SYNC');
  logger.log(minorDivider);
  if (stats.freescout.total > 0) {
    const freescoutSyncText = `${stats.freescout.synced}/${stats.freescout.total}`;
    logger.log(`Customers synced: ${freescoutSyncText}`);
    if (stats.freescout.created > 0) {
      logger.log(`  Created: ${stats.freescout.created}`);
    }
    if (stats.freescout.updated > 0) {
      logger.log(`  Updated: ${stats.freescout.updated}`);
    }
    if (stats.freescout.skipped > 0) {
      logger.log(`  Skipped: ${stats.freescout.skipped} (unchanged)`);
    }
    if (stats.freescout.deleted > 0) {
      logger.log(`  Deleted: ${stats.freescout.deleted}`);
    }
  } else {
    logger.log('Customers synced: skipped (not configured)');
  }
  logger.log('');

  logger.log('FREESCOUT CONVERSATIONS');
  logger.log(minorDivider);
  if (stats.freescoutConversations.total > 0 || stats.freescoutConversations.created > 0) {
    logger.log(`Activities created: ${stats.freescoutConversations.created}`);
    if (stats.freescoutConversations.skipped > 0) {
      logger.log(`  Skipped: ${stats.freescoutConversations.skipped}`);
    }
    if (stats.freescoutConversations.failed > 0) {
      logger.log(`  Failed: ${stats.freescoutConversations.failed}`);
    }
  } else {
    logger.log('Conversations synced: 0 changes');
  }
  logger.log('');

  logger.log('DISCIPLINE SYNC');
  logger.log(minorDivider);
  if (stats.discipline.total > 0) {
    const disciplineSyncText = `${stats.discipline.synced}/${stats.discipline.total}`;
    logger.log(`Cases synced: ${disciplineSyncText}`);
    if (stats.discipline.created > 0) {
      logger.log(`  Created: ${stats.discipline.created}`);
    }
    if (stats.discipline.updated > 0) {
      logger.log(`  Updated: ${stats.discipline.updated}`);
    }
    if (stats.discipline.skipped > 0) {
      logger.log(`  Skipped: ${stats.discipline.skipped} (unchanged)`);
    }
    if (stats.discipline.linked > 0) {
      logger.log(`  Linked to persons: ${stats.discipline.linked}`);
    }
    if (stats.discipline.skipped_no_person > 0) {
      logger.log(`  Skipped (no person): ${stats.discipline.skipped_no_person}`);
    }
  } else {
    logger.log('Cases synced: 0 changes');
  }
  logger.log('');

  const allErrors = [
    ...stats.errors,
    ...stats.lapostaDeliverability.errors,
    ...stats.rondoClub.errors,
    ...stats.teams.errors,
    ...stats.workHistory.errors,
    ...stats.functions.errors,
    ...stats.commissies.errors,
    ...stats.commissieWorkHistory.errors,
    ...stats.photos.download.errors,
    ...stats.photos.upload.errors,
    ...stats.photos.delete.errors,
    ...stats.freescout.errors,
    ...stats.freescoutConversations.errors,
    ...stats.discipline.errors
  ];
  if (allErrors.length > 0) {
    logger.log(`ERRORS (${allErrors.length})`);
    logger.log(minorDivider);
    allErrors.forEach(error => {
      const identifier = error.knvb_id || error.email || 'system';
      const system = error.system ? ` [${error.system}]` : '';
      logger.log(`- ${identifier}${system}: ${error.message}`);
    });
    logger.log('');
  }

  logger.log(divider);
}

/**
 * Run the full sync pipeline
 * @param {Object} options
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @param {boolean} [options.force=false] - Force sync all members
 * @returns {Promise<{success: boolean, stats: Object, error?: string}>}
 */
async function runSyncAll(options = {}) {
  const { verbose = false, force = false } = options;

  const logger = createSyncLogger({ verbose });
  const startTime = Date.now();

  const tracker = new RunTracker('all');
  tracker.startRun();

  const stats = {
    completedAt: '',
    duration: '',
    downloaded: 0,
    prepared: 0,
    excluded: 0,
    synced: 0,
    added: 0,
    updated: 0,
    errors: [],
    lists: [],
    lapostaDeliverability: {
      scanned: 0,
      pending: 0,
      matched: 0,
      created: 0,
      unresolved: 0,
      assigneeUserId: null,
      errors: []
    },
    rondoClub: {
      total: 0,
      synced: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      deleted: 0,
      errors: []
    },
    photos: {
      download: {
        total: 0,
        downloaded: 0,
        skipped: 0,
        failed: 0,
        errors: []
      },
      upload: {
        total: 0,
        synced: 0,
        skipped: 0,
        errors: []
      },
      delete: {
        total: 0,
        deleted: 0,
        errors: []
      },
      coverage: {
        members_with_photos: 0,
        total_members: 0
      }
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
    functions: {
      total: 0,
      downloaded: 0,
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
    commissieWorkHistory: {
      total: 0,
      synced: 0,
      created: 0,
      ended: 0,
      skipped: 0,
      errors: []
    },
    freescout: {
      total: 0,
      synced: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      deleted: 0,
      errors: []
    },
    freescoutConversations: {
      total: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      errors: []
    },
    discipline: {
      total: 0,
      synced: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      linked: 0,
      skipped_no_person: 0,
      errors: []
    }
  };

  // Shared Sportlink browser session — reused across all Sportlink download steps
  const sportlinkSession = new SportlinkSession({ logger, verbose });

  try {
    // Initialize shared Sportlink session (single login for all browser steps)
    let sportlinkPage;
    try {
      sportlinkPage = await sportlinkSession.getPage();
    } catch (loginErr) {
      const errorMsg = `Sportlink login failed: ${loginErr.message}`;
      logger.error(errorMsg);
      tracker.endRun('failure', stats);
      stats.completedAt = formatTimestamp();
      stats.duration = formatDuration(Date.now() - startTime);
      printSummary(logger, stats);
      logger.close();
      return { success: false, stats, error: errorMsg };
    }

    // Step 1: Download from Sportlink (uses shared session)
    logger.verbose('Starting download from Sportlink...');
    const downloadResult = await runDownload({ logger, verbose, page: sportlinkPage });

    if (!downloadResult.success) {
      const errorMsg = downloadResult.error || 'Download failed';
      logger.error(`Download failed: ${errorMsg}`);
      await sportlinkSession.close();
      tracker.endRun('failure', stats);
      stats.completedAt = formatTimestamp();
      stats.duration = formatDuration(Date.now() - startTime);
      printSummary(logger, stats);
      logger.close();
      return { success: false, stats, error: errorMsg };
    }

    stats.downloaded = downloadResult.memberCount;
    logger.verbose(`Downloaded ${downloadResult.memberCount} members`);

    // Step 2: Prepare Laposta members
    logger.verbose('Preparing Laposta members...');
    const prepareResult = await runPrepare({ logger, verbose });

    if (!prepareResult.success) {
      const errorMsg = prepareResult.error || 'Prepare failed';
      logger.error(`Prepare failed: ${errorMsg}`);
      tracker.endRun('failure', stats);
      stats.completedAt = formatTimestamp();
      stats.duration = formatDuration(Date.now() - startTime);
      printSummary(logger, stats);
      logger.close();
      return { success: false, stats, error: errorMsg };
    }

    // Sum up total prepared members and updates
    stats.prepared = prepareResult.lists.reduce((sum, list) => sum + list.total, 0);
    stats.excluded = prepareResult.excluded;
    logger.verbose(`Prepared ${stats.prepared} members (${stats.excluded} excluded)`);

    // Step 3: Submit to Laposta
    logger.verbose('Submitting to Laposta...');
    const submitResult = await runSubmit({ logger, verbose, force });

    // Collect submit stats (even if there were errors)
    stats.lists = submitResult.lists.map(list => ({
      index: list.index,
      listId: list.listId,
      total: list.total,
      synced: list.synced,
      added: list.added,
      updated: list.updated,
      errors: list.errors
    }));

    // Calculate totals
    stats.synced = stats.lists.reduce((sum, list) => sum + list.synced, 0);
    stats.added = stats.lists.reduce((sum, list) => sum + list.added, 0);
    stats.updated = stats.lists.reduce((sum, list) => sum + list.updated, 0);

    // Collect all errors
    stats.lists.forEach(list => {
      if (list.errors && list.errors.length > 0) {
        stats.errors.push(...list.errors);
      }
    });

    // Step 4: Sync to Rondo Club
    logger.verbose('Syncing to Rondo Club...');
    try {
      const rondoClubResult = await runRondoClubSync({ logger, verbose, force });

      // Members stats
      stats.rondoClub.total = rondoClubResult.total;
      stats.rondoClub.synced = rondoClubResult.synced;
      stats.rondoClub.created = rondoClubResult.created;
      stats.rondoClub.updated = rondoClubResult.updated;
      stats.rondoClub.skipped = rondoClubResult.skipped;
      stats.rondoClub.deleted = rondoClubResult.deleted;

      // Parents stats (add to totals for combined persons count)
      if (rondoClubResult.parents) {
        stats.rondoClub.total += rondoClubResult.parents.total;
        stats.rondoClub.synced += rondoClubResult.parents.synced;
        stats.rondoClub.created += rondoClubResult.parents.created;
        stats.rondoClub.updated += rondoClubResult.parents.updated;
        stats.rondoClub.skipped += rondoClubResult.parents.skipped;
        stats.rondoClub.deleted += rondoClubResult.parents.deleted;

        // Collect parent errors
        if (rondoClubResult.parents.errors?.length > 0) {
          stats.rondoClub.errors.push(...rondoClubResult.parents.errors.map(e => ({
            email: e.email,
            message: e.message,
            system: 'rondoClub'
          })));
        }
      }

      // Collect member errors
      if (rondoClubResult.errors?.length > 0) {
        stats.rondoClub.errors.push(...rondoClubResult.errors.map(e => ({
          knvb_id: e.knvb_id,
          email: e.email,
          message: e.message,
          system: 'rondoClub'
        })));
      }
    } catch (err) {
      // Rondo Club failure is non-critical - log error but continue
      logger.error(`Rondo Club sync failed: ${err.message}`);
      stats.rondoClub.errors.push({
        message: `Rondo Club sync failed: ${err.message}`,
        system: 'rondoClub'
      });
    }

    // Step 4a: Create follow-up todos for Laposta bounces/unsubscribes (NON-CRITICAL)
    logger.verbose('Syncing Laposta deliverability events...');
    try {
      const lapostaDeliverabilityResult = await runSyncLapostaDeliverabilityTasks({ logger, verbose });
      stats.lapostaDeliverability = {
        scanned: lapostaDeliverabilityResult.scanned,
        pending: lapostaDeliverabilityResult.pending,
        matched: lapostaDeliverabilityResult.matched,
        created: lapostaDeliverabilityResult.created,
        unresolved: lapostaDeliverabilityResult.unresolved,
        assigneeUserId: lapostaDeliverabilityResult.assigneeUserId,
        errors: (lapostaDeliverabilityResult.errors || []).map(e => ({
          email: e.email,
          message: e.message,
          system: 'laposta-deliverability'
        }))
      };
    } catch (err) {
      logger.error(`Laposta deliverability sync failed: ${err.message}`);
      stats.lapostaDeliverability.errors.push({
        message: `Laposta deliverability sync failed: ${err.message}`,
        system: 'laposta-deliverability'
      });
    }

    // Step 4b: Team Download + Sync (NON-CRITICAL, uses shared session)
    logger.verbose('Downloading teams from Sportlink...');
    let teamDownloadSportlinkIds = [];
    try {
      const teamPage = sportlinkSession.isActive ? await sportlinkSession.getPage() : undefined;
      const teamDownloadResult = await runTeamDownload({ logger, verbose, page: teamPage });
      if (teamDownloadResult.success) {
        logger.verbose(`Downloaded ${teamDownloadResult.teamCount} teams with ${teamDownloadResult.memberCount} members`);
        // Store the sportlink IDs for orphan detection
        const { getAllTeamsForSync } = require('../lib/rondo-club-db');
        const db = openDb();
        const allTeams = getAllTeamsForSync(db);
        teamDownloadSportlinkIds = allTeams.filter(t => t.sportlink_id).map(t => t.sportlink_id);
        db.close();
      } else {
        logger.error(`Team download failed: ${teamDownloadResult.error}`);
        stats.teams.errors.push({
          message: `Team download failed: ${teamDownloadResult.error}`,
          system: 'team-download'
        });
      }
    } catch (err) {
      logger.error(`Team download failed: ${err.message}`);
      stats.teams.errors.push({
        message: `Team download failed: ${err.message}`,
        system: 'team-download'
      });
    }

    logger.verbose('Syncing teams to Rondo Club...');
    try {
      const teamResult = await runTeamSync({ logger, verbose, force, currentSportlinkIds: teamDownloadSportlinkIds });
      stats.teams.total = teamResult.total;
      stats.teams.synced = teamResult.synced;
      stats.teams.created = teamResult.created;
      stats.teams.updated = teamResult.updated;
      stats.teams.skipped = teamResult.skipped;
      if (teamResult.errors?.length > 0) {
        stats.teams.errors = teamResult.errors.map(e => ({
          team_name: e.team_name,
          message: e.message,
          system: 'team-sync'
        }));
      }
    } catch (err) {
      logger.error(`Team sync failed: ${err.message}`);
      stats.teams.errors.push({
        message: `Team sync failed: ${err.message}`,
        system: 'team-sync'
      });
    }

    // Step 4c: Work History Sync (NON-CRITICAL)
    logger.verbose('Syncing work history to Rondo Club...');
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
    } catch (err) {
      logger.error(`Work history sync failed: ${err.message}`);
      stats.workHistory.errors.push({
        message: `Work history sync failed: ${err.message}`,
        system: 'work-history-sync'
      });
    }

    // Step 4d: Functions Download from Sportlink (NON-CRITICAL, uses shared session)
    logger.verbose('Downloading functions from Sportlink...');
    try {
      const functionsPage = sportlinkSession.isActive ? await sportlinkSession.getPage() : undefined;
      const functionsResult = await runFunctionsDownload({ logger, verbose, page: functionsPage });
      stats.functions.total = functionsResult.total;
      stats.functions.downloaded = functionsResult.downloaded;
      stats.functions.functionsCount = functionsResult.functionsCount;
      stats.functions.committeesCount = functionsResult.committeesCount;
      if (functionsResult.errors?.length > 0) {
        stats.functions.errors = functionsResult.errors.map(e => ({
          knvb_id: e.knvb_id,
          message: e.message,
          system: 'functions-download'
        }));
      }
    } catch (err) {
      logger.error(`Functions download failed: ${err.message}`);
      stats.functions.errors.push({
        message: `Functions download failed: ${err.message}`,
        system: 'functions-download'
      });
    }

    // Step 4e: Commissie Sync (NON-CRITICAL)
    logger.verbose('Syncing commissies to Rondo Club...');
    try {
      const commissieResult = await runCommissieSync({ logger, verbose, force });
      stats.commissies.total = commissieResult.total;
      stats.commissies.synced = commissieResult.synced;
      stats.commissies.created = commissieResult.created;
      stats.commissies.updated = commissieResult.updated;
      stats.commissies.skipped = commissieResult.skipped;
      stats.commissies.deleted = commissieResult.deleted;
      if (commissieResult.errors?.length > 0) {
        stats.commissies.errors = commissieResult.errors.map(e => ({
          commissie_name: e.commissie_name,
          message: e.message,
          system: 'commissie-sync'
        }));
      }
    } catch (err) {
      logger.error(`Commissie sync failed: ${err.message}`);
      stats.commissies.errors.push({
        message: `Commissie sync failed: ${err.message}`,
        system: 'commissie-sync'
      });
    }

    // Step 4f: Commissie Work History Sync (NON-CRITICAL)
    logger.verbose('Syncing commissie work history to Rondo Club...');
    try {
      const commissieWorkHistoryResult = await runCommissieWorkHistorySync({ logger, verbose, force });
      stats.commissieWorkHistory.total = commissieWorkHistoryResult.total;
      stats.commissieWorkHistory.synced = commissieWorkHistoryResult.synced;
      stats.commissieWorkHistory.created = commissieWorkHistoryResult.created;
      stats.commissieWorkHistory.ended = commissieWorkHistoryResult.ended;
      stats.commissieWorkHistory.skipped = commissieWorkHistoryResult.skipped;
      if (commissieWorkHistoryResult.errors?.length > 0) {
        stats.commissieWorkHistory.errors = commissieWorkHistoryResult.errors.map(e => ({
          knvb_id: e.knvb_id,
          message: e.message,
          system: 'commissie-work-history-sync'
        }));
      }
    } catch (err) {
      logger.error(`Commissie work history sync failed: ${err.message}`);
      stats.commissieWorkHistory.errors.push({
        message: `Commissie work history sync failed: ${err.message}`,
        system: 'commissie-work-history-sync'
      });
    }

    // Step 5: Photo Download (NON-CRITICAL, uses shared session)
    logger.verbose('Downloading photos from Sportlink...');
    try {
      const photoPage = sportlinkSession.isActive ? await sportlinkSession.getPage() : undefined;
      const photoDownloadResult = await runPhotoDownload({ logger, verbose, page: photoPage });

      stats.photos.download = {
        total: photoDownloadResult.total,
        downloaded: photoDownloadResult.downloaded,
        skipped: photoDownloadResult.skipped || 0,
        failed: photoDownloadResult.failed,
        errors: (photoDownloadResult.errors || []).map(e => ({
          knvb_id: e.knvb_id,
          message: e.message,
          system: 'photo-download'
        }))
      };
    } catch (err) {
      logger.error(`Photo download failed: ${err.message}`);
      stats.photos.download.errors.push({
        message: `Photo download failed: ${err.message}`,
        system: 'photo-download'
      });
    }

    // Step 6: Photo Upload/Delete (NON-CRITICAL)
    logger.verbose('Syncing photos to Rondo Club...');
    try {
      const photoSyncResult = await runPhotoSync({ logger, verbose });

      stats.photos.upload = {
        total: photoSyncResult.upload.total,
        synced: photoSyncResult.upload.synced,
        skipped: photoSyncResult.upload.skipped,
        errors: (photoSyncResult.upload.errors || []).map(e => ({
          knvb_id: e.knvb_id,
          message: e.message,
          system: 'photo-upload'
        }))
      };

      stats.photos.delete = {
        total: photoSyncResult.delete.total,
        deleted: photoSyncResult.delete.deleted,
        errors: (photoSyncResult.delete.errors || []).map(e => ({
          knvb_id: e.knvb_id,
          message: e.message,
          system: 'photo-delete'
        }))
      };
    } catch (err) {
      logger.error(`Photo sync failed: ${err.message}`);
      stats.photos.upload.errors.push({
        message: `Photo sync failed: ${err.message}`,
        system: 'photo-upload'
      });
    }

    // Calculate photo coverage
    try {
      const db = openDb();
      const totalMembers = db.prepare('SELECT COUNT(*) as count FROM rondo_club_members').get().count;
      const membersWithPhotos = db.prepare(
        "SELECT COUNT(*) as count FROM rondo_club_members WHERE photo_state = 'synced'"
      ).get().count;
      db.close();

      stats.photos.coverage = {
        members_with_photos: membersWithPhotos,
        total_members: totalMembers
      };
    } catch (err) {
      logger.verbose(`Could not calculate photo coverage: ${err.message}`);
    }

    // Step 7: FreeScout Sync (NON-CRITICAL, only if credentials configured)
    const freescoutCreds = checkFreescoutCredentials();
    if (freescoutCreds.configured) {
      logger.verbose('Syncing to FreeScout...');
      try {
        const freescoutResult = await runFreescoutSubmit({ logger, verbose, force });

        stats.freescout = {
          total: freescoutResult.total,
          synced: freescoutResult.synced,
          created: freescoutResult.created,
          updated: freescoutResult.updated,
          skipped: freescoutResult.skipped,
          deleted: freescoutResult.deleted,
          errors: (freescoutResult.errors || []).map(e => ({
            knvb_id: e.knvb_id,
            email: e.email,
            message: e.message,
            system: 'freescout'
          }))
        };
      } catch (err) {
        logger.error(`FreeScout sync failed: ${err.message}`);
        stats.freescout.errors.push({
          message: `FreeScout sync failed: ${err.message}`,
          system: 'freescout'
        });
      }

      // Step 7b: FreeScout Conversations Sync (NON-CRITICAL)
      logger.verbose('Syncing FreeScout conversations to Rondo Club activities...');
      try {
        const convResult = await runFreescoutConversationsSync({ verbose, force });
        if (convResult.stats) {
          stats.freescoutConversations = {
            total: convResult.stats.submit.total,
            created: convResult.stats.submit.created,
            skipped: convResult.stats.submit.skipped,
            failed: convResult.stats.submit.failed,
            errors: (convResult.stats.submit.errors || []).map(e => ({
              message: e.message,
              system: 'freescout-conversations'
            }))
          };
        }
      } catch (err) {
        logger.error(`FreeScout conversations sync failed: ${err.message}`);
        stats.freescoutConversations.errors.push({
          message: `FreeScout conversations sync failed: ${err.message}`,
          system: 'freescout-conversations'
        });
      }
    } else {
      logger.verbose('FreeScout sync skipped (credentials not configured)');
    }

    // Step 8: Discipline Sync (NON-CRITICAL, uses shared session)
    logger.verbose('Syncing discipline cases to Rondo Club...');
    try {
      const disciplinePage = sportlinkSession.isActive ? await sportlinkSession.getPage() : undefined;
      const disciplineResult = await runDisciplinePipelineSync({ verbose, force, page: disciplinePage });

      if (disciplineResult.stats) {
        stats.discipline = {
          total: disciplineResult.stats.sync.total,
          synced: disciplineResult.stats.sync.synced,
          created: disciplineResult.stats.sync.created,
          updated: disciplineResult.stats.sync.updated,
          skipped: disciplineResult.stats.sync.skipped,
          linked: disciplineResult.stats.sync.linked || 0,
          skipped_no_person: disciplineResult.stats.sync.skipped_no_person || 0,
          errors: []
        };
      }
    } catch (err) {
      logger.error(`Discipline sync failed: ${err.message}`);
      stats.discipline.errors.push({
        message: `Discipline sync failed: ${err.message}`,
        system: 'discipline'
      });
    }

    // Close shared Sportlink session (done with all browser steps)
    await sportlinkSession.close();
    if (sportlinkSession.loginCount > 0) {
      logger.verbose(`Shared Sportlink session closed (${sportlinkSession.loginCount} login(s))`);
    }

    // Complete timing
    const endTime = Date.now();
    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(endTime - startTime);

    const allErrorArrays = [
      stats.errors,
      stats.lapostaDeliverability.errors,
      stats.rondoClub.errors,
      stats.teams.errors,
      stats.workHistory.errors,
      stats.functions.errors,
      stats.commissies.errors,
      stats.commissieWorkHistory.errors,
      stats.photos.download.errors,
      stats.photos.upload.errors,
      stats.photos.delete.errors,
      stats.freescout.errors,
      stats.freescoutConversations.errors,
      stats.discipline.errors
    ];
    const totalErrors = allErrorArrays.reduce((sum, arr) => sum + arr.length, 0);
    const success = totalErrors === 0;
    const outcome = totalErrors === 0 ? 'success' : 'partial';

    tracker.endRun(outcome, stats);

    // Print summary
    printSummary(logger, stats);

    // Log file location
    logger.log(`Log file: ${logger.getLogPath()}`);

    logger.close();

    return { success, stats };
  } catch (err) {
    const errorMsg = err.message || String(err);
    logger.error(`Fatal error: ${errorMsg}`);

    await sportlinkSession.close();
    tracker.endRun('failure', stats);

    stats.completedAt = formatTimestamp();
    stats.duration = formatDuration(Date.now() - startTime);
    printSummary(logger, stats);

    logger.close();

    return { success: false, stats, error: errorMsg };
  }
}

module.exports = { runSyncAll };

// CLI entry point
if (require.main === module) {
  // Prevent accidental local runs that cause duplicate entries
  requireProductionServer({
    allowLocal: true,
    scriptName: 'sync-all.js'
  });

  const { verbose, force, dryRun } = parseArgs(process.argv);

  runSyncAll({ verbose, force, dryRun })
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
