'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePersonEmailMatches,
  selectParentEmailMatch,
  normalizePersonName,
  isSafeParentToMemberTransition,
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

test('normalizes split member names and legacy full parent names identically', () => {
  assert.equal(
    normalizePersonName({ first_name: 'Linda', last_name: 'Atema' }),
    normalizePersonName({ first_name: 'Linda Atema', last_name: '' })
  );
});

test('accepts a unique parent-to-member identity match', () => {
  const member = {
    knvb_id: 'NEW123',
    email: 'Linda.Atema88@example.test',
    data: { fields: { first_name: 'Linda', last_name: 'Atema' } }
  };
  const parent = {
    email: 'linda.atema88@example.test',
    rondo_club_id: 1232,
    childKnvbIds: ['CHILD1'],
    data: { fields: { first_name: 'Linda Atema', last_name: '' } }
  };

  assert.equal(isSafeParentToMemberTransition(member, parent), true);
});

test('rejects a child using the shared family email even when names match', () => {
  const member = {
    knvb_id: 'CHILD1',
    email: 'family@example.test',
    data: { fields: { first_name: 'Alex', last_name: 'Jansen' } }
  };
  const parent = {
    email: 'family@example.test',
    rondo_club_id: 1232,
    childKnvbIds: ['CHILD1'],
    data: { fields: { first_name: 'Alex Jansen', last_name: '' } }
  };

  assert.equal(isSafeParentToMemberTransition(member, parent), false);
});

test('rejects a parent post already owned by another member mapping', () => {
  const member = {
    knvb_id: 'NEW123',
    email: 'linda@example.test',
    data: { fields: { first_name: 'Linda', last_name: 'Atema' } }
  };
  const parent = {
    email: 'linda@example.test',
    rondo_club_id: 1232,
    childKnvbIds: ['CHILD1'],
    data: { fields: { first_name: 'Linda Atema' } }
  };

  assert.equal(isSafeParentToMemberTransition(member, parent, new Set([1232])), false);
});

test('rejects stale parent data without a known child', () => {
  const member = {
    knvb_id: 'NEW123',
    email: 'linda@example.test',
    data: { fields: { first_name: 'Linda', last_name: 'Atema' } }
  };
  const parent = {
    email: 'linda@example.test',
    rondo_club_id: 1232,
    childKnvbIds: [],
    data: { fields: { first_name: 'Linda Atema' } }
  };

  assert.equal(isSafeParentToMemberTransition(member, parent), false);
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
