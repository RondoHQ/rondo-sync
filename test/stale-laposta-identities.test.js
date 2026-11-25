const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSource, buildStaleIdentityPlan, syncStaleLapostaIdentities } = require('../steps/sync-stale-laposta-identities');
const { runSubmit } = require('../steps/submit-laposta-list');
const { openDb, recordAutomaticUnsubscription, getPendingMemberDeliverabilityEvents } = require('../lib/laposta-db');

const source = () => ({ SourceComplete: true, ObservedAt: new Date().toISOString(), Members: [{
  PublicPersonId: 'CHILD', FirstName: 'Child', LastName: 'Example', Email: 'child@example.test', EmailAlternative: null,
  EmailAddressParent1: 'parent@example.test', NameParent1: 'Parent Example'
}] });
const member = (id, email, name, code) => ({ member_id: id, email, state: 'active',
  custom_fields: { voornaam: name, achternaam: 'Example', relatiecode: code } });
function lists() {
  return [
    { index: 1, listId: 'one', members: [member('old', 'parent@example.test', 'Child', 'CHILD'), member('child', 'child@example.test', 'Child', 'CHILD')] },
    { index: 2, listId: 'two', members: [member('parent', 'parent@example.test', 'Parent', '')] }
  ];
}

test('retires only obsolete child identities and supports an exact email scope', () => {
  const remote = lists();
  remote[0].members.push(member('unmanaged', 'someone@example.test', 'Unknown', 'OTHER'));
  assert.deepEqual(buildStaleIdentityPlan(source(), remote).map(row => row.member.member_id), ['old']);
  assert.equal(buildStaleIdentityPlan(source(), remote, 'different@example.test').length, 0);
  assert.equal(buildStaleIdentityPlan(source(), remote, ' PARENT@example.test ').length, 1);
});

test('preserves a shared primary or alternate address still owned by the child', () => {
  for (const field of ['Email', 'EmailAlternative']) {
    const data = source();
    data.Members[0][field] = 'parent@example.test';
    assert.equal(buildStaleIdentityPlan(data, lists()).length, 0);
  }
});

test('requires the correct active child replacement and correct active parent survivor', () => {
  for (const target of ['child', 'parent']) {
    for (const state of ['unsubscribed', 'cleaned', undefined]) {
      const remote = lists();
      remote.flatMap(list => list.members).find(row => row.member_id === target).state = state;
      assert.equal(buildStaleIdentityPlan(source(), remote).length, 0);
    }
    const remote = lists();
    remote.flatMap(list => list.members).find(row => row.member_id === target).custom_fields.voornaam = 'Wrong';
    assert.equal(buildStaleIdentityPlan(source(), remote).length, 0);
  }
});

test('unknown identities, existing opt-outs and ambiguous parent names stay untouched', () => {
  for (const state of ['unsubscribed', 'cleaned']) {
    const remote = lists();
    remote[0].members[0].state = state;
    assert.equal(buildStaleIdentityPlan(source(), remote).length, 0);
  }
  const data = source();
  data.Members.push({ ...data.Members[0], PublicPersonId: 'SECOND', NameParent1: 'Another Parent' });
  assert.equal(buildStaleIdentityPlan(data, lists()).length, 0);
  const remote = lists();
  remote[0].members[0].custom_fields.relatiecode = 'UNKNOWN';
  assert.equal(buildStaleIdentityPlan(source(), remote).length, 0);
});

test('an actual parent member can supply the surviving identity', () => {
  const data = source();
  data.Members.push({ PublicPersonId: 'PARENT', FirstName: 'Parent', LastName: 'Example', Email: 'parent@example.test', EmailAlternative: null });
  const remote = lists();
  remote[1].members[0].custom_fields.relatiecode = 'PARENT';
  assert.equal(buildStaleIdentityPlan(data, remote).length, 1);
});

test('rejects incomplete, duplicate, stale, future or partial source records', () => {
  const valid = source();
  for (const data of [null, {}, { ...valid, SourceComplete: false }, { ...valid, Members: [] },
    { ...valid, ObservedAt: '2020-01-01' }, { ...valid, ObservedAt: new Date(Date.now() + 120000).toISOString() },
    { ...valid, Members: [valid.Members[0], valid.Members[0]] },
    { ...valid, Members: [{ PublicPersonId: 'PARTIAL', Email: 'parent@example.test' }] }]) {
    assert.throws(() => validateSource(data));
  }
  assert.doesNotThrow(() => validateSource(valid));
});

function fixture(t) {
  const data = source();
  const remote = lists();
  const calls = [];
  const db = openDb(':memory:');
  t.after(() => { if (db.open) db.close(); });
  const dependencies = {
    readSource: () => data,
    getListConfig: index => ({ listId: remote.find(list => list.index === index)?.listId }),
    fetchMembers: async (id, state) => structuredClone(remote.find(list => list.listId === id).members.filter(row => row.state === state)),
    openDb: () => ({ close() {} }),
    recordAutomaticUnsubscription: (_, ...args) => { calls.push('journal'); recordAutomaticUnsubscription(db, ...args); },
    updateMember: async (id, memberId, changes) => {
      calls.push('write');
      Object.assign(remote.find(list => list.listId === id).members.find(row => row.member_id === memberId), changes);
    }
  };
  return { data, remote, calls, db, dependencies };
}

test('preview is read-only; apply journals, verifies and does not repeat or create unsubscribe tasks', async t => {
  const f = fixture(t);
  const preview = await syncStaleLapostaIdentities({ dependencies: f.dependencies });
  assert.equal(preview.candidates, 1);
  assert.deepEqual(f.calls, []);
  const result = await syncStaleLapostaIdentities({ apply: true, dependencies: f.dependencies });
  assert.equal(result.unsubscribed, 1);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(f.calls, ['journal', 'write']);
  assert.deepEqual(getPendingMemberDeliverabilityEvents(f.db), []);
  assert.equal(f.remote[1].members[0].state, 'active');
  assert.equal(f.remote[0].members[1].state, 'active');
  const again = await syncStaleLapostaIdentities({ apply: true, dependencies: f.dependencies });
  assert.equal(again.candidates, 0);
  assert.deepEqual(f.calls, ['journal', 'write']);
});

test('malformed sources cause no remote calls or writes', async t => {
  const f = fixture(t);
  f.dependencies.readSource = () => null;
  f.dependencies.fetchMembers = async () => { throw new Error('unexpected remote read'); };
  const result = await syncStaleLapostaIdentities({ apply: true, dependencies: f.dependencies });
  assert.match(result.errors[0].message, /snapshot/);
  assert.deepEqual(f.calls, []);
});

test('scheduled reconciliation defers an expired snapshot without blocking the pipeline source refresh', async t => {
  const f = fixture(t);
  f.data.ObservedAt = '2020-01-01';
  f.dependencies.fetchMembers = async () => { throw new Error('unexpected remote read'); };
  const result = await syncStaleLapostaIdentities({ apply: true, deferStaleSource: true, dependencies: f.dependencies });
  assert.match(result.skipped, /one hour/);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(f.calls, []);
});

test('concurrent replacement removal or source changes stop before mutation', async t => {
  for (const change of ['remote', 'source']) {
    const f = fixture(t);
    const fetch = f.dependencies.fetchMembers;
    let reads = 0;
    let changedSource = false;
    f.dependencies.readSource = () => changedSource ? { ...f.data, ObservedAt: '2020-01-01' } : f.data;
    f.dependencies.fetchMembers = async (...args) => {
      if (++reads === 3) {
        if (change === 'remote') f.remote[1].members[0].state = 'unsubscribed';
        else changedSource = true;
      }
      return fetch(...args);
    };
    const result = await syncStaleLapostaIdentities({ apply: true, dependencies: f.dependencies });
    assert.equal(result.errors.length, 1);
    assert.deepEqual(f.calls, []);
  }
});

test('uncertain writes are verified, never retried, and unconfirmed writes are reported', async t => {
  for (const persisted of [true, false]) {
    const f = fixture(t);
    const update = f.dependencies.updateMember;
    f.dependencies.updateMember = async (...args) => {
      if (persisted) await update(...args);
      else f.calls.push('write');
      throw new Error('timeout');
    };
    const result = await syncStaleLapostaIdentities({ apply: true, dependencies: f.dependencies });
    assert.equal(result.unsubscribed, persisted ? 1 : 0);
    assert.equal(result.errors.length, persisted ? 0 : 1);
    assert.deepEqual(f.calls, ['journal', 'write']);
  }
});

test('submission reconciles only after success on all lists and reports cleanup failures', async () => {
  for (const scenario of ['success', 'single-list', 'submit-failure', 'cleanup-failure']) {
    let cleaned = 0;
    const result = await runSubmit({
      listIndex: scenario === 'single-list' ? 1 : null,
      dependencies: {
        syncList: async index => ({ index, errors: scenario === 'submit-failure' && index === 2 ? [{ message: 'failed' }] : [] }),
        syncStaleLapostaIdentities: async options => {
          assert.equal(options.apply, true);
          cleaned++;
          return { errors: scenario === 'cleanup-failure' ? [{ message: 'cleanup failed' }] : [] };
        }
      }
    });
    assert.equal(cleaned, ['success', 'cleanup-failure'].includes(scenario) ? 1 : 0);
    assert.equal(result.success, ['success', 'single-list'].includes(scenario));
  }
});
