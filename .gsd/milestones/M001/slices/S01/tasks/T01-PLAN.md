# T01: 34-infrastructure-foundation 01

**Slice:** S01 — **Milestone:** M001

## Description

Add WAL journal mode and busy_timeout to all 5 existing SQLite database modules, and create the dashboard database module with run tracking schema.

Purpose: Prepare all databases for concurrent access from cron pipelines and a future long-running web server. Without WAL mode, simultaneous reads and writes cause SQLITE_BUSY errors.

Output: 5 modified database modules with WAL+busy_timeout, 1 new dashboard-db.js with runs/run_steps/run_errors tables.

## Must-Haves

- [ ] "Every openDb() call enables WAL journal mode and sets busy_timeout"
- [ ] "dashboard.sqlite is created with runs, run_steps, and run_errors tables"
- [ ] "All dashboard tables include a club_slug column"
- [ ] "Node.js 22 is running on the production server"
- [ ] "All existing cron pipelines work after the upgrade"

## Files

- `lib/laposta-db.js`
- `lib/rondo-club-db.js`
- `lib/freescout-db.js`
- `lib/nikki-db.js`
- `lib/discipline-db.js`
- `lib/dashboard-db.js`
