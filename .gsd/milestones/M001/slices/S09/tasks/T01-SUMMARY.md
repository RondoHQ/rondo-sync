---
id: T01
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
# T01: 42-code-references 01

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
