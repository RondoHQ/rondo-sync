'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePersonEmailMatches,
  selectParentEmailMatch,
  getParentProfileOwnership
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
  assert.deepEqual(
    getParentProfileOwnership({
      person_type: 'contact',
      is_sponsor: '1',
      sponsit_contact_id: '391822'
    }),
    { preserveIdentity: true, preserveContact: true }
  );
});

test('preserves identity and contact fields for an active member profile', () => {
  assert.deepEqual(
    getParentProfileOwnership({ 'knvb_id': 'ABC123', former_member: false }),
    { preserveIdentity: true, preserveContact: true }
  );
});

test('preserves former-member identity but lets current parent data refresh contacts', () => {
  assert.deepEqual(
    getParentProfileOwnership({ 'knvb_id': 'BNHX357', former_member: '1' }),
    { preserveIdentity: true, preserveContact: false }
  );
});

test('lets Sportlink manage a standalone parent profile', () => {
  assert.deepEqual(
    getParentProfileOwnership({ first_name: 'Vincent Wouters' }),
    { preserveIdentity: false, preserveContact: false }
  );
});
