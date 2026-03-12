# T03: 41-database-migration 03

**Slice:** S08 — **Milestone:** M001

## Description

Update `lib/discipline-db.js` and `lib/conflict-resolver.js` to use `rondo_club` naming throughout, including a column rename migration in discipline-db.js.

Purpose: Complete the database layer rename for the two remaining files. These are independent of the rondo-club-db.js query updates (plan 41-02) and can run in parallel.
Output: Updated `lib/discipline-db.js` with `rondo_club_id` column and migration, updated `lib/conflict-resolver.js` with all stadion references replaced.

CRITICAL DEPLOYMENT NOTE: Do NOT deploy Phase 41 to production until Phase 42 (Code References) is also complete. The migration in openDb() runs automatically and will rename tables, but steps/ and tools/ files still reference old table names until Phase 42 is deployed. Deploy Phase 41 + Phase 42 atomically.

## Must-Haves

- [ ] "The stadion_id column in discipline_cases (discipline-sync.sqlite) is renamed to rondo_club_id"
- [ ] "discipline-db.js migration uses ALTER TABLE RENAME COLUMN (safe — no concurrent access)"
- [ ] "conflict-resolver.js uses rondo_club variable names, return values, and winner/reason strings"
- [ ] "Migration is idempotent — running openDb() multiple times does not error or corrupt data"
- [ ] "No stadion references remain in either file"

## Files

- `lib/discipline-db.js`
- `lib/conflict-resolver.js`
