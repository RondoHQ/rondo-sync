#!/usr/bin/env node
'use strict';
require('dotenv/config');

const { openDb: openSourceDb, getLatestSportlinkSnapshot } = require('../lib/laposta-db');
const { openDb, getAllTrackedMembers } = require('../lib/rondo-club-db');
const { prepareParentSlotObservations, submitParentSlotObservations } = require('../lib/parent-slot-observations');

/** Backfill labels from the stored source snapshot, without running a people sync. */
async function run(options = {}) {
  const sourceDb = openSourceDb();
  const db = openDb();
  try {
    const snapshot = getLatestSportlinkSnapshot(sourceDb);
    if (!snapshot) throw new Error('No Sportlink snapshot available');
    const members = JSON.parse(snapshot.results_json).Members;
    if (!Array.isArray(members)) throw new Error('Invalid Sportlink snapshot');
    let observations = prepareParentSlotObservations(members, snapshot.created_at);
    if (options.knvbId) observations = observations.filter(item => item.knvb_id === options.knvbId);
    const memberIds = new Map(getAllTrackedMembers(db).map(member => [member.knvb_id, member.rondo_club_id]));
    const preview = { observedAt: snapshot.created_at, completeSources: observations.length, mappedSources: observations.filter(item => memberIds.has(item.knvb_id)).length };
    if (!options.apply) return { ...preview, dryRun: true };
    return { ...preview, ...await submitParentSlotObservations(observations, memberIds, options) };
  } finally {
    sourceDb.close();
    db.close();
  }
}

module.exports = { run };
if (require.main === module) {
  const idIndex = process.argv.indexOf('--knvb-id');
  if (idIndex !== -1 && (!process.argv[idIndex + 1] || process.argv[idIndex + 1].startsWith('--'))) {
    console.error('--knvb-id requires an identity');
    process.exitCode = 1;
  } else {
    run({ apply: process.argv.includes('--apply'), knvbId: idIndex === -1 ? null : process.argv[idIndex + 1] })
      .then(result => {
        console.log(JSON.stringify(result, null, 2));
        if (result.errors?.length) process.exitCode = 2;
      })
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
