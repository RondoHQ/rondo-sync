'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isTrackedParentKnownChild,
  mergeParentChildRelationships
} = require('../steps/submit-rondo-club-sync');

test('recognizes a stale parent mapping to one of its own children', () => {
  const knownChildIds = new Set([491, 572, 573]);

  assert.equal(isTrackedParentKnownChild(491, knownChildIds), true);
});

test('recognizes a stale parent mapping to a globally known sibling', () => {
  const directChildIds = new Set([435, 797]);
  const allChildIds = new Set([...directChildIds, 443]);

  assert.equal(isTrackedParentKnownChild(443, allChildIds), true);
  assert.equal(isTrackedParentKnownChild(443, directChildIds), false);
});

test('keeps a genuine separate parent mapping', () => {
  const knownChildIds = new Set([435, 443, 797]);

  assert.equal(isTrackedParentKnownChild(9001, knownChildIds), false);
  assert.equal(isTrackedParentKnownChild(null, knownChildIds), false);
});

test('preserves manually linked former children while refreshing current children', () => {
  const existing = [
    {
      related_person_id: 4893,
      relationship_type_id: 3,
      relationship_label: '',
      person_name: 'Derived name',
      person_thumbnail: 'https://example.test/photo.jpg'
    },
    { related_person_id: 4894, relationship_type_id: 9, relationship_label: '' },
    { related_person_id: 708, relationship_type_id: 3, relationship_label: '' },
    { related_person_id: 9000, relationship_type_id: 4, relationship_label: '' }
  ];
  const current = [
    { related_person_id: 708, relationship_type_id: 3, relationship_label: '' },
    { related_person_id: 707, relationship_type_id: 3, relationship_label: '' }
  ];

  assert.deepEqual(
    mergeParentChildRelationships(existing, current, new Set([707, 708]), 8604),
    [
      { related_person_id: 4893, relationship_type_id: 3, relationship_label: '' },
      { related_person_id: 4894, relationship_type_id: 3, relationship_label: '' },
      { related_person_id: 9000, relationship_type_id: 4, relationship_label: '' },
      { related_person_id: 708, relationship_type_id: 3, relationship_label: '' },
      { related_person_id: 707, relationship_type_id: 3, relationship_label: '' }
    ]
  );
});

test('drops stale links for current children and prevents a parent self-link', () => {
  const existing = [
    { related_person_id: 708, relationship_type_id: 9, relationship_label: '' },
    { related_person_id: 8604, relationship_type_id: 3, relationship_label: '' }
  ];
  const current = [
    { related_person_id: 708, relationship_type_id: 3, relationship_label: '' },
    { related_person_id: 8604, relationship_type_id: 3, relationship_label: '' }
  ];

  assert.deepEqual(
    mergeParentChildRelationships(existing, current, new Set([708]), 8604),
    [
      { related_person_id: 708, relationship_type_id: 3, relationship_label: '' }
    ]
  );
});
