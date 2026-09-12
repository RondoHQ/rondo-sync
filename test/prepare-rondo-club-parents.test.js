const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildParentContactFields,
  mergeMemberOverrides,
  prepareParentsFromMembers
} = require('../steps/prepare-rondo-club-parents');
const { resolveParentImportName } = require('../lib/parent-person-resolution');

test('a parent email without a name uses the child first name and keeps sibling links', () => {
  const children = [
    { PublicPersonId: 'A', FirstName: 'Emma', EmailAddressParent1: 'same@example.com' },
    { PublicPersonId: 'B', FirstName: 'Sam', EmailAddressParent1: 'same@example.com' }
  ];
  const parents = prepareParentsFromMembers(children);
  assert.equal(parents.length, 1);
  assert.equal(parents[0].data.fields.first_name, 'Ouder van Emma');
  assert.deepEqual(parents[0].childKnvbIds, ['A', 'B']);
  children[1].NameParent1 = 'Bekende ouder';
  assert.equal(prepareParentsFromMembers(children)[0].data.fields.first_name, 'Bekende ouder');
  assert.equal(prepareParentsFromMembers([...children].reverse())[0].data.fields.first_name, 'Bekende ouder');
});

test('generated parent names never replace a known name and real names replace placeholders', () => {
  const real = { first_name: 'Jan', last_name: 'Jansen' };
  const fallback = { first_name: 'Ouder van Emma', last_name: '' };
  assert.deepEqual(resolveParentImportName(fallback, real), real);
  assert.deepEqual(resolveParentImportName(real, fallback), real);
  assert.deepEqual(resolveParentImportName(real, fallback, true), fallback);
});

test('parent contacts use the fixed person canonical fields', () => {
  assert.deepEqual(
    buildParentContactFields('ouder@example.com', new Set(['06 12345678', '+31612345678', '024-1234567'])),
    {
      email_1: 'ouder@example.com',
      telephone_1: '+31612345678',
      telephone_2: '+31241234567'
    }
  );
});

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
  assert.equal(newParent.data.fields.email_1, 'nieuw@example.com');
  assert.equal(newParent.data.fields.contact_info, undefined);
  assert.deepEqual(existingParent.childKnvbIds.sort(), ['CHILD-1', 'SIBLING-1']);
});
