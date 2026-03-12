# S04: Dashboard Ui

**Goal:** Build the pipeline overview page, run history page, and run detail page for the dashboard.
**Demo:** Build the pipeline overview page, run history page, and run detail page for the dashboard.

## Must-Haves


## Tasks

- [x] **T01: 37-dashboard-ui 01** `est:3min`
  - Build the pipeline overview page, run history page, and run detail page for the dashboard.

Purpose: Operators need to monitor all 6 pipeline activities at a glance and drill into individual runs to see per-step breakdown with counts -- replacing SSH access as the primary monitoring tool.

Output: Three functional dashboard pages served via EJS templates with a shared layout, backed by a data query module that reads from the dashboard SQLite database.
- [x] **T02: 37-dashboard-ui 02** `est:8min`
  - Build the error browser with filtering and drill-down, then polish responsive layout across all dashboard pages.

Purpose: Operators need to investigate sync failures without SSH. The error browser lets them filter errors by pipeline and date range, then drill down to see which members failed and why. Responsive polish ensures the dashboard works on phones for on-the-go monitoring.

Output: Error browser page, error detail view, and a responsive layout verified on mobile.

## Files Likely Touched

- `lib/dashboard-queries.js`
- `lib/web-server.js`
- `views/layout.ejs`
- `views/overview.ejs`
- `views/run-history.ejs`
- `views/run-detail.ejs`
- `public/style.css`
- `lib/dashboard-queries.js`
- `views/errors.ejs`
- `views/error-detail.ejs`
- `lib/web-server.js`
- `public/style.css`
