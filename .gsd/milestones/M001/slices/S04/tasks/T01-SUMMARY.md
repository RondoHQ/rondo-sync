---
id: T01
parent: S04
milestone: M001
provides:
  - Pipeline overview page with traffic-light status cards
  - Run history page with paginated run list per pipeline
  - Run detail page with per-step breakdown and counts
  - Dashboard queries module for reading dashboard database
  - Shared EJS layout partials with navigation and logout
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 3min
verification_result: passed
completed_at: 2026-02-09
blocker_discovered: false
---
# T01: 37-dashboard-ui 01

**# Phase 37 Plan 01: Dashboard Queries and Overview Summary**

## What Happened

# Phase 37 Plan 01: Dashboard Queries and Overview Summary

**Pipeline overview with traffic-light status cards, paginated run history tables, and per-step drill-down using server-rendered EJS templates**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-09T09:56:16Z
- **Completed:** 2026-02-09T09:59:37Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments
- Dashboard overview shows all 6 pipelines with traffic-light status indicators (green/yellow/red/gray)
- Overdue pipelines flagged with orange badge based on cron schedule
- Run history page shows paginated list of runs per pipeline with outcome, counts, and duration
- Run detail page shows per-step breakdown with counts and link to error browser
- Shared layout with navigation (Overview, Errors) and logout button

## Task Commits

Each task was committed atomically:

1. **Task 1: Dashboard queries module and pipeline overview page** - `9dd22c4` (feat)
2. **Task 2: Run history and run detail pages** - `535c9d6` (feat)

## Files Created/Modified
- `lib/dashboard-queries.js` - Query functions for pipeline overview, run history, run detail
- `views/partials/head.ejs` - Shared layout header with navigation
- `views/partials/foot.ejs` - Shared layout footer
- `views/overview.ejs` - Pipeline overview grid with traffic-light cards
- `views/run-history.ejs` - Paginated run history table for a pipeline
- `views/run-detail.ejs` - Run detail with per-step breakdown
- `lib/web-server.js` - Added routes (GET /, GET /pipeline/:name, GET /run/:id) with helpers
- `public/style.css` - Added pipeline grid, data tables, pagination, breadcrumbs, run summary styles

## Decisions Made

**EJS partials pattern:** Used include('partials/head') and include('partials/foot') instead of layout inheritance, since @fastify/view doesn't natively support layouts. Simple and explicit.

**Overdue detection:** Each pipeline has a configured hours threshold (people: 4h, nikki: 25h, freescout: 25h, teams: 192h, functions: 4h, discipline: 192h). Pipeline is overdue if last run was more than threshold hours ago, or never run.

**Lazy database connection:** dashboard-queries.js opens database connection on first query and reuses it, closed via closeDb() in server onClose hook. Avoids opening multiple connections.

**Helper functions as locals:** formatRelativeTime and formatDuration passed to EJS views as locals, enabling consistent formatting across all templates.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Pipeline overview, run history, and run detail pages complete
- Ready for Phase 37-02 (Error Browser)
- Error browser will add /errors route with filtering by pipeline and date range
- Error detail will show individual member failures with stack traces

---
*Phase: 37-dashboard-ui*
*Completed: 2026-02-09*
