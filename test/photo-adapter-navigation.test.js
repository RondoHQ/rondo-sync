const test = require('node:test');
const assert = require('node:assert/strict');
const { SportlinkPhotoUpload } = require('../lib/sportlink-photo-upload');

const memberId = 'TEST123';
const target = `https://club.sportlink.com/member/member-details/${memberId}/general`;

function header({ id = memberId, status = 200, method = 'GET', data = { Photo: null } } = {}) {
  return {
    url: () => `https://club.sportlink.com/navajo/entity/common/clubweb/member/MemberHeader?PublicPersonId=${id}`,
    request: () => ({ method: () => method }),
    ok: () => status >= 200 && status < 300,
    json: async () => data
  };
}

function createPage(navigations) {
  let current = 'https://club.sportlink.com/';
  let count = 0;
  let waiter;
  const page = {
    waitForResponse: (predicate) => new Promise((resolve, reject) => { waiter = { predicate, resolve, reject }; }),
    goto: async () => {
      const navigation = navigations[count++];
      current = navigation.url || target;
      if (navigation.error) {
        waiter.reject(navigation.error);
        throw navigation.error;
      }
      for (const response of navigation.responses || [header()]) {
        if (waiter.predicate(response)) { waiter.resolve(response); break; }
      }
      if (navigation.noSuccessfulResponse) waiter.reject(new Error('Response timeout'));
    },
    waitForLoadState: async () => {},
    url: () => current,
    getByText: (id, options) => {
      assert.equal(id, memberId);
      assert.equal(options.exact, true);
      return { waitFor: async () => {} };
    },
    get navigations() { return count; }
  };
  return page;
}

test('photo reader recovers when Sportlink redirects the first member navigation to its dashboard', async () => {
  const page = createPage([{ url: 'https://club.sportlink.com/dashboard', responses: [] }, {}]);
  assert.deepEqual(await new SportlinkPhotoUpload(page).read(memberId), { sha256: 'none', photoDate: null });
  assert.equal(page.navigations, 2);
});

test('failed responses before a redirected navigation do not hide the successful member response', async () => {
  const page = createPage([
    { url: 'https://club.sportlink.com/dashboard', responses: [header({ status: 401 })] },
    {}
  ]);
  assert.deepEqual(await new SportlinkPhotoUpload(page).read(memberId), { sha256: 'none', photoDate: null });
  assert.equal(page.navigations, 2);
});

test('photo reader ignores other members and preflight responses', async () => {
  const page = createPage([{ responses: [
    header({ id: 'OTHER12', data: { Photo: { PhotoDate: '2026-10-08' } } }),
    header({ method: 'OPTIONS', data: { Photo: { PhotoDate: '2026-10-08' } } }),
    header()
  ] }]);
  assert.deepEqual(await new SportlinkPhotoUpload(page).read(memberId), { sha256: 'none', photoDate: null });
  assert.equal(page.navigations, 1);
});

test('a failed member-header read is retried with a fresh response wait', async () => {
  const page = createPage([
    { responses: [header({ status: 503 })], noSuccessfulResponse: true },
    {}
  ]);
  assert.deepEqual(await new SportlinkPhotoUpload(page).read(memberId), { sha256: 'none', photoDate: null });
  assert.equal(page.navigations, 2);
});

test('a transient navigation timeout is retried before reading the photo', async () => {
  const page = createPage([{ error: new Error('page.waitForLoadState: Timeout') }, {}]);
  assert.deepEqual(await new SportlinkPhotoUpload(page).read(memberId), { sha256: 'none', photoDate: null });
  assert.equal(page.navigations, 2);
});

test('unavailable member headers fail after two read attempts', async () => {
  const failure = { responses: [header({ status: 503 })], noSuccessfulResponse: true };
  const page = createPage([failure, failure]);
  await assert.rejects(new SportlinkPhotoUpload(page).read(memberId), /Sportlink-profiel is niet geladen/);
  assert.equal(page.navigations, 2);
});
