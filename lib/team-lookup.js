'use strict';

function normalizeTeamName(value) {
  return String(value || '').trim().toLowerCase();
}

// A shared name or code is not an identity. Retain null for collisions so
// adding another alias later cannot accidentally make that key usable again.
function buildUniqueTeamMap(teams, fields = ['team_name', 'team_code']) {
  const map = new Map();
  for (const team of teams) {
    for (const field of fields) {
      const key = normalizeTeamName(team[field]);
      if (!key) continue;
      if (!map.has(key)) map.set(key, team.rondo_club_id || null);
      else if (map.get(key) !== team.rondo_club_id) map.set(key, null);
    }
  }
  return map;
}

module.exports = { buildUniqueTeamMap, normalizeTeamName };
