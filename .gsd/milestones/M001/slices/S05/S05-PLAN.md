# S05: Email Migration

**Goal:** Replace always-send email reports with error-only alerts containing dashboard links.
**Demo:** Replace always-send email reports with error-only alerts containing dashboard links.

## Must-Haves


## Tasks

- [x] **T01: 38-email-migration 01**
  - Replace always-send email reports with error-only alerts containing dashboard links.

Purpose: Emails become alerts, not reports. Successful runs produce no email (the dashboard is the source of truth). Failed pipeline runs and overdue pipelines trigger minimal emails with clickable links to the dashboard.

Output: New `lib/alert-email.js` module, updated `sync.sh`, overdue check in web server, deleted old `scripts/send-email.js`.

## Files Likely Touched

- `lib/alert-email.js`
- `scripts/sync.sh`
- `scripts/send-email.js`
- `lib/web-server.js`
- `.env.example`
