---
id: T03
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
# T03: 41-database-migration 03

**# Phase 41 Plan 03: Database Layer Naming Updates (discipline-db, conflict-resolver)**

## What Happened

# Phase 41 Plan 03: Database Layer Naming Updates (discipline-db, conflict-resolver)

**One-liner:** Migrated discipline_cases.stadion_id to rondo_club_id with ALTER TABLE RENAME COLUMN, updated conflict-resolver.js to use rondo_club variable names throughout

## What Was Done

Updated `lib/discipline-db.js` and `lib/conflict-resolver.js` to use `rondo_club` naming, completing the database layer migration started in plan 41-01.

### A. discipline-db.js Updates

**Migration function:**
- Added `migrateStadionToRondoClub(db)` function that checks for `stadion_id` column and renames to `rondo_club_id` using `ALTER TABLE RENAME COLUMN`
- Integrated into `openDb()` after pragmas, before `initDb()` for idempotency
- Used ALTER TABLE RENAME COLUMN (safe for discipline pipeline's single-process weekly execution)

**Query updates:**
- `initDb()`: Changed column check and ADD COLUMN to use `rondo_club_id`
- `getCasesNeedingSync()`: Updated SELECT to return `rondo_club_id` instead of `stadion_id`
- `updateCaseSyncState()`: Changed SET clause to `rondo_club_id = ?`
- `getCaseByDossierId()`: Updated SELECT to return `rondo_club_id`
- All JSDoc comments updated

**Files modified:**
- `lib/discipline-db.js` (361 lines)

### B. conflict-resolver.js Updates

**Variable names:**
- `stadionData` → `rondoClubData` (parameter + JSDoc)
- `stadionTs` → `rondoClubTs` (timestamp variable)
- `stadionValue` → `rondoClubValue` (field value variable)

**Return values:**
- `winner: 'stadion'` → `winner: 'rondo_club'`
- `reason: 'only_stadion_has_history'` → `reason: 'only_rondo_club_has_history'`
- `reason: 'stadion_newer'` → `reason: 'rondo_club_newer'`
- `stadion_value: String(...)` → `rondo_club_value: String(...)`
- `stadion_modified: ...` → `rondo_club_modified: ...`

**Self-tests:**
- Updated all test data column names from `*_stadion_modified` to `*_rondo_club_modified`
- Updated test variable names: `stadion1`, `stadion2`, `stadion3` → `rondoClub1`, `rondoClub2`, `rondoClub3`
- All 4 self-tests pass on production server

**Files modified:**
- `lib/conflict-resolver.js` (275 lines)

### C. Bug Fix (Deviation Rule 1)

**Issue:** conflict_resolutions migration in rondo-club-db.js was checking for new column name (`rondo_club_value`) instead of old column name (`stadion_value`), preventing migration from running

**Fix:** Changed line 326 from:
```javascript
if (conflictColumns.some(col => col.name === 'rondo_club_value')) {
```
to:
```javascript
if (conflictColumns.some(col => col.name === 'stadion_value')) {
```

**Impact:** Migration now triggers correctly, allowing conflict-resolver.js self-tests to pass

**Files modified:**
- `lib/rondo-club-db.js`

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed conflict_resolutions migration check logic**
- **Found during:** Task 1 verification (running conflict-resolver.js self-test)
- **Issue:** Migration was checking for new column (`rondo_club_value`) instead of old column (`stadion_value`), causing SqliteError: "table conflict_resolutions has no column named stadion_value"
- **Root cause:** Plan 41-01's migration logic had inverted condition - should check if OLD column exists to trigger migration
- **Fix:** Changed condition from `col.name === 'rondo_club_value'` to `col.name === 'stadion_value'`
- **Files modified:** `lib/rondo-club-db.js` (line 326)
- **Commit:** 927c7f8

## Verification Results

All verification tests passed on production server (46.202.155.16):

1. ✅ `openDb()` executes without errors
2. ✅ `discipline_cases` table has `rondo_club_id` column (not `stadion_id`)
3. ✅ `resolveFieldConflicts()` exports correctly as function
4. ✅ Self-test passes with all 4 test cases
5. ✅ Only 3 "stadion" references remain in discipline-db.js (all in migration function checking for old column name)
6. ✅ Zero "stadion" references in conflict-resolver.js

**Migration verification:**
```bash
node -e "const Database = require('better-sqlite3'); const db = new Database('data/discipline-sync.sqlite'); const cols = db.prepare('PRAGMA table_info(discipline_cases)').all(); console.log(cols.map(c=>c.name).join(', ')); db.close()"
# Output includes: rondo_club_id (not stadion_id)
```

**Self-test output:**
```
Running conflict-resolver self-test...

Test 1: NULL timestamp handling
  email (both NULL): sportlink = sportlink@example.com
  email2 (only Rondo Club has timestamp): rondo_club = rondoclub2@example.com
  mobile (only Sportlink has timestamp): sportlink = 0612345678
  Conflicts detected: 0
  ✓ NULL handling test passed

Test 2: Grace period handling
  email (within grace period): sportlink = sportlink@example.com
  Reason: grace_period_sportlink_wins
  Conflicts detected: 0
  ✓ Grace period test passed

Test 3: Real conflict detection
  email (Rondo Club 10min newer): rondo_club = rondoclub@example.com
  Reason: rondo_club_newer
  Conflicts detected: 1
  ✓ Conflict detection test passed

Test 4: Summary generation
CONFLICTS DETECTED AND RESOLVED

Total conflicts: 1
Members affected: 1

RESOLUTION DETAILS

- TEST003: 1 field(s)
  email: rondo_club won (rondo club newer)
  ✓ Summary generation test passed

All self-tests passed! ✓
```

## Integration Points

**Upstream dependencies (completed in 41-01):**
- `lib/sync-origin.js` - `getTimestampColumnNames()` now returns `cols.rondo_club` key
- `lib/rondo-club-db.js` - `conflict_resolutions` table migrated to use `rondo_club_value` and `rondo_club_modified` columns

**Downstream impact (Phase 42):**
- `steps/submit-discipline-cases.js` still references `case.stadion_id` as JavaScript property (will be updated in Phase 42)
- `pipelines/discipline.js` still uses old variable names (will be updated in Phase 42)
- `tools/show-*.js` scripts need updates for new column names

## Success Criteria Met

- [x] `grep -c 'stadion' lib/discipline-db.js` returns 3 (only in migration function)
- [x] `grep -c 'stadion' lib/conflict-resolver.js` returns 0
- [x] `openDb()` on discipline-sync.sqlite migrates `stadion_id` column to `rondo_club_id`
- [x] Migration is idempotent — calling `openDb()` twice does not error
- [x] `resolveFieldConflicts()` returns `rondo_club` as winner (not `stadion`)
- [x] Self-test block in conflict-resolver.js runs without errors

## Known Limitations

**CRITICAL DEPLOYMENT NOTE:** Do NOT deploy Phase 41 to production in isolation. Phase 42 (Code References) must be deployed atomically with Phase 41 because:
- Plan 41-03 renames database columns/variables
- Plan 42 updates consuming code (steps/, tools/, pipelines/) that reference those columns
- Deploying 41 without 42 will cause runtime errors when sync pipelines access renamed columns

**Recommended deployment:** Complete Phase 41 + Phase 42, then deploy both together.

## Self-Check: PASSED

**Files created:**
- `.planning/phases/41-database-migration/41-03-SUMMARY.md` - ✅ FOUND

**Commits exist:**
- `5e92842` - ✅ FOUND (feat: migrate discipline-db and conflict-resolver to rondo_club naming)
- `927c7f8` - ✅ FOUND (fix: correct conflict_resolutions migration check)

**Key functionality:**
- discipline-db.js migration runs without errors - ✅ VERIFIED
- conflict-resolver.js self-tests pass - ✅ VERIFIED
- rondo_club_id column exists in discipline_cases table - ✅ VERIFIED

---

**Duration:** 213 seconds (3.5 minutes)
**Status:** Complete
**Next:** Ready for Phase 41 Plan 04 or Phase 42 (Code References)
