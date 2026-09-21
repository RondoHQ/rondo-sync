const { rondoClubRequest } = require('./rondo-club-client');
const { openDb } = require('./rondo-club-db');
const { normalizeEmail } = require('./parent-dedupe');

const NO_OBLIGATION = Object.freeze({
  vrijwilligersplicht: -1,
  vrijwilligersingepland: 0,
  vrijwilligersafgerond: 0
});

/**
 * Use the same current-season obligation/household attribution as Rondo.
 * Required duties do not decrease when work is planned or completed.
 * Exempt units do not add a requirement, but retain their progress counts.
 * Missing/malformed source counts must never silently overwrite known values.
 */
function buildPersonObligationValues(units) {
  const states = new Map();

  for (const unit of units) {
    if (typeof unit.is_exempt !== 'boolean') {
      throw new Error('Rondo Club volunteer-obligations response is missing is_exempt');
    }
    for (const field of ['required_count', 'pending_count', 'completed_count']) {
      if (!Number.isSafeInteger(unit[field]) || unit[field] < 0) {
        throw new Error(`Rondo Club volunteer-obligations response has invalid ${field}`);
      }
    }
    const personIds = Array.from(new Set(
      (unit.person_ids || [])
        .map(personId => Number.parseInt(personId, 10))
        .filter(personId => Number.isInteger(personId) && personId > 0)
    ));
    for (const personId of personIds) {
      const key = String(personId);
      const state = states.get(key) || { ...NO_OBLIGATION };
      if (!unit.is_exempt) {
        state.vrijwilligersplicht = Math.max(0, state.vrijwilligersplicht) + unit.required_count;
      }
      state.vrijwilligersingepland += unit.pending_count;
      state.vrijwilligersafgerond += unit.completed_count;
      states.set(key, state);
    }
  }
  return states;
}

/**
 * Map Rondo person IDs to the identities used while preparing Laposta rows.
 * People without an obligation get -1 for the requirement and zero progress.
 * Laposta coerces an empty value for numeric fields to 0, which is reserved
 * for a zero requirement and would make those states indistinguishable.
 */
function buildRecipientObligationMaps(personValues, memberRows, parentRows) {
  const byKnvbId = new Map();
  const byParentEmail = new Map();

  for (const row of memberRows) {
    if (!row.knvb_id) continue;
    const personId = row.rondo_club_id ? String(row.rondo_club_id) : '';
    byKnvbId.set(String(row.knvb_id), personValues.has(personId) ? personValues.get(personId) : NO_OBLIGATION);
  }

  for (const row of parentRows) {
    const email = normalizeEmail(row.email);
    if (!email) continue;
    const personId = row.rondo_club_id ? String(row.rondo_club_id) : '';
    byParentEmail.set(email, personValues.has(personId) ? personValues.get(personId) : NO_OBLIGATION);
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
  return maps.byKnvbId.has(normalizedKnvbId) ? maps.byKnvbId.get(normalizedKnvbId) : NO_OBLIGATION;
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
