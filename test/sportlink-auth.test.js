const test = require('node:test');
const assert = require('node:assert/strict');

const { isSportlinkAuthUrl } = require('../lib/sportlink-auth');

test('recognizes current Sportlink identity-provider URLs', () => {
  assert.equal(isSportlinkAuthUrl('https://idm.sportlink.com/realms/sportlink/protocol/openid-connect/auth'), true);
});

test('recognizes legacy Sportlink authentication URLs', () => {
  assert.equal(isSportlinkAuthUrl('https://club.sportlink.com/auth/realms/sportlink/protocol/openid-connect/auth'), true);
});

test('does not classify Club pages as authentication URLs', () => {
  assert.equal(isSportlinkAuthUrl('https://club.sportlink.com/member/member-details/TBQC00P/general'), false);
  assert.equal(isSportlinkAuthUrl('not a url'), false);
});
