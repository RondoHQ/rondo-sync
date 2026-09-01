/**
 * Reverse-sync parent/guardian relationships from Rondo Club to Sportlink.
 *
 * The implementation lives in one module so detection, queueing and the
 * browser writer share the same normalization rules and safety invariants.
 */

const { SportlinkSession } = require('./sportlink-session');
const { openDb } = require('./rondo-club-db');
const { rondoClubRequest, notifyProfileChangeStatus } = require('./rondo-club-client');
const { enterEditMode, clickSaveButton, navigateWithTimeoutCheck } = require('./reverse-sync-sportlink');
const { stableStringify, computeHash } = require('./utils');

const PARENT_INFO_PATH = '/navajo/entity/common/clubweb/member/MemberParentalInfo';
const MAX_ATTEMPTS = 5;
const PROFILE_SYNC_FIELDS = ['email_1', 'email_2', 'mobile_1', 'telephone_1', 'mobile_2'];

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeName(value) {
  return normalizeText(value).toLowerCase().replace(/\s*-\s*/g, '-');
}

function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('0031')) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith('31')) digits = `0${digits.slice(2)}`;
  return digits;
}

function ensureParentSyncSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS parent_slot_sync_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_detection_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS parent_slot_sync_jobs (
      id INTEGER PRIMARY KEY,
      child_knvb_id TEXT NOT NULL,
      child_rondo_id INTEGER NOT NULL,
      parent_rondo_id INTEGER NOT NULL,
      desired_json TEXT NOT NULL,
      desired_hash TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      slot INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      next_attempt_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      synced_at TEXT,
      UNIQUE (child_rondo_id, parent_rondo_id),
      CHECK (state IN ('pending', 'retry', 'blocked', 'synced', 'cancelled')),
      CHECK (slot IS NULL OR slot IN (1, 2))
    );

    CREATE INDEX IF NOT EXISTS idx_parent_slot_sync_jobs_ready
      ON parent_slot_sync_jobs (state, next_attempt_at, updated_at);
  `);
}

function getLastParentDetectionTime(db) {
  ensureParentSyncSchema(db);
  return db.prepare('SELECT last_detection_at FROM parent_slot_sync_state WHERE id = 1').get()?.last_detection_at || null;
}

function updateLastParentDetectionTime(db, timestamp) {
  ensureParentSyncSchema(db);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO parent_slot_sync_state (id, last_detection_at, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      last_detection_at = excluded.last_detection_at,
      updated_at = excluded.updated_at
  `).run(timestamp, now);
}

function relationshipSlug(relationship) {
  return String(relationship?.relationship_slug || '').trim().toLowerCase();
}

function relatedPersonId(relationship) {
  return Number(relationship?.related_person_id || 0);
}

function formatPersonName(fields = {}) {
  return normalizeText([fields.first_name, fields.infix, fields.last_name].filter(Boolean).join(' '));
}

function buildDesiredParent(parent, child) {
  const fields = parent?.fields || {};
  const childFields = child?.fields || {};
  const email = normalizeEmail(fields.email_1 || fields.email_2);
  const desired = {
    childKnvbId: normalizeText(childFields.knvb_id),
    childRondoId: Number(child?.id || 0),
    parentRondoId: Number(parent?.id || 0),
    name: formatPersonName(fields),
    email,
    phone: normalizeText(fields.mobile_1 || fields.telephone_1 || fields.mobile_2 || fields.telephone_2)
  };

  if (!desired.childKnvbId || !desired.childRondoId || !desired.parentRondoId) {
    throw new Error('Kind of ouder mist een stabiele Rondo/Sportlink-identificatie.');
  }
  if (!desired.name) {
    throw new Error('De ouder/verzorger heeft geen naam.');
  }
  if (!desired.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(desired.email)) {
    throw new Error('De ouder/verzorger heeft geen geldig e-mailadres.');
  }

  return desired;
}

function findTrackedParentSource(db, parentRondoId, childKnvbId) {
  const rows = db.prepare(`
    SELECT email, data_json
    FROM rondo_club_parents
    WHERE rondo_club_id = ?
    ORDER BY last_seen_at DESC, id DESC
  `).all(parentRondoId);

  for (const row of rows) {
    let childIds = [];
    try {
      childIds = JSON.parse(row.data_json || '{}').childKnvbIds || [];
    } catch {
      continue;
    }
    if (childIds.map(String).includes(String(childKnvbId))) {
      const email = normalizeEmail(row.email);
      if (email) return { email };
    }
  }
  return null;
}

function desiredHash(desired) {
  return computeHash(stableStringify(desired));
}

function upsertParentJob(db, desired) {
  ensureParentSyncSchema(db);
  const now = new Date().toISOString();
  const hash = desiredHash(desired);
  const existing = db.prepare(`
    SELECT id, desired_hash, state FROM parent_slot_sync_jobs
    WHERE child_rondo_id = ? AND parent_rondo_id = ?
  `).get(desired.childRondoId, desired.parentRondoId);

  if (existing?.desired_hash === hash && existing.state !== 'cancelled') {
    return { id: existing.id, changed: false, state: existing.state };
  }

  db.prepare(`
    INSERT INTO parent_slot_sync_jobs (
      child_knvb_id, child_rondo_id, parent_rondo_id, desired_json,
      desired_hash, state, attempts, last_error, next_attempt_at,
      created_at, updated_at, synced_at, slot
    ) VALUES (?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, ?, ?, NULL, NULL)
    ON CONFLICT(child_rondo_id, parent_rondo_id) DO UPDATE SET
      child_knvb_id = excluded.child_knvb_id,
      desired_json = excluded.desired_json,
      desired_hash = excluded.desired_hash,
      state = 'pending',
      attempts = 0,
      last_error = NULL,
      next_attempt_at = NULL,
      updated_at = excluded.updated_at,
      synced_at = NULL,
      slot = NULL
  `).run(
    desired.childKnvbId,
    desired.childRondoId,
    desired.parentRondoId,
    stableStringify(desired),
    hash,
    now,
    now
  );

  const job = db.prepare(`
    SELECT id, state FROM parent_slot_sync_jobs
    WHERE child_rondo_id = ? AND parent_rondo_id = ?
  `).get(desired.childRondoId, desired.parentRondoId);
  return { id: job.id, changed: true, state: job.state };
}

function cancelMissingParentJobs(db, childRondoId, desiredParentIds) {
  ensureParentSyncSchema(db);
  const ids = Array.from(desiredParentIds);
  const now = new Date().toISOString();
  if (ids.length === 0) {
    return db.prepare(`
      UPDATE parent_slot_sync_jobs SET state = 'cancelled', updated_at = ?
      WHERE child_rondo_id = ? AND state IN ('pending', 'retry', 'blocked')
    `).run(now, childRondoId).changes;
  }
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`
    UPDATE parent_slot_sync_jobs SET state = 'cancelled', updated_at = ?
    WHERE child_rondo_id = ?
      AND parent_rondo_id NOT IN (${placeholders})
      AND state IN ('pending', 'retry', 'blocked')
  `).run(now, childRondoId, ...ids).changes;
}

async function fetchModifiedPeople(since, options = {}) {
  const people = [];
  let page = 1;
  while (true) {
    const endpoint = `wp/v2/people?per_page=100&page=${page}&modified_after=${encodeURIComponent(since)}&_fields=id,modified_gmt,fields,parent_sync_statuses`;
    const response = await rondoClubRequest(endpoint, 'GET', null, options);
    if (!Array.isArray(response.body)) throw new Error('Unexpected Rondo Club people response');
    people.push(...response.body);
    if (response.body.length < 100) break;
    page++;
  }
  return people;
}

async function fetchPerson(personId, options = {}) {
  const response = await rondoClubRequest(`wp/v2/people/${personId}?_fields=id,modified_gmt,fields,parent_sync_statuses`, 'GET', null, options);
  return response.body;
}

async function reportParentStatus(job, state, details = {}, options = {}) {
  const payload = {
    parent_id: Number(job.parent_rondo_id || job.parentRondoId),
    state,
    slot: details.slot || null,
    message: details.message || ''
  };
  try {
    await rondoClubRequest(
      `rondo/v1/people/${job.child_rondo_id || job.childRondoId}/parent-sync-status`,
      'POST',
      payload,
      options
    );
  } catch (error) {
    options.logger?.verbose(`Kon ouder-syncstatus niet terugmelden: ${error.message}`);
  }
}

async function reconcileChild(db, child, options = {}) {
  const fields = child?.fields || {};
  if (!fields.knvb_id || fields.former_member === true) return { queued: 0, blocked: 0 };

  const statusesByParentId = new Map(
    (child.parent_sync_statuses || [])
      .map(status => [Number(status.parent_id), status])
      .filter(([parentId]) => parentId)
  );
  const parentSources = new Map();
  for (const relationship of fields.relationships || []) {
    if (relationshipSlug(relationship) !== 'parent') continue;
    const parentId = relatedPersonId(relationship);
    if (!parentId) continue;
    const source = findTrackedParentSource(db, parentId, fields.knvb_id);
    if (statusesByParentId.has(parentId) || source) {
      parentSources.set(parentId, source);
    }
  }
  const parentIds = new Set(parentSources.keys());
  cancelMissingParentJobs(db, Number(child.id), parentIds);

  let queued = 0;
  let blocked = 0;
  for (const parentId of parentIds) {
    let jobRef = { childRondoId: child.id, parentRondoId: parentId };
    try {
      const personFetcher = options.fetchPerson || fetchPerson;
      const parent = await personFetcher(parentId, options);
      const desired = buildDesiredParent(parent, child);
      const source = parentSources.get(parentId);
      if (source?.email && source.email !== desired.email) {
        desired.sourceEmail = source.email;
      }
      const result = upsertParentJob(db, desired);
      jobRef = desired;
      if (result.changed) {
        queued++;
        const reporter = options.reportParentStatus || reportParentStatus;
        await reporter(jobRef, 'pending', {}, options);
      }
    } catch (error) {
      blocked++;
      const desired = {
        childKnvbId: normalizeText(fields.knvb_id),
        childRondoId: Number(child.id),
        parentRondoId: parentId,
        name: '', email: '', phone: ''
      };
      upsertParentJob(db, desired);
      db.prepare(`
        UPDATE parent_slot_sync_jobs
        SET state = 'blocked', last_error = ?, updated_at = ?
        WHERE child_rondo_id = ? AND parent_rondo_id = ?
      `).run(error.message, new Date().toISOString(), child.id, parentId);
      const reporter = options.reportParentStatus || reportParentStatus;
      await reporter(jobRef, 'error', { message: error.message }, options);
    }
  }
  return { queued, blocked };
}

async function detectParentChanges(options = {}) {
  const { logger } = options;
  const db = openDb();
  ensureParentSyncSchema(db);
  const startedAt = new Date().toISOString();
  try {
    const lastDetection = getLastParentDetectionTime(db);
    if (!lastDetection) {
      updateLastParentDetectionTime(db, startedAt);
      logger?.log('Ouder-syncdetector geïnitialiseerd; toekomstige wijzigingen worden gevolgd');
      return { candidates: 0, queued: 0, blocked: 0, initialized: true };
    }

    const overlapSince = new Date(new Date(lastDetection).getTime() - 5000).toISOString();
    const modified = await fetchModifiedPeople(overlapSince, options);
    const peopleById = new Map(modified.map(person => [Number(person.id), person]));
    const candidateChildIds = new Set();

    for (const person of modified) {
      const fields = person.fields || {};
      if (fields.knvb_id) candidateChildIds.add(Number(person.id));
      for (const relationship of fields.relationships || []) {
        if (relationshipSlug(relationship) === 'child') {
          candidateChildIds.add(relatedPersonId(relationship));
        }
      }
    }

    let queued = 0;
    let blocked = 0;
    for (const childId of candidateChildIds) {
      const child = peopleById.get(childId) || await fetchPerson(childId, options);
      const result = await reconcileChild(db, child, options);
      queued += result.queued;
      blocked += result.blocked;
    }
    updateLastParentDetectionTime(db, startedAt);
    logger?.log(`Ouder-sync: ${candidateChildIds.size} kind(eren) bekeken, ${queued} taak/taken klaar, ${blocked} geblokkeerd`);
    return { candidates: candidateChildIds.size, queued, blocked, initialized: false };
  } finally {
    db.close();
  }
}

function findParentInfoObject(value) {
  if (!value || typeof value !== 'object') return null;
  if (Object.hasOwn(value, 'NameParent1') || Object.hasOwn(value, 'EmailAddressParent1')) return value;
  for (const child of Object.values(value)) {
    const match = findParentInfoObject(child);
    if (match) return match;
  }
  return null;
}

function extractParentSlots(payload) {
  const info = findParentInfoObject(payload) || {};
  return [1, 2].map(slot => ({
    slot,
    name: normalizeText(info[`NameParent${slot}`]),
    email: normalizeEmail(info[`EmailAddressParent${slot}`]),
    phone: normalizeText(info[`TelephoneParent${slot}`])
  }));
}

function selectParentSlot(slots, desired) {
  const email = normalizeEmail(desired.email);
  const emailMatches = slots.filter(slot => slot.email && slot.email === email);
  if (emailMatches.length === 1) return { slot: emailMatches[0].slot, existing: true };

  const sourceEmail = normalizeEmail(desired.sourceEmail);
  if (sourceEmail) {
    const sourceMatches = slots.filter(slot => slot.email && slot.email === sourceEmail);
    if (sourceMatches.length === 1) return { slot: sourceMatches[0].slot, existing: true };
  }

  const compatible = slots.filter(slot => {
    const existing = {
      name: normalizeName(slot.name),
      email: normalizeEmail(slot.email),
      phone: normalizePhone(slot.phone)
    };
    if (!existing.name && !existing.email && !existing.phone) return false;
    if (existing.name && existing.name !== normalizeName(desired.name)) return false;
    if (existing.email && existing.email !== email) return false;
    if (existing.phone && existing.phone !== normalizePhone(desired.phone)) return false;
    return true;
  });
  if (compatible.length === 1) return { slot: compatible[0].slot, existing: true };

  const empty = slots.find(slot => !slot.name && !slot.email && !slot.phone);
  if (empty) return { slot: empty.slot, existing: false };
  return null;
}

function parentValuesMatch(slot, desired) {
  return normalizeName(slot.name) === normalizeName(desired.name)
    && normalizeEmail(slot.email) === normalizeEmail(desired.email)
    && normalizePhone(slot.phone) === normalizePhone(desired.phone);
}

async function readParentInfo(page, knvbId) {
  const url = `https://club.sportlink.com/member/member-details/${knvbId}/general`;
  const credentials = {
    username: process.env.SPORTLINK_USERNAME,
    password: process.env.SPORTLINK_PASSWORD,
    otpSecret: process.env.SPORTLINK_OTP_SECRET
  };
  const [response] = await Promise.all([
    page.waitForResponse(
      candidate => candidate.url().includes('/member/MemberParentalInfo?') && candidate.request().method() === 'GET',
      { timeout: 15000 }
    ),
    navigateWithTimeoutCheck(page, url, credentials)
  ]);
  if (!response.ok()) throw new Error(`Sportlink oudergegevens lezen mislukte (HTTP ${response.status()})`);
  return response.json();
}

async function writeParentJob(page, job, options = {}) {
  const desired = JSON.parse(job.desired_json);
  const payload = await readParentInfo(page, job.child_knvb_id);
  const slots = extractParentSlots(payload);
  const selection = selectParentSlot(slots, desired);
  if (!selection) {
    const error = new Error('Beide ouder/verzorger-velden in Sportlink zijn al bezet.');
    error.code = 'no_free_parent_slot';
    throw error;
  }

  const current = slots.find(slot => slot.slot === selection.slot);
  if (selection.existing && parentValuesMatch(current, desired)) {
    return { slot: selection.slot, alreadySynced: true };
  }

  await enterEditMode(page, 'parent', 'input[name="NameParent1"]');
  await page.locator(`input[name="NameParent${selection.slot}"]`).fill(desired.name);
  await page.locator(`input[name="EmailAddressParent${selection.slot}"]`).fill(desired.email);
  await page.locator(`input[name="TelephoneParent${selection.slot}"]`).fill(desired.phone || '');

  const [saveResponse] = await Promise.all([
    page.waitForResponse(
      response => response.url().includes(PARENT_INFO_PATH) && response.request().method() === 'PUT',
      { timeout: 15000 }
    ),
    clickSaveButton(page)
  ]);
  if (!saveResponse.ok()) throw new Error(`Sportlink oudergegevens opslaan mislukte (HTTP ${saveResponse.status()})`);

  const verified = extractParentSlots(await readParentInfo(page, job.child_knvb_id));
  const verifiedSlot = verified.find(slot => slot.slot === selection.slot);
  if (!verifiedSlot || !parentValuesMatch(verifiedSlot, desired)) {
    throw new Error('Sportlink bevestigde de opgeslagen oudergegevens niet.');
  }
  return { slot: selection.slot, alreadySynced: false };
}

function getReadyParentJobs(db, limit = 20) {
  ensureParentSyncSchema(db);
  return db.prepare(`
    SELECT * FROM parent_slot_sync_jobs
    WHERE state IN ('pending', 'retry')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY created_at ASC
    LIMIT ?
  `).all(new Date().toISOString(), limit);
}

function markParentJobSynced(db, jobId, slot) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE parent_slot_sync_jobs
    SET state = 'synced', slot = ?, last_error = NULL, next_attempt_at = NULL,
        synced_at = ?, updated_at = ?
    WHERE id = ?
  `).run(slot, now, now, jobId);
}

function markParentJobFailed(db, job, error) {
  const attempts = Number(job.attempts || 0) + 1;
  const blocked = error.code === 'no_free_parent_slot' || attempts >= MAX_ATTEMPTS;
  const delayMinutes = Math.min(60, 2 ** attempts);
  const nextAttempt = blocked ? null : new Date(Date.now() + delayMinutes * 60000).toISOString();
  db.prepare(`
    UPDATE parent_slot_sync_jobs
    SET state = ?, attempts = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
    WHERE id = ?
  `).run(blocked ? 'blocked' : 'retry', attempts, error.message, nextAttempt, new Date().toISOString(), job.id);
  return blocked;
}

async function runParentSlotSync(options = {}) {
  const { logger } = options;
  const db = openDb();
  ensureParentSyncSchema(db);
  const jobs = getReadyParentJobs(db);
  if (jobs.length === 0) {
    db.close();
    return { success: true, synced: 0, failed: 0, results: [] };
  }

  const session = new SportlinkSession({ logger, verbose: options.verbose });
  const results = [];
  let synced = 0;
  let failed = 0;
  try {
    const page = await session.getPage();
    for (const job of jobs) {
      try {
        const result = await writeParentJob(page, job, options);
        markParentJobSynced(db, job.id, result.slot);
        await reportParentStatus(job, 'synced', { slot: result.slot }, options);
        const profileReporter = options.notifyProfileChangeStatus || notifyProfileChangeStatus;
        try {
          await profileReporter(job.parent_rondo_id, PROFILE_SYNC_FIELDS, 'synced', '', options);
        } catch (error) {
          logger?.verbose(`Kon profielwijzigingsstatus niet terugmelden: ${error.message}`);
        }
        synced++;
        results.push({ id: job.id, success: true, slot: result.slot });
      } catch (error) {
        const blocked = markParentJobFailed(db, job, error);
        await reportParentStatus(job, blocked ? 'error' : 'pending', { message: error.message }, options);
        failed++;
        results.push({ id: job.id, success: false, blocked, error: error.message });
        logger?.error(`Ouder-sync voor ${job.child_knvb_id} mislukte: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 1000));
    }
  } finally {
    await session.close();
    db.close();
  }
  return { success: failed === 0, synced, failed, results };
}

module.exports = {
  ensureParentSyncSchema,
  getLastParentDetectionTime,
  updateLastParentDetectionTime,
  buildDesiredParent,
  findTrackedParentSource,
  desiredHash,
  upsertParentJob,
  cancelMissingParentJobs,
  detectParentChanges,
  reconcileChild,
  extractParentSlots,
  selectParentSlot,
  parentValuesMatch,
  writeParentJob,
  getReadyParentJobs,
  markParentJobSynced,
  markParentJobFailed,
  runParentSlotSync,
  normalizeEmail
};
