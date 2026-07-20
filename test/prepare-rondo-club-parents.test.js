const test = require('node:test');
const assert = require('node:assert/strict');

const {
  mergeMemberOverrides,
  prepareParentsFromMembers
} = require('../steps/prepare-rondo-club-parents');

test('fresh individual data replaces the stale child record used for parent sync', () => {
  const snapshot = [
    {
      PublicPersonId: 'CHILD-1',
      NameParent1: 'Bestaande ouder',
      EmailAddressParent1: 'bestaand@example.com'
    },
    {
      PublicPersonId: 'SIBLING-1',
      NameParent1: 'Bestaande ouder',
      EmailAddressParent1: 'bestaand@example.com'
    }
  ];
  const freshChild = {
    PublicPersonId: 'CHILD-1',
    NameParent1: 'Bestaande ouder',
    EmailAddressParent1: 'bestaand@example.com',
    NameParent2: 'Nieuwe ouder',
    EmailAddressParent2: 'nieuw@example.com'
  };

  const merged = mergeMemberOverrides(snapshot, [freshChild]);

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.find(member => member.PublicPersonId === 'CHILD-1'),
    freshChild
  );
  assert.ok(merged.some(member => member.PublicPersonId === 'SIBLING-1'));

  const parents = prepareParentsFromMembers(merged);
  const newParent = parents.find(parent => parent.email === 'nieuw@example.com');
  const existingParent = parents.find(parent => parent.email === 'bestaand@example.com');

  assert.deepEqual(newParent.childKnvbIds, ['CHILD-1']);
  assert.deepEqual(existingParent.childKnvbIds.sort(), ['CHILD-1', 'SIBLING-1']);
});
