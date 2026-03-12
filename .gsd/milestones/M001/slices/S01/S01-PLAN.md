# S01: Infrastructure Foundation

**Goal:** Add WAL journal mode and busy_timeout to all 5 existing SQLite database modules, and create the dashboard database module with run tracking schema.
**Demo:** Add WAL journal mode and busy_timeout to all 5 existing SQLite database modules, and create the dashboard database module with run tracking schema.

## Must-Haves


## Tasks

- [x] **T01: 34-infrastructure-foundation 01** `est:8min`
  - Add WAL journal mode and busy_timeout to all 5 existing SQLite database modules, and create the dashboard database module with run tracking schema.

Purpose: Prepare all databases for concurrent access from cron pipelines and a future long-running web server. Without WAL mode, simultaneous reads and writes cause SQLITE_BUSY errors.

Output: 5 modified database modules with WAL+busy_timeout, 1 new dashboard-db.js with runs/run_steps/run_errors tables.

## Files Likely Touched

- `lib/laposta-db.js`
- `lib/rondo-club-db.js`
- `lib/freescout-db.js`
- `lib/nikki-db.js`
- `lib/discipline-db.js`
- `lib/dashboard-db.js`
