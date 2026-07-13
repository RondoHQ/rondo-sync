const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { computeHash, nowISO, stableStringify } = require('./utils');
const { isActiveSponsor } = require('./sponsit-client');

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'sponsit-sync.sqlite');

function openDb(dbPath = DEFAULT_DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');
  initDb(db);
  secureDatabaseFiles(dbPath);
  return db;
}

function secureDatabaseFiles(dbPath) {
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      fs.chmodSync(file, 0o600);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function initDb(db) {
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS sponsit_contacts (
      sponsit_contact_id INTEGER PRIMARY KEY,
      type TEXT,
      name TEXT NOT NULL,
      email1 TEXT,
      contact_number TEXT,
      status_id INTEGER,
      status_code TEXT,
      status_name TEXT,
      active_sponsor INTEGER NOT NULL DEFAULT 0,
      data_json TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      last_seen_run TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sponsit_contacts_status
      ON sponsit_contacts (status_code, status_name);
    CREATE INDEX IF NOT EXISTS idx_sponsit_contacts_active
      ON sponsit_contacts (active_sponsor);
    CREATE INDEX IF NOT EXISTS idx_sponsit_contacts_email
      ON sponsit_contacts (email1);

    CREATE TABLE IF NOT EXISTS sponsit_people (
      sponsit_person_id INTEGER PRIMARY KEY,
      sponsit_contact_id INTEGER NOT NULL,
      name TEXT,
      email1 TEXT,
      data_json TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      last_seen_run TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (sponsit_contact_id)
        REFERENCES sponsit_contacts (sponsit_contact_id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_sponsit_people_contact
      ON sponsit_people (sponsit_contact_id);
    CREATE INDEX IF NOT EXISTS idx_sponsit_people_email
      ON sponsit_people (email1);

    CREATE TABLE IF NOT EXISTS sponsit_laposta_suppressions (
      list_id TEXT NOT NULL,
      email TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      PRIMARY KEY (list_id, email)
    );
  `);
}

/**
 * Atomically replace the locally mirrored Sponsit snapshot.
 * The database remains untouched when downloading fails before this function.
 */
function replaceSnapshot(db, records, options = {}) {
  if (!Array.isArray(records)) throw new TypeError('Sponsit snapshot must be an array');
  const now = options.now || nowISO();
  const runId = options.runId || crypto.randomUUID();
  validateSnapshot(records);

  const existingContacts = new Map(
    db.prepare('SELECT sponsit_contact_id, source_hash FROM sponsit_contacts')
      .all()
      .map((row) => [row.sponsit_contact_id, row.source_hash])
  );
  const existingPeople = new Map(
    db.prepare('SELECT sponsit_person_id, source_hash FROM sponsit_people')
      .all()
      .map((row) => [row.sponsit_person_id, row.source_hash])
  );

  const contactStats = { created: 0, updated: 0, unchanged: 0, deleted: 0 };
  const peopleStats = { created: 0, updated: 0, unchanged: 0, deleted: 0 };

  const upsertContact = db.prepare(`
    INSERT INTO sponsit_contacts (
      sponsit_contact_id, type, name, email1, contact_number,
      status_id, status_code, status_name, active_sponsor,
      data_json, source_hash, last_seen_run, last_seen_at, created_at, updated_at
    ) VALUES (
      @sponsit_contact_id, @type, @name, @email1, @contact_number,
      @status_id, @status_code, @status_name, @active_sponsor,
      @data_json, @source_hash, @last_seen_run, @last_seen_at, @created_at, @updated_at
    )
    ON CONFLICT(sponsit_contact_id) DO UPDATE SET
      type = excluded.type,
      name = excluded.name,
      email1 = excluded.email1,
      contact_number = excluded.contact_number,
      status_id = excluded.status_id,
      status_code = excluded.status_code,
      status_name = excluded.status_name,
      active_sponsor = excluded.active_sponsor,
      data_json = excluded.data_json,
      source_hash = excluded.source_hash,
      last_seen_run = excluded.last_seen_run,
      last_seen_at = excluded.last_seen_at,
      updated_at = CASE
        WHEN sponsit_contacts.source_hash != excluded.source_hash THEN excluded.updated_at
        ELSE sponsit_contacts.updated_at
      END
  `);

  const upsertPerson = db.prepare(`
    INSERT INTO sponsit_people (
      sponsit_person_id, sponsit_contact_id, name, email1,
      data_json, source_hash, last_seen_run, last_seen_at, created_at, updated_at
    ) VALUES (
      @sponsit_person_id, @sponsit_contact_id, @name, @email1,
      @data_json, @source_hash, @last_seen_run, @last_seen_at, @created_at, @updated_at
    )
    ON CONFLICT(sponsit_person_id) DO UPDATE SET
      sponsit_contact_id = excluded.sponsit_contact_id,
      name = excluded.name,
      email1 = excluded.email1,
      data_json = excluded.data_json,
      source_hash = excluded.source_hash,
      last_seen_run = excluded.last_seen_run,
      last_seen_at = excluded.last_seen_at,
      updated_at = CASE
        WHEN sponsit_people.source_hash != excluded.source_hash THEN excluded.updated_at
        ELSE sponsit_people.updated_at
      END
  `);

  const transaction = db.transaction(() => {
    for (const record of records) {
      const contactRow = buildContactRow(record, { now, runId });
      categorize(existingContacts, contactRow.sponsit_contact_id, contactRow.source_hash, contactStats);
      upsertContact.run(contactRow);

      for (const person of record.people) {
        const personRow = buildPersonRow(record.contact.id, person, { now, runId });
        categorize(existingPeople, personRow.sponsit_person_id, personRow.source_hash, peopleStats);
        upsertPerson.run(personRow);
      }
    }

    peopleStats.deleted = db.prepare(
      'DELETE FROM sponsit_people WHERE last_seen_run != ?'
    ).run(runId).changes;
    contactStats.deleted = db.prepare(
      'DELETE FROM sponsit_contacts WHERE last_seen_run != ?'
    ).run(runId).changes;
  });

  transaction();

  return {
    runId,
    contacts: contactStats,
    people: peopleStats,
    totals: getSponsitStats(db)
  };
}

function getSponsitStats(db) {
  const contact = db.prepare(`
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(active_sponsor), 0) AS active
    FROM sponsit_contacts
  `).get();
  const people = db.prepare('SELECT COUNT(*) AS total FROM sponsit_people').get();
  const candidates = db.prepare(`
    SELECT COALESCE(SUM(
      CASE WHEN c.active_sponsor = 1 THEN
        CASE WHEN p.people_count > 0 THEN p.people_count ELSE 1 END
      ELSE 0 END
    ), 0) AS total
    FROM sponsit_contacts c
    LEFT JOIN (
      SELECT sponsit_contact_id, COUNT(*) AS people_count
      FROM sponsit_people
      GROUP BY sponsit_contact_id
    ) p ON p.sponsit_contact_id = c.sponsit_contact_id
  `).get();
  const statuses = db.prepare(`
    SELECT status_code, status_name, COUNT(*) AS count
    FROM sponsit_contacts
    GROUP BY status_code, status_name
    ORDER BY count DESC, status_name ASC
  `).all();

  return {
    contacts: contact.total,
    activeSponsors: contact.active,
    people: people.total,
    rondoCandidates: candidates.total,
    statuses
  };
}

function getContactRecords(db, options = {}) {
  const { activeOnly = false, contactId = null, limit = null } = options;
  const where = [];
  const params = [];
  if (activeOnly) where.push('active_sponsor = 1');
  if (contactId !== null && contactId !== undefined) {
    where.push('sponsit_contact_id = ?');
    params.push(Number(contactId));
  }

  let sql = 'SELECT * FROM sponsit_contacts';
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY name COLLATE NOCASE, sponsit_contact_id';
  if (Number.isInteger(limit) && limit > 0) {
    sql += ' LIMIT ?';
    params.push(limit);
  }

  const peopleStmt = db.prepare(`
    SELECT data_json FROM sponsit_people
    WHERE sponsit_contact_id = ?
    ORDER BY name COLLATE NOCASE, sponsit_person_id
  `);

  return db.prepare(sql).all(...params).map((row) => {
    const record = JSON.parse(row.data_json);
    record.people = peopleStmt.all(row.sponsit_contact_id)
      .map((personRow) => JSON.parse(personRow.data_json));
    return record;
  });
}

function upsertLapostaSuppressions(db, listId, emails, reason = 'laposta_opt_out') {
  const now = nowISO();
  const upsert = db.prepare(`
    INSERT INTO sponsit_laposta_suppressions (
      list_id, email, reason, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(list_id, email) DO UPDATE SET
      reason = excluded.reason,
      last_seen_at = excluded.last_seen_at
  `);
  const persist = db.transaction((values) => {
    for (const value of values) {
      const email = String(value || '').trim().toLowerCase();
      if (email) upsert.run(listId, email, reason, now, now);
    }
  });
  persist(emails);
}

function getLapostaSuppressedEmails(db, listId) {
  return db.prepare(`
    SELECT email
    FROM sponsit_laposta_suppressions
    WHERE list_id = ?
    ORDER BY email
  `).all(listId).map((row) => row.email);
}

function buildContactRow(record, { now, runId }) {
  const contact = record.contact;
  const status = contact.status && typeof contact.status === 'object'
    ? contact.status
    : { id: contact.status_id || null, code: null, name: contact.status || null };
  const stored = {
    contact,
    addresses: record.addresses || [],
    billingAddress: record.billingAddress || null,
    dossier: record.dossier || null,
    customfieldDefinitions: record.customfieldDefinitions || []
  };
  const dataJson = stableStringify(stored);

  return {
    sponsit_contact_id: Number(contact.id),
    type: nullable(contact.type),
    name: String(contact.name || '').trim(),
    email1: nullable(contact.email1),
    contact_number: nullable(contact.contact_number),
    status_id: numberOrNull(status.id || contact.status_id),
    status_code: nullable(status.code),
    status_name: nullable(status.name),
    active_sponsor: isActiveSponsor(record) ? 1 : 0,
    data_json: dataJson,
    source_hash: computeHash(dataJson),
    last_seen_run: runId,
    last_seen_at: now,
    created_at: now,
    updated_at: now
  };
}

function buildPersonRow(contactId, person, { now, runId }) {
  const dataJson = stableStringify(person);
  return {
    sponsit_person_id: Number(person.id),
    sponsit_contact_id: Number(contactId),
    name: nullable(person.name),
    email1: nullable(person.email1),
    data_json: dataJson,
    source_hash: computeHash(dataJson),
    last_seen_run: runId,
    last_seen_at: now,
    created_at: now,
    updated_at: now
  };
}

function categorize(existing, id, hash, stats) {
  if (!existing.has(id)) stats.created++;
  else if (existing.get(id) === hash) stats.unchanged++;
  else stats.updated++;
}

function validateSnapshot(records) {
  const contactIds = new Set();
  const personIds = new Set();
  for (const record of records) {
    const contactId = Number(record?.contact?.id);
    if (!Number.isInteger(contactId) || contactId <= 0) {
      throw new Error('Sponsit snapshot contains an invalid contact ID');
    }
    if (contactIds.has(contactId)) {
      throw new Error(`Sponsit snapshot contains duplicate contact ID ${contactId}`);
    }
    contactIds.add(contactId);

    if (!Array.isArray(record.people)) {
      throw new Error(`Sponsit contact ${contactId} has no people array`);
    }
    for (const person of record.people) {
      const personId = Number(person?.id);
      if (!Number.isInteger(personId) || personId <= 0) {
        throw new Error(`Sponsit contact ${contactId} contains an invalid person ID`);
      }
      if (personIds.has(personId)) {
        throw new Error(`Sponsit snapshot contains duplicate person ID ${personId}`);
      }
      personIds.add(personId);
    }
  }
}

function nullable(value) {
  if (value === null || value === undefined) return null;
  const string = String(value).trim();
  return string === '' ? null : string;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

module.exports = {
  DEFAULT_DB_PATH,
  openDb,
  initDb,
  replaceSnapshot,
  getSponsitStats,
  getContactRecords,
  upsertLapostaSuppressions,
  getLapostaSuppressedEmails,
  buildContactRow,
  buildPersonRow,
  secureDatabaseFiles
};
