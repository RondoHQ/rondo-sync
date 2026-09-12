const test = require('node:test');
const assert = require('node:assert/strict');
const { SportlinkPhotoUpload } = require('../lib/sportlink-photo-upload');

test('photo reader recovers when Sportlink redirects the first member navigation to its dashboard', async () => {
  const target = 'https://club.sportlink.com/member/member-details/TCVN32T/general';
  let navigations = 0;
  let current = 'https://club.sportlink.com/';
  const page = {
    waitForResponse: async () => ({ ok: () => true, json: async () => ({ Photo: null }) }),
    goto: async () => { current = ++navigations === 1 ? 'https://club.sportlink.com/dashboard' : target; },
    waitForLoadState: async () => {},
    url: () => current,
    getByText: (id, options) => {
      assert.equal(id, 'TCVN32T');
      assert.equal(options.exact, true);
      return { waitFor: async () => {} };
    }
  };
  assert.deepEqual(await new SportlinkPhotoUpload(page).read('TCVN32T'), { sha256: 'none', photoDate: null });
  assert.equal(navigations, 2);
});
