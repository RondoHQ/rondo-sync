'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeRelationship, toBooleanFlag } = require('../lib/canonical-fields');

test('relationship writes retain only canonical writable fields', () => {
  assert.deepEqual(
    sanitizeRelationship({
      related_person_id: '42',
      relationship_type_id: '3',
      relationship_label: 'Kind',
      person_name: 'Derived name',
      person_thumbnail: 'https://example.test/photo.jpg',
      relationship_slug: 'child'
    }),
    {
      related_person_id: 42,
      relationship_type_id: 3,
      relationship_label: 'Kind'
    }
  );
});

test('canonical booleans and legacy one values map to enabled flags', () => {
  assert.equal(toBooleanFlag(true), true);
  assert.equal(toBooleanFlag(1), true);
  assert.equal(toBooleanFlag('1'), true);
  assert.equal(toBooleanFlag(false), false);
  assert.equal(toBooleanFlag(0), false);
  assert.equal(toBooleanFlag('0'), false);
});
