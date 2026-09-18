'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initDb, upsertTeamsWithMetadata, updateTeamSyncState, getAllTeamsForSync } = require('../lib/rondo-club-db');
const { runTeamDownload } = require('../steps/download-teams-from-sportlink');
const { runSync } = require('../steps/submit-rondo-club-teams');
const { retireMissingTeams } = require('../lib/retire-missing-teams');

const quiet = { log() {}, verbose() {}, error() {} };
const orphan = { team_name: 'Old team', sportlink_id: 'OLD', rondo_club_id: 22 };
const ended = { team_id: 22, team_name_text: '', entity_type: 'team', job_title: 'Speler', is_current: true, start_date: '2024-07-01', end_date: '2025-06-30' };

function api({ history = [ended], mismatched = false, failSave = false, failVerify = false, newReference = false } = {}) {
  let people = [{ id: 100, fields: { work_history: structuredClone(history) } }];
  const post = { id: 22, type: 'team', title: { raw: 'Old team' }, status: 'publish', fields: { publicteamid: mismatched ? 'OTHER' : 'OLD' } };
  const calls = [];
  let scans = 0;
  const request = async (url, method, body) => {
    calls.push({ url, method, body });
    if (url.startsWith('wp/v2/people?')) {
      scans++;
      if (newReference && scans > 1) people.push({ id: 101, fields: { work_history: [ended] } });
      return { body: structuredClone(people), headers: { 'x-wp-totalpages': '1' } };
    }
    if (url.startsWith('wp/v2/people/100')) {
      if (method === 'PUT') {
        if (failSave) throw new Error('save failed');
        if (!failVerify) people[0].fields.work_history = structuredClone(body.fields.work_history);
      }
      return { body: structuredClone(people[0]) };
    }
    if (url.startsWith('wp/v2/teams/22')) {
      if (method === 'PUT') post.status = body.status;
      return { body: structuredClone(post) };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { request, calls, post, get people() { return people; } };
}

test('archives only after preserving and independently verifying all historical rows', async () => {
  const unrelated = { ...ended, team_id: 33, job_title: 'Trainer' };
  const inactive = { ...ended, end_date: null, is_current: false };
  const mock = api({ history: [ended, inactive, unrelated] });
  const result = await retireMissingTeams([orphan], { request: mock.request });
  assert.deepEqual(result, { retired: [orphan], errors: [] });
  assert.equal(mock.post.status, 'draft');
  assert.deepEqual(mock.people[0].fields.work_history, [
    { ...ended, team_id: null, team_name_text: 'Old team', entity_type: 'external_team' },
    { ...inactive, team_id: null, team_name_text: 'Old team', entity_type: 'external_team' },
    unrelated
  ]);
  assert.equal(mock.calls.filter(call => call.method === 'DELETE').length, 0);
  const writesBeforeReplay = mock.calls.filter(call => call.method === 'PUT').length;
  await retireMissingTeams([orphan], { request: mock.request });
  assert.equal(mock.calls.filter(call => call.method === 'PUT').length, writesBeforeReplay);
});

for (const scenario of [
  { mismatched: true },
  { history: [{ ...ended, end_date: null, is_current: true }] },
  { history: [{ ...ended, end_date: '2099-06-30', is_current: false }] },
  { newReference: true }
]) {
  test(`blocks archival when identity or history is unsafe: ${JSON.stringify(scenario)}`, async () => {
    const mock = api(scenario);
    const result = await retireMissingTeams([orphan], { request: mock.request });
    assert.equal(result.retired.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(mock.post.status, 'publish');
  });
}

for (const scenario of [{ failSave: true }, { failVerify: true }]) {
  test(`history write or verification failure leaves team published: ${JSON.stringify(scenario)}`, async () => {
    const mock = api(scenario);
    await assert.rejects(retireMissingTeams([orphan], { request: mock.request }));
    assert.equal(mock.post.status, 'publish');
  });
}

function makeDb() {
  const db = new Database(':memory:');
  initDb(db);
  upsertTeamsWithMetadata(db, [
    { team_name: 'Old team', sportlink_id: 'OLD' },
    { team_name: 'Current team', sportlink_id: 'CURRENT' }
  ]);
  for (const team of getAllTeamsForSync(db)) {
    updateTeamSyncState(db, team.sportlink_id, team.source_hash, team.sportlink_id === 'OLD' ? 22 : 33);
  }
  return db;
}

for (const currentSportlinkIds of [null, undefined, []]) {
  test(`no archival without complete non-empty source: ${JSON.stringify(currentSportlinkIds)}`, async () => {
    const db = makeDb();
    const result = await runSync({ db, currentSportlinkIds, logger: quiet, request() { throw new Error('Must not contact API'); } });
    assert.equal(result.success, true);
    assert.equal(result.archived, 0);
    assert.equal(getAllTeamsForSync(db).length, 2);
    db.close();
  });
}

test('fresh snapshot excludes changed cached orphan and removes only verified mapping', async () => {
  const db = makeDb();
  // An old cached row needing sync must not be republished before retirement.
  updateTeamSyncState(db, 'OLD', 'outdated', 22);
  const mock = api();
  const result = await runSync({ db, currentSportlinkIds: ['CURRENT'], logger: quiet, request: mock.request });
  assert.equal(result.success, true);
  assert.equal(result.archived, 1);
  assert.deepEqual(getAllTeamsForSync(db).map(t => t.sportlink_id), ['CURRENT']);
  db.close();
});

function pageFor(union, club) {
  let listRequest = 0;
  return {
    goto: async () => {},
    waitForResponse: async () => {
      const data = listRequest++ === 0 ? union : listRequest === 2 ? club : { Person: [] };
      return { ok: () => true, json: async () => data };
    }
  };
}

test('download returns source IDs without cached teams and filters linked club duplicates', async () => {
  const db = makeDb();
  const result = await runTeamDownload({ db, logger: quiet, page: pageFor(
    { Team: [{ TeamName: 'Current team', PublicTeamId: 'CURRENT' }] },
    { Team: [{ TeamName: 'Linked', PublicTeamId: 'DUP', HasUnionTeamConnection: true }] }
  ) });
  assert.equal(result.success, true);
  assert.deepEqual(result.currentSportlinkIds, ['CURRENT']);
  assert.equal(getAllTeamsForSync(db).length, 2, 'old tracking remains until verified retirement');
  db.close();
});

for (const [union, club] of [
  [{}, { Team: [] }],
  [{ Team: [] }, {}],
  [{ Team: [{ TeamName: 'Missing ID' }] }, { Team: [] }]
]) {
  test(`malformed download never supplies cleanup IDs: ${JSON.stringify([union, club])}`, async () => {
    const result = await runTeamDownload({ logger: quiet, page: pageFor(union, club) });
    assert.equal(result.success, false);
    assert.equal(result.currentSportlinkIds, undefined);
  });
}


test('preview reports historical references without writing', async () => {
  const mock = api();
  const result = await retireMissingTeams([orphan], { request: mock.request, dryRun: true });
  assert.deepEqual(result.planned, [{ ...orphan, history_rows: 1 }]);
  assert.equal(mock.calls.every(call => call.method === 'GET'), true);
});
