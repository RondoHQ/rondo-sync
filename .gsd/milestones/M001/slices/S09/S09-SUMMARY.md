---
id: S09
parent: M001
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
# S09: Code References

**# Phase 42 Plan 01: Code References - Step Files Summary**

## What Happened

# Phase 42 Plan 01: Code References - Step Files Summary

**One-liner:** Renamed all stadion references to rondo_club in people-pipeline step files (member sync, photo upload, FreeScout prep, Nikki sync, functions download)

## What Was Done

Systematically renamed all `stadion` references to `rondo_club` across 5 step files that consume the database layer updated in Phase 41. This ensures naming consistency throughout the people-pipeline codebase after the database migration.

### Files Updated

1. **steps/submit-rondo-club-sync.js** (56 references)
   - SQL queries: `stadion_members` → `rondo_club_members`
   - Variables: `stadion_id` → `rondo_club_id`, `knvbIdToStadionId` → `knvbIdToRondoClubId`, `childStadionIds` → `childRondoClubIds`
   - Data variable: `stadionData` → `rondoClubData` (conflict resolution)
   - Function call: `resetParentStadionIds` → `resetParentRondoClubIds`
   - Comments updated to reference `rondo_club`

2. **steps/upload-photos-to-rondo-club.js** (13 references)
   - Function names: `uploadPhotoToStadion` → `uploadPhotoToRondoClub`, `deletePhotoFromStadion` → `deletePhotoFromRondoClub`
   - Variables: `member.stadion_id` → `member.rondo_club_id`, `stadionDeleted` → `rondoClubDeleted`
   - Error objects: `stadion_id` → `rondo_club_id`

3. **steps/prepare-freescout-customers.js** (8 references)
   - SQL queries: `FROM stadion_members` → `FROM rondo_club_members`
   - Variables: `row.stadion_id` → `row.rondo_club_id`
   - Comments: `Member record from stadion_members` → `...from rondo_club_members`
   - JSDoc: `Transform a stadion member` → `Transform a Rondo Club member`

4. **steps/sync-nikki-to-rondo-club.js** (4 references)
   - Variables: `knvbIdToStadionId` → `knvbIdToRondoClubId` (Map and all usages)
   - Logger prefix: `'nikki-stadion'` → `'nikki-rondo-club'`
   - Comments: `knvb_id -> stadion_id mapping` → `knvb_id -> rondo_club_id mapping`

5. **steps/download-functions-from-sportlink.js** (1 reference)
   - Comment: `[{knvb_id, stadion_id}]` → `[{knvb_id, rondo_club_id}]`

## Verification

All files verified:
- Zero `stadion` references remain in any of the 5 files (grep confirmed)
- All files load without syntax errors (Node.js require test passed)
- SQL queries correctly reference `rondo_club_members` table
- Variable names consistently use `rondo_club_id`
- Function names use `RondoClub` terminology

## Deviations from Plan

None - plan executed exactly as written.

## Commits

- `0266599` - refactor(42-01): rename stadion to rondo_club in member sync and photo upload steps
- `7ac7e35` - refactor(42-01): rename stadion to rondo_club in freescout, nikki, and functions steps

## Impact

**Zero runtime impact** - this is a pure refactoring. The database layer (Phase 41) already uses the new table/column names, and these step files now match that naming convention.

**Benefits:**
- Naming consistency: codebase now uniformly uses `rondo_club` terminology
- Reduces confusion: developers see consistent naming from database → queries → variables → function names
- Completes migration: Phase 41 (database) + Phase 42 Plan 01 (step files) = full stadion→rondo_club rename in people-pipeline

## Next Steps

Phase 42 Plan 02 will rename references in pipeline orchestrators, tools/, and lib/ files.

## Self-Check: PASSED

Verified all modified files exist:
```bash
✓ steps/submit-rondo-club-sync.js
✓ steps/upload-photos-to-rondo-club.js
✓ steps/prepare-freescout-customers.js
✓ steps/sync-nikki-to-rondo-club.js
✓ steps/download-functions-from-sportlink.js
```

Verified all commits exist:
```bash
✓ 0266599 (Task 1 commit)
✓ 7ac7e35 (Task 2 commit)
```

All zero-stadion-reference checks passed:
```bash
✓ grep -r 'stadion' [5 files] returns no matches
```

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

# Phase 42 Plan 03: Code References Rename Summary

Renamed all stadion references to rondo_club in pipelines, tools, and lib/http-client.js completing the codebase-wide rename.

## What Was Done

### Task 1: Pipeline Files and lib/http-client.js
- **pipelines/sync-individual.js** (8 references):
  - SQL query: `stadion_members` → `rondo_club_members`
  - Variable: `stadion_id` → `rondo_club_id` (5 occurrences)
  - Variable: `stadionData` → `rondoClubData`
  - Comments updated
- **pipelines/sync-all.js** (2 references):
  - SQL queries for photo coverage stats updated
- **pipelines/sync-former-members.js** (13 references):
  - All `stadion_id` variable references → `rondo_club_id`
  - Comments updated for table and ID references
- **pipelines/reverse-sync.js** (1 reference):
  - Comment: `stadion_change_detections` → `rondo_club_change_detections`
- **lib/http-client.js** (1 reference):
  - Comment: `stadion-client` → `rondo-club-client`

### Task 2: Tool Files (12 files, 90+ references)
- **verify-rondo-club-data.js** (20 references):
  - All table names: `stadion_*` → `rondo_club_*`
  - All ID columns: `stadion_id` → `rondo_club_id`
  - Result properties, comments, help text
- **reset-photo-states.js** (4 references):
  - SQL queries: `stadion_members` → `rondo_club_members`
- **merge-duplicate-person.js** (1 reference):
  - SQL DELETE: `stadion_parents` → `rondo_club_parents`
- **clear-commissie-work-history.js** (2 references):
  - Variable: `stadion_id` → `rondo_club_id`
- **cleanup-orphan-relationships.js** (4 references):
  - Function: `getAllStadionPeople()` → `getAllRondoClubPeople()`
  - Variable: `stadionPeople` → `rondoClubPeople`
- **cleanup-duplicate-former-members.js** (5 references):
  - SQL query: `stadion_members` → `rondo_club_members`
  - Variable and comments updated
- **cleanup-rondo-club-duplicates.js** (3 references):
  - Function and variable renames
- **validate-rondo-club-ids.js** (9 references):
  - Function: `getAllStadionPeopleIds()` → `getAllRondoClubPeopleIds()`
  - SQL queries and variables updated
- **merge-duplicate-parents.js** (11 references):
  - All SQL queries: `stadion_*` → `rondo_club_*`
  - Column references updated
- **unmerge-parent-from-child.js** (9 references):
  - SQL queries and variable names updated
- **repopulate-rondo-club-ids.js** (9 references):
  - Function: `fetchAllPeopleFromStadion()` → `fetchAllPeopleFromRondoClub()`
  - All SQL and variable references updated
- **verify-all.js** (1 reference):
  - Table name: `stadion_change_detections` → `rondo_club_change_detections`

### Task 3: Final Verification
- Ran comprehensive grep across entire codebase
- Verified ONLY `lib/rondo-club-db.js` and `lib/discipline-db.js` contain stadion references (migration code)
- Zero unexpected stadion references in steps/, pipelines/, tools/, or other lib/ files

## Deviations from Plan

None - plan executed exactly as written.

## Verification

All files load without syntax errors:
- `node -e "require('./pipelines/sync-individual.js')"` ✓
- `node -e "require('./pipelines/sync-all.js')"` ✓
- `node -e "require('./pipelines/sync-former-members.js')"` ✓
- `node -e "require('./pipelines/reverse-sync.js')"` ✓

Codebase-wide grep results:
```bash
$ grep -r --include='*.js' 'stadion' --exclude-dir=node_modules . | grep -v 'lib/rondo-club-db.js' | grep -v 'lib/discipline-db.js'
# No results (zero unexpected references)

$ grep -rl --include='*.js' 'stadion' --exclude-dir=node_modules .
./lib/discipline-db.js
./lib/rondo-club-db.js
# Only migration files remain
```

## Commits

1. `18d8484` - refactor(42-03): rename stadion references to rondo_club in pipelines and lib/http-client.js
2. `ecbc453` - refactor(42-03): rename stadion references to rondo_club in all tool files
3. `1f021de` - refactor(42-03): verify zero stadion references in codebase outside migrations

## Impact

**Breaking changes:** None (internal naming only)

**Dependencies updated:** None

**Files changed:** 17 files modified (5 pipelines, 1 lib, 12 tools)

**Database impact:** None (code references only, no schema changes)

## Next Steps

1. Deploy Phase 41 + Phase 42 atomically to production
2. Run full sync to verify all renamed references work correctly
3. Monitor logs for any missed references

## Self-Check

Verification steps:
- [x] All 17 target files have zero stadion references
- [x] All pipeline files load without syntax errors
- [x] Codebase-wide grep shows only migration files with stadion references
- [x] All SQL queries reference rondo_club_* tables
- [x] All variable names use rondo_club_id
- [x] Function names use RondoClub instead of Stadion

**Self-Check: PASSED** ✓

All files exist, all commits recorded, no missing references.
