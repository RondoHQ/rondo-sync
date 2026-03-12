---
id: T01
parent: S07
milestone: M001
provides:
  - download-inactive-members.js step for fetching inactive Sportlink members
  - import-former-members.js tool for one-time former member import
  - Status filter toggle pattern for Sportlink search (INACTIVE members)
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 2min
verification_result: passed
completed_at: 2026-02-09
blocker_discovered: false
---
# T01: 40-former-member-import-tool 01

**# Phase 40 Plan 01: Former Member Import Tool Summary**

## What Happened

# Phase 40 Plan 01: Former Member Import Tool Summary

**Playwright-based inactive member download from Sportlink with orchestrator tool that syncs former members to Rondo Club with acf.former_member = true**

## Performance

- **Duration:** 2 min 8s
- **Started:** 2026-02-09T20:08:04Z
- **Completed:** 2026-02-09T20:10:12Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Download step toggles Sportlink status filter to INACTIVE via multiple fallback strategies
- Import tool orchestrates download, prepare, and sync with dry-run support
- Former members tracked in stadion_members table with former_member = true in WordPress ACF
- Cached download results enable resume-after-failure workflow

## Task Commits

Each task was committed atomically:

1. **Task 1: Create download-inactive-members step** - `824b05e` (feat)
2. **Task 2: Create import-former-members orchestrator tool** - `4aaa2b9` (feat)

## Files Created/Modified
- `steps/download-inactive-members.js` - Playwright-based download of inactive members from Sportlink with status filter toggle
- `tools/import-former-members.js` - Main orchestrator: download, prepare, sync with --import, --verbose, --skip-download flags
- `steps/prepare-rondo-club-members.js` - Exported isValidMember function for reuse in import tool

## Decisions Made

**Status filter discovery strategy:** Implemented three fallback strategies (ID-based → text-based → role-based) for resilience to Sportlink UI changes. This pattern increases robustness without requiring manual UI inspection on every run.

**Caching for resumability:** Download results cached to data/former-members.json. If sync fails partway through, operator can use --skip-download to resume without re-downloading from Sportlink. Reduces load on external API and speeds up debugging iterations.

**Safe-by-default with --import flag:** Dry-run is default behavior. Tool shows what would be synced without making changes. Operator must explicitly pass --import to execute, following merge-duplicate-parents.js pattern.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - all tasks completed as specified.

## User Setup Required

None - no external service configuration required. Tool runs on-demand, not scheduled.

## Next Phase Readiness

- Former member import tool complete and ready for production use on server
- Tool must be run on production server (46.202.155.16), never locally
- Ready for Phase 40 Plan 02: Photo download for former members
- Base infrastructure established for tracking former members in Rondo Club

---
*Phase: 40-former-member-import-tool*
*Completed: 2026-02-09*

## Self-Check: PASSED

All claimed files and commits verified to exist.
