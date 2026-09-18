'use strict';

const { isDeepStrictEqual } = require('node:util');
const { rondoClubRequest } = require('./rondo-club-client');

function historyOf(person) {
  if (!Array.isArray(person?.fields?.work_history)) {
    throw new Error(`Missing readable work_history for person ${person?.id}`);
  }
  return person.fields.work_history;
}

function hasUnendedRole(row, today) {
  // Preserve explicit historical status and dates; do not invent an end date.
  if (row.end_date) return row.end_date >= today;
  return row.is_current !== false;
}

function preserveTeamHistory(history, teams) {
  return history.map(row => {
    const team = teams.get(Number(row.team_id));
    return team ? {
      ...row,
      team_id: null,
      team_name_text: team.team_name,
      entity_type: 'external_team'
    } : row;
  });
}

async function fetchPeople(request, options) {
  const people = [];
  for (let page = 1; ; page++) {
    const response = await request(
      `wp/v2/people?context=edit&status=publish,draft,private,pending,future,trash&per_page=100&page=${page}&_fields=id,fields.work_history`,
      'GET', null, options
    );
    if (!Array.isArray(response.body)) throw new Error('Incomplete people response');
    response.body.forEach(historyOf);
    people.push(...response.body);
    const pages = Number(response.headers?.['x-wp-totalpages']);
    if (!Number.isInteger(pages) || pages < 0) throw new Error('Missing people pagination metadata');
    if (page >= pages) return people;
  }
}

function assertTeamIdentity(post, team) {
  const name = post.title?.raw ?? post.title?.rendered;
  if (post.id !== team.rondo_club_id || post.type !== 'team' || name !== team.team_name ||
      String(post.fields?.publicteamid || '') !== String(team.sportlink_id)) {
    throw new Error(`Team identity mismatch for ${team.rondo_club_id}`);
  }
}

/**
 * Keep missing teams as drafts and preserve linked history as named historical
 * rows. Only sync-owned identities with no unended roles may be retired. Read
 * failures, changed identities and incomplete verification leave the team live.
 */
async function retireMissingTeams(orphans, options = {}) {
  const request = options.request || rondoClubRequest;
  const result = { retired: [], errors: [] };
  const candidates = new Map();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' })
    .format(options.now || new Date());
  const fail = (team, error) => result.errors.push({ team_name: team.team_name, message: error.message });

  for (const team of orphans) {
    if (!team.rondo_club_id) {
      result.retired.push(team);
      continue;
    }
    try {
      const { body } = await request(`wp/v2/teams/${team.rondo_club_id}?context=edit`, 'GET', null, options);
      assertTeamIdentity(body, team);
      candidates.set(team.rondo_club_id, team);
    } catch (error) {
      fail(team, error);
    }
  }
  if (!candidates.size) return result;

  // Fetch all statuses, including former members, rather than the active roster.
  const people = await fetchPeople(request, options);
  for (const person of people) {
    for (const row of historyOf(person)) {
      const team = candidates.get(Number(row.team_id));
      if (team && hasUnendedRole(row, today)) {
        candidates.delete(team.rondo_club_id);
        fail(team, new Error('Team still has an unended role; source history must be reconciled first'));
      }
    }
  }
  if (!candidates.size) return result;

  if (options.dryRun) {
    result.planned = [...candidates.values()].map(team => ({
      ...team,
      history_rows: people.reduce((count, person) => count + historyOf(person)
        .filter(row => Number(row.team_id) === team.rondo_club_id).length, 0)
    }));
    return result;
  }

  for (const person of people) {
    if (!historyOf(person).some(row => candidates.has(Number(row.team_id)))) continue;
    const endpoint = `wp/v2/people/${person.id}`;
    // Re-read just before saving the shared repeater to retain intervening edits.
    const { body: current } = await request(`${endpoint}?context=edit`, 'GET', null, options);
    const history = historyOf(current);
    for (const row of history) {
      const team = candidates.get(Number(row.team_id));
      if (team && hasUnendedRole(row, today)) {
        candidates.delete(team.rondo_club_id);
        fail(team, new Error('Team role changed during cleanup'));
      }
    }
    const next = preserveTeamHistory(history, candidates);
    if (isDeepStrictEqual(history, next)) continue;
    await request(endpoint, 'PUT', { fields: { work_history: next } }, options);
    const { body: verified } = await request(`${endpoint}?context=edit`, 'GET', null, options);
    if (!isDeepStrictEqual(historyOf(verified), next)) {
      throw new Error(`History preservation verification failed for person ${person.id}`);
    }
  }

  // Verify globally, including references added during the first pass.
  const remainingPeople = await fetchPeople(request, options);
  const referenced = new Set(remainingPeople.flatMap(person => historyOf(person).map(row => Number(row.team_id))));
  for (const [id, team] of candidates) {
    try {
      if (referenced.has(id)) throw new Error('Team still has linked history after preservation');
      const endpoint = `wp/v2/teams/${id}`;
      const { body: current } = await request(`${endpoint}?context=edit`, 'GET', null, options);
      assertTeamIdentity(current, team);
      if (current.status !== 'draft') await request(endpoint, 'PUT', { status: 'draft' }, options);
      const { body: verified } = await request(`${endpoint}?context=edit`, 'GET', null, options);
      assertTeamIdentity(verified, team);
      if (verified.status !== 'draft') throw new Error('Team archive verification failed');
      result.retired.push(team);
      options.logger?.log(`Archived missing Sportlink team: ${team.team_name} (${id})`);
    } catch (error) {
      fail(team, error);
    }
  }
  return result;
}

module.exports = { retireMissingTeams, preserveTeamHistory, hasUnendedRole };
