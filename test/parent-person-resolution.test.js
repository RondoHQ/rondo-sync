'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePersonEmailMatches,
  selectParentEmailMatch,
  shouldPreserveParentProfile
} = require('../lib/parent-person-resolution');

test('selects a trashed parent instead of a published sibling with the same family email', () => {
  const matches = normalizePersonEmailMatches({
    id: 540,
    status: 'publish',
    matches: [
      { id: 540, status: 'publish' },
      { id: 1081, status: 'trash' }
    ]
  });

  assert.deepEqual(
    selectParentEmailMatch(matches, new Set([540, 559])),
    { id: 1081, status: 'trash' }
  );
});

test('normalizes the legacy single-id lookup response', () => {
  assert.deepEqual(
    normalizePersonEmailMatches({ id: 1081 }),
    [{ id: 1081, status: 'publish' }]
  );
});

test('preserves an existing sponsor profile when it is also a Sportlink parent', () => {
  assert.equal(shouldPreserveParentProfile({
    person_type: 'contact',
    is_sponsor: '1',
    sponsit_contact_id: '391822'
  }), true);
});

test('preserves an existing member profile', () => {
  assert.equal(shouldPreserveParentProfile({ 'knvb-id': 'ABC123' }), true);
});

test('lets Sportlink manage a standalone parent profile', () => {
  assert.equal(shouldPreserveParentProfile({ first_name: 'Vincent Wouters' }), false);
});
