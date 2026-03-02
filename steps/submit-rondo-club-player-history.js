require('dotenv/config');

const { chromium } = require('playwright');
const { rondoClubRequest } = require('../lib/rondo-club-client');
const { openDb, getAllTrackedMembers, getAllTeams } = require('../lib/rondo-club-db');
const { createSyncLogger } = require('../lib/logger');
const { loginToSportlink, fetchMemberTeamMemberships } = require('./download-functions-from-sportlink');

function formatDateForACF(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return '';
  const trimmed = dateStr.trim();
  const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  return `${match[1]}${match[2]}${match[3]}`;
}

function normalizeGameType(gameTypeDescription) {
  if (!gameTypeDescription || typeof gameTypeDescription !== 'string') return '';
  return gameTypeDescription.replace(/^Veld\s*-\s*/i, '').trim();
}

function buildFallbackTeamName(teamRow) {
  const prefix = normalizeGameType(teamRow.GameTypeDescription);
  const teamName = String(teamRow.TeamName || '').trim();
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
  const team = String(entry.team || '');
  const start = String(entry.start_date || '');
  const end = String(entry.end_date || '');
  const title = String(entry.job_title || '').trim().toLowerCase();
  return `${team}|${start}|${end}|${title}`;
}

function resolveTeamRondoClubId(teamRow, teamBySportlinkId, teamByName) {
  const byId = teamRow.PublicTeamId ? teamBySportlinkId.get(String(teamRow.PublicTeamId)) : null;
  if (byId) return byId;

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
    skippedNoTeam: 0,
    skippedDuplicate: 0
  };

  if (!member.rondo_club_id) {
    return result;
  }

  const response = await rondoClubRequest(`wp/v2/people/${member.rondo_club_id}`, 'GET', null, { logger, verbose });
  const person = response.body || {};
  const existingWorkHistory = Array.isArray(person.acf?.work_history) ? person.acf.work_history : [];

  const signatures = new Set(existingWorkHistory.map(buildSignature));
  const newWorkHistory = [...existingWorkHistory];

  for (const row of teamRows) {
    const teamRondoClubId = resolveTeamRondoClubId(row, teamBySportlinkId, teamByName);
    if (!teamRondoClubId) {
      result.skippedNoTeam++;
      continue;
    }

    const entry = {
      job_title: buildJobTitle(row),
      is_current: !row.RelationEnd,
      start_date: formatDateForACF(row.RelationStart),
      end_date: formatDateForACF(row.RelationEnd),
      team: teamRondoClubId
    };

    const signature = buildSignature(entry);
    if (signatures.has(signature)) {
      result.skippedDuplicate++;
      continue;
    }

    signatures.add(signature);
    newWorkHistory.push(entry);
    result.created++;
  }

  if (result.created === 0) {
    return result;
  }

  await rondoClubRequest(
    `wp/v2/people/${member.rondo_club_id}`,
    'PUT',
    {
      acf: {
        first_name: person.acf?.first_name || '',
        last_name: person.acf?.last_name || '',
        work_history: newWorkHistory
      }
    },
    { logger, verbose }
  );

  result.synced = true;
  logVerbose(`  Added ${result.created} work history row(s) for ${member.knvb_id}`);
  return result;
}

function buildTeamLookupMaps(db) {
  const teams = getAllTeams(db);
  const teamBySportlinkId = new Map();
  const teamByName = new Map();
  for (const team of teams) {
    if (!team.rondo_club_id) continue;
    if (team.sportlink_id) {
      teamBySportlinkId.set(String(team.sportlink_id), team.rondo_club_id);
    }
    if (team.team_name) {
      teamByName.set(String(team.team_name).toLowerCase(), team.rondo_club_id);
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
      skippedNoTeamMatch: res.skippedNoTeam || 0,
      skippedDuplicate: res.skippedDuplicate || 0,
      errors: []
    };
  } catch (error) {
    return {
      success: false,
      synced: 0,
      created: 0,
      skippedNoTeamMatch: 0,
      skippedDuplicate: 0,
      errors: [{ knvb_id: knvbId, message: error.message }]
    };
  }
}

async function runSync(options = {}) {
  const { verbose = false, knvbIds = null } = options;
  const createdLogger = !options.logger;
  const logger = options.logger || createSyncLogger({ verbose, prefix: 'player-history' });

  const result = {
    success: true,
    total: 0,
    downloaded: 0,
    synced: 0,
    created: 0,
    skippedNoTeamMatch: 0,
    skippedDuplicate: 0,
    errors: []
  };

  const db = openDb();
  let browser;

  try {
    let members = getAllTrackedMembers(db);
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

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    });
    const page = await context.newPage();

    await loginToSportlink(page, { logger });

    const shouldRetryAfterRelogin = (error) => {
      const message = String(error?.message || '').toLowerCase();
      return (
        message.includes('non-json') ||
        message.includes('json parse') ||
        message.includes('failed to fetch') ||
        message.includes('timeout') ||
        message.includes('memberteams request failed')
      );
    };

    for (let i = 0; i < members.length; i++) {
      const member = members[i];
      logger.verbose(`Processing ${i + 1}/${members.length}: ${member.knvb_id}`);

      try {
        let teamRows;
        try {
          teamRows = await fetchMemberTeamMemberships(page, member.knvb_id, logger);
        } catch (error) {
          if (!shouldRetryAfterRelogin(error)) {
            throw error;
          }
          logger.verbose(`  Membership fetch failed for ${member.knvb_id}, re-authenticating and retrying once...`);
          await loginToSportlink(page, { logger });
          teamRows = await fetchMemberTeamMemberships(page, member.knvb_id, logger);
        }
        result.downloaded++;

        if (!teamRows || teamRows.length === 0) continue;

        const syncResult = await syncMemberPlayerHistory(
          member,
          teamRows,
          teamBySportlinkId,
          teamByName,
          { verbose, logger }
        );

        if (syncResult.synced) result.synced++;
        result.created += syncResult.created;
        result.skippedNoTeamMatch += syncResult.skippedNoTeam;
        result.skippedDuplicate += syncResult.skippedDuplicate;
      } catch (error) {
        result.errors.push({
          knvb_id: member.knvb_id,
          message: error.message
        });
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
    if (result.skippedNoTeamMatch > 0) {
      logger.log(`  Rows skipped (unknown team mapping): ${result.skippedNoTeamMatch}`);
    }
    if (result.skippedDuplicate > 0) {
      logger.log(`  Rows skipped (already present): ${result.skippedDuplicate}`);
    }
    if (result.errors.length > 0) {
      logger.log(`  Errors: ${result.errors.length}`);
    }

    return result;
  } finally {
    if (browser) {
      await browser.close();
    }
    db.close();
    if (createdLogger && typeof logger.close === 'function') {
      logger.close();
    }
  }
}

module.exports = {
  runSync,
  syncSingleMember,
  syncMemberPlayerHistory,
  formatDateForACF,
  buildFallbackTeamName
};

if (require.main === module) {
  const verbose = process.argv.includes('--verbose');
  const knvbIdx = process.argv.indexOf('--knvb-id');
  const knvbIds = knvbIdx >= 0 && process.argv[knvbIdx + 1]
    ? process.argv[knvbIdx + 1].split(',').map(id => id.trim()).filter(Boolean)
    : null;

  runSync({ verbose, knvbIds })
    .then((res) => {
      if (!res.success) process.exitCode = 1;
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exitCode = 1;
    });
}
