const test = require('node:test');
const assert = require('node:assert/strict');

const { SportlinkSession } = require('../lib/sportlink-session');

test('getPage closes Chromium when login initialization fails', async () => {
  let closed = false;
  const session = new SportlinkSession({ useStorageCache: false });
  session._launchBrowser = async () => ({
    close: async () => {
      closed = true;
    }
  });
  session._openContextAndLogin = async () => {
    throw new Error('OTP login failed');
  };

  await assert.rejects(session.getPage(), /OTP login failed/);
  assert.equal(closed, true);
  assert.equal(session._browser, null);
});
