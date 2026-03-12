# T01: 38-email-migration 01

**Slice:** S05 — **Milestone:** M001

## Description

Replace always-send email reports with error-only alerts containing dashboard links.

Purpose: Emails become alerts, not reports. Successful runs produce no email (the dashboard is the source of truth). Failed pipeline runs and overdue pipelines trigger minimal emails with clickable links to the dashboard.

Output: New `lib/alert-email.js` module, updated `sync.sh`, overdue check in web server, deleted old `scripts/send-email.js`.

## Must-Haves

- [ ] "A successful pipeline run sends no email"
- [ ] "A pipeline run that crashes or exits non-zero sends an email with pipeline name, timestamp, and dashboard run detail link"
- [ ] "Each failed pipeline sends its own separate email, even when sync-all runs multiple pipelines"
- [ ] "Overdue pipelines trigger a grouped email alert with dashboard overview link"
- [ ] "Overdue alerts repeat with a 4-hour cooldown while pipelines remain overdue"
- [ ] "Alert email subject lines follow the format: [Rondo Sync] FAILED: people pipeline or [Rondo Sync] OVERDUE: people, nikki"

## Files

- `lib/alert-email.js`
- `scripts/sync.sh`
- `scripts/send-email.js`
- `lib/web-server.js`
- `.env.example`
