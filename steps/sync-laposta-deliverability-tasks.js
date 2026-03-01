require('dotenv/config');

const {
  openDb: openLapostaDb,
  upsertMemberDeliverabilityEvents,
  getPendingMemberDeliverabilityEvents,
  markMemberDeliverabilityEventTaskCreated,
  markMemberDeliverabilityEventIgnored,
  getBounceDeliverabilityEventsWithTodos,
  markMemberDeliverabilityTodoDeleted
} = require('../lib/laposta-db');
const { fetchMembers, getListConfig } = require('../lib/laposta-client');
const { openDb: openRondoDb } = require('../lib/rondo-club-db');
const { rondoClubRequest } = require('../lib/rondo-club-client');
const { createSyncLogger } = require('../lib/logger');
const { parseCliArgs, readEnv } = require('../lib/utils');

const DELIVERABILITY_STATES = ['unsubscribed', 'cleaned'];
const BOUNCE_TASK_MAX_AGE_DAYS = 31;
const OLD_BOUNCE_CLEANUP_DAYS = 92;

function normalizeEmail(email) {
  if (!email) return '';
  return String(email).trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEventKey({ listId, email, memberId, state }) {
  const stableEmail = normalizeEmail(email);
  const identity = memberId || stableEmail;
  return `${listId}:${identity}:${state}`;
}

function parseLapostaDate(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;

  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)) {
    const dt = new Date(text.replace(' ', 'T') + 'Z');
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const dt = new Date(`${text}T00:00:00Z`);
    return Number.isNaN(dt.getTime()) ? null : dt;
  }

  const dt = new Date(text);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function isOlderThanDays(value, days) {
  const dt = parseLapostaDate(value);
  if (!dt) return false;
  return dt.getTime() < (Date.now() - (days * 24 * 60 * 60 * 1000));
}

function parseMemberName(dataJson, knvbId) {
  try {
    const data = JSON.parse(dataJson || '{}');
    const acf = data.acf || {};
    const fullName = [acf.first_name, acf.infix, acf.last_name].filter(Boolean).join(' ').trim();
    return fullName || knvbId;
  } catch {
    return knvbId;
  }
}

function findRondoMemberByEmail(db, email) {
  const row = db.prepare(`
    SELECT knvb_id, rondo_club_id, data_json
    FROM rondo_club_members
    WHERE rondo_club_id IS NOT NULL
      AND lower(email) = lower(?)
    ORDER BY last_synced_at DESC, id DESC
    LIMIT 1
  `).get(email);

  if (!row) return null;

  return {
    knvbId: row.knvb_id,
    rondoClubId: row.rondo_club_id,
    fullName: parseMemberName(row.data_json, row.knvb_id)
  };
}

function detectSecretarisPersonId(rondoDb) {
  const row = rondoDb.prepare(`
    SELECT smf.knvb_id, rcm.rondo_club_id, smf.function_description
    FROM sportlink_member_functions smf
    INNER JOIN rondo_club_members rcm ON rcm.knvb_id = smf.knvb_id
    WHERE smf.is_active = 1
      AND rcm.rondo_club_id IS NOT NULL
      AND lower(smf.function_description) LIKE '%secretaris%'
    ORDER BY
      CASE
        WHEN lower(smf.function_description) = 'secretaris' THEN 0
        ELSE 1
      END ASC,
      smf.id ASC
    LIMIT 1
  `).get();

  return row ? row.rondo_club_id : null;
}

async function resolveTaskAssignee(rondoDb, options = {}) {
  const { logger, verbose = false } = options;
  const logVerbose = logger?.verbose?.bind(logger) || (verbose ? console.log : () => {});

  const configuredUserId = Number.parseInt(readEnv('LAPOSTA_TASK_ASSIGNEE_USER_ID', ''), 10);
  if (Number.isFinite(configuredUserId) && configuredUserId > 0) {
    return configuredUserId;
  }

  const configuredEmail = normalizeEmail(readEnv('LAPOSTA_TASK_ASSIGNEE_EMAIL', ''));
  const secretarisPersonId = detectSecretarisPersonId(rondoDb);

  if (!configuredEmail && !secretarisPersonId) {
    return null;
  }

  try {
    const response = await rondoClubRequest('rondo/v1/users', 'GET', null, { logger, verbose });
    const users = Array.isArray(response.body) ? response.body : [];

    if (configuredEmail) {
      const userByEmail = users.find(user => normalizeEmail(user.email) === configuredEmail);
      if (userByEmail?.id) {
        logVerbose(`Using configured Laposta task assignee ${configuredEmail} (user ${userByEmail.id})`);
        return userByEmail.id;
      }
    }

    if (secretarisPersonId) {
      const userByPerson = users.find(user => Number(user.linked_person_id) === Number(secretarisPersonId));
      if (userByPerson?.id) {
        logVerbose(`Resolved Secretaris assignee user ${userByPerson.id} from linked person ${secretarisPersonId}`);
        return userByPerson.id;
      }
    }
  } catch (error) {
    logVerbose(`Could not resolve assignee via /rondo/v1/users: ${error.message}`);
  }

  return null;
}

function buildTodoPayload(event, member) {
  const dueDate = new Date().toISOString().slice(0, 10);
  const memberName = member.fullName || member.knvbId;

  const content = `Controleer contactgegevens van ${memberName}`;
  const notes = [
    `<p>Het e-mail adres ${escapeHtml(event.email)} van ${escapeHtml(memberName)} kan geen mail ontvangen via Laposta. Aangezien we ook naar dit e-mail adres communiceren over contributie, boetes, etc. moeten we dit e-mail adres controleren.</p>`
  ].join('');

  return {
    content,
    due_date: dueDate,
    status: 'open',
    notes
  };
}

async function createTodoForMember(event, member, assigneeUserId, options = {}) {
  const { logger, verbose = false } = options;
  const logVerbose = logger?.verbose?.bind(logger) || (verbose ? console.log : () => {});

  const createResponse = await rondoClubRequest(
    `rondo/v1/people/${member.rondoClubId}/todos`,
    'POST',
    buildTodoPayload(event, member),
    { logger, verbose }
  );

  const todoId = createResponse.body?.id;
  const createdAuthorId = createResponse.body?.author_id || null;

  if (!todoId) {
    throw new Error('Todo creation succeeded but no todo ID was returned');
  }

  let assignedUserId = createdAuthorId;

  // Assign to the Secretaris user when possible (author field on wp/v2/todos).
  if (assigneeUserId && Number(createdAuthorId) !== Number(assigneeUserId)) {
    try {
      await rondoClubRequest(
        `wp/v2/todos/${todoId}`,
        'PUT',
        { author: assigneeUserId },
        { logger, verbose }
      );
      assignedUserId = assigneeUserId;
    } catch (error) {
      logVerbose(`Could not reassign todo ${todoId} to user ${assigneeUserId}: ${error.message}`);
    }
  }

  return { todoId, assignedUserId };
}

async function collectDeliverabilityEvents(options = {}) {
  const { logger, verbose = false } = options;
  const logVerbose = logger?.verbose?.bind(logger) || (verbose ? console.log : () => {});

  const events = [];
  const fetched = {
    unsubscribed: 0,
    cleaned: 0
  };

  for (const listIndex of [1, 2, 3, 4]) {
    const { listId } = getListConfig(listIndex);
    if (!listId) continue;

    for (const state of DELIVERABILITY_STATES) {
      const members = await fetchMembers(listId, state);
      fetched[state] += members.length;
      logVerbose(`Laposta list ${listIndex} (${listId}): ${members.length} members in state ${state}`);

      for (const member of members) {
        const email = normalizeEmail(member.email || member.EmailAddress);
        if (!email) continue;

        const memberId = member.member_id || null;
        const modifiedAt = member.modified || null;
        const signupDate = member.signup_date || null;

        events.push({
          list_index: listIndex,
          list_id: listId,
          member_id: memberId,
          email,
          state,
          modified_at: modifiedAt,
          signup_date: signupDate,
          event_key: buildEventKey({
            listId,
            email,
            memberId,
            state
          }),
          payload: member
        });
      }
    }
  }

  return { events, fetched };
}

/**
 * Fetch Laposta deliverability events (unsubscribe + bounce), map them to existing members,
 * and create follow-up todos in Rondo Club.
 *
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @returns {Promise<{success: boolean, scanned: number, pending: number, matched: number, created: number, unresolved: number, assigneeUserId: number|null, fetched: Object, errors: Array}>}
 */
async function runSyncLapostaDeliverabilityTasks(options = {}) {
  const { logger: providedLogger, verbose = false } = options;
  const logger = providedLogger || createSyncLogger({ verbose, prefix: 'laposta-deliverability' });
  const logVerbose = logger?.verbose?.bind(logger) || (verbose ? console.log : () => {});

  const result = {
    success: true,
    scanned: 0,
    pending: 0,
    matched: 0,
    created: 0,
    unresolved: 0,
    skippedOldBounces: 0,
    assigneeUserId: null,
    fetched: {
      unsubscribed: 0,
      cleaned: 0
    },
    errors: []
  };

  const lapostaDb = openLapostaDb();
  const rondoDb = openRondoDb();

  try {
    const { events, fetched } = await collectDeliverabilityEvents({ logger, verbose });
    result.scanned = events.length;
    result.fetched = fetched;

    upsertMemberDeliverabilityEvents(lapostaDb, events);
    const pendingEvents = getPendingMemberDeliverabilityEvents(lapostaDb);
    result.pending = pendingEvents.length;

    if (pendingEvents.length === 0) {
      logVerbose('No pending Laposta deliverability events');
      return result;
    }

    result.assigneeUserId = await resolveTaskAssignee(rondoDb, { logger, verbose });
    if (result.assigneeUserId) {
      logVerbose(`Todos will be assigned to WordPress user ${result.assigneeUserId}`);
    } else {
      logVerbose('No explicit Secretaris assignee resolved, using authenticated sync user');
    }

    for (const event of pendingEvents) {
      try {
        const eventDate = event.modified_at || event.signup_date;
        if (event.state === 'cleaned' && isOlderThanDays(eventDate, BOUNCE_TASK_MAX_AGE_DAYS)) {
          markMemberDeliverabilityEventIgnored(
            lapostaDb,
            event.id,
            `bounce_older_than_${BOUNCE_TASK_MAX_AGE_DAYS}_days`
          );
          result.skippedOldBounces++;
          continue;
        }

        const member = findRondoMemberByEmail(rondoDb, event.email);
        if (!member) {
          result.unresolved++;
          continue;
        }

        result.matched++;
        const todo = await createTodoForMember(event, member, result.assigneeUserId, { logger, verbose });

        markMemberDeliverabilityEventTaskCreated(lapostaDb, event.id, {
          knvbId: member.knvbId,
          rondoClubId: member.rondoClubId,
          todoId: todo.todoId,
          assignedUserId: todo.assignedUserId
        });

        result.created++;
      } catch (error) {
        result.errors.push({
          email: event.email,
          state: event.state,
          message: error.message
        });
      }
    }

    result.success = result.errors.length === 0;
    return result;
  } finally {
    lapostaDb.close();
    rondoDb.close();
  }
}

/**
 * Cleanup old bounce todos created by Laposta deliverability sync.
 * Deletes tasks linked to bounce events older than OLD_BOUNCE_CLEANUP_DAYS.
 *
 * @param {Object} options
 * @param {Object} [options.logger] - Logger instance
 * @param {boolean} [options.verbose=false] - Verbose mode
 * @returns {Promise<{success: boolean, total: number, deleted: number, skipped: number, errors: Array}>}
 */
async function runCleanupOldBounceTodos(options = {}) {
  const { logger: providedLogger, verbose = false } = options;
  const logger = providedLogger || createSyncLogger({ verbose, prefix: 'laposta-deliverability' });
  const logVerbose = logger?.verbose?.bind(logger) || (verbose ? console.log : () => {});

  const result = {
    success: true,
    total: 0,
    deleted: 0,
    skipped: 0,
    errors: []
  };

  const lapostaDb = openLapostaDb();
  try {
    const candidates = getBounceDeliverabilityEventsWithTodos(lapostaDb);
    const toDelete = candidates.filter((row) => {
      const eventDate = row.modified_at || row.signup_date;
      return isOlderThanDays(eventDate, OLD_BOUNCE_CLEANUP_DAYS);
    });
    result.total = toDelete.length;

    for (const row of toDelete) {
      try {
        await rondoClubRequest(`wp/v2/todos/${row.rondo_todo_id}?force=true`, 'DELETE', null, { logger, verbose });
        markMemberDeliverabilityTodoDeleted(lapostaDb, row.id);
        result.deleted++;
      } catch (error) {
        if (error.status === 404 || error.details?.data?.status === 404) {
          markMemberDeliverabilityTodoDeleted(lapostaDb, row.id);
          result.skipped++;
          continue;
        }
        result.errors.push({
          eventId: row.id,
          todoId: row.rondo_todo_id,
          message: error.message
        });
        logVerbose(`Failed deleting todo ${row.rondo_todo_id}: ${error.message}`);
      }
    }

    result.success = result.errors.length === 0;
    return result;
  } finally {
    lapostaDb.close();
  }
}

module.exports = { runSyncLapostaDeliverabilityTasks, runCleanupOldBounceTodos };

if (require.main === module) {
  const { verbose } = parseCliArgs();
  const cleanupOldBounces = process.argv.includes('--cleanup-old-bounces');
  const logger = createSyncLogger({ verbose, prefix: 'laposta-deliverability' });

  const runner = cleanupOldBounces
    ? runCleanupOldBounceTodos({ logger, verbose })
    : runSyncLapostaDeliverabilityTasks({ logger, verbose });

  runner
    .then((result) => {
      if (cleanupOldBounces) {
        logger.log(
          `Cleanup done: ${result.deleted} deleted, ${result.skipped} already missing, ${result.errors.length} errors (from ${result.total} old bounce tasks)`
        );
      } else {
        logger.log(
          `Done: ${result.created} todos created (${result.pending} pending events, ${result.unresolved} unmatched, ${result.skippedOldBounces} old bounces skipped, ${result.errors.length} errors)`
        );
      }
      if (result.errors.length > 0) {
        result.errors.slice(0, 20).forEach((err) => {
          const label = err.email
            ? `${err.email} (${err.state})`
            : `todo ${err.todoId || 'unknown'}`;
          logger.error(`  ${label}: ${err.message}`);
        });
        process.exitCode = 1;
      }
      logger.close();
    })
    .catch((err) => {
      logger.error(`Fatal: ${err.message}`);
      logger.close();
      process.exitCode = 1;
    });
}
