const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForSourceResponse, readSourceWithRecovery } = require('../lib/sportlink-source-retry');
const { fetchMemberDataFromOtherPage, fetchMemberTeamMemberships } = require('../steps/download-functions-from-sportlink');

const pageState = (expired = false) => ({
  url: () => 'https://club.sportlink.com/dashboard',
  getByText: () => ({ isVisible: async () => expired })
});
const failure = code => Object.assign(new Error(code), { code });

test('source waiter ignores an initial 401 and accepts the SPA retry', async () => {
  const good = { status: () => 200 };
  const page = { waitForResponse: async predicate => {
    assert.equal(predicate({ status: () => 401 }), false);
    assert.equal(predicate(good), true);
    return good;
  } };
  assert.equal((await waitForSourceResponse(page, () => true)).response, good);
});

test('a persistent 401 remains an explicit session error after the bounded wait', async () => {
  const page = { waitForResponse: async predicate => {
    predicate({ status: () => 401 });
    throw new Error('timeout');
  } };
  assert.equal((await waitForSourceResponse(page, () => true)).error.code, 'ERR_SPORTLINK_SESSION_EXPIRED');
});

test('session recovery reacquires the page and reads only twice', async () => {
  let logins = 0;
  const pages = [pageState(true), pageState()];
  const visited = [];
  const session = { getPage: async () => pages[logins], relogin: async () => { logins++; } };
  const result = await readSourceWithRecovery({ session }, async page => { visited.push(page); return []; });
  assert.deepEqual(result, []);
  assert.equal(logins, 1);
  assert.deepEqual(visited, pages);
});

test('persistent expiry is not accepted after reauthentication', async () => {
  let reads = 0, logins = 0;
  const session = { getPage: async () => pageState(true), relogin: async () => { logins++; } };
  await assert.rejects(readSourceWithRecovery({ session }, async () => { reads++; return {}; }),
    { code: 'ERR_SPORTLINK_SESSION_EXPIRED' });
  assert.equal(reads, 2);
  assert.equal(logins, 1);
});

test('missing panel and incomplete data get only one retry without needless login', async () => {
  for (const code of ['ERR_MEMBER_TEAMS_PANEL_NOT_LOADED', 'ERR_SPORTLINK_SOURCE_INCOMPLETE']) {
    let reads = 0;
    await assert.rejects(readSourceWithRecovery({ page: pageState() }, async () => {
      reads++; throw failure(code);
    }), { code });
    assert.equal(reads, 2);
  }
});

test('missing persons and permanent failures are never retried', async () => {
  for (const error of [failure('ERR_SPORTLINK_MEMBER_NOT_FOUND'), new Error('forbidden')]) {
    let reads = 0;
    await assert.rejects(readSourceWithRecovery({ page: pageState() }, async () => { reads++; throw error; }), error);
    assert.equal(reads, 1);
  }
});

test('onboarding team panel retries do not multiply the existing navigation attempts', async () => {
  let navigations = 0;
  const page = {
    ...pageState(), goto: async () => { navigations++; }, waitForLoadState: async () => {},
    waitForSelector: async () => { throw new Error('panel unavailable'); }
  };
  await assert.rejects(readSourceWithRecovery({ page }, current =>
    fetchMemberTeamMemberships(current, 'TEST001', { verbose() {} }, { strict: true, retryPanel: false })),
  { code: 'ERR_MEMBER_TEAMS_PANEL_NOT_LOADED' });
  assert.equal(navigations, 2);
});

function vogPage(freeFields = { FreeFields: { Remarks8: { Value: '' } } }, status = 200) {
  return {
    ...pageState(), goto: async () => {},
    waitForResponse: async predicate => {
      const responses = [
        ['/member/MemberHeader?', 401, {}],
        ['/member/MemberHeader?', 200, {}],
        ['/remarks/MemberFreeFields?', status, freeFields]
      ];
      for (const [url, code, data] of responses) {
        const response = { url: () => url, status: () => code, ok: () => code === 200, json: async () => data };
        if (predicate(response)) return response;
      }
      throw new Error('No matching response');
    }
  };
}

test('VOG reader accepts explicit empty VOG after a 401/200 header recovery', async () => {
  const result = await fetchMemberDataFromOtherPage(vogPage(), 'TEST001', { verbose() {} }, { strict: true });
  assert.equal(result.vog_datum, null);
});

test('missing VOG field still fails closed and a forbidden response remains permanent', async () => {
  await assert.rejects(fetchMemberDataFromOtherPage(vogPage({ FreeFields: {} }), 'TEST001', { verbose() {} }, { strict: true }),
    { code: 'ERR_SPORTLINK_SOURCE_INCOMPLETE' });
  await assert.rejects(fetchMemberDataFromOtherPage(vogPage({}, 403), 'TEST001', { verbose() {} }, { strict: true }),
    error => error.message.includes('403') && !error.code);
});
