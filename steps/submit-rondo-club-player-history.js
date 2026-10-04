require('dotenv/config');

const { rondoClubRequest } = require('../lib/rondo-club-client');
const { openDb, getPlayerHistoryMembers, getAllTeams, computeMemberTeamSignature, updateMemberPlayerHistorySignature } = require('../lib/rondo-club-db');
const { createSyncLogger } = require('../lib/logger');
const { SportlinkSession } = require('../lib/sportlink-session');
const { fetchMemberTeamMemberships } = require('./download-functions-from-sportlink');
const { normalizeTeamMembershipSeasons, isTeamMembershipCurrent } = require('../lib/team-membership-periods');
const { buildUniqueTeamMap } = require('../lib/team-lookup');
const { findMembersNeedingRoleAudit, hasUnmatchedCurrentRole, roleKey } = require('../lib/team-role-audit');

function formatDateForFields(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const trimmed = dateStr.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

// WordPress text fields collapse whitespace when saved. Compare and emit the
// same representation so a Sportlink double space cannot create a row per run.
function normalizeHistoryText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeGameType(gameTypeDescription) {
  if (!gameTypeDescription || typeof gameTypeDescription !== 'string') return '';
  return normalizeHistoryText(gameTypeDescription.replace(/^Veld\s*-\s*/i, ''));
}

function buildFallbackTeamName(teamRow) {
  const prefix = normalizeGameType(teamRow.GameTypeDescription);
  const teamName = normalizeHistoryText(teamRow.TeamName);
  if (prefix && teamName) return `${prefix} ${teamName}`;
  return teamName || '';
}

function buildJobTitle(teamRow) {
  return (
    teamRow.RoleFunctionDescription ||
    teamRow.FunctionDescription ||
    teamRow.RoleDescription ||
    'Teamspeler'
  );
}

function buildSignature(entry) {
  const teamKey = entry.team_id
    ? `id:${entry.team_id}`
    : `name:${normalizeHistoryText(entry.team_name_text).toLowerCase()}`;
  const start = String(entry.start_date || '');
  const end = String(entry.end_date || '');
  const title = String(entry.job_title || '').trim().toLowerCase();
  return `${teamKey}|${start}|${end}|${title}|${entry.is_current === false ? 0 : 1}`;
}

function buildAssignmentKey(entry) {
  const teamKey = entry.team_id
    ? `id:${entry.team_id}`
    : `name:${normalizeHistoryText(entry.team_name_text).toLowerCase()}`;
  const title = String(entry.job_title || '').trim().toLowerCase();
  return `${teamKey}|${title}`;
}

/**
 * Reconcile Sportlink membership history with the shared native field repeater.
 * The old append-only merge added a second ended row when RelationEnd
 * appeared, leaving the original assignment incorrectly marked current.
 */
function reconcilePlayerHistory(existingWorkHistory, sourceEntries) {
  const workHistory = existingWorkHistory.map(entry => ({ ...entry }));
  const currentSourceKeys = new Set(
    sourceEntries.filter(entry => entry.is_current).map(buildAssignmentKey)
  );
  const latestEndedByKey = new Map();

  for (const entry of sourceEntries) {
    if (entry.is_current || !entry.end_date) continue;
    const key = buildAssignmentKey(entry);
    const previous = latestEndedByKey.get(key);
    if (!previous || String(previous.end_date) < String(entry.end_date)) {
      latestEndedByKey.set(key, entry);
    }
  }

  let created = 0;
  let reconciled = 0;

  for (const sourceEntry of sourceEntries) {
    const signature = buildSignature(sourceEntry);
    if (workHistory.some(entry => buildSignature(entry) === signature)) continue;

    const key = buildAssignmentKey(sourceEntry);
    let index = workHistory.findIndex(entry => (
      buildAssignmentKey(entry) === key &&
      String(entry.start_date || '') === String(sourceEntry.start_date || '')
    ));

    if (index < 0 && (sourceEntry.is_current || !currentSourceKeys.has(key))) {
      index = workHistory.findIndex(entry => (
        buildAssignmentKey(entry) === key && entry.is_current !== false
      ));
    }

    if (index >= 0) {
      workHistory[index] = { ...workHistory[index], ...sourceEntry };
      reconciled++;
    } else {
      workHistory.push(sourceEntry);
      created++;
    }
  }

  // Also close a legacy current duplicate when the exact ended source row
  // already existed and therefore needed no in-place update above.
  for (let index = 0; index < workHistory.length; index++) {
    const entry = workHistory[index];
    if (entry.is_current === false) continue;
    const key = buildAssignmentKey(entry);
    if (currentSourceKeys.has(key)) continue;

    const endedSource = latestEndedByKey.get(key);
    if (!endedSource) continue;
    workHistory[index] = {
      ...entry,
      is_current: false,
      end_date: endedSource.end_date
    };
    reconciled++;
  }

  return { workHistory, created, reconciled };
}

function buildHistoricalTeamName(teamRow) {
  const baseName = buildFallbackTeamName(teamRow);
  const season = normalizeHistoryText(teamRow.SeasonDescription);
  if (baseName && season) return `${baseName} (${season})`;
  return baseName || season || 'Onbekend team';
}

function resolveTeamRondoClubId(teamRow, teamBySportlinkId, teamByName) {
  if (teamRow.PublicTeamId) {
    return teamBySportlinkId.get(String(teamRow.PublicTeamId)) || null;
  }

  const fallbackName = buildFallbackTeamName(teamRow);
  if (fallbackName) {
    const byFallbackName = teamByName.get(fallbackName.toLowerCase());
    if (byFallbackName) return byFallbackName;
  }

  if (teamRow.TeamName) {
    const byTeamName = teamByName.get(String(teamRow.TeamName).trim().toLowerCase());
    if (byTeamName) return byTeamName;
  }

  return null;
}

async function syncMemberPlayerHistory(member, teamRows, teamBySportlinkId, teamByName, options = {}) {
  const { verbose = false, logger } = options;
  const logVerbose = logger?.verbose?.bind(logger) || (verbose ? console.log : () => {});

  const result = {
    synced: false,
    created: 0,
    reconciled: 0,
    textFallback: 0,
    currentTextFallback: 0,
    skippedDuplicate: 0
  };

  if (!member.rondo_club_id) {
    return result;
  }

  const response = await rondoClubRequest(`wp/v2/people/${member.rondo_club_id}`, 'GET', null, { logger, verbose });
  const person = response.body || {};
  const existingWorkHistory = Array.isArray(person.fields?.work_history) ? person.fields.work_history : [];

  const sourceEntries = [];
  const sourceSignatures = new Set();

  for (const row of normalizeTeamMembershipSeasons(teamRows, options.now)) {
    const teamRondoClubId = resolveTeamRondoClubId(row, teamBySportlinkId, teamByName);

    const entry = {
      job_title: buildJobTitle(row),
      is_current: isTeamMembershipCurrent(row),
      start_date: formatDateForFields(row.RelationStart),
      end_date: formatDateForFields(row.RelationEnd)
    };

    if (teamRondoClubId) {
      entry.team_id = teamRondoClubId;
    } else {
      entry.team_name_text = buildHistoricalTeamName(row);
      entry.entity_type = 'external_team';
      result.textFallback++;
      if (entry.is_current) result.currentTextFallback++;
    }

    const signature = buildSignature(entry);
    if (sourceSignatures.has(signature)) {
      result.skippedDuplicate++;
      continue;
    }

    sourceSignatures.add(signature);
    sourceEntries.push(entry);
  }

  const reconciliation = reconcilePlayerHistory(existingWorkHistory, sourceEntries);
  if (options.auditCurrentRoles) {
    const teamIds = new Set([...teamBySportlinkId.values()].map(Number));
    const sourceKeys = new Set(sourceEntries.map(entry => roleKey(entry.team_id, entry.job_title)));
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(new Date());
    if (hasUnmatchedCurrentRole(reconciliation.workHistory, teamIds, sourceKeys, today)) {
      throw new Error('Current Rondo team role is absent from Sportlink history; preserved for review');
    }
  }
  result.created = reconciliation.created;
  result.reconciled = reconciliation.reconciled;

  if (result.created === 0 && result.reconciled === 0) {
    return result;
  }

  await rondoClubRequest(
    `wp/v2/people/${member.rondo_club_id}`,
    'PUT',
    {
      fields: {
        first_name: person.fields?.first_name || '',
        last_name: person.fields?.last_name || '',
        work_history: reconciliation.workHistory
      }
    },
    { logger, verbose }
  );

  result.synced = true;
  logVerbose(`  Added ${result.created} and reconciled ${result.reconciled} work history row(s) for ${member.knvb_id}`);
  return result;
}

function buildTeamLookupMaps(db) {
  const teams = getAllTeams(db);
  const teamBySportlinkId = new Map();
  const teamByName = buildUniqueTeamMap(teams, ['team_name']);
  for (const team of teams) {
    if (!team.rondo_club_id) continue;
    if (team.sportlink_id) {
      teamBySportlinkId.set(String(team.sportlink_id), team.rondo_club_id);
    }
  }
  return { teamBySportlinkId, teamByName };
}

async function syncSingleMember(options = {}) {
  const {
    db,
    knvbId,
    rondoClubId,
    teamRows = [],
    verbose = false,
    logger
  } = options;

  const { teamBySportlinkId, teamByName } = buildTeamLookupMaps(db);
  try {
    const res = await syncMemberPlayerHistory(
      { knvb_id: knvbId, rondo_club_id: rondoClubId },
      teamRows,
      teamBySportlinkId,
      teamByName,
      { verbose, logger }
    );
    return {
      success: true,
      synced: res.synced ? 1 : 0,
      created: res.created || 0,
      reconciled: res.reconciled || 0,
      textFallback: res.textFallback || 0,
      currentTextFallback: res.currentTextFallback || 0,
      skippedDuplicate: res.skippedDuplicate || 0,
      errors: []
    };
  } catch (error) {
    return {
      success: false,
      synced: 0,
      created: 0,
      reconciled: 0,
      textFallback: 0,
      currentTextFallback: 0,
      skippedDuplicate: 0,
      errors: [{ knvb_id: knvbId, message: error.message }]
    };
  }
}

async function fetchPlayerHistoryWithRetry(page, knvbId, logger, options = {}) {
  const { session, fetchMemberships = fetchMemberTeamMemberships } = options;
  try {
    return await fetchMemberships(page, knvbId, logger, { strict: true });
  } catch (error) {
    if (error.code === 'ERR_SPORTLINK_MEMBER_NOT_FOUND') throw error;
    const message = String(error?.message || '').toLowerCase();
    const retryable = error.code === 'ERR_MEMBER_TEAMS_PANEL_NOT_LOADED' || [
      'non-json', 'json parse', 'failed to fetch', 'timeout', 'memberteams request failed'
    ].some(fragment => message.includes(fragment));
    if (!retryable) throw error;

    logger.verbose(`  Membership fetch failed for ${knvbId}; retrying once${session ? ' after re-authentication' : ''}...`);
    if (session) {
      await session.relogin();
      page = await session.getPage();
    }
    return fetchMemberships(page, knvbId, logger, { strict: true });
  }
}

async function runSync(options = {}) {
  const { verbose = false, knvbIds = null, page: sharedPage, session: sharedSession, onProgress = null, force = false } = options;
  const createdLogger = !options.logger;
  const logger = options.logger || createSyncLogger({ verbose, prefix: 'player-history' });

  const result = {
    success: true,
    total: 0,
    downloaded: 0,
    synced: 0,
    created: 0,
    reconciled: 0,
    textFallback: 0,
    skippedDuplicate: 0,
    skippedUnchanged: 0,
    skippedQuarantined: 0,
    quarantined: [],
    errors: []
  };

  const db = openDb();
  let session;

  try {
    let members = getPlayerHistoryMembers(db);
    if (Array.isArray(knvbIds) && knvbIds.length > 0) {
      const requested = new Set(knvbIds.map(String));
      members = members.filter(member => requested.has(String(member.knvb_id)));
    }

    result.total = members.length;
    if (members.length === 0) {
      logger.log('No tracked members found for player history sync.');
      return result;
    }

    const { teamBySportlinkId, teamByName } = buildTeamLookupMaps(db);
    const roleAuditMembers = await findMembersNeedingRoleAudit(db, members, { logger });
    logger.log(`Current Rondo team roles requiring source verification: ${roleAuditMembers.size}`);

    let page;
    if (sharedPage) {
      page = sharedPage;
    } else {
      session = new SportlinkSession({ logger });
      page = await session.getPage();
    }

    for (let i = 0; i < members.length; i++) {
      const member = members[i];

      // Skip members explicitly quarantined via tools/player-history-quarantine.js.
      // Used when Sportlink's /member-details/{id}/memberships endpoint is
      // broken for a specific member (e.g. PKWR41Q since 2026-03-02) and we
      // don't want every run to waste 45s + emit an error on them.
      // --force does NOT lift the quarantine — that's an explicit human action.
      if (member.player_history_skip_reason) {
        result.skippedQuarantined++;
        result.quarantined.push({
          knvb_id: member.knvb_id,
          reason: member.player_history_skip_reason
        });
        if (onProgress) {
          onProgress({ current: i + 1, total: members.length, label: `${member.knvb_id} (quarantined)` });
        }
        continue;
      }

      // Skip members whose current team-membership signature matches the
      // one stored at their last successful run, unless the Rondo role audit
      // found a current role missing from the roster. An empty cached roster
      // does not prove that Rondo received the source's termination dates.
      // --force / force=true bypasses this for one-off backfills or to
      // recover from a suspected Sportlink historical correction.
      const currentSignature = computeMemberTeamSignature(db, member.knvb_id);
      if (
        !force && !roleAuditMembers.has(member.knvb_id) &&
        member.last_player_history_team_signature !== null &&
        member.last_player_history_team_signature !== undefined &&
        member.last_player_history_team_signature === currentSignature
      ) {
        result.skippedUnchanged++;
        if (onProgress) {
          onProgress({ current: i + 1, total: members.length, label: `${member.knvb_id} (unchanged)` });
        }
        continue;
      }

      logger.log(`Processing ${i + 1}/${members.length}: ${member.knvb_id}`);
      if (onProgress) {
        onProgress({ current: i + 1, total: members.length, label: member.knvb_id });
      }

      let memberSucceeded = false;
      try {
        const teamRows = await fetchPlayerHistoryWithRetry(page, member.knvb_id, logger, {
          session: session || sharedSession
        });
        result.downloaded++;

        if (!teamRows || teamRows.length === 0) {
          if (roleAuditMembers.has(member.knvb_id)) {
            throw new Error('Current Rondo team role has no Sportlink history; preserved for review');
          }
          // Member has no Sportlink team data — record that we checked so
          // future runs with the same (empty) signature skip them.
          memberSucceeded = true;
          continue;
        }

        const syncResult = await syncMemberPlayerHistory(
          member,
          teamRows,
          teamBySportlinkId,
          teamByName,
          { verbose, logger, auditCurrentRoles: roleAuditMembers.has(member.knvb_id) }
        );

        if (syncResult.synced) result.synced++;
        result.created += syncResult.created;
        result.reconciled += syncResult.reconciled;
        result.textFallback += syncResult.textFallback;
        result.skippedDuplicate += syncResult.skippedDuplicate;
        memberSucceeded = true;
      } catch (error) {
        result.errors.push({
          knvb_id: member.knvb_id,
          message: error.message
        });
      } finally {
        if (memberSucceeded) {
          try {
            updateMemberPlayerHistorySignature(db, member.knvb_id, currentSignature);
          } catch (sigErr) {
            logger.verbose(`  Failed to update player-history signature for ${member.knvb_id}: ${sigErr.message}`);
          }
        }
      }

      if (i < members.length - 1) {
        const delay = 500 + Math.random() * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    if (result.errors.length > 0) {
      result.success = false;
    }

    logger.log(`Player history fetched for ${result.downloaded}/${result.total} member(s)`);
    logger.log(`  Members updated: ${result.synced}`);
    logger.log(`  Work history rows created: ${result.created}`);
    logger.log(`  Work history rows reconciled: ${result.reconciled}`);
    if (result.skippedUnchanged > 0) {
      logger.log(`  Skipped (team data unchanged since last run): ${result.skippedUnchanged}`);
    }
    if (result.skippedQuarantined > 0) {
      logger.log(`  Skipped (quarantined): ${result.skippedQuarantined}`);
      for (const q of result.quarantined) {
        logger.log(`    - ${q.knvb_id}: ${q.reason}`);
      }
    }
    if (result.textFallback > 0) {
      logger.log(`  Rows written with text fallback (no Rondo team match): ${result.textFallback}`);
    }
    if (result.skippedDuplicate > 0) {
      logger.log(`  Rows skipped (already present): ${result.skippedDuplicate}`);
    }
    if (result.errors.length > 0) {
      logger.log(`  Errors: ${result.errors.length}`);
    }

    return result;
  } finally {
    if (session) {
      await session.close();
    }
    db.close();
    if (createdLogger && typeof logger.close === 'function') {
      logger.close();
    }
  }
}

module.exports = {
  fetchPlayerHistoryWithRetry,
  runSync,
  syncSingleMember,
  syncMemberPlayerHistory,
  formatDateForFields,
  buildFallbackTeamName,
  resolveTeamRondoClubId,
  reconcilePlayerHistory
};

if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const force = process.argv.includes('--force');
  const knvbIdx = process.argv.indexOf('--knvb-id');
  const knvbIds = knvbIdx >= 0 && process.argv[knvbIdx + 1]
    ? process.argv[knvbIdx + 1].split(',').map(id => id.trim()).filter(Boolean)
    : null;

  runSync({ verbose, knvbIds, force })
    .then((res) => {
      if (!res.success) process.exitCode = 1;
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
