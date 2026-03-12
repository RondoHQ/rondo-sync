---
id: T01
parent: S08
milestone: M001
provides: []
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 
verification_result: passed
completed_at: 
blocker_discovered: false
---
# T01: 41-database-migration 01

**# Phase 41 Plan 01: Database Migration Infrastructure Summary**

## What Happened

# Phase 41 Plan 01: Database Migration Infrastructure Summary

**One-liner:** Added idempotent stadion-to-rondo_club migration function using CREATE+INSERT+DROP pattern for 8 tables, plus updated schema and sync origin constants.

## What Was Done

### Migration Function

Created `migrateStadionToRondoClub(db)` in `lib/rondo-club-db.js`:
- Checks if `stadion_members` table exists (idempotency)
- Runs full migration inside transaction with `foreign_keys = OFF`
- Uses CREATE+INSERT+DROP pattern for 8 tables:
  1. `stadion_members` → `rondo_club_members` (26 columns with renames)
  2. `stadion_parents` → `rondo_club_parents`
  3. `stadion_important_dates` → `rondo_club_important_dates`
  4. `stadion_teams` → `rondo_club_teams`
  5. `stadion_work_history` → `rondo_club_work_history`
  6. `stadion_commissies` → `rondo_club_commissies`
  7. `stadion_commissie_work_history` → `rondo_club_commissie_work_history`
  8. `stadion_change_detections` → `rondo_club_change_detections`
- Migrates `conflict_resolutions` table columns (not renamed, but columns updated)
- Updates `sync_origin` data values in `rondo_club_members`
- Recreates all indexes on new tables

### Schema Updates

Updated `initDb()` in `lib/rondo-club-db.js`:
- All `CREATE TABLE IF NOT EXISTS stadion_*` → `rondo_club_*`
- All `CREATE INDEX` statements updated to reference new table names
- All `PRAGMA table_info()` calls updated to new table names
- All `ALTER TABLE` migrations updated to new table names
- Photo state migration block updated to use `rondo_club_members_new`
- Team migration block updated to use `rondo_club_teams_new`
- All column name references updated:
  - `stadion_id` → `rondo_club_id`
  - `stadion_date_id` → `rondo_club_date_id`
  - `stadion_work_history_id` → `rondo_club_work_history_id`
  - `*_stadion_modified` → `*_rondo_club_modified` (7 tracked fields)
  - `stadion_modified_gmt` → `rondo_club_modified_gmt`
  - `stadion_value` → `rondo_club_value` (in conflict_resolutions)
  - `stadion_modified` → `rondo_club_modified` (in conflict_resolutions)

### openDb() Wiring

Modified `openDb()` to call migration after pragmas, before initDb:
```javascript
function openDb(dbPath = DEFAULT_DB_PATH) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  migrateStadionToRondoClub(db);  // NEW
  initDb(db);
  return db;
}
```

### Sync Origin Updates

Updated `lib/sync-origin.js`:
- `SYNC_FORWARD: 'sync_sportlink_to_stadion'` → `'sync_sportlink_to_rondo_club'`
- `SYNC_REVERSE: 'sync_stadion_to_sportlink'` → `'sync_rondo_club_to_sportlink'`
- `getTimestampColumnNames()` now returns `{ rondo_club: '...', sportlink: '...' }`
- Updated JSDoc comments to reference rondo_club instead of stadion
- Verified: `grep -n 'stadion' lib/sync-origin.js` returns 0 matches

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

All verification steps passed on production server (46.202.155.16):

1. Syntax validation: `require('./lib/rondo-club-db.js')` — no errors
2. SYNC_ORIGIN constants: Correctly show `sync_sportlink_to_rondo_club` and `sync_rondo_club_to_sportlink`
3. getTimestampColumnNames: Correctly returns `{ rondo_club: 'email_rondo_club_modified', sportlink: 'email_sportlink_modified' }`

## Implementation Notes

### Column Mapping Strategy

For `rondo_club_members`, the migration dynamically extracts the column list from the existing `stadion_members` table to ensure all historically added columns are included. This handles:
- Base columns (knvb_id, email, data_json, etc.)
- Photo tracking columns (person_image_date, photo_state, photo_url, etc.)
- Bidirectional timestamp columns (7 tracked fields × 2 systems = 14 columns)
- Metadata columns (sync_origin, tracked_fields_hash, huidig_vrijwilliger)

### Foreign Keys Handling

Migration disables foreign keys during table recreation:
```javascript
db.pragma('foreign_keys = OFF');
db.transaction(() => { /* migration */ })();
db.pragma('foreign_keys = ON');
```

This prevents FK constraint violations during the DROP/CREATE sequence.

### Data Migration for Enum Values

The `conflict_resolutions.winning_system` column contains enum values including 'stadion'. Migration updates these:
```sql
CASE winning_system
  WHEN 'stadion' THEN 'rondo_club'
  ELSE winning_system
END
```

## Success Criteria Met

- [x] `migrateStadionToRondoClub(db)` exists and handles CREATE+INSERT+DROP for all 8 tables
- [x] Migration is idempotent — calling `openDb()` when no `stadion_members` table exists does not error
- [x] `initDb()` uses `rondo_club_*` for all table and column names
- [x] `openDb()` calls migration after pragmas, before initDb
- [x] `lib/sync-origin.js` exports `sync_sportlink_to_rondo_club` and `sync_rondo_club_to_sportlink`
- [x] `getTimestampColumnNames()` returns `rondo_club` key (not `stadion`)
- [x] `grep -n 'stadion' lib/sync-origin.js` returns 0 matches

## Next Steps

Phase 41-02 will update all 80+ SQL query functions in `lib/rondo-club-db.js` to reference the new table and column names. This plan provided the schema foundation; plan 41-02 updates the query layer.

**CRITICAL:** Do NOT deploy Phase 41 to production until Phase 42 (Code References) is also complete. The migration runs automatically on openDb(), but steps/ and tools/ files still reference old table names until Phase 42.

## Self-Check: PASSED

Verified all claimed artifacts exist and work correctly:
- [x] `lib/rondo-club-db.js` contains `migrateStadionToRondoClub` function
- [x] `lib/rondo-club-db.js` initDb() uses `rondo_club_*` table names
- [x] `lib/rondo-club-db.js` openDb() calls migration function
- [x] `lib/sync-origin.js` exports updated constants
- [x] Commit fc5feb5 exists in git log
- [x] All verification commands pass on production server
