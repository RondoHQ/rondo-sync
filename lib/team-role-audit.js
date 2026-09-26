'use strict';

const { rondoClubRequest } = require('./rondo-club-client');

function roleKey(teamId, title) {
  return `${teamId}|${String(title || '').trim().toLowerCase()}`;
}

function hasUnmatchedCurrentRole(history, teamIds, rosterKeys, today) {
  return history.some(row => (
    teamIds.has(Number(row.team_id)) &&
    ![false, 0, '0'].includes(row.is_current) &&
    (!row.end_date || row.end_date >= today) &&
    !rosterKeys.has(roleKey(row.team_id, row.job_title))
  ));
}

// Inspect Rondo itself, not only the sync tracking rows: a role can remain
// current after its tracking row disappeared and its empty signature was cached.
async function findMembersNeedingRoleAudit(db, members, options = {}) {
  const request = options.request || rondoClubRequest;
  const today = options.today || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
  const teamIds = new Set(db.prepare('SELECT rondo_club_id FROM rondo_club_teams WHERE rondo_club_id IS NOT NULL').all().map(row => Number(row.rondo_club_id)));
  const rosters = new Map();
  for (const row of db.prepare(`
    SELECT tm.sportlink_person_id AS knvb_id, t.rondo_club_id, tm.role_description
    FROM sportlink_team_members tm
    JOIN rondo_club_teams t ON tm.sportlink_team_id = t.sportlink_id
  `).all()) {
    if (!rosters.has(row.knvb_id)) rosters.set(row.knvb_id, new Set());
    rosters.get(row.knvb_id).add(roleKey(row.rondo_club_id, row.role_description));
  }

  const candidates = new Set();
  const eligible = members.filter(member => !member.player_history_skip_reason);
  for (let offset = 0; offset < eligible.length; offset += 100) {
    const batch = eligible.slice(offset, offset + 100);
    const byId = new Map(batch.map(member => [Number(member.rondo_club_id), member]));
    const ids = [...byId.keys()].join(',');
    const response = await request(
      `wp/v2/people?include=${ids}&per_page=100&_fields=id,fields.work_history`,
      'GET', null, options
    );
    if (!Array.isArray(response.body)) throw new Error('Rondo team-role audit returned no person list');
    for (const person of response.body) {
      const member = byId.get(Number(person.id));
      if (!member) continue;
      const history = person.fields?.work_history;
      if (!Array.isArray(history)) throw new Error(`Rondo team-role audit returned no work history for ${member.knvb_id}`);
      if (hasUnmatchedCurrentRole(history, teamIds, rosters.get(member.knvb_id) || new Set(), today)) {
        candidates.add(member.knvb_id);
      }
    }
  }
  return candidates;
}

module.exports = { findMembersNeedingRoleAudit, hasUnmatchedCurrentRole, roleKey };
