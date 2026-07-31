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

/**
 * Decide which parts of an existing Rondo profile remain owned by another
 * source when the same person is also linked as a Sportlink parent.
 *
 * A former member keeps their historical member identity, but their current
 * parent contact/address data comes from the active child's Sportlink record.
 *
 * @param {Object|null|undefined} acf
 * @returns {{preserveIdentity: boolean, preserveContact: boolean}}
 */
function getParentProfileOwnership(acf) {
  if (!acf || typeof acf !== 'object') {
    return { preserveIdentity: false, preserveContact: false };
  }

  const personType = String(acf.person_type || '').trim().toLowerCase();
  const isSponsor = acf.is_sponsor === true || acf.is_sponsor === 1 || acf.is_sponsor === '1';
  const isExternalContact = Boolean(
    personType === 'contact' ||
    isSponsor ||
    acf.sponsit_contact_id ||
    acf.sponsit_person_id
  );

  if (isExternalContact) {
    return { preserveIdentity: true, preserveContact: true };
  }

  if (acf['knvb_id']) {
    const isFormerMember = acf.former_member === true || acf.former_member === 1 || acf.former_member === '1';
    return {
      preserveIdentity: true,
      preserveContact: !isFormerMember
    };
  }

  return { preserveIdentity: false, preserveContact: false };
}

module.exports = {
  normalizePersonEmailMatches,
  selectParentEmailMatch,
  getParentProfileOwnership
};
