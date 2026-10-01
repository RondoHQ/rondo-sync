const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchMemberTeamMemberships } = require('../steps/download-functions-from-sportlink');
const { fetchPlayerHistoryWithRetry } = require('../steps/submit-rondo-club-player-history');

const logger = { verbose() {} };
const panelError = () => Object.assign(new Error('Membership panel did not load'), {
  code: 'ERR_MEMBER_TEAMS_PANEL_NOT_LOADED'
});

test('missing membership panel refreshes authentication once and uses the refreshed page', async () => {
  const originalPage = {};
  const refreshedPage = {};
  const history = [{ PublicTeamId: 'team-1' }];
  let calls = 0;
  let logins = 0;
  const result = await fetchPlayerHistoryWithRetry(originalPage, 'TEST001', logger, {
    session: {
      async relogin() { logins++; },
      async getPage() { return refreshedPage; }
    },
    async fetchMemberships(page, id, _logger, options) {
      assert.equal(id, 'TEST001');
      assert.equal(options.strict, true);
      calls++;
      if (calls === 1) { assert.equal(page, originalPage); throw panelError(); }
      assert.equal(logins, 1);
      assert.equal(page, refreshedPage);
      return history;
    }
  });
  assert.equal(result, history);
  assert.equal(calls, 2);
});

test('persistent panel failure stops after one authentication retry', async () => {
  let calls = 0;
  let logins = 0;
  await assert.rejects(fetchPlayerHistoryWithRetry({}, 'TEST001', logger, {
    session: { async relogin() { logins++; }, async getPage() { return {}; } },
    async fetchMemberships() { calls++; throw panelError(); }
  }), { code: 'ERR_MEMBER_TEAMS_PANEL_NOT_LOADED' });
  assert.equal(calls, 2);
  assert.equal(logins, 1);
});

test('missing source person and malformed history do not retry or become empty history', async () => {
  for (const error of [
    Object.assign(new Error('Sportlink has no person for relation code TEST001'), { code: 'ERR_SPORTLINK_MEMBER_NOT_FOUND' }),
    new Error('MemberTeams response has no explicit Team array')
  ]) {
    let calls = 0;
    await assert.rejects(fetchPlayerHistoryWithRetry({}, 'TEST001', logger, {
      session: { async relogin() { assert.fail('permanent errors must not reauthenticate'); } },
      async fetchMemberships() { calls++; throw error; }
    }), error);
    assert.equal(calls, 1);
  }
});

test('a shared page without a session gets a bounded retry without owning its browser', async () => {
  const page = {};
  let calls = 0;
  assert.deepEqual(await fetchPlayerHistoryWithRetry(page, 'TEST001', logger, {
    async fetchMemberships(actualPage) {
      assert.equal(actualPage, page);
      if (++calls === 1) throw new Error('Timeout waiting for MemberTeams');
      return [];
    }
  }), []);
  assert.equal(calls, 2);
});

function missingPanelPage(personMissing) {
  let navigations = 0;
  return {
    get navigations() { return navigations; },
    async goto() { navigations++; },
    async waitForLoadState() {},
    async waitForSelector() { throw new Error('selector timeout'); },
    getByText(text, options) {
      assert.equal(text, 'Er is geen persoon gevonden met deze relatiecode');
      assert.equal(options.exact, true);
      return { async isVisible() { return personMissing; } };
    }
  };
}

test('explicit missing person stops after one page load even in non-strict mode', async () => {
  for (const strict of [true, false]) {
    const page = missingPanelPage(true);
    await assert.rejects(fetchMemberTeamMemberships(page, 'TEST001', logger, { strict }), {
      code: 'ERR_SPORTLINK_MEMBER_NOT_FOUND'
    });
    assert.equal(page.navigations, 1);
  }
});

test('unknown missing panel reloads once and remains a typed failure in strict mode', async () => {
  const page = missingPanelPage(false);
  await assert.rejects(fetchMemberTeamMemberships(page, 'TEST001', logger, { strict: true }), {
    code: 'ERR_MEMBER_TEAMS_PANEL_NOT_LOADED'
  });
  assert.equal(page.navigations, 2);
});
