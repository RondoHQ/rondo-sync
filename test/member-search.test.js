const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchMemberSearchData, readMemberSearchResult } = require('../steps/download-member-search');
const { mergeFreshMemberData } = require('../pipelines/sync-individual');
const { preparePerson } = require('../steps/prepare-rondo-club-members');

const member = { PublicPersonId: 'TEST001', FirstName: 'Test', LastName: 'Member',
  KernelGameActivities: 'Veld -  Algemeen', AgeClassDescription: 'Senioren' };
const logger = { verbose: () => {} };

function mockPage(results = [{ Members: [member] }]) {
  const calls = [];
  let next = 0;
  return {
    calls,
    goto: async url => calls.push(['goto', url]),
    url: () => 'https://club.sportlink.com/member/search',
    waitForSelector: async () => {},
    click: async selector => calls.push(['click', selector]),
    check: async selector => calls.push(['check', selector]),
    uncheck: async () => {},
    $: async () => ({}),
    isChecked: async () => false,
    fill: async (selector, value) => calls.push(['fill', selector, value]),
    waitForResponse: async predicate => {
      assert.equal(predicate({ url: () => 'https://club.sportlink.com/navajo/entity/common/clubweb/member/search/SearchMembers', request: () => ({ method: () => 'POST' }) }), true);
      const result = results[next++];
      return { ok: () => true, json: async () => result };
    }
  };
}

test('fresh search replaces stale activity and age class through the prepared person payload', () => {
  const fresh = readMemberSearchResult({ Members: [{ ...member, PublicPersonId: 'OTHER' }, member] }, 'TEST001');
  const merged = mergeFreshMemberData({ ...member, KernelGameActivities: null, AgeClassDescription: null },
    mergeFreshMemberData(fresh, { PublicPersonId: 'TEST001', Email: 'fresh@example.test' }));
  const prepared = preparePerson(merged);
  assert.equal(prepared.data.fields.spelactiviteit, 'Veld - Algemeen');
  assert.equal(prepared.data.fields.leeftijdsgroep, 'Senioren');
});

test('explicitly empty fresh activity clears an older activity', () => {
  for (const value of [null, '']) {
    const fresh = readMemberSearchResult({ Members: [{ ...member, KernelGameActivities: value }] }, 'TEST001');
    const prepared = preparePerson(mergeFreshMemberData(member, fresh));
    assert.equal(prepared.data.fields.spelactiviteit, null);
  }
});

test('missing, malformed and ambiguous source data fail instead of clearing fields', () => {
  assert.throws(() => readMemberSearchResult({}, 'TEST001'), /incomplete/);
  for (const field of ['KernelGameActivities', 'AgeClassDescription']) {
    const incomplete = { ...member };
    delete incomplete[field];
    assert.throws(() => readMemberSearchResult({ Members: [incomplete] }, 'TEST001'), /omitted/);
    assert.throws(() => readMemberSearchResult({ Members: [{ ...member, [field]: [] }] }, 'TEST001'), /invalid/);
  }
  assert.throws(() => readMemberSearchResult({ Members: [member, member] }, 'TEST001'), /multiple/);
  assert.equal(readMemberSearchResult({ Members: [{ ...member, PublicPersonId: 'OTHER' }] }, 'TEST001'), null);
});

test('search targets the exact KNVB ID and includes union team data', async () => {
  const page = mockPage();
  assert.deepEqual(await fetchMemberSearchData(page, 'TEST001', logger), member);
  assert.ok(page.calls.some(call => call[0] === 'fill' && call[2] === 'TEST001'));
  assert.ok(page.calls.some(call => call[0] === 'check' && call[1] === '#scFetchUnionTeams_input'));
  assert.equal(page.calls.filter(call => call[0] === 'goto').length, 1);
});

test('an absent active match is retried with the existing former-member status selector', async () => {
  const page = mockPage([{ Members: [] }, { Members: [member] }]);
  assert.deepEqual(await fetchMemberSearchData(page, 'TEST001', logger), member);
  assert.ok(page.calls.some(call => call[0] === 'check' && call[1] === 'input[name="DROPDOWN_MULTISELECT_OPTION_INACTIVE"]'));
});

test('missing member and HTTP failure abort the fresh fetch', async () => {
  await assert.rejects(fetchMemberSearchData(mockPage([{ Members: [] }, { Members: [] }]), 'TEST001', logger), /did not return/);
  const page = mockPage();
  page.waitForResponse = async () => ({ ok: () => false, status: () => 500 });
  await assert.rejects(fetchMemberSearchData(page, 'TEST001', logger), /failed \(500\)/);
});

test('a stale session reauthenticates before retrying search', async () => {
  const page = mockPage();
  let relogins = 0;
  page.url = () => relogins ? 'https://club.sportlink.com/member/search' : 'https://club.sportlink.com/dashboard';
  const session = { relogin: async () => { relogins++; }, getPage: async () => page };
  assert.deepEqual(await fetchMemberSearchData(page, 'TEST001', logger, { session }), member);
  assert.equal(relogins, 1);
});

test('a stuck search panel is retried once and persistent failure aborts', async () => {
  const page = mockPage();
  let waits = 0;
  page.waitForSelector = async () => { if (waits++ === 0) throw new Error('panel timeout'); };
  assert.deepEqual(await fetchMemberSearchData(page, 'TEST001', logger), member);
  assert.equal(page.calls.filter(call => call[0] === 'goto').length, 2);
  page.waitForSelector = async () => { throw new Error('panel timeout'); };
  await assert.rejects(fetchMemberSearchData(page, 'TEST001', logger), /panel timeout/);
});
