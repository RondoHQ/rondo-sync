# T01: 41-database-migration 01

**Slice:** S08 — **Milestone:** M001

## Description

Add the stadion-to-rondo_club migration function to `lib/rondo-club-db.js`, update the `initDb()` schema to use `rondo_club_*` names, wire the migration into `openDb()`, and update `lib/sync-origin.js` constants.

Purpose: Create the migration infrastructure and schema foundation. SQL query updates across the 80+ functions are handled in plan 41-02 (depends on this plan).
Output: `lib/rondo-club-db.js` with working migration + updated schema, `lib/sync-origin.js` with rondo_club constants.

CRITICAL DEPLOYMENT NOTE: Do NOT deploy Phase 41 to production until Phase 42 (Code References) is also complete. The migration in openDb() runs automatically and will rename tables, but steps/ and tools/ files still reference old table names until Phase 42 is deployed. Deploy Phase 41 + Phase 42 atomically.

## Must-Haves

- [ ] "All stadion_* tables in rondo-sync.sqlite are renamed to rondo_club_* via CREATE+INSERT+DROP migration"
- [ ] "All stadion_id columns are renamed to rondo_club_id across all tables"
- [ ] "All *_stadion_modified columns are renamed to *_rondo_club_modified"
- [ ] "Migration is idempotent — running openDb() multiple times does not error or corrupt data"
- [ ] "Migration runs safely inside a transaction without breaking concurrent sync processes"
- [ ] "initDb() creates tables with rondo_club_* names for fresh databases"
- [ ] "sync_origin values are renamed from *_stadion* to *_rondo_club*"

## Files

- `lib/rondo-club-db.js`
- `lib/sync-origin.js`
