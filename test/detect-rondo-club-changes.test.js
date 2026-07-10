const test = require('node:test');
const assert = require('node:assert/strict');

const { isRondoClubContact } = require('../lib/detect-rondo-club-changes');

test('explicit contacts are excluded from reverse sync even with a KNVB ID', () => {
  assert.equal(isRondoClubContact({
    person_type: 'contact',
    'knvb-id': 'STALE123'
  }), true);
});

test('members and legacy people remain eligible for reverse sync', () => {
  assert.equal(isRondoClubContact({ person_type: 'member' }), false);
  assert.equal(isRondoClubContact({}), false);
});
