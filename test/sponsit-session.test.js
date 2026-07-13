const test = require('node:test');
const assert = require('node:assert/strict');

const { validateSponsitUrl } = require('../lib/sponsit-session');

test('Sponsit credentials can only be submitted to an HTTPS origin', () => {
  assert.equal(
    validateSponsitUrl('https://account.sponsit.nl/contacts'),
    'https://account.sponsit.nl'
  );
  assert.throws(
    () => validateSponsitUrl('http://account.sponsit.nl'),
    /must use HTTPS/
  );
});
