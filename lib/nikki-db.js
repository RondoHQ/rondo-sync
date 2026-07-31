const path = require('path');
const Database = require('better-sqlite3');
const { stableStringify, computeHash, nowISO } = require('./utils');

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'nikki-sync.sqlite');

/**
 * Coerce to finite number or null. Mirrors the helper in
 * steps/sync-nikki-to-rondo-club.js so empty strings can never reach the
 * REAL-typed saldo/hoofdsom columns (and from there, Rondo Club's REST API).
 */
function toNumberOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Compute SHA-256 hash of contribution data for change detection.
 */
function computeContributionHash(knvbId, year, nikkiId, saldo, hoofdsom, status) {
  const payload = stableStringify({
    knvb_id: knvbId,
    year: year,
    nikki_id: nikkiId,
    saldo: saldo,
    hoofdsom: hoofdsom,
    status: status
  });
  return computeHash(payload);
}

/**
 * Open database and initialize schema.
 */
function openDb(dbPath = DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  initDb(db);
  return db;
}

/**
 * Initialize database tables and indexes.
 */
function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nikki_contributions (
      id INTEGER PRIMARY KEY,
      knvb_id TEXT NOT NULL,
      year INTEGER NOT NULL,
      nikki_id TEXT NOT NULL,
      saldo REAL,
      hoofdsom REAL,
      status TEXT,
      source_hash TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(knvb_id, year, nikki_id)
    );

    CREATE INDEX IF NOT EXISTS idx_nikki_contributions_knvb_id
      ON nikki_contributions (knvb_id);

    CREATE INDEX IF NOT EXISTS idx_nikki_contributions_year
      ON nikki_contributions (year);

    CREATE INDEX IF NOT EXISTS idx_nikki_contributions_saldo
      ON nikki_contributions (saldo);
  `);

  // Migration: add hoofdsom column if it doesn't exist
  try {
    db.exec('ALTER TABLE nikki_contributions ADD COLUMN hoofdsom REAL');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: update constraint from UNIQUE(knvb_id, year) to UNIQUE(knvb_id, year, nikki_id)
  try {
    // Test if old constraint exists by checking table schema
    const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='nikki_contributions'").get();
    if (tableInfo && tableInfo.sql && tableInfo.sql.includes('UNIQUE(knvb_id, year)') && !tableInfo.sql.includes('UNIQUE(knvb_id, year, nikki_id)')) {
      // Old constraint exists - migrate to new schema
      db.exec(`
        BEGIN TRANSACTION;

        CREATE TABLE nikki_contributions_new (
          id INTEGER PRIMARY KEY,
          knvb_id TEXT NOT NULL,
          year INTEGER NOT NULL,
          nikki_id TEXT NOT NULL,
          saldo REAL,
          hoofdsom REAL,
          status TEXT,
          source_hash TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(knvb_id, year, nikki_id)
        );

        INSERT INTO nikki_contributions_new
          SELECT id, knvb_id, year, nikki_id, saldo, hoofdsom, status, source_hash, last_seen_at, created_at
          FROM nikki_contributions;

        DROP TABLE nikki_contributions;

        ALTER TABLE nikki_contributions_new RENAME TO nikki_contributions;

        CREATE INDEX IF NOT EXISTS idx_nikki_contributions_knvb_id
          ON nikki_contributions (knvb_id);
        CREATE INDEX IF NOT EXISTS idx_nikki_contributions_year
          ON nikki_contributions (year);
        CREATE INDEX IF NOT EXISTS idx_nikki_contributions_saldo
          ON nikki_contributions (saldo);

        COMMIT;
      `);
    }
  } catch (e) {
    // Migration failed or not needed - ignore
  }
}

/**
 * Insert or update contribution records in bulk.
 * Each contribution: { knvb_id, year, nikki_id, saldo, hoofdsom, status }
 */
function upsertContributions(db, contributions) {
  const now = nowISO();
  const stmt = db.prepare(`
    INSERT INTO nikki_contributions (
      knvb_id,
      year,
      nikki_id,
      saldo,
      hoofdsom,
      status,
      source_hash,
      last_seen_at,
      created_at
    )
    VALUES (
      @knvb_id,
      @year,
      @nikki_id,
      @saldo,
      @hoofdsom,
      @status,
      @source_hash,
      @last_seen_at,
      @created_at
    )
    ON CONFLICT(knvb_id, year, nikki_id) DO UPDATE SET
      saldo = excluded.saldo,
      hoofdsom = excluded.hoofdsom,
      status = excluded.status,
      source_hash = excluded.source_hash,
      last_seen_at = excluded.last_seen_at
  `);

  const insertMany = db.transaction((rows) => {
    rows.forEach((row) => stmt.run(row));
  });

  const rows = contributions.map((contrib) => {
    const saldo = toNumberOrNull(contrib.saldo);
    const hoofdsom = toNumberOrNull(contrib.hoofdsom);
    const status = contrib.status || null;
    return {
      knvb_id: contrib.knvb_id,
      year: contrib.year,
      nikki_id: contrib.nikki_id,
      saldo,
      hoofdsom,
      status,
      source_hash: computeContributionHash(
        contrib.knvb_id,
        contrib.year,
        contrib.nikki_id,
        saldo,
        hoofdsom,
        status
      ),
      last_seen_at: now,
      created_at: now
    };
  });

  insertMany(rows);
}

/**
 * Get contributions by KNVB ID (aggregated by year).
 * Returns: [{ knvb_id, year, nikki_id, saldo, hoofdsom, status }]
 */
function getContributionsByKnvbId(db, knvbId) {
  const stmt = db.prepare(`
    SELECT
      knvb_id,
      year,
      MAX(nikki_id) as nikki_id,
      SUM(saldo) as saldo,
      SUM(hoofdsom) as hoofdsom,
      MAX(status) as status
    FROM nikki_contributions
    WHERE knvb_id = ?
    GROUP BY knvb_id, year
    ORDER BY year DESC
  `);
  return stmt.all(knvbId);
}

/**
 * Get contributions by year (aggregated by KNVB ID).
 * Returns: [{ knvb_id, year, nikki_id, saldo, hoofdsom, status }]
 */
function getContributionsByYear(db, year) {
  const stmt = db.prepare(`
    SELECT
      knvb_id,
      year,
      MAX(nikki_id) as nikki_id,
      SUM(saldo) as saldo,
      SUM(hoofdsom) as hoofdsom,
      MAX(status) as status
    FROM nikki_contributions
    WHERE year = ?
    GROUP BY knvb_id, year
    ORDER BY knvb_id ASC
  `);
  return stmt.all(year);
}

/**
 * Get all contributions.
 * Returns: [{ knvb_id, year, nikki_id, saldo, hoofdsom, status }]
 */
function getAllContributions(db) {
  const stmt = db.prepare(`
    SELECT knvb_id, year, nikki_id, saldo, hoofdsom, status
    FROM nikki_contributions
    ORDER BY year DESC, knvb_id ASC
  `);
  return stmt.all();
}

/**
 * Get members with outstanding balance (aggregated saldo > 0).
 * Returns: [{ knvb_id, year, nikki_id, saldo, hoofdsom, status }]
 */
function getMembersWithOutstandingBalance(db) {
  const stmt = db.prepare(`
    SELECT
      knvb_id,
      year,
      MAX(nikki_id) as nikki_id,
      SUM(saldo) as saldo,
      SUM(hoofdsom) as hoofdsom,
      MAX(status) as status
    FROM nikki_contributions
    GROUP BY knvb_id, year
    HAVING SUM(saldo) > 0
    ORDER BY SUM(saldo) DESC, year DESC
  `);
  return stmt.all();
}

/**
 * Get all contributions grouped by KNVB ID (aggregated by year).
 * Returns: Map<knvb_id, [{ year, nikki_id, saldo, hoofdsom, status }]>
 */
function getContributionsGroupedByMember(db) {
  const stmt = db.prepare(`
    SELECT
      knvb_id,
      year,
      MAX(nikki_id) as nikki_id,
      SUM(saldo) as saldo,
      SUM(hoofdsom) as hoofdsom,
      MAX(status) as status
    FROM nikki_contributions
    GROUP BY knvb_id, year
    ORDER BY knvb_id ASC, year DESC
  `);
  const rows = stmt.all();

  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.knvb_id)) {
      grouped.set(row.knvb_id, []);
    }
    grouped.get(row.knvb_id).push({
      year: row.year,
      nikki_id: row.nikki_id,
      saldo: row.saldo,
      hoofdsom: row.hoofdsom,
      status: row.status
    });
  }

  return grouped;
}

/**
 * Get unique KNVB IDs from contributions.
 */
function getUniqueKnvbIds(db) {
  const stmt = db.prepare(`
    SELECT DISTINCT knvb_id
    FROM nikki_contributions
    ORDER BY knvb_id ASC
  `);
  return stmt.all().map(row => row.knvb_id);
}

/**
 * Get contribution count.
 */
function getContributionCount(db) {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM nikki_contributions');
  return stmt.get().count;
}

/**
 * Delete all contributions (for fresh import).
 */
function clearContributions(db) {
  db.exec('DELETE FROM nikki_contributions');
}

/**
 * Prune old contribution data outside retention window.
 * @param {Database} db - SQLite database instance
 * @param {number} retentionYears - Number of years to keep (default: 4)
 * @returns {number} - Number of rows deleted
 */
function pruneOldContributions(db, retentionYears = 4) {
  const currentYear = new Date().getFullYear();
  const cutoffYear = currentYear - retentionYears + 1;
  const stmt = db.prepare('DELETE FROM nikki_contributions WHERE year < ?');
  const info = stmt.run(cutoffYear);
  return info.changes;
}

module.exports = {
  DEFAULT_DB_PATH,
  openDb,
  initDb,
  computeContributionHash,
  toNumberOrNull,
  upsertContributions,
  getContributionsByKnvbId,
  getContributionsByYear,
  getAllContributions,
  getMembersWithOutstandingBalance,
  getContributionsGroupedByMember,
  getUniqueKnvbIds,
  getContributionCount,
  clearContributions,
  pruneOldContributions
};
