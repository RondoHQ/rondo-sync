---
id: S04
parent: M001
milestone: M001
provides:
  - Pipeline overview page with traffic-light status cards
  - Run history page with paginated run list per pipeline
  - Run detail page with per-step breakdown and counts
  - Dashboard queries module for reading dashboard database
  - Shared EJS layout partials with navigation and logout
  - Error browser page with filtering by pipeline, date range, and run
  - Error detail page with individual member failures and stack traces
  - Responsive layout verified on mobile
requires: []
affects: []
key_files: []
key_decisions:
  - "EJS partials pattern (include head/foot) instead of layout inheritance"
  - "formatRelativeTime and formatDuration helpers passed to all views"
  - "Overdue detection based on cron schedule × 1.5 grace period"
  - "20 runs per page for pagination"
  - "Dynamic WHERE clause for flexible error filtering"
  - "Error detail shows all errors for a run (not paginated, typically <50)"
  - "Stack traces use HTML details/summary for progressive disclosure"
patterns_established:
  - "Dashboard queries module with lazy database connection (open once, reuse)"
  - "Helper functions for formatting passed as locals to EJS templates"
  - "KNOWN_PIPELINES map for display names and validation"
  - "Filter form preserves state via query params (pipeline, date_from, date_to, run_id)"
  - "Error cards with red left border for visual emphasis"
observability_surfaces: []
drill_down_paths: []
duration: 8min
verification_result: passed
completed_at: 2026-02-09
blocker_discovered: false
---
# S04: Dashboard Ui

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

# Phase 37 Plan 02: Error Browser and Responsive Verification Summary

**Error browser with pipeline/date filtering, error detail with expandable stack traces, and responsive layout verified on production**

## Performance

- **Duration:** 8 min
- **Started:** 2026-02-09T10:01:00Z
- **Completed:** 2026-02-09T10:09:00Z
- **Tasks:** 2 (1 auto + 1 checkpoint)
- **Files modified:** 5

## Accomplishments
- Error browser page with filtering by pipeline, date range, and run ID
- Error detail page showing individual member failures with expandable stack traces
- Filter form preserves selected values across submissions
- Pagination on error list (20 per page)
- Run detail page links to error browser when errors exist
- Dashboard visually verified on production server by user

## Task Commits

Each task was committed atomically:

1. **Task 1: Error browser and error detail pages** - `3ee96ab` (feat)
2. **Task 2: Human verification checkpoint** - User approved dashboard on production

**Plan metadata:** (this commit)

## Files Created/Modified
- `views/errors.ejs` - Error browser with filter form (pipeline, date range), paginated error table
- `views/error-detail.ejs` - Error detail with cards showing step badge, member ID, error message, expandable stack traces
- `lib/dashboard-queries.js` - Added getErrors() with dynamic filtering and getRunErrors()
- `lib/web-server.js` - Added GET /errors and GET /errors/:runId routes with requireAuth
- `public/style.css` - Added filter-bar, error-card, banner, pipeline-badge styles and mobile responsive rules

## Decisions Made

**Dynamic WHERE clause:** Error query builds WHERE conditions dynamically based on provided filters (pipeline, dateFrom, dateTo, runId). Always includes club_slug = 'rondo'.

**Unpaginated error detail:** Error detail for a single run shows all errors without pagination since typical error count per run is <50.

**Progressive disclosure for stack traces:** Uses HTML `<details><summary>` elements for stack traces, keeping the page clean while making full traces accessible.

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Complete dashboard UI verified on production
- All 5 pages functional: overview, run history, run detail, error browser, error detail
- Ready for Phase 38 (Email Migration)

---
*Phase: 37-dashboard-ui*
*Completed: 2026-02-09*
