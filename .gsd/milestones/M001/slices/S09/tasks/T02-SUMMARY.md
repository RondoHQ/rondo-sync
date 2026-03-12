---
id: T02
parent: S09
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
# T02: 42-code-references 02

**# Phase 42 Plan 02: Step File References Summary**

## What Happened

# Phase 42 Plan 02: Step File References Summary

**One-liner:** Renamed stadion to rondo_club in 6 step files (teams, work history, commissies, discipline, important dates) for alignment with Phase 41 database migration.

## Objective

Rename all stadion references to rondo_club in the team, commissie, discipline, and important dates step files to align with Phase 41 database migration (rondo_club_members table and column names).

## Execution Summary

### Tasks Completed

**Task 1: Rename stadion references in teams, work history, and commissie step files**
- Status: Already completed in previous 42-01 execution
- Files: submit-rondo-club-teams.js, submit-rondo-club-work-history.js, submit-rondo-club-commissies.js, submit-rondo-club-commissie-work-history.js
- All 4 files already had zero stadion references

**Task 2: Rename stadion references in discipline and important dates step files**
- Commit: 98e6a28
- Files modified:
  - `steps/submit-rondo-club-discipline.js`: SQL query updated to reference rondo_club_members table, function buildPersonLookup → buildPersonRondoClubIdLookup, all stadion_id → rondo_club_id
  - `steps/sync-important-dates.js`: Function deleteStadionImportantDate → deleteRondoClubImportantDate, all stadion_date_id → rondo_club_date_id, all parameter names updated

### Verification Results

All 6 files verified:
- Zero stadion references across all files
- All files load without syntax errors
- SQL queries reference correct table names (rondo_club_members)
- Function names use RondoClub prefix
- Variable names use rondo_club naming consistently

## Deviations from Plan

**[Rule 0 - Pre-completed Work]**
- **Found during:** Task 1 execution
- **Issue:** First 4 files (teams, work history, commissies, commissie work history) already had all stadion references renamed to rondo_club
- **Cause:** These files were updated in a previous 42-01 commit (7ac7e35)
- **Action taken:** Verified files were correct, proceeded to Task 2
- **Impact:** No functional impact, reduced execution time

## Technical Details

### Key Changes

**SQL Query Updates:**
```javascript
// Before
const stmt = db.prepare('SELECT knvb_id, stadion_id FROM stadion_members WHERE stadion_id IS NOT NULL');

// After
const stmt = db.prepare('SELECT knvb_id, rondo_club_id FROM rondo_club_members WHERE rondo_club_id IS NOT NULL');
```

**Function Naming:**
- `buildPersonLookup` → `buildPersonRondoClubIdLookup`
- `lookupTeamStadionId` → `lookupTeamRondoClubId`
- `deleteStadionImportantDate` → `deleteRondoClubImportantDate`

**Variable Naming:**
- `stadion_id` → `rondo_club_id` (destructured from DB results)
- `stadion_work_history_id` → `rondo_club_work_history_id`
- `stadion_date_id` → `rondo_club_date_id`
- `personStadionId` → `personRondoClubId` (function parameters)
- `trackedStadionIds` → `trackedRondoClubIds`

### Files Updated

1. **steps/submit-rondo-club-discipline.js** (17 references → 0)
   - SQL query table and column name
   - Function name: buildPersonRondoClubIdLookup
   - All variable and parameter names

2. **steps/sync-important-dates.js** (18 references → 0)
   - Function name: deleteRondoClubImportantDate
   - All date ID and person ID references
   - JSDoc parameter names

## Dependencies

**Requires:**
- Phase 41-02: Database layer uses rondo_club_members table
- Phase 42-01: Member sync steps use rondo_club naming

**Enables:**
- Phase 42-03: Pipeline orchestration updates
- Atomic deployment of Phase 41 + Phase 42 to production

## Self-Check

### Created Files
- `.planning/phases/42-code-references/42-02-SUMMARY.md` - FOUND

### Modified Files
- `steps/submit-rondo-club-discipline.js` - FOUND
- `steps/sync-important-dates.js` - FOUND

### Commits
- `98e6a28` - FOUND (Task 2: discipline and important dates)

## Self-Check: PASSED

All claimed files exist, commit is present in git log.

## Success Criteria

- [x] Zero stadion references in 6 step files
- [x] SQL queries reference rondo_club_members table with rondo_club_id
- [x] All variable names use rondo_club_id or rondo_club_work_history_id
- [x] All function names use RondoClub prefix instead of Stadion
- [x] All 6 files load without syntax errors
- [x] Commit created for Task 2 changes

## Deployment Notes

**Critical:** This plan MUST be deployed atomically with Phase 41 and other Phase 42 plans. The database migration (Phase 41) renames tables at runtime, and step files reference the new names. Deploying Phase 41 without Phase 42 will break sync pipelines.

**Deployment order:**
1. Deploy all Phase 41 + Phase 42 code simultaneously
2. Restart rondo-sync processes (migration runs on first openDb() call)
3. Verify sync operations work correctly

## Next Steps

- Plan 42-03: Update pipeline orchestrators and lib/http-client.js to use rondo_club naming
- Integration testing of full sync pipelines with renamed references
- Production deployment coordination
