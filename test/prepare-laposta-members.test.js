const test = require('node:test');
const assert = require('node:assert/strict');
const { buildAggregationMaps, processMembers } = require('../steps/prepare-laposta-members');

const mapping = { voornaam: 'FirstName', tussenvoegsel: 'Infix', achternaam: 'LastName', team: 'UnionTeams', geboortedatum: 'DateOfBirth', relatiecode: 'PublicPersonId' };
const child = (extra = {}) => ({
  PublicPersonId: 'CHILD1', FirstName: 'Sanne', Infix: 'de', LastName: 'Jong',
  Email: 'ouder@example.nl', EmailAddressParent1: 'ouder@example.nl', NameParent1: 'Petra',
  UnionTeams: 'JO12-1', DateOfBirth: '2014-10-08', ...extra
});
function prepare(members) {
  return processMembers(members, mapping, buildAggregationMaps(members, mapping), new Map(), null).listMembers;
}

test('shared primary mailbox has separate child and parent identities, and only the child birthday', () => {
  const lists = prepare([child()]);
  assert.equal(lists.flat().length, 2);
  const member = lists[0][0].custom_fields;
  const parent = lists[1][0].custom_fields;
  assert.equal(member.voornaam, 'Sanne');
  assert.equal(member.achternaam, 'Jong');
  assert.equal(member.geboortedatum, '2014-10-08');
  assert.equal(member.relatiecode, 'CHILD1');
  assert.equal(parent.voornaam, 'Petra');
  assert.equal(parent.achternaam, '');
  assert.equal(parent.geboortedatum, '');
  assert.equal(parent.relatiecode, '');
  assert.equal(parent.oudervan, 'Sanne de Jong');
});

test('alternative parent mailbox keeps the child identity and adds a separate parent2 row', () => {
  const entries = prepare([child({ Email: 'kind@example.nl', EmailAlternative: ' OUDER@example.nl ',
    EmailAddressParent1: '', NameParent1: '', EmailAddressParent2: 'ouder@example.nl', NameParent2: 'Petra' })]).flat();
  assert.equal(entries.length, 3);
  assert.equal(entries[0].custom_fields.voornaam, 'Sanne');
  assert.equal(entries[1].custom_fields.voornaam, 'Sanne');
  assert.equal(entries[2].custom_fields.voornaam, 'Petra');
  assert.equal(entries[2].custom_fields.geboortedatum, '');
});

test('siblings retain their own birthdays and share one separate parent regardless of row order', () => {
  const siblings = [child({ NameParent1: '' }), child({ PublicPersonId: 'CHILD2', FirstName: 'Tim', DateOfBirth: '2016-02-03' })];
  for (const members of [siblings, [...siblings].reverse()]) {
    const lists = prepare(members);
    assert.equal(lists[0].length, 1);
    assert.equal(lists[1].length, 1);
    assert.equal(lists[2].length, 1);
    for (const [index, member] of members.entries()) {
      const entry = lists[index][0];
      assert.equal(entry.custom_fields.voornaam, member.FirstName);
      assert.equal(entry.custom_fields.geboortedatum, member.DateOfBirth);
      assert.deepEqual(new Set(entry.custom_fields.oudervan.split(', ')), new Set(['Sanne de Jong', 'Tim de Jong']));
    }
    assert.equal(lists[2][0].custom_fields.voornaam, 'Petra');
    assert.equal(lists[2][0].custom_fields.geboortedatum, '');
  }
});

test('parent who is a member retains their own birthdate without an extra synthetic parent row', () => {
  const parent = { PublicPersonId: 'PARENT', Email: 'ouder@example.nl', FirstName: 'Petra', Infix: 'van', LastName: 'Dijk', DateOfBirth: '1980-01-02' };
  for (const members of [[child(), parent], [parent, child()]]) {
    const entries = prepare(members).flat();
    assert.equal(entries.length, 2);
    for (const member of members) {
      const fields = entries.find(entry => entry.custom_fields.relatiecode === member.PublicPersonId).custom_fields;
      assert.equal(fields.voornaam, member.FirstName);
      assert.equal(fields.geboortedatum, member.DateOfBirth);
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
  const entry = prepare([child({ NameParent1: '' })]).flat()[1];
  assert.equal(entry.custom_fields.voornaam, 'Ouder/verzorger van Sanne');
  assert.equal(entry.custom_fields.tussenvoegsel, 'de');
  assert.equal(entry.custom_fields.achternaam, 'Jong');
});

test('conflicting parent names on shared mailbox use neutral salutation in every row order', () => {
  const siblings = [child(), child({ PublicPersonId: 'CHILD2', FirstName: 'Tim', NameParent1: 'Pieter' })];
  for (const members of [siblings, [...siblings].reverse()]) {
    const entries = prepare(members).flat();
    assert.equal(entries.length, 3);
    assert.equal(entries[2].custom_fields.voornaam, 'Ouder/verzorger');
    assert.equal(entries[2].custom_fields.achternaam, '');
    assert.equal(entries[2].custom_fields.geboortedatum, '');
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

test('publishes all three numeric volunteer fields with distinct member and parent progress', () => {
  const memberCounts = { vrijwilligersplicht: 3, vrijwilligersingepland: 1, vrijwilligersafgerond: 2 };
  const parentCounts = { vrijwilligersplicht: 5, vrijwilligersingepland: 2, vrijwilligersafgerond: 2 };
  const members = [child({ Email: 'kind@example.nl' })];
  const maps = { byKnvbId: new Map([['CHILD1', memberCounts]]), byParentEmail: new Map([['ouder@example.nl', parentCounts]]) };
  const entries = processMembers(members, mapping, buildAggregationMaps(members, mapping), new Map(), maps).listMembers.flat();
  for (const [email, expected] of [['kind@example.nl', memberCounts], ['ouder@example.nl', parentCounts]]) {
    const actual = entries.find(entry => entry.email === email).custom_fields;
    for (const [field, value] of Object.entries(expected)) assert.equal(actual[field], value);
  }
});

test('unavailable volunteer source omits every counter so Laposta retains last known data', () => {
  const fields = prepare([child()]).flat()[0].custom_fields;
  for (const field of ['vrijwilligersplicht', 'vrijwilligersingepland', 'vrijwilligersafgerond']) {
    assert.equal(Object.hasOwn(fields, field), false);
  }
});

test('three siblings and their standalone parent fit the four existing lists', () => {
  const members = ['Sanne', 'Tim', 'Kim'].map((FirstName, index) => child({ FirstName, PublicPersonId: `CHILD${index}` }));
  const result = processMembers(members, mapping, buildAggregationMaps(members, mapping), new Map(), null);
  assert.equal(result.excludedCount, 0);
  assert.deepEqual(result.listMembers.map(list => list.map(entry => entry.custom_fields.voornaam)), [['Sanne'], ['Tim'], ['Kim'], ['Petra']]);
  assert.equal(result.listMembers[3][0].custom_fields.geboortedatum, '');
});

test('a parent with an alternative member mailbox reuses their own identity', () => {
  const parent = { PublicPersonId: 'PARENT', Email: 'werk@example.nl', EmailAlternative: 'ouder@example.nl', FirstName: 'Petra', LastName: 'Jong', DateOfBirth: '1980-01-02' };
  const rows = prepare([child(), parent]).flat();
  assert.equal(rows.length, 3);
  assert.equal(rows.filter(row => row.custom_fields.relatiecode === 'PARENT').length, 2);
  assert.equal(rows.filter(row => row.custom_fields.geboortedatum === '').length, 0);
});

test('multiple adults sharing a mailbox reuse the explicitly named parent', () => {
  const members = [
    child({ NameParent1: 'Petra de Jong' }),
    { PublicPersonId: 'PARENT1', Email: 'ouder@example.nl', FirstName: 'Petra', Infix: 'de', LastName: 'Jong', DateOfBirth: '1980-01-02' },
    { PublicPersonId: 'PARENT2', Email: 'ouder@example.nl', FirstName: 'Pieter', Infix: 'de', LastName: 'Jong', DateOfBirth: '1979-03-04' }
  ];
  assert.equal(prepare(members).flat().length, 3);
});

test('duplicate source identities with the same adult name do not add another parent record', () => {
  const members = [child(), ...['PARENT1', 'PARENT2'].map(PublicPersonId => ({
    PublicPersonId, Email: 'ouder@example.nl', FirstName: 'Petra', LastName: 'Jong', DateOfBirth: '1980-01-02'
  }))];
  assert.equal(prepare(members).flat().length, 3);
});

test('capacity overflow is reported while retaining every member birthday before parents', () => {
  const members = ['Sanne', 'Tim', 'Kim', 'Jan'].map((FirstName, index) => child({ FirstName, PublicPersonId: `CHILD${index}` }));
  const result = processMembers(members, mapping, buildAggregationMaps(members, mapping), new Map(), null);
  assert.equal(result.excludedCount, 1);
  assert.deepEqual(result.listMembers.flat().map(entry => entry.custom_fields.voornaam), ['Sanne', 'Tim', 'Kim', 'Jan']);
  assert.ok(result.listMembers.flat().every(entry => entry.custom_fields.geboortedatum === '2014-10-08'));
});

function prepareWithLive(liveLists) {
  const members = [child()];
  return processMembers(members, mapping, buildAggregationMaps(members, mapping), new Map(), null, liveLists);
}
const liveEntry = (fields, state = 'active') => ({ email: 'ouder@example.nl', state, custom_fields: fields });

test('an older child contact reserves its slot and the new parent uses the next list', () => {
  const result = prepareWithLive([[], [liveEntry({ voornaam: 'Ander', relatiecode: 'OLD', geboortedatum: '2010-01-01' })]]);
  assert.equal(result.excludedCount, 0);
  assert.equal(result.listMembers[1].length, 0);
  assert.equal(result.listMembers[2][0].custom_fields.voornaam, 'Petra');
});

test('a matching parent keeps their current list and loses only a proven inherited child birthday', () => {
  const result = prepareWithLive([[], [], [liveEntry({ voornaam: 'Petra', relatiecode: 'CHILD1', geboortedatum: '2014-10-08' })]]);
  assert.equal(result.listMembers[1].length, 0);
  assert.equal(result.listMembers[2][0].custom_fields.geboortedatum, '');
  assert.equal(result.listMembers[2][0].custom_fields.relatiecode, '');
});

test('an older parents own birthday is reserved rather than cleared', () => {
  const result = prepareWithLive([[], [liveEntry({ voornaam: 'Petra', relatiecode: 'OLDPARENT', geboortedatum: '1980-01-02' })]]);
  assert.equal(result.listMembers[1].length, 0);
  assert.equal(result.listMembers[2][0].custom_fields.geboortedatum, '');
});

test('a new parent entry cannot bypass an unsubscribe in another list', () => {
  const result = prepareWithLive([[liveEntry({ voornaam: 'Sanne', relatiecode: 'CHILD1' }, 'unsubscribed')]]);
  assert.equal(result.listMembers.flat().length, 1);
  assert.equal(result.listMembers[0][0].custom_fields.voornaam, 'Sanne');
});

test('a suppressed existing parent stays on its list for suppress_reactivation protection', () => {
  const result = prepareWithLive([[], [liveEntry({ voornaam: 'Petra', geboortedatum: '' }, 'unsubscribed')]]);
  assert.equal(result.listMembers[1][0].custom_fields.voornaam, 'Petra');
});

test('the next run keeps the same separate parent placement', () => {
  const original = [[], [liveEntry({ voornaam: 'Ander', relatiecode: 'OLD', geboortedatum: '2010-01-01' })]];
  const first = prepareWithLive(original);
  const live = first.listMembers.map((rows, index) => [
    ...(original[index] || []), ...rows.map(row => ({ ...row, state: 'active' }))
  ]);
  const second = prepareWithLive(live);
  assert.deepEqual(second, first);
});

test('reserved legacy slots count as capacity instead of being overwritten', () => {
  const result = prepareWithLive([[], ...[1, 2, 3].map(index => [liveEntry({
    voornaam: `Legacy${index}`, relatiecode: `OLD${index}`, geboortedatum: '2000-01-01'
  })])]);
  assert.equal(result.excludedCount, 1);
  assert.equal(result.listMembers.flat().length, 1);
});
