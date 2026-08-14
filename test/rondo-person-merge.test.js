'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fetchPersonFollowingMerge,
  resolveMergedPersonId
} = require('../lib/rondo-person-merge');

function apiError(status) {
  const error = new Error(`Rondo Club API error (${status})`);
  error.details = { data: { status } };
  return error;
}

test('resolves a merged source ID to its surviving person', async () => {
  const requests = [];
  const request = async (endpoint) => {
    requests.push(endpoint);
    if (endpoint === 'wp/v2/people/8010') throw apiError(404);
    if (endpoint === 'rondo/v1/people/8010/merge-target') {
      return { body: { person_id: 8010, merged_into_person_id: 209 } };
    }
    if (endpoint === 'wp/v2/people/209') return { body: { id: 209, fields: {} } };
    throw new Error(`Unexpected endpoint: ${endpoint}`);
  };

  const result = await fetchPersonFollowingMerge(8010, {}, request);

  assert.equal(result.personId, 209);
  assert.equal(result.remapped, true);
  assert.equal(result.response.body.id, 209);
  assert.deepEqual(requests, [
    'wp/v2/people/8010',
    'rondo/v1/people/8010/merge-target',
    'wp/v2/people/209'
  ]);
});

test('returns null when a missing person was not merged', async () => {
  const request = async () => {
    throw apiError(404);
  };

  assert.equal(await fetchPersonFollowingMerge(999, {}, request), null);
});

test('does not hide merge lookup failures behind duplicate creation', async () => {
  let calls = 0;
  const request = async () => {
    calls += 1;
    if (calls === 1) throw apiError(404);
    throw apiError(503);
  };

  await assert.rejects(
    fetchPersonFollowingMerge(8010, {}, request),
    /503/
  );
});

test('rejects malformed merge target responses before creating a duplicate', async () => {
  const request = async () => ({ body: { merged_into_person_id: 'not-an-id' } });

  await assert.rejects(
    resolveMergedPersonId(8010, {}, request),
    /Invalid merge target response/
  );
});
