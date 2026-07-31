const path = require('path');
const Database = require('better-sqlite3');
const { nowISO } = require('./utils');

const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'dashboard.sqlite');

/**
 * Open database connection and initialize schema.
 * @param {string} [dbPath] - Database file path
 * @returns {Database} Database instance
 */
function openDb(dbPath = DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  initDb(db);
  migrate(db);
  return db;
}

function migrate(db) {
  const columns = new Set(db.prepare(`PRAGMA table_info(run_steps)`).all().map(c => c.name));
  const additions = [
    ['progress_current', 'INTEGER'],
    ['progress_total', 'INTEGER'],
    ['progress_label', 'TEXT'],
    ['progress_updated_at', 'TEXT']
  ];
  for (const [name, type] of additions) {
    if (columns.has(name)) continue;
    try {
      db.exec(`ALTER TABLE run_steps ADD COLUMN ${name} ${type}`);
    } catch (err) {
      // Another process may have added the column between our PRAGMA check
      // and the ALTER. SQLite raises "duplicate column name" — that's the
      // desired end state, so swallow it. Anything else, re-throw.
      if (!/duplicate column/i.test(err.message)) throw err;
    }
  }
}

/**
 * Initialize database schema for run tracking.
 * @param {Database} db - Database instance
 */
function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY,
      club_slug TEXT NOT NULL DEFAULT 'rondo',
      pipeline TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      outcome TEXT CHECK(outcome IN ('success', 'failure', 'running', 'partial')),
      total_created INTEGER DEFAULT 0,
      total_updated INTEGER DEFAULT 0,
      total_skipped INTEGER DEFAULT 0,
      total_failed INTEGER DEFAULT 0,
      summary_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_club_pipeline
      ON runs (club_slug, pipeline, started_at);

    CREATE TABLE IF NOT EXISTS run_steps (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      club_slug TEXT NOT NULL DEFAULT 'rondo',
      step_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      outcome TEXT CHECK(outcome IN ('success', 'failure', 'skipped', 'partial')),
      created_count INTEGER DEFAULT 0,
      updated_count INTEGER DEFAULT 0,
      skipped_count INTEGER DEFAULT 0,
      failed_count INTEGER DEFAULT 0,
      detail_json TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_run_steps_run_id
      ON run_steps (run_id);

    CREATE TABLE IF NOT EXISTS run_errors (
      id INTEGER PRIMARY KEY,
      run_id INTEGER NOT NULL REFERENCES runs(id),
      run_step_id INTEGER REFERENCES run_steps(id),
      club_slug TEXT NOT NULL DEFAULT 'rondo',
      step_name TEXT NOT NULL,
      member_identifier TEXT,
      error_message TEXT NOT NULL,
      error_stack TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_run_errors_run_id
      ON run_errors (run_id);

    CREATE INDEX IF NOT EXISTS idx_run_errors_club_step
      ON run_errors (club_slug, step_name, created_at);
  `);
}

module.exports = {
  DEFAULT_DB_PATH,
  openDb,
  initDb,
  migrate
};

// CLI: Initialize database and verify schema
if (require.main === module) {
  const dbPath = process.argv[2] || DEFAULT_DB_PATH;
  const db = openDb(dbPath);
  console.log(`Dashboard database initialized at ${dbPath}`);
  db.close();
}
