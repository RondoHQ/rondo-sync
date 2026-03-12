---
id: S07
parent: M001
milestone: M001
provides:
  - download-inactive-members.js step for fetching inactive Sportlink members
  - import-former-members.js tool for one-time former member import
  - Status filter toggle pattern for Sportlink search (INACTIVE members)
  - Photo download for former members via MemberHeader API
  - Photo upload to Rondo Club person records
  - Complete former member import with photos
requires: []
affects: []
key_files: []
key_decisions:
  - "Status filter toggle uses three fallback strategies (ID-based, text-based, role-based) for resilience to Sportlink UI changes"
  - "Former members cached to data/former-members.json for resume support after partial failure"
  - "Dry-run is default behavior (--import required to execute) following safe-by-default pattern"
  - "Photo steps integrated into import tool rather than separate script for atomic operation"
  - "--skip-photos flag allows member-only import without photos for faster testing"
  - "Photo failures don't prevent member sync completion (non-critical steps)"
patterns_established:
  - "Pattern 1: Status filter discovery - Try ID selectors first, then text-based, then role-based as fallback"
  - "Pattern 2: One-time import tools - Use caching + --skip-download for resumability"
  - "Pattern 3: Former member detection - Check stadion_members.stadion_id + last_synced_hash to skip already-synced members"
  - "Pattern 1: Photo download requires separate Playwright session after member sync completes"
  - "Pattern 2: Photo upload uses inline implementation to avoid external dependencies"
  - "Pattern 3: Dry-run mode shows photo potential count without downloading"
observability_surfaces: []
drill_down_paths: []
duration: 2min
verification_result: passed
completed_at: 2026-02-09
blocker_discovered: false
---
# S07: Former Member Import Tool

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

# Phase 40 Plan 02: Former Member Photo Import Summary

**Photo download via MemberHeader API and upload to Rondo Club integrated into former member import tool**

## Performance

- **Duration:** 1 min 57s
- **Started:** 2026-02-09T20:52:22Z
- **Completed:** 2026-02-09T20:54:19Z
- **Tasks:** 1
- **Files modified:** 1

## Accomplishments
- Photo download step launches Playwright session to capture MemberHeader API responses
- Photos download immediately from signed CDN URLs while session is active
- Photo upload uses multipart form-data to WordPress REST API endpoint
- --skip-photos flag allows member-only import without photo processing
- Dry-run mode estimates photo count by checking PersonImageDate fields
- Photo statistics included in summary output

## Task Commits

Each task was committed atomically:

1. **Task 1: Add photo download and upload to import-former-members tool** - `f7239fa` (feat)

## Files Created/Modified
- `tools/import-former-members.js` - Added Step 4 (photo download) and Step 5 (photo upload) after member sync, --skip-photos flag, photo statistics tracking

## Decisions Made

**Inline photo implementation:** Implemented photo download and upload directly in the import tool rather than calling separate modules. This creates an atomic operation where photos are processed immediately after member sync. If photo steps fail, member sync is still complete.

**Skip-photos flag for flexibility:** Added --skip-photos flag to allow operators to run member-only import without photo processing. Useful for quick testing or when photos aren't immediately needed.

**Non-critical photo steps:** Photo download and upload failures are tracked but don't fail the overall import. Former members are successfully imported even if photos fail. This follows the pattern established in regular sync pipelines.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None - all tasks completed as specified.

## User Setup Required

None - photo functionality uses existing credentials and infrastructure.

## Next Phase Readiness

- Former member import tool now complete with full photo support
- Tool ready for production use on server (46.202.155.16)
- Phase 40 (Former Member Import Tool) complete
- All v3.1 milestone requirements satisfied

---
*Phase: 40-former-member-import-tool*
*Completed: 2026-02-09*

## Self-Check: PASSED

All claimed files and commits verified to exist.
