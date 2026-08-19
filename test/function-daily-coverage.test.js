'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { selectDailyCoverageMembers } = require('../steps/download-functions-from-sportlink');

const members = Array.from({ length: 17 }, (_, index) => ({
  knvb_id: `MEMBER-${String(index + 1).padStart(2, '0')}`
}));

test('four scheduled Amsterdam runs cover every member exactly once per day', () => {
  const runTimes = [
    new Date('2026-08-19T05:30:00Z'), // 07:30 Amsterdam.
    new Date('2026-08-19T08:30:00Z'), // 10:30 Amsterdam.
    new Date('2026-08-19T11:30:00Z'), // 13:30 Amsterdam.
    new Date('2026-08-19T14:30:00Z')  // 16:30 Amsterdam.
  ];

  const selected = runTimes.flatMap(now => selectDailyCoverageMembers(members, now));
  assert.equal(selected.length, members.length);
  assert.deepEqual(
    selected.map(member => member.knvb_id).sort(),
    members.map(member => member.knvb_id).sort()
  );
});

test('coverage selection is stable regardless of database row order', () => {
  const now = new Date('2026-08-19T08:30:00Z');
  const forward = selectDailyCoverageMembers(members, now).map(member => member.knvb_id);
  const reverse = selectDailyCoverageMembers([...members].reverse(), now).map(member => member.knvb_id);

  assert.deepEqual(reverse, forward);
});
