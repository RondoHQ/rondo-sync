const test = require('node:test');
const assert = require('node:assert/strict');

const { navigateWithTimeoutCheck } = require('../lib/reverse-sync-sportlink');

function createPage(destinations) {
  let currentUrl = 'https://club.sportlink.com/';
  let navigations = 0;
  return {
    async goto() {
      currentUrl = destinations[navigations++];
    },
    async waitForLoadState() {},
    url() {
      return currentUrl;
    },
    get navigations() {
      return navigations;
    }
  };
}

test('retries the member page after Sportlink silently lands on the dashboard', async () => {
  const target = 'https://club.sportlink.com/member/member-details/TBQC00P/general';
  const page = createPage(['https://club.sportlink.com/dashboard', target]);

  await navigateWithTimeoutCheck(page, target, {});

  assert.equal(page.navigations, 2);
  assert.equal(page.url(), target);
});

test('fails clearly when Sportlink never opens the requested member page', async () => {
  const target = 'https://club.sportlink.com/member/member-details/TBQC00P/general';
  const page = createPage([
    'https://club.sportlink.com/dashboard',
    'https://club.sportlink.com/dashboard'
  ]);

  await assert.rejects(
    navigateWithTimeoutCheck(page, target, {}),
    /did not open the requested member page/
  );
  assert.equal(page.navigations, 2);
});
