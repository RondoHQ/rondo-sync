const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { assertTeamHistoryComplete, checkSource, sourceRecord } = require('../lib/onboarding-source');

test('onboarding accepts saved historical teams, but blocks current fallbacks and failed saves', async () => {
  const originalLoad = Module._load;
  let history = [];
  let writes = 0;
  let failWrite = false;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename.endsWith('submit-rondo-club-player-history.js')) {
      if (request === '../lib/rondo-club-db') return {
        getAllTeams: () => [{ sportlink_id: 'current', team_name: 'Current team', rondo_club_id: 42 }]
      };
      if (request === '../lib/rondo-club-client') return {
        rondoClubRequest: async (_route, method, body) => {
          if (method === 'PUT') {
            if (failWrite) throw new Error('Team save rejected');
            history = structuredClone(body.fields.work_history);
            writes++;
          }
          return { body: { fields: { first_name: 'Test', last_name: 'Member', work_history: structuredClone(history) } } };
        }
      };
    }
    return originalLoad(request, parent, isMain);
  };
  const modulePath = require.resolve('../steps/submit-rondo-club-player-history');
  delete require.cache[modulePath];
  try {
    const { syncSingleMember } = require(modulePath);
    const rows = [
      { PublicTeamId: 'current', TeamName: 'Current team', Status: 'ACTIVE' },
      { TeamName: 'Old team', RelationStart: '2013-01-16', RelationEnd: '2014-06-17', Status: 'ACTIVE' },
      { TeamName: 'Inactive team', Status: 'INACTIVE' },
      { TeamName: 'Closed season', SeasonDescription: "seizoen 2019/'20", Status: 'ACTIVE' }
    ];
    const sync = teamRows => syncSingleMember({ db: {}, knvbId: 'TEST001', rondoClubId: 123, teamRows });
    const saved = await sync(rows);
    assert.equal(saved.textFallback, 3);
    assert.equal(saved.currentTextFallback, 0);
    assert.doesNotThrow(() => assertTeamHistoryComplete(saved));
    assert.equal(history[0].team_id, 42);
    assert.ok(history.slice(1).every(row => row.entity_type === 'external_team' && row.is_current === false));
    assert.equal(history[1].end_date, '2014-06-17');
    assert.equal(history[2].end_date, null);
    assert.equal(history[3].end_date, '2020-06-30');

    const repeated = await sync(rows);
    assert.equal(writes, 1, 'unchanged history is not rewritten');
    assert.equal(repeated.synced, 0);
    assert.doesNotThrow(() => assertTeamHistoryComplete(repeated));

    const member = { PublicPersonId: 'TEST001', MemberSince: '2026-09-12', TypeOfMember: 'KERNELMEMBER',
      TypeOfMemberDescription: 'Bondslid', Status: 'insync', StatusDescription: 'Definitief', MemberStatus: 'ACTIVE' };
    let observation;
    const check = teamRows => checkSource({ candidate: sourceRecord(member), member, steps: {
      personId: async () => 123,
      fetch: async key => key === 'teams' ? teamRows : {},
      person: async () => ({ success: true, personId: 123 }),
      parents: async () => ({ success: true }),
      functions: async () => ({ success: true }),
      teams: async (_id, teams) => { assertTeamHistoryComplete(await sync(teams)); return { success: true }; }
    }, request: async (route, _method, body) => {
      if (route.includes('/simulation/')) return { body: { snapshot_hash: 'saved-history' } };
      if (route.includes('/observations/')) observation = body;
      return { body: { complete: observation && Object.values(observation.coverage).every(Boolean) } };
    } });
    assert.equal((await check(rows)).complete, true);

    const unknown = [...rows, { TeamName: 'Unmapped current team', Status: 'ACTIVE' }];
    const partial = await sync(unknown);
    assert.equal(partial.textFallback, 4);
    assert.equal(partial.currentTextFallback, 1);
    assert.throws(() => assertTeamHistoryComplete(partial), /Current team mappings/);
    assert.equal((await check(unknown)).coverage.teams, false);
    const unchangedPartial = await sync(unknown);
    assert.equal(unchangedPartial.synced, 0);
    assert.throws(() => assertTeamHistoryComplete(unchangedPartial), /Current team mappings/);

    failWrite = true;
    const failed = await sync([...rows, { TeamName: 'Another old team', RelationEnd: '2010-01-01' }]);
    assert.equal(failed.success, false);
    assert.throws(() => assertTeamHistoryComplete(failed), /could not be saved/);
    assert.throws(() => assertTeamHistoryComplete({ success: true, errors: [], textFallback: 1 }), /Current team mappings/);
    assert.doesNotThrow(() => assertTeamHistoryComplete({ success: true, errors: [], textFallback: 0, currentTextFallback: 0 }));
  } finally {
    Module._load = originalLoad;
    delete require.cache[modulePath];
  }
});
