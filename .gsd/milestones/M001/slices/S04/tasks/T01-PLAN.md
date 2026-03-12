# T01: 37-dashboard-ui 01

**Slice:** S04 — **Milestone:** M001

## Description

Build the pipeline overview page, run history page, and run detail page for the dashboard.

Purpose: Operators need to monitor all 6 pipeline activities at a glance and drill into individual runs to see per-step breakdown with counts -- replacing SSH access as the primary monitoring tool.

Output: Three functional dashboard pages served via EJS templates with a shared layout, backed by a data query module that reads from the dashboard SQLite database.

## Must-Haves

- [ ] "Pipeline overview page shows traffic-light status (green/yellow/red) for all 6 pipelines"
- [ ] "Each pipeline shows last run time, outcome, and key counts (created, updated, failed)"
- [ ] "Overdue pipelines are visually flagged based on their cron schedule"
- [ ] "User can click a pipeline to see paginated run history"
- [ ] "User can click a run to see per-step breakdown with counts"
- [ ] "All pages use server-rendered HTML via EJS templates (no SPA, no build step)"

## Files

- `lib/dashboard-queries.js`
- `lib/web-server.js`
- `views/layout.ejs`
- `views/overview.ejs`
- `views/run-history.ejs`
- `views/run-detail.ejs`
- `public/style.css`
