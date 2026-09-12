const test = require('node:test');
const assert = require('node:assert/strict');
const { membershipState, sourceRecord, checkSource, COVERAGE } = require('../lib/onboarding-source');

const member = { PublicPersonId: 'TEST001', MemberSince: '2026-09-12', TypeOfMember: 'KERNELMEMBER',
  TypeOfMemberDescription: 'Bondslid', Status: 'insync', StatusDescription: 'Definitief', MemberStatus: 'ACTIVE' };

test('definitive membership needs explicit source evidence; transfers and unknown statuses fail closed', () => {
  assert.equal(membershipState(member), 'definitive');
  for (const key of ['Status', 'StatusDescription', 'MemberStatus', 'MemberSince', 'TypeOfMember']) {
    assert.equal(membershipState({ ...member, [key]: '' }), 'unknown');
  }
  assert.equal(membershipState({ ...member, Status: 'transferrequest', MemberStatus: 'HAS_TRANSFER_REQUEST' }), 'unknown');
  assert.equal(membershipState({ ...member, StatusDescription: 'Voorinschrijving' }), 'unknown');
  assert.equal(membershipState({ ...member, TypeOfMemberDescription: 'Oud bondslid', RelationEnd: '2020-01-01' }), 'ended');
  assert.equal(sourceRecord(member).fingerprint, sourceRecord({ ...member }).fingerprint);
});

function fixture(overrides = {}) {
  const calls = [];
  const steps = {
    personId: async () => 123,
    fetch: async key => key === 'teams' ? [] : {},
    person: async () => ({ success: true, personId: 123 }),
    parents: async () => ({ success: true }),
    functions: async () => ({ success: true }),
    teams: async () => ({ success: true }),
    ...overrides
  };
  let observation;
  const request = async (route, method, body) => {
    calls.push({ route, method, body });
    if (route.includes('/simulation/')) return { body: { snapshot_hash: 'stored-hash' } };
    if (route.includes('/observations/')) observation = body;
    return { body: { complete: observation && COVERAGE.every(key => observation.coverage[key]) } };
  };
  return { calls, args: { candidate: sourceRecord(member), member, steps, request } };
}

test('confirmed empty teams and unchanged saves complete coverage, after all writes and a snapshot read', async () => {
  const { calls, args } = fixture();
  const result = await checkSource(args);
  assert.equal(result.complete, true);
  assert.deepEqual(result.coverage, Object.fromEntries(COVERAGE.map(key => [key, true])));
  assert.match(calls[0].route, /simulation/);
  assert.match(calls[1].route, /observations/);
  assert.equal(calls[1].body.snapshot_hash, 'stored-hash');
  assert.match(calls[2].route, /sources\/finish/);
});

test('failed fetches never become complete empty results or invoke that writer', async () => {
  let teamWrites = 0;
  const { args } = fixture({
    fetch: async key => { if (key === 'teams') throw new Error('timeout'); return {}; },
    teams: async () => { teamWrites++; return { success: true }; }
  });
  const result = await checkSource(args);
  assert.equal(result.complete, false);
  assert.equal(result.coverage.teams, false);
  assert.equal(teamWrites, 0);
  assert.equal(result.coverage.parents, true);
});

test('partial VOG response blocks the person save and all dependent writes', async () => {
  let writes = 0;
  const { args } = fixture({
    fetch: async key => key === 'vog' ? null : {},
    person: async () => { writes++; return { success: true, personId: 123 }; }
  });
  const result = await checkSource(args);
  assert.equal(result.complete, false);
  assert.equal(writes, 0);
  assert.ok(COVERAGE.every(key => !result.coverage[key]));
});

test('a null team response cannot be promoted to a confirmed empty source', async () => {
  let writes = 0;
  const { args } = fixture({ fetch: async key => key === 'teams' ? null : {}, teams: async () => { writes++; return { success: true }; } });
  assert.equal((await checkSource(args)).coverage.teams, false);
  assert.equal(writes, 0);
});

test('swallowed or skipped saves are not accepted; retry is a new actual source observation', async () => {
  const { args } = fixture({ parents: async () => ({ synced: 0, errors: [] }) });
  const first = await checkSource(args);
  assert.equal(first.coverage.parents, false);
  args.steps.parents = async () => ({ success: true });
  assert.equal((await checkSource(args)).complete, true);
});

test('unknown registration state is sent as incomplete, never silently definitive', async () => {
  const { args, calls } = fixture();
  args.member = { ...member, Status: 'transferrequest' };
  const result = await checkSource(args);
  assert.equal(result.complete, false);
  assert.equal(calls[1].body.membership_state, 'unknown');
});

test('a refused snapshot observation is not acknowledged as completed', async () => {
  const { args, calls } = fixture();
  const request = args.request;
  args.request = async (...params) => {
    if (params[0].includes('/observations/')) throw new Error('snapshot changed');
    return request(...params);
  };
  await assert.rejects(checkSource(args), /snapshot changed/);
  assert.equal(calls.some(call => call.route.endsWith('/finish')), false);
});
