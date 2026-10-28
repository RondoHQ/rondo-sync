const test = require('node:test');
const assert = require('node:assert/strict');
const { loginToSportlink } = require('../lib/sportlink-login');

const credentials = { username: 'synthetic', password: 'synthetic', otpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' };

test('login waits for the delayed OTP redirect before checking the authenticated page', async () => {
  let url = 'https://idm.sportlink.com/realms/test';
  let waited = false;
  const page = {
    on: () => {}, off: () => {}, $: async () => null,
    goto: async () => {}, fill: async () => {}, click: async () => {},
    waitForSelector: async selector => {
      if (selector.includes('#panelHeaderTasks')) assert.equal(waited, true);
    },
    url: () => url,
    waitForURL: async (predicate, options) => {
      assert.equal(predicate(new URL(url)), false);
      assert.equal(options.timeout, 45000);
      url = 'https://club.sportlink.com/dashboard';
      assert.equal(predicate(new URL(url)), true);
      waited = true;
    }
  };
  await loginToSportlink(page, { credentials });
  assert.equal(waited, true);
});

test('an OTP flow which never returns to Sportlink still fails', async () => {
  const page = {
    on: () => {}, off: () => {}, $: async () => null,
    goto: async () => {}, fill: async () => {}, click: async () => {}, waitForSelector: async () => {},
    waitForURL: async () => { throw new Error('redirect timeout'); }
  };
  await assert.rejects(loginToSportlink(page, { credentials }), /redirect timeout/);
});


test('reports club API rejection after OTP and removes its listener', async () => {
  let listener;
  let removed = false;
  let clicks = 0;
  const page = {
    goto: async () => {}, fill: async () => {},
    on: (event, fn) => { listener = fn; },
    off: (event, fn) => { assert.equal(fn, listener); removed = true; },
    click: async () => {
      if (++clicks === 2) listener({
        url: () => 'https://club.sportlink.com/navajo/entity/common/clubweb/user/ClubAuthorizations',
        status: () => 401
      });
    },
    waitForURL: async () => {},
    waitForSelector: async selector => {
      if (selector.includes('#panelHeaderTasks')) throw new Error('dashboard timeout');
    }
  };
  await assert.rejects(loginToSportlink(page, { credentials }), /ClubAuthorizations.*HTTP 401/);
  assert.equal(removed, true);
});

test('accepts SPA recovery from an initial authorization 401', async () => {
  let listener;
  let clicks = 0;
  const page = {
    goto: async () => {}, fill: async () => {}, $: async () => null,
    on: (event, fn) => { listener = fn; }, off: () => {},
    click: async () => {
      if (++clicks === 2) for (const status of [401, 200]) listener({
        url: () => 'https://club.sportlink.com/navajo/entity/common/clubweb/user/ClubAuthorizations',
        status: () => status
      });
    },
    waitForURL: async () => {}, waitForSelector: async () => {},
    url: () => 'https://club.sportlink.com/dashboard'
  };
  await loginToSportlink(page, { credentials });
});
