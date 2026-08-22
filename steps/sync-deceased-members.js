require('dotenv/config');

const { openDb: openLapostaDb, getMembersForList, getLatestSportlinkResults } = require('../lib/laposta-db');
const {
  openDb: openRondoClubDb,
  getTrackedDeathStates,
  updateTrackedDeathState
} = require('../lib/rondo-club-db');
const { fetchMembers, updateMember, waitForRateLimit, getListConfig } = require('../lib/laposta-client');
const { rondoClubRequest } = require('../lib/rondo-club-client');
const { createLoggerAdapter } = require('../lib/log-adapters');

function normalizeSportlinkDate(value) {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;
  if (/^\d{8}$/.test(normalized)) {
    return `${normalized.slice(0, 4)}-${normalized.slice(4, 6)}-${normalized.slice(6, 8)}`;
  }
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})T/);
  return match ? match[1] : null;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.includes('@') ? email : null;
}

function buildRondoDeathPlan(inactiveMembers, trackedStates) {
  const inactiveByKnvbId = new Map(
    inactiveMembers
      .filter(member => member.PublicPersonId)
      .map(member => [String(member.PublicPersonId), member])
  );

  return trackedStates.flatMap(state => {
    const member = inactiveByKnvbId.get(String(state.knvb_id));
    if (!member) return [];

    const sourceDate = normalizeSportlinkDate(member.DateOfPassing);
    const trackedDate = normalizeSportlinkDate(state.date_of_passing);
    if (sourceDate === trackedDate) return [];

    return [{
      knvbId: String(state.knvb_id),
      rondoClubId: Number(state.rondo_club_id),
      sourceDate,
      trackedDate
    }];
  });
}

function collectDeceasedEmails(inactiveMembers) {
  const emails = new Set();
  for (const member of inactiveMembers) {
    if (!normalizeSportlinkDate(member.DateOfPassing)) continue;
    for (const value of [member.Email, member.EmailAlternative]) {
      const email = normalizeEmail(value);
      if (email) emails.add(email);
    }
  }
  return emails;
}

function collectActiveOwnEmails(activeMembers) {
  const emails = new Set();
  for (const member of activeMembers) {
    if (normalizeSportlinkDate(member.DateOfPassing)) continue;
    for (const value of [member.Email, member.EmailAlternative]) {
      const email = normalizeEmail(value);
      if (email) emails.add(email);
    }
  }
  return emails;
}

function planLapostaUnsubscriptions(remoteMembers, deceasedEmails, desiredEmails) {
  return remoteMembers.filter(member => {
    const email = normalizeEmail(member.email || member.EmailAddress);
    return email && deceasedEmails.has(email) && !desiredEmails.has(email);
  });
}

async function syncDeceasedToRondoClub(inactiveMembers, options = {}) {
  const { logger, verbose = false } = options;
  const { verbose: logVerbose, error: logError } = createLoggerAdapter({ logger, verbose });
  const stats = { total: 0, updated: 0, unchanged: 0, errors: [] };
  const db = openRondoClubDb();

  try {
    const plan = buildRondoDeathPlan(inactiveMembers, getTrackedDeathStates(db));
    stats.total = plan.length;

    for (const item of plan) {
      try {
        const current = await rondoClubRequest(
          `wp/v2/people/${item.rondoClubId}?_fields=id,fields`,
          'GET',
          null,
          { logger, verbose }
        );
        const fields = current.body?.fields || {};
        const currentDate = normalizeSportlinkDate(fields.datum_overlijden);

        if (currentDate !== item.sourceDate) {
          await rondoClubRequest(
            `wp/v2/people/${item.rondoClubId}`,
            'PUT',
            {
              fields: {
                first_name: fields.first_name || '',
                last_name: fields.last_name || '',
                datum_overlijden: item.sourceDate
              }
            },
            { logger, verbose }
          );

          const verification = await rondoClubRequest(
            `wp/v2/people/${item.rondoClubId}?_fields=id,fields`,
            'GET',
            null,
            { logger, verbose }
          );
          const verifiedDate = normalizeSportlinkDate(verification.body?.fields?.datum_overlijden);
          if (verifiedDate !== item.sourceDate) {
            throw new Error(`Death-date verification failed: expected ${item.sourceDate || 'empty'}, received ${verifiedDate || 'empty'}`);
          }

          stats.updated++;
          logVerbose(`Updated death date for ${item.knvbId}: ${item.sourceDate || 'cleared'}`);
        } else {
          stats.unchanged++;
        }

        updateTrackedDeathState(db, item.knvbId, item.sourceDate);
      } catch (error) {
        const entry = { knvb_id: item.knvbId, message: error.message, system: 'deceased-rondo' };
        stats.errors.push(entry);
        logError(`Could not reconcile death date for ${item.knvbId}: ${error.message}`);
      }
    }
  } finally {
    db.close();
  }

  return stats;
}

async function syncDeceasedToLaposta(inactiveMembers, options = {}) {
  const { logger, verbose = false } = options;
  const { verbose: logVerbose, error: logError } = createLoggerAdapter({ logger, verbose });
  const deceasedEmails = collectDeceasedEmails(inactiveMembers);
  const stats = { candidates: deceasedEmails.size, unsubscribed: 0, keptShared: 0, errors: [] };
  if (deceasedEmails.size === 0) return stats;

  const db = openLapostaDb();
  try {
    const latestResults = getLatestSportlinkResults(db);
    if (!latestResults) {
      stats.errors.push({
        email: 'active-snapshot',
        message: 'No active Sportlink snapshot available; Laposta unsubscribe skipped for safety',
        system: 'deceased-laposta'
      });
      return stats;
    }

    let activeMembers;
    try {
      activeMembers = JSON.parse(latestResults).Members || [];
    } catch (error) {
      stats.errors.push({
        email: 'active-snapshot',
        message: `Invalid active Sportlink snapshot; Laposta unsubscribe skipped for safety: ${error.message}`,
        system: 'deceased-laposta'
      });
      return stats;
    }

    const activeOwnEmails = collectActiveOwnEmails(activeMembers);

    for (let listIndex = 1; listIndex <= 4; listIndex++) {
      const { listId } = getListConfig(listIndex);
      if (!listId) continue;

      try {
        const desiredEmails = new Set(
          getMembersForList(db, listIndex)
            .map(member => normalizeEmail(member.email))
            .filter(Boolean)
        );
        const protectedLivingEmails = new Set(
          [...desiredEmails].filter(email => activeOwnEmails.has(email))
        );
        const remoteMembers = await fetchMembers(listId, 'active');
        const toUnsubscribe = planLapostaUnsubscriptions(remoteMembers, deceasedEmails, protectedLivingEmails);

        for (let index = 0; index < toUnsubscribe.length; index++) {
          const member = toUnsubscribe[index];
          const email = normalizeEmail(member.email || member.EmailAddress);
          const identifier = member.member_id || email;
          await updateMember(listId, identifier, { state: 'unsubscribed' });
          stats.unsubscribed++;
          logVerbose(`Unsubscribed deceased email from Laposta list ${listIndex}: ${email}`);
          if (index < toUnsubscribe.length - 1) await waitForRateLimit();
        }

        for (const email of deceasedEmails) {
          if (protectedLivingEmails.has(email)) stats.keptShared++;
        }
      } catch (error) {
        const entry = { email: `list-${listIndex}`, message: error.message, system: 'deceased-laposta' };
        stats.errors.push(entry);
        logError(`Could not reconcile deceased emails for Laposta list ${listIndex}: ${error.message}`);
      }
    }
  } finally {
    db.close();
  }

  return stats;
}

module.exports = {
  normalizeSportlinkDate,
  buildRondoDeathPlan,
  collectDeceasedEmails,
  collectActiveOwnEmails,
  planLapostaUnsubscriptions,
  syncDeceasedToRondoClub,
  syncDeceasedToLaposta
};
