const { rondoClubRequest } = require('./rondo-club-client');

function hasHttpStatus(error, status) {
  return Number(error?.details?.data?.status || error?.details?.status) === status
    || String(error?.message || '').includes(`(${status})`);
}

/**
 * Resolve a WordPress person ID that was retired by Rondo Club's merge flow.
 * A 404 means the ID was not merged; other failures must surface so the sync
 * never creates a duplicate merely because the redirect lookup was unavailable.
 */
async function resolveMergedPersonId(personId, options = {}, request = rondoClubRequest) {
  try {
    const response = await request(
      `rondo/v1/people/${personId}/merge-target`,
      'GET',
      null,
      options
    );
    const targetId = Number(response.body?.merged_into_person_id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      throw new Error(`Invalid merge target response for Rondo person ${personId}`);
    }
    return targetId;
  } catch (error) {
    if (hasHttpStatus(error, 404)) return null;
    throw error;
  }
}

/**
 * Fetch a tracked person, following the merge audit link after a 404.
 */
async function fetchPersonFollowingMerge(personId, options = {}, request = rondoClubRequest) {
  try {
    const response = await request(`wp/v2/people/${personId}`, 'GET', null, options);
    return { personId, response, remapped: false };
  } catch (error) {
    if (!hasHttpStatus(error, 404)) throw error;
  }

  const targetId = await resolveMergedPersonId(personId, options, request);
  if (!targetId) return null;

  const response = await request(`wp/v2/people/${targetId}`, 'GET', null, options);
  return { personId: targetId, response, remapped: targetId !== personId };
}

module.exports = {
  fetchPersonFollowingMerge,
  hasHttpStatus,
  resolveMergedPersonId
};
