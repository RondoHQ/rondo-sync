const path = require('path');
const Database = require('better-sqlite3');
const { stableStringify, computeHash } = require('./utils');

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'discipline-sync.sqlite');

/**
 * Compute SHA-256 hash of discipline case data for change detection.
 */
function computeCaseHash(caseData) {
  const payload = stableStringify({
    dossier_id: caseData.DossierId,
    public_person_id: caseData.PublicPersonId,
    match_date: caseData.MatchDate,
    match_description: caseData.MatchDescription,
    team_name: caseData.TeamName,
    charge_codes: caseData.ChargeCodes,
    charge_description: caseData.ChargeDescription,
    sanction_description: caseData.SanctionDescription,
    processing_date: caseData.ProcessingDate,
    administrative_fee: caseData.AdministrativeFee,
    is_charged: caseData.IsCharged,
    home_team_id: caseData.HomeTeam?.PublicTeamId,
    away_team_id: caseData.AwayTeam?.PublicTeamId
  });
  return computeHash(payload);
}

/**
 * Migrate stadion_id column to rondo_club_id.
 * Uses ALTER TABLE RENAME COLUMN (safe for single-process discipline pipeline).
 * @param {Database} db - SQLite database connection
 */
function migrateStadionToRondoClub(db) {
  const columns = db.prepare('PRAGMA table_info(discipline_cases)').all();
  const hasStadionId = columns.some(col => col.name === 'stadion_id');

  if (hasStadionId) {
    db.exec('ALTER TABLE discipline_cases RENAME COLUMN stadion_id TO rondo_club_id');
  }
}

/**
 * Open database and initialize schema.
 */
function openDb(dbPath = DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrateStadionToRondoClub(db);
  initDb(db);
  return db;
}

/**
 * Initialize database tables and indexes.
 */
function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS discipline_cases (
      id INTEGER PRIMARY KEY,
      dossier_id TEXT NOT NULL UNIQUE,
      public_person_id TEXT,
      match_date TEXT,
      match_description TEXT,
      team_name TEXT,
      charge_codes TEXT,
      charge_description TEXT,
      sanction_description TEXT,
      processing_date TEXT,
      administrative_fee REAL,
      is_charged INTEGER,
      source_hash TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_discipline_cases_person
      ON discipline_cases (public_person_id);

    CREATE INDEX IF NOT EXISTS idx_discipline_cases_date
      ON discipline_cases (match_date);
  `);

  // Add sync tracking columns if they don't exist
  const columns = db.prepare('PRAGMA table_info(discipline_cases)').all();

  if (!columns.some(col => col.name === 'rondo_club_id')) {
    db.exec('ALTER TABLE discipline_cases ADD COLUMN rondo_club_id INTEGER');
  }

  if (!columns.some(col => col.name === 'last_synced_hash')) {
    db.exec('ALTER TABLE discipline_cases ADD COLUMN last_synced_hash TEXT');
  }

  if (!columns.some(col => col.name === 'last_synced_at')) {
    db.exec('ALTER TABLE discipline_cases ADD COLUMN last_synced_at TEXT');
  }

  if (!columns.some(col => col.name === 'season')) {
    db.exec('ALTER TABLE discipline_cases ADD COLUMN season TEXT');
  }

  if (!columns.some(col => col.name === 'home_team_id')) {
    db.exec('ALTER TABLE discipline_cases ADD COLUMN home_team_id TEXT');
  }

  if (!columns.some(col => col.name === 'away_team_id')) {
    db.exec('ALTER TABLE discipline_cases ADD COLUMN away_team_id TEXT');
  }
}

/**
 * Insert or update discipline case records in bulk.
 * Each case should have API fields: DossierId, PublicPersonId, MatchDate, etc.
 */
function upsertCases(db, cases) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO discipline_cases (
      dossier_id,
      public_person_id,
      match_date,
      match_description,
      team_name,
      charge_codes,
      charge_description,
      sanction_description,
      processing_date,
      administrative_fee,
      is_charged,
      home_team_id,
      away_team_id,
      source_hash,
      last_seen_at,
      created_at
    )
    VALUES (
      @dossier_id,
      @public_person_id,
      @match_date,
      @match_description,
      @team_name,
      @charge_codes,
      @charge_description,
      @sanction_description,
      @processing_date,
      @administrative_fee,
      @is_charged,
      @home_team_id,
      @away_team_id,
      @source_hash,
      @last_seen_at,
      @created_at
    )
    ON CONFLICT(dossier_id) DO UPDATE SET
      public_person_id = excluded.public_person_id,
      match_date = excluded.match_date,
      match_description = excluded.match_description,
      team_name = excluded.team_name,
      charge_codes = excluded.charge_codes,
      charge_description = excluded.charge_description,
      sanction_description = excluded.sanction_description,
      processing_date = excluded.processing_date,
      administrative_fee = excluded.administrative_fee,
      is_charged = excluded.is_charged,
      home_team_id = excluded.home_team_id,
      away_team_id = excluded.away_team_id,
      source_hash = excluded.source_hash,
      last_seen_at = excluded.last_seen_at
  `);

  const insertMany = db.transaction((rows) => {
    rows.forEach((row) => stmt.run(row));
  });

  const rows = cases.map((c) => ({
    dossier_id: c.DossierId,
    public_person_id: c.PublicPersonId ?? null,
    match_date: c.MatchDate ?? null,
    match_description: c.MatchDescription ?? null,
    team_name: c.TeamName ?? null,
    charge_codes: Array.isArray(c.ChargeCodes) ? JSON.stringify(c.ChargeCodes) : (c.ChargeCodes ?? null),
    charge_description: c.ChargeDescription ?? null,
    sanction_description: c.SanctionDescription ?? null,
    processing_date: c.ProcessingDate ?? null,
    administrative_fee: c.AdministrativeFee ?? null,
    is_charged: c.IsCharged === true ? 1 : (c.IsCharged === false ? 0 : null),
    home_team_id: c.HomeTeam?.PublicTeamId ?? null,
    away_team_id: c.AwayTeam?.PublicTeamId ?? null,
    source_hash: computeCaseHash(c),
    last_seen_at: now,
    created_at: now
  }));

  insertMany(rows);
}

/**
 * Get all discipline cases.
 * Returns: [{ dossier_id, public_person_id, match_date, ... }]
 */
function getAllCases(db) {
  const stmt = db.prepare(`
    SELECT
      dossier_id,
      public_person_id,
      match_date,
      match_description,
      team_name,
      charge_codes,
      charge_description,
      sanction_description,
      processing_date,
      administrative_fee,
      is_charged,
      home_team_id,
      away_team_id,
      source_hash,
      last_seen_at,
      created_at
    FROM discipline_cases
    ORDER BY match_date DESC
  `);
  return stmt.all();
}

/**
 * Get discipline cases by person public ID.
 * Returns: [{ dossier_id, match_date, ... }]
 */
function getCasesByPersonId(db, publicPersonId) {
  const stmt = db.prepare(`
    SELECT
      dossier_id,
      public_person_id,
      match_date,
      match_description,
      team_name,
      charge_codes,
      charge_description,
      sanction_description,
      processing_date,
      administrative_fee,
      is_charged,
      home_team_id,
      away_team_id,
      source_hash,
      last_seen_at,
      created_at
    FROM discipline_cases
    WHERE public_person_id = ?
    ORDER BY match_date DESC
  `);
  return stmt.all(publicPersonId);
}

/**
 * Get discipline case count.
 */
function getCaseCount(db) {
  const stmt = db.prepare('SELECT COUNT(*) as count FROM discipline_cases');
  return stmt.get().count;
}

/**
 * Delete all discipline cases (for fresh import).
 */
function clearCases(db) {
  db.exec('DELETE FROM discipline_cases');
}

/**
 * Derive season string from match date.
 * Season runs from August 1 to July 31.
 * Examples: "2026-01-15" -> "2025-2026", "2026-08-01" -> "2026-2027"
 * @param {string} dateString - ISO date string (YYYY-MM-DD)
 * @returns {string} - Season string (e.g., "2025-2026")
 */
function getSeasonFromDate(dateString) {
  if (!dateString) return null;
  const date = new Date(dateString);
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed: 0=Jan, 7=Aug

  // August (7) or later = new season starting that year
  // July (6) or earlier = season started previous year
  if (month >= 7) {
    return `${year}-${year + 1}`;
  } else {
    return `${year - 1}-${year}`;
  }
}

/**
 * Get discipline cases needing Rondo Club sync.
 * @param {Database} db - SQLite database connection
 * @param {boolean} force - If true, return all cases; otherwise only changed cases
 * @returns {Array} - Cases with source_hash included
 */
function getCasesNeedingSync(db, force = false) {
  let query = `
    SELECT
      dossier_id,
      public_person_id,
      match_date,
      match_description,
      team_name,
      charge_codes,
      charge_description,
      sanction_description,
      processing_date,
      administrative_fee,
      is_charged,
      home_team_id,
      away_team_id,
      source_hash,
      rondo_club_id,
      last_synced_hash,
      last_synced_at,
      season
    FROM discipline_cases
  `;

  if (!force) {
    query += ' WHERE last_synced_hash IS NULL OR last_synced_hash != source_hash';
  }

  query += ' ORDER BY match_date DESC';

  const stmt = db.prepare(query);
  return stmt.all();
}

/**
 * Update case sync state after successful Rondo Club sync.
 * @param {Database} db - SQLite database connection
 * @param {string} dossierId - Dossier ID
 * @param {string} syncedHash - Hash at time of sync
 * @param {number} rondoClubId - WordPress post ID
 * @param {string} season - Season string
 */
function updateCaseSyncState(db, dossierId, syncedHash, rondoClubId, season) {
  const stmt = db.prepare(`
    UPDATE discipline_cases
    SET rondo_club_id = ?,
        last_synced_hash = ?,
        last_synced_at = ?,
        season = ?
    WHERE dossier_id = ?
  `);
  stmt.run(rondoClubId, syncedHash, new Date().toISOString(), season, dossierId);
}

/**
 * Get a single discipline case by dossier ID.
 * @param {Database} db - SQLite database connection
 * @param {string} dossierId - Dossier ID
 * @returns {Object|null} - Case data or null
 */
function getCaseByDossierId(db, dossierId) {
  const stmt = db.prepare(`
    SELECT
      dossier_id,
      public_person_id,
      match_date,
      match_description,
      team_name,
      charge_codes,
      charge_description,
      sanction_description,
      processing_date,
      administrative_fee,
      is_charged,
      home_team_id,
      away_team_id,
      source_hash,
      rondo_club_id,
      last_synced_hash,
      last_synced_at,
      season
    FROM discipline_cases
    WHERE dossier_id = ?
  `);
  return stmt.get(dossierId);
}

/**
 * Get synced cases that were not seen in the most recent download.
 * These cases likely disappeared from Sportlink (reassigned to another club).
 * @param {Database} db - SQLite database connection
 * @returns {Array} - Cases with rondo_club_id that have stale last_seen_at
 */
function getStaleSyncedCases(db) {
  // Find the most recent last_seen_at timestamp (from the latest download)
  const latest = db.prepare(
    'SELECT MAX(last_seen_at) as latest FROM discipline_cases'
  ).get();

  if (!latest?.latest) return [];

  // Return cases that were synced to WP but not seen in the latest download
  return db.prepare(`
    SELECT
      dossier_id, public_person_id, rondo_club_id, last_seen_at,
      source_hash, last_synced_hash
    FROM discipline_cases
    WHERE rondo_club_id IS NOT NULL
      AND last_seen_at < ?
  `).all(latest.latest);
}

module.exports = {
  DEFAULT_DB_PATH,
  openDb,
  initDb,
  computeCaseHash,
  upsertCases,
  getAllCases,
  getCasesByPersonId,
  getCaseCount,
  clearCases,
  getSeasonFromDate,
  getCasesNeedingSync,
  updateCaseSyncState,
  getCaseByDossierId,
  getStaleSyncedCases
};
