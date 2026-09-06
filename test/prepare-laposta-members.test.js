const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAggregationMaps, processMembers } = require('../steps/prepare-laposta-members');

const mapping = { voornaam: 'FirstName', tussenvoegsel: 'Infix', achternaam: 'LastName', team: 'UnionTeams' };
const child = (extra = {}) => ({
  PublicPersonId: 'CHILD1', FirstName: 'Sanne', Infix: 'de', LastName: 'Jong',
  Email: 'ouder@example.nl', EmailAddressParent1: 'ouder@example.nl', NameParent1: 'Petra',
  UnionTeams: 'JO12-1', ...extra
});
function prepare(members) {
  return processMembers(members, mapping, buildAggregationMaps(members, mapping), new Map(), null).listMembers;
}

test('primary address belonging to parent uses parent name and clears child surname', () => {
  const lists = prepare([child()]);
  assert.equal(lists.flat().length, 1);
  assert.deepEqual(lists[0][0].custom_fields, {
    voornaam: 'Petra', tussenvoegsel: '', achternaam: '', team: 'JO12-1', huidigvrijwilliger: '0', oudervan: 'Sanne de Jong'
  });
});

test('alternative address belonging to parent2 uses parent name while own address keeps child name', () => {
  const entries = prepare([child({ Email: 'kind@example.nl', EmailAlternative: ' OUDER@example.nl ',
    EmailAddressParent1: '', NameParent1: '', EmailAddressParent2: 'ouder@example.nl', NameParent2: 'Petra' })]).flat();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].custom_fields.voornaam, 'Sanne');
  assert.equal(entries[1].custom_fields.voornaam, 'Petra');
  assert.equal(entries[1].custom_fields.achternaam, '');
});

test('all sibling rows use the known parent name regardless of which child supplies it', () => {
  const siblings = [child({ NameParent1: '' }), child({ PublicPersonId: 'CHILD2', FirstName: 'Tim' })];
  for (const members of [siblings, [...siblings].reverse()]) {
    const lists = prepare(members);
    assert.equal(lists[0].length, 1);
    assert.equal(lists[1].length, 1);
    for (const entry of lists.flat()) {
      assert.equal(entry.custom_fields.voornaam, 'Petra');
      assert.deepEqual(new Set(entry.custom_fields.oudervan.split(', ')), new Set(['Sanne de Jong', 'Tim de Jong']));
    }
  }
});

test('parent who is a member supplies structured name even when child is first', () => {
  const parent = { PublicPersonId: 'PARENT', Email: 'ouder@example.nl', FirstName: 'Petra', Infix: 'van', LastName: 'Dijk' };
  for (const members of [[child(), parent], [parent, child()]]) {
    for (const entry of prepare(members).flat()) {
      assert.equal(entry.custom_fields.voornaam, 'Petra');
      assert.equal(entry.custom_fields.tussenvoegsel, 'van');
      assert.equal(entry.custom_fields.achternaam, 'Dijk');
    }
  }
});

test('standalone parent uses a name from another sibling instead of the first blank slot', () => {
  const entries = prepare([
    child({ Email: 'sanne@example.nl', NameParent1: '' }),
    child({ PublicPersonId: 'CHILD2', FirstName: 'Tim', Email: 'tim@example.nl' })
  ]).flat();
  const parents = entries.filter(entry => entry.email === 'ouder@example.nl');
  assert.equal(parents.length, 1);
  assert.equal(parents[0].custom_fields.voornaam, 'Petra');
});

test('missing parent name retains explicit parent-of-child fallback', () => {
  const entry = prepare([child({ NameParent1: '' })]).flat()[0];
  assert.equal(entry.custom_fields.voornaam, 'Ouder/verzorger van Sanne');
  assert.equal(entry.custom_fields.tussenvoegsel, 'de');
  assert.equal(entry.custom_fields.achternaam, 'Jong');
});

test('conflicting parent names on shared mailbox use neutral salutation in every row order', () => {
  const siblings = [child(), child({ PublicPersonId: 'CHILD2', FirstName: 'Tim', NameParent1: 'Pieter' })];
  for (const members of [siblings, [...siblings].reverse()]) {
    for (const entry of prepare(members).flat()) {
      assert.equal(entry.custom_fields.voornaam, 'Ouder/verzorger');
      assert.equal(entry.custom_fields.achternaam, '');
    }
  }
});

test('unrelated members sharing an address retain their own names and list assignments', () => {
  const lists = prepare([
    child({ EmailAddressParent1: '', NameParent1: '' }),
    child({ PublicPersonId: 'OTHER', FirstName: 'Tim', EmailAddressParent1: '', NameParent1: '' })
  ]);
  assert.equal(lists[0][0].custom_fields.voornaam, 'Sanne');
  assert.equal(lists[1][0].custom_fields.voornaam, 'Tim');
});
