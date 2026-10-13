const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initDb, upsertTeamMembers } = require('../lib/rondo-club-db');
const { runTeamDownload } = require('../steps/download-teams-from-sportlink');
const { SportlinkSession } = require('../lib/sportlink-session');
const logger = { log() {}, verbose() {}, error() {} };
const team = { TeamName: 'Test team', PublicTeamId: 'TEAM1' };
function response(endpoint, status = 200, data = { Team: [] }, method = 'GET') {
  return { url: () => `https://club.sportlink.com/navajo/${endpoint}`, request: () => ({ method: () => method }),
    status: () => status, ok: () => status === 200, json: async () => data };
}
function pageFor(navigations, loggedOut = false) {
  let waits = [];
  return {
    visits: 0,
    getByText: () => ({ isVisible: async () => loggedOut }),
    waitForResponse(predicate) { return new Promise((resolve, reject) => waits.push({ predicate, resolve, reject })); },
    async goto() {
      const pending = waits;
      waits = [];
      const responses = navigations[this.visits++] || [];
      for (const wait of pending) {
        const match = responses.find(wait.predicate);
        if (match) wait.resolve(match);
        else wait.reject(new Error('Response timeout'));
      }
    }
  };
}

test('accepts SPA token refresh after 401 and ignores unrelated or non-GET responses', async () => {
  const page = pageFor([
    [response('UnionTeamsPlayers'), response('UnionTeams', 200, {}, 'POST'), response('UnionTeams', 401), response('UnionTeams', 200, { Team: [team] })],
    [response('ClubTeams', 401), response('ClubTeams')]
  ]);
  const result = await runTeamDownload({ page, rosters: false, logger });
  assert.equal(result.success, true);
  assert.deepEqual(result.currentSportlinkIds, ['TEAM1']);
  assert.equal(page.visits, 2);
});

for (const endpoint of ['UnionTeams', 'ClubTeams']) {
  test(`persistent ${endpoint} 401 reauthenticates once using the owned session`, async t => {
    const sequence = [[response('UnionTeams')], [response('ClubTeams')]];
    const index = endpoint === 'UnionTeams' ? 0 : 1;
    sequence.splice(index, 0, [response(endpoint, 401)]);
    const page = pageFor(sequence);
    let logins = 0;
    let closes = 0;
    t.mock.method(SportlinkSession.prototype, 'getPage', async () => page);
    t.mock.method(SportlinkSession.prototype, 'relogin', async () => { logins++; });
    t.mock.method(SportlinkSession.prototype, 'close', async () => { closes++; });
    const result = await runTeamDownload({ rosters: false, logger });
    assert.equal(result.success, true);
    assert.equal(logins, 1);
    assert.equal(closes, 1);
  });
}

test('persistent 401 after relogin fails with no cleanup snapshot and preserves shared session ownership', async () => {
  const page = pageFor([[response('UnionTeams', 401)], [response('UnionTeams', 401)]]);
  let logins = 0;
  const session = { relogin: async () => { logins++; }, close: () => assert.fail('Shared session must stay open') };
  const result = await runTeamDownload({ page, session, rosters: false, logger });
  assert.equal(result.success, false);
  assert.match(result.error, /401/);
  assert.equal(result.currentSportlinkIds, undefined);
  assert.equal(logins, 1);
  assert.equal(page.visits, 2);
});

for (const status of [403, 500]) {
  test(`${status} fails without reauthenticating`, async () => {
    const result = await runTeamDownload({ page: pageFor([[response('UnionTeams', status)]]), rosters: false, logger,
      session: { relogin: () => assert.fail('Not an authentication expiry') } });
    assert.equal(result.success, false);
    assert.match(result.error, new RegExp(String(status)));
  });
}

for (const bad of [response('UnionTeamPlayers', 401), response('UnionTeamPlayers', 500), response('UnionTeamPlayers', 200, {})]) {
  test(`failed or malformed roster (${bad.status()}) preserves existing team members`, async () => {
    const db = new Database(':memory:');
    initDb(db);
    const saved = { sportlink_team_id: 'TEAM1', sportlink_person_id: 'TEST001', role_description: 'Teamspeler' };
    upsertTeamMembers(db, [saved]);
    const before = db.prepare('SELECT * FROM sportlink_team_members').all();
    try {
      const page = pageFor([[response('UnionTeams', 200, { Team: [team] })], [response('ClubTeams')],
        [bad, response('UnionTeamNonPlayers', 200, { Person: [] })]]);
      const result = await runTeamDownload({ page, db, logger });
      assert.equal(result.success, false);
      assert.equal(result.currentSportlinkIds, undefined);
      assert.deepEqual(db.prepare('SELECT * FROM sportlink_team_members').all(), before);
    } finally { db.close(); }
  });
}

test('roster reauthentication re-reads both responses before storing members', async () => {
  const db = new Database(':memory:');
  initDb(db);
  let logins = 0;
  const page = pageFor([[response('UnionTeams', 200, { Team: [team] })], [response('ClubTeams')],
    [response('UnionTeamPlayers', 401), response('UnionTeamNonPlayers', 200, { Person: [{ PublicPersonId: 'STALE', FunctionDescription: 'Trainer' }] })],
    [response('UnionTeamPlayers', 200, { Person: [{ PublicPersonId: 'TEST001', RoleFunctionDescription: 'Teamspeler' }] }), response('UnionTeamNonPlayers', 200, { Person: [] })]]);
  try {
    const result = await runTeamDownload({ page, db, logger, session: { relogin: async () => { logins++; } } });
    assert.equal(result.success, true);
    assert.equal(logins, 1);
    assert.equal(result.memberCount, 1);
    assert.deepEqual(db.prepare('SELECT sportlink_person_id FROM sportlink_team_members').all(), [{ sportlink_person_id: 'TEST001' }]);
  } finally { db.close(); }
});

for (const loggedOut of [true, false]) {
  test(`response timeout reauthenticates only with visible session expiry (${loggedOut})`, async () => {
    const page = pageFor([[], [response('UnionTeams')], [response('ClubTeams')]], loggedOut);
    let logins = 0;
    const result = await runTeamDownload({ page, rosters: false, logger, session: { relogin: async () => { logins++; } } });
    assert.equal(result.success, loggedOut);
    assert.equal(logins, loggedOut ? 1 : 0);
  });
}
