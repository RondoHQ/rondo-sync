/**
 * Normalize the Rondo Club email lookup response.
 * Supports both the legacy `{ id }` shape and the richer `{ matches }` shape.
 *
 * @param {Object|null|undefined} body
 * @returns {Array<{id: number, status: string}>}
 */
function normalizePersonEmailMatches(body) {
  if (Array.isArray(body?.matches)) {
    return body.matches
      .map(match => ({ id: Number(match?.id), status: String(match?.status || 'publish') }))
      .filter(match => Number.isInteger(match.id) && match.id > 0);
  }

  const id = Number(body?.id);
  return Number.isInteger(id) && id > 0
    ? [{ id, status: String(body?.status || 'publish') }]
    : [];
}

/**
 * Select the first exact email match that is not a known child or sibling.
 * The API orders published matches before trashed matches.
 *
 * @param {Array<{id: number, status: string}>} matches
 * @param {Set<number>} knownChildIds
 * @returns {{id: number, status: string}|null}
 */
function selectParentEmailMatch(matches, knownChildIds) {
  return matches.find(match => !knownChildIds.has(match.id)) || null;
}

module.exports = { normalizePersonEmailMatches, selectParentEmailMatch };
