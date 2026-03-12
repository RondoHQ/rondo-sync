# T02: 41-database-migration 02

**Slice:** S08 — **Milestone:** M001

## Description

Update all 80+ SQL query functions in `lib/rondo-club-db.js` to use `rondo_club_*` table names, `rondo_club_id` columns, and `*_rondo_club_modified` timestamp columns instead of their `stadion_*` predecessors.

Purpose: Complete the rondo-club-db.js rename that was started in plan 41-01 (which handled migration + schema). This plan handles the bulk find-and-replace across all query functions, plus the SQL queries in `lib/detect-rondo-club-changes.js`.
Output: Fully updated `lib/rondo-club-db.js` and `lib/detect-rondo-club-changes.js` with zero `stadion` references remaining.

CRITICAL DEPLOYMENT NOTE: Do NOT deploy Phase 41 to production until Phase 42 (Code References) is also complete. The migration in openDb() runs automatically and will rename tables, but steps/ and tools/ files still reference old table names until Phase 42 is deployed. Deploy Phase 41 + Phase 42 atomically.

## Must-Haves

- [ ] "All SQL queries throughout rondo-club-db.js reference the new rondo_club_* table and column names"
- [ ] "All function return values use rondo_club_id instead of stadion_id as property names"
- [ ] "All function parameters referencing stadion are renamed to rondo_club equivalents"
- [ ] "resetParentStadionIds is renamed to resetParentRondoClubIds (function + export)"
- [ ] "No stadion references remain in rondo-club-db.js"
- [ ] "No stadion references remain in detect-rondo-club-changes.js"
- [ ] "Migration is idempotent — running openDb() multiple times does not error or corrupt data"

## Files

- `lib/rondo-club-db.js`
- `lib/detect-rondo-club-changes.js`
