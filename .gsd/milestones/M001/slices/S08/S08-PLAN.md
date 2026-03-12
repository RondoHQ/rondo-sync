# S08: Database Migration

**Goal:** Add the stadion-to-rondo_club migration function to `lib/rondo-club-db.
**Demo:** Add the stadion-to-rondo_club migration function to `lib/rondo-club-db.

## Must-Haves


## Tasks

- [x] **T01: 41-database-migration 01**
  - Add the stadion-to-rondo_club migration function to `lib/rondo-club-db.js`, update the `initDb()` schema to use `rondo_club_*` names, wire the migration into `openDb()`, and update `lib/sync-origin.js` constants.

Purpose: Create the migration infrastructure and schema foundation. SQL query updates across the 80+ functions are handled in plan 41-02 (depends on this plan).
Output: `lib/rondo-club-db.js` with working migration + updated schema, `lib/sync-origin.js` with rondo_club constants.

CRITICAL DEPLOYMENT NOTE: Do NOT deploy Phase 41 to production until Phase 42 (Code References) is also complete. The migration in openDb() runs automatically and will rename tables, but steps/ and tools/ files still reference old table names until Phase 42 is deployed. Deploy Phase 41 + Phase 42 atomically.
- [x] **T02: 41-database-migration 02**
  - Update all 80+ SQL query functions in `lib/rondo-club-db.js` to use `rondo_club_*` table names, `rondo_club_id` columns, and `*_rondo_club_modified` timestamp columns instead of their `stadion_*` predecessors.

Purpose: Complete the rondo-club-db.js rename that was started in plan 41-01 (which handled migration + schema). This plan handles the bulk find-and-replace across all query functions, plus the SQL queries in `lib/detect-rondo-club-changes.js`.
Output: Fully updated `lib/rondo-club-db.js` and `lib/detect-rondo-club-changes.js` with zero `stadion` references remaining.

CRITICAL DEPLOYMENT NOTE: Do NOT deploy Phase 41 to production until Phase 42 (Code References) is also complete. The migration in openDb() runs automatically and will rename tables, but steps/ and tools/ files still reference old table names until Phase 42 is deployed. Deploy Phase 41 + Phase 42 atomically.
- [x] **T03: 41-database-migration 03**
  - Update `lib/discipline-db.js` and `lib/conflict-resolver.js` to use `rondo_club` naming throughout, including a column rename migration in discipline-db.js.

Purpose: Complete the database layer rename for the two remaining files. These are independent of the rondo-club-db.js query updates (plan 41-02) and can run in parallel.
Output: Updated `lib/discipline-db.js` with `rondo_club_id` column and migration, updated `lib/conflict-resolver.js` with all stadion references replaced.

CRITICAL DEPLOYMENT NOTE: Do NOT deploy Phase 41 to production until Phase 42 (Code References) is also complete. The migration in openDb() runs automatically and will rename tables, but steps/ and tools/ files still reference old table names until Phase 42 is deployed. Deploy Phase 41 + Phase 42 atomically.

## Files Likely Touched

- `lib/rondo-club-db.js`
- `lib/sync-origin.js`
- `lib/rondo-club-db.js`
- `lib/detect-rondo-club-changes.js`
- `lib/discipline-db.js`
- `lib/conflict-resolver.js`
