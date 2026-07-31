const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePeople } = require('../tools/preview-sponsit-rondo-from-tsv');

test('parses aggregate-only WP database export rows', () => {
  const [person] = parsePeople('12\tmember\t1\t44\t55\tJan\tJansen\tjan@example.test\tExample BV\n');
  assert.equal(person.id, 12);
  assert.equal(person.acf.person_type, 'member');
  assert.equal(person.acf.sponsit_person_id, '55');
});
