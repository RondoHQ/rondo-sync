# T02: 37-dashboard-ui 02

**Slice:** S04 — **Milestone:** M001

## Description

Build the error browser with filtering and drill-down, then polish responsive layout across all dashboard pages.

Purpose: Operators need to investigate sync failures without SSH. The error browser lets them filter errors by pipeline and date range, then drill down to see which members failed and why. Responsive polish ensures the dashboard works on phones for on-the-go monitoring.

Output: Error browser page, error detail view, and a responsive layout verified on mobile.

## Must-Haves

- [ ] "Error browser lists all errors with filtering by pipeline and date range"
- [ ] "Error drill-down shows individual member failures with error details"
- [ ] "Dashboard is usable on a phone screen"
- [ ] "All pages are responsive at mobile and tablet breakpoints"

## Files

- `lib/dashboard-queries.js`
- `views/errors.ejs`
- `views/error-detail.ejs`
- `lib/web-server.js`
- `public/style.css`
