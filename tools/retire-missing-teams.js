'use strict';

// Run only on the production sync host under the teams pipeline lock.
const { runTeamDownload } = require('../steps/download-teams-from-sportlink');
const { openDb, getOrphanTeamsBySportlinkId, deleteTeamBySportlinkId } = require('../lib/rondo-club-db');
const { retireMissingTeams } = require('../lib/retire-missing-teams');

async function run({ apply = false } = {}) {
  const logger = { log: console.log, verbose() {}, error: console.error };
  const snapshot = await runTeamDownload({ logger, rosters: false });
  if (!snapshot.success || !snapshot.currentSportlinkIds?.length) {
    throw new Error(snapshot.error || 'No complete non-empty team snapshot; no cleanup performed');
  }
  const db = openDb();
  try {
    const orphans = getOrphanTeamsBySportlinkId(db, snapshot.currentSportlinkIds)
      .filter(team => team.sportlink_id);
    console.log(JSON.stringify({ source_teams: snapshot.teamCount, missing_teams: orphans }, null, 2));
    const result = await retireMissingTeams(orphans, { logger, dryRun: !apply });
    if (apply) {
      for (const team of result.retired) deleteTeamBySportlinkId(db, team.sportlink_id);
    }
    console.log(JSON.stringify(result, null, 2));
    if (result.errors.length) process.exitCode = 2;
    return result;
  } finally {
    db.close();
  }
}

if (require.main === module) {
  run({ apply: process.argv.includes('--apply') }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { run };
