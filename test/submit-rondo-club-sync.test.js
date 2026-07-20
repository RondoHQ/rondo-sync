'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isTrackedParentKnownChild } = require('../steps/submit-rondo-club-sync');

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
