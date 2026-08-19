const { rondoClubRequest } = require('./rondo-club-client');
const { openDb } = require('./rondo-club-db');
const { normalizeEmail } = require('./parent-dedupe');

/**
 * Convert Rondo obligation units to one Laposta value per Rondo person ID.
 *
 * Non-applicable people are added later from the local identity tables as -1.
 * A person with at least one active unit gets the sum of all remaining duties.
 * Only when every applicable unit is exempt do they receive -1.
 *
 * @param {Array<Object>} units Decorated units from /volunteer-obligations.
 * @returns {Map<string, number>}
 */
function buildPersonObligationValues(units) {
  const states = new Map();

  for (const unit of units) {
    if (!Object.hasOwn(unit, 'is_exempt')) {
      throw new Error('Rondo Club volunteer-obligations response is missing is_exempt');
    }

    const personIds = Array.from(new Set(
      (unit.person_ids || [])
        .map(personId => Number.parseInt(personId, 10))
        .filter(personId => Number.isInteger(personId) && personId > 0)
    ));
    const remaining = Math.max(0, Number.parseInt(unit.remaining, 10) || 0);

    for (const personId of personIds) {
      const key = String(personId);
      const state = states.get(key) || { activeUnits: 0, exemptUnits: 0, remaining: 0 };
      if (unit.is_exempt) {
        state.exemptUnits += 1;
      } else {
        state.activeUnits += 1;
        state.remaining += remaining;
      }
      states.set(key, state);
    }
  }

  const values = new Map();
  for (const [personId, state] of states) {
    values.set(personId, state.activeUnits > 0 ? state.remaining : -1);
  }
  return values;
}

/**
 * Map Rondo person IDs to the identities used while preparing Laposta rows.
 * People without an obligation map to -1 (vrijgesteld / not applicable).
 * Laposta coerces an empty value for numeric fields to 0, which is reserved
 * for completed obligations and would make those states indistinguishable.
 */
function buildRecipientObligationMaps(personValues, memberRows, parentRows) {
  const byKnvbId = new Map();
  const byParentEmail = new Map();

  for (const row of memberRows) {
    if (!row.knvb_id) continue;
    const personId = row.rondo_club_id ? String(row.rondo_club_id) : '';
    byKnvbId.set(String(row.knvb_id), personValues.has(personId) ? personValues.get(personId) : -1);
  }

  for (const row of parentRows) {
    const email = normalizeEmail(row.email);
    if (!email) continue;
    const personId = row.rondo_club_id ? String(row.rondo_club_id) : '';
    byParentEmail.set(email, personValues.has(personId) ? personValues.get(personId) : -1);
  }

  return { byKnvbId, byParentEmail };
}

/**
 * Resolve the value for one concrete Laposta relation.
 * Standalone parent rows prefer their own Rondo person mapping and fall back
 * to the child whose Sportlink row created the relation.
 */
function resolveLapostaObligationValue(maps, { knvbId, email, emailType }) {
  if (!maps) return undefined;

  if (emailType === 'parent1' || emailType === 'parent2') {
    const normalizedEmail = normalizeEmail(email);
    if (maps.byParentEmail.has(normalizedEmail)) {
      return maps.byParentEmail.get(normalizedEmail);
    }
  }

  const normalizedKnvbId = knvbId ? String(knvbId) : '';
  return maps.byKnvbId.has(normalizedKnvbId) ? maps.byKnvbId.get(normalizedKnvbId) : -1;
}

/** Fetch the current-season obligation view and join it to local sync identities. */
async function fetchVolunteerObligationMaps(options = {}) {
  const response = await rondoClubRequest(
    'rondo/v1/volunteer-obligations',
    'GET',
    null,
    options
  );
  const units = response.body?.units;
  if (!Array.isArray(units)) {
    throw new Error('Rondo Club volunteer-obligations response has no units array');
  }

  const personValues = buildPersonObligationValues(units);
  const db = openDb();
  try {
    const memberRows = db.prepare(`
      SELECT knvb_id, rondo_club_id
      FROM rondo_club_members
      WHERE knvb_id IS NOT NULL
    `).all();
    const parentRows = db.prepare(`
      SELECT email, rondo_club_id
      FROM rondo_club_parents
      WHERE email IS NOT NULL
    `).all();

    return {
      ...buildRecipientObligationMaps(personValues, memberRows, parentRows),
      season: response.body?.season || null,
      unitCount: units.length
    };
  } finally {
    db.close();
  }
}

module.exports = {
  buildPersonObligationValues,
  buildRecipientObligationMaps,
  resolveLapostaObligationValue,
  fetchVolunteerObligationMaps
};
