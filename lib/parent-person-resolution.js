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
 * Normalize a person's fixed name fields for identity comparisons.
 * Parent imports historically store the complete name in first_name, while
 * member imports split it over first_name, infix, and last_name.
 *
 * @param {Object|null|undefined} fields
 * @returns {string}
 */
function normalizePersonName(fields) {
  if (!fields || typeof fields !== 'object') return '';

  return [fields.first_name, fields.infix, fields.last_name]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' ')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('nl-NL')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Determine whether a standalone parent profile can safely become a member.
 * Email alone is deliberately insufficient because children commonly use a
 * parent's address as their own Sportlink email.
 *
 * @param {Object} member
 * @param {Object} parent
 * @param {Set<number>} mappedMemberIds
 * @returns {boolean}
 */
function isSafeParentToMemberTransition(member, parent, mappedMemberIds = new Set()) {
  const memberEmail = String(member?.email || '').trim().toLowerCase();
  const parentEmail = String(parent?.email || '').trim().toLowerCase();
  const parentId = Number(parent?.rondo_club_id);
  const childKnvbIds = new Set((parent?.childKnvbIds || []).map(String));

  if (!memberEmail || memberEmail !== parentEmail) return false;
  if (!Number.isInteger(parentId) || parentId <= 0) return false;
  if (childKnvbIds.size === 0) return false;
  if (mappedMemberIds.has(parentId)) return false;
  if (childKnvbIds.has(String(member?.knvb_id || ''))) return false;

  const memberName = normalizePersonName(member?.data?.fields);
  const parentName = normalizePersonName(parent?.data?.fields);
  return Boolean(memberName && parentName && memberName === parentName);
}

/**
 * Decide which parts of an existing Rondo profile remain owned by another
 * source when the same person is also linked as a Sportlink parent.
 *
 * A former member keeps their historical member identity, but their current
 * parent contact/address data comes from the active child's Sportlink record.
 *
 * @param {Object|null|undefined} fields
 * @returns {{preserveIdentity: boolean, preserveContact: boolean}}
 */
function getParentProfileOwnership(fields) {
  if (!fields || typeof fields !== 'object') {
    return { preserveIdentity: false, preserveContact: false };
  }

  const personType = String(fields.person_type || '').trim().toLowerCase();
  const isSponsor = fields.is_sponsor === true || fields.is_sponsor === 1 || fields.is_sponsor === '1';
  const isExternalContact = Boolean(
    personType === 'contact' ||
    isSponsor ||
    fields.sponsit_contact_id ||
    fields.sponsit_person_id
  );

  if (isExternalContact) {
    return { preserveIdentity: true, preserveContact: true };
  }

  if (fields['knvb_id']) {
    const isFormerMember = fields.former_member === true || fields.former_member === 1 || fields.former_member === '1';
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
  normalizePersonName,
  isSafeParentToMemberTransition,
  getParentProfileOwnership
};
