'use strict';

const { rondoClubRequest } = require('./rondo-club-client');

/** Preserve complete, timestamped source slots, including explicitly empty slots. */
function prepareParentSlotObservations(members, observedAt) {
  if (!observedAt || !Number.isFinite(Date.parse(observedAt))) return [];
  const seen = new Set();
  const duplicates = new Set();
  for (const member of members) {
    if (seen.has(member.PublicPersonId)) duplicates.add(member.PublicPersonId);
    seen.add(member.PublicPersonId);
  }
  return members.filter(member => member.PublicPersonId && !duplicates.has(member.PublicPersonId)
    && [1, 2].every(slot => ['EmailAddressParent', 'NameParent'].every(prefix =>
      Object.hasOwn(member, `${prefix}${slot}`)
      && (member[`${prefix}${slot}`] === null || typeof member[`${prefix}${slot}`] === 'string')
    ))).map(member => ({
    knvb_id: member.PublicPersonId,
    observed_at: new Date(observedAt).toISOString(),
    slots: [1, 2].map(slot => ({
      slot,
      email: (member[`EmailAddressParent${slot}`] || '').trim(),
      name: (member[`NameParent${slot}`] || '').trim()
    }))
  }));
}

/** Import labels only: no person/contact writes and no calls to Sportlink. */
async function submitParentSlotObservations(observations, memberIds, options = {}) {
  const request = options.rondoClubRequest || rondoClubRequest;
  const mapped = observations.filter(item => Number.isInteger(memberIds.get(item.knvb_id)))
    .map(item => ({ ...item, person_id: memberIds.get(item.knvb_id) }));
  const result = { observed: 0, matched: 0, skipped: observations.length - mapped.length, errors: [] };
  for (let offset = 0; offset < mapped.length; offset += 100) {
    const batch = mapped.slice(offset, offset + 100);
    try {
      const response = await request('rondo/v1/people/parent-slot-observations', 'POST', { observations: batch }, options);
      const rows = response.body?.results;
      if (!Array.isArray(rows) || rows.length !== batch.length) throw new Error('Incomplete parent-slot observation response');
      for (const row of rows) {
        if (row.error) result.errors.push({ person_id: row.person_id, message: row.error });
        else if (row.observed) {
          result.observed++;
          result.matched += row.matched || 0;
        } else result.skipped++;
      }
    } catch (error) {
      result.errors.push({ message: error.message, person_ids: batch.map(item => item.person_id) });
    }
  }
  return result;
}

module.exports = { prepareParentSlotObservations, submitParentSlotObservations };
