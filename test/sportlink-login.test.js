const test = require('node:test');
const assert = require('node:assert/strict');
const { loginToSportlink } = require('../lib/sportlink-login');

const credentials = { username: 'synthetic', password: 'synthetic', otpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' };

test('login waits for the delayed OTP redirect before checking the authenticated page', async () => {
  let url = 'https://idm.sportlink.com/realms/test';
  let waited = false;
  const page = {
    goto: async () => {}, fill: async () => {}, click: async () => {},
    waitForSelector: async selector => {
      if (selector === '#panelHeaderTasks') assert.equal(waited, true);
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
    goto: async () => {}, fill: async () => {}, click: async () => {}, waitForSelector: async () => {},
    waitForURL: async () => { throw new Error('redirect timeout'); }
  };
  await assert.rejects(loginToSportlink(page, { credentials }), /redirect timeout/);
});
