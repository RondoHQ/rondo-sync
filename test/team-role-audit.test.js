const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const Module = require('node:module');
const { findMembersNeedingRoleAudit, hasUnmatchedCurrentRole, roleKey } = require('../lib/team-role-audit');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE rondo_club_teams (sportlink_id TEXT, rondo_club_id INTEGER);
    CREATE TABLE sportlink_team_members (sportlink_team_id TEXT, sportlink_person_id TEXT, role_description TEXT);
    INSERT INTO rondo_club_teams VALUES ('team-source',2647);
  `);
  return db;
}

const role = { team_id: 2647, job_title: 'Assistent-trainer/coach', start_date: '2025-07-01', end_date: null, is_current: true };

test('audit checks Rondo roles even without any work-history tracking or current roster', async () => {
  const db = fixture();
  try {
    const candidates = await findMembersNeedingRoleAudit(db, [{ knvb_id: 'TEST001', rondo_club_id: 163 }], {
      today: '2026-09-26',
      request: async (route, method) => {
        assert.equal(method, 'GET');
        assert.ok(route.includes('include=163'));
        return { body: [{ id: 163, fields: { work_history: [role] } }] };
      }
    });
    assert.deepEqual([...candidates], ['TEST001']);
  } finally { db.close(); }
});

test('audit respects exact team and role identity, inactive roles, dates and committees', () => {
  const teams = new Set([2647]);
  const roster = new Set([roleKey(2647, ' ASSISTENT-TRAINER/COACH ')]);
  const check = rows => hasUnmatchedCurrentRole(rows, teams, roster, '2026-09-26');
  assert.equal(check([role]), false);
  assert.equal(check([{ ...role, job_title: 'Teammanager' }]), true);
  assert.equal(check([{ ...role, team_id: 2662 }]), false);
  for (const is_current of [false, 0, '0']) assert.equal(check([{ ...role, job_title: 'Old', is_current }]), false);
  assert.equal(check([{ ...role, job_title: 'Old', end_date: '2026-09-25' }]), false);
  assert.equal(check([{ ...role, job_title: 'Other', end_date: '2026-09-26' }]), true);
});

test('audit batches reads and rejects failed or malformed responses', async () => {
  const db = fixture();
  const members = Array.from({ length: 101 }, (_, i) => ({ knvb_id: `TEST${i}`, rondo_club_id: i + 1 }));
  try {
    let requests = 0;
    await findMembersNeedingRoleAudit(db, members, { request: async () => { requests++; return { body: [] }; } });
    assert.equal(requests, 2);
    await assert.rejects(findMembersNeedingRoleAudit(db, members, { request: async () => { throw new Error('timeout'); } }), /timeout/);
    await assert.rejects(findMembersNeedingRoleAudit(db, members, { request: async () => ({ body: {} }) }), /no person list/);
    await assert.rejects(findMembersNeedingRoleAudit(db, members, { request: async () => ({ body: [{ id: 1 }] }) }), /no work history/);
  } finally { db.close(); }
});

test('normal run repairs an orphan despite unchanged empty signature, then replay writes nothing', async () => {
  const db = fixture();
  const member = { knvb_id: 'TEST001', rondo_club_id: 163, last_player_history_team_signature: 'v2:' };
  let history = [{ team_id: 2662, job_title: 'Commissielid', is_current: true }, { ...role }];
  let writes = 0;
  let fetches = 0;
  let signatures = 0;
  let failFetch = false;
  let emptySource = false;
  let unrelatedSource = false;
  const logger = { log() {}, verbose() {}, error() {} };
  const request = async (route, method, body) => {
    if (method === 'PUT') { history = structuredClone(body.fields.work_history); writes++; }
    if (route.includes('?include=')) return { body: [{ id: 163, fields: { work_history: history } }] };
    return { body: { id: 163, fields: { first_name: 'Test', last_name: 'Member', work_history: history } } };
  };
  const originalLoad = Module._load;
  const modulePath = require.resolve('../steps/submit-rondo-club-player-history');
  Module._load = function(name, parent, isMain) {
    if (parent?.filename === modulePath) {
      if (name === '../lib/rondo-club-client') return { rondoClubRequest: request };
      if (name === '../lib/team-role-audit') return {
        ...require('../lib/team-role-audit'),
        findMembersNeedingRoleAudit: (database, rows, options) => findMembersNeedingRoleAudit(database, rows, { ...options, request })
      };
      if (name === '../lib/rondo-club-db') return {
        openDb: () => ({ prepare: db.prepare.bind(db), close() {} }),
        getAllTrackedMembers: () => [member],
        getAllTeams: () => [{ sportlink_id: 'team-source', rondo_club_id: 2647, team_name: 'Test team' }],
        computeMemberTeamSignature: () => 'v2:',
        updateMemberPlayerHistorySignature: () => { signatures++; }
      };
      if (name === './download-functions-from-sportlink') return {
        fetchMemberTeamMemberships: async (_page, id, _logger, options) => {
          fetches++;
          assert.equal(id, 'TEST001');
          assert.equal(options.strict, true);
          if (failFetch) throw new Error('Source unavailable');
          if (emptySource) return [];
          if (unrelatedSource) return [{ PublicTeamId: 'team-source', RoleFunctionDescription: 'Other role', RelationEnd: '2026-07-03' }];
          return [{ PublicTeamId: 'team-source', RoleFunctionDescription: role.job_title, RelationStart: role.start_date, RelationEnd: '2026-07-03', Status: 'ACTIVE' }];
        }
      };
    }
    return originalLoad(name, parent, isMain);
  };
  delete require.cache[modulePath];
  try {
    const { runSync } = require(modulePath);
    const run = () => runSync({ logger, page: {} });
    failFetch = true;
    assert.equal((await run()).success, false);
    assert.equal(writes, 0);
    assert.equal(signatures, 0, 'failed source must remain retryable');
    failFetch = false;
    emptySource = true;
    assert.equal((await run()).success, false);
    assert.equal(writes, 0, 'empty source must never end a role');
    assert.equal(signatures, 0);
    emptySource = false;
    unrelatedSource = true;
    assert.equal((await run()).success, false);
    assert.equal(writes, 0, 'unrelated history is no proof that the unmatched role ended');
    assert.equal(signatures, 0);
    unrelatedSource = false;
    const repaired = await run();
    assert.equal(repaired.success, true);
    assert.equal(repaired.reconciled, 1);
    assert.equal(history[1].end_date, '2026-07-03');
    assert.equal(history[1].is_current, false);
    assert.equal(history[0].is_current, true, 'committee history stays unchanged');
    assert.equal(writes, 1);
    const checked = fetches;
    const replay = await run();
    assert.equal(replay.success, true);
    assert.equal(replay.skippedUnchanged, 1);
    assert.equal(fetches, checked);
    assert.equal(writes, 1);
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
    db.close();
  }
});
