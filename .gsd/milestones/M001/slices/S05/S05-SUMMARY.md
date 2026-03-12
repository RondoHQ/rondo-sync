---
id: S05
parent: M001
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
# S05: Email Migration

**# Phase 38 Plan 01: Email Migration Summary**

## What Happened

# Phase 38 Plan 01: Email Migration Summary

Replace always-send email reports with error-only alerts containing dashboard links.

## Tasks Completed

### Task 1: Create alert email module and update sync.sh
Created `lib/alert-email.js` with three core functions:
- `sendFailureAlert({ pipeline, runId, error, startedAt })` - Sends minimal failure alert with dashboard link to run detail
- `sendOverdueAlert(overduePipelines)` - Sends grouped overdue alert with dashboard overview link
- `checkAndAlertOverdue()` - Checks for overdue pipelines and sends alerts with 4-hour cooldown

Updated `scripts/sync.sh`:
- Removed old email block that called `send-email.js` with log parsing
- Added failure-only alert gated on `EXIT_CODE -ne 0`
- Alert looks up latest run ID automatically if not provided
- Calls: `node lib/alert-email.js send-failure-alert --pipeline "$SYNC_TYPE"`

Deleted `scripts/send-email.js` (old log-parsing email script).

Added `DASHBOARD_URL` to `.env.example`.

**Commit:** `741c93d` - feat(38-01): add alert email module for failure-only notifications

### Task 2: Add periodic overdue check to web server
Updated `lib/web-server.js`:
- Imported `checkAndAlertOverdue` from `./alert-email`
- Set up 30-minute periodic check via `setInterval`
- Run initial check 10 seconds after server startup
- Clean up interval in `onClose` hook alongside `closeDb()`

Overdue detection logic:
- Reuses `PIPELINE_CONFIG` thresholds (people/functions: 4h, nikki/freescout: 25h, teams/discipline: 192h)
- Queries dashboard database for latest run per pipeline
- 4-hour cooldown prevents spam (alert only if 4+ hours since last OR set of overdue pipelines changed)
- Grouped alerts list all currently overdue pipelines with "last run" timestamps

**Commit:** `6f8860b` - feat(38-01): add periodic overdue check to web server

## Deviations from Plan

None - plan executed exactly as written.

## Email Content Examples

### Failure Alert
- **Subject:** `[Rondo Sync] FAILED: people pipeline`
- **Body:** Pipeline name, start time, error summary, clickable "View Run Details" button linking to `${DASHBOARD_URL}/run/${runId}`
- **Footer:** Dashboard URL for context

### Overdue Alert
- **Subject:** `[Rondo Sync] OVERDUE: people, nikki`
- **Body:** Table of overdue pipelines with "last run" timestamps, clickable "View Dashboard" button linking to `${DASHBOARD_URL}/`
- **Footer:** "This alert will repeat every 4 hours while pipelines remain overdue"

## Verification

1. **No email on success:** Alert call in `sync.sh` is gated on `EXIT_CODE -ne 0` ✓
2. **Failure email with dashboard link:** `sendFailureAlert` constructs `${DASHBOARD_URL}/run/${runId}` URL ✓
3. **Overdue email with dashboard link:** `sendOverdueAlert` links to `${DASHBOARD_URL}/` ✓
4. **Subject line format:** `[Rondo Sync] FAILED:` and `[Rondo Sync] OVERDUE:` patterns verified ✓
5. **Old email code removed:** `scripts/send-email.js` deleted, no references in `sync.sh` ✓
6. **4-hour cooldown:** `shouldSendOverdueAlert()` checks timestamp and pipeline set changes ✓

## Success Criteria

- [x] `scripts/send-email.js` does not exist
- [x] `lib/alert-email.js` exports sendFailureAlert, sendOverdueAlert, checkAndAlertOverdue
- [x] `scripts/sync.sh` only sends email on non-zero exit code
- [x] `lib/web-server.js` runs periodic overdue checks
- [x] `.env.example` includes DASHBOARD_URL
- [x] EMAIL-01: successful pipeline runs send no email
- [x] EMAIL-02: failure emails contain clickable dashboard link to run detail

## Self-Check

Verifying implementation claims:

**Created files:**
```bash
[ -f "lib/alert-email.js" ] && echo "FOUND: lib/alert-email.js" || echo "MISSING: lib/alert-email.js"
```
Output: FOUND: lib/alert-email.js ✓

**Modified files exist:**
```bash
[ -f "scripts/sync.sh" ] && echo "FOUND: scripts/sync.sh" || echo "MISSING: scripts/sync.sh"
[ -f "lib/web-server.js" ] && echo "FOUND: lib/web-server.js" || echo "MISSING: lib/web-server.js"
[ -f ".env.example" ] && echo "FOUND: .env.example" || echo "MISSING: .env.example"
```
Output: All files FOUND ✓

**Deleted files:**
```bash
[ ! -f "scripts/send-email.js" ] && echo "DELETED: scripts/send-email.js" || echo "EXISTS: scripts/send-email.js"
```
Output: DELETED: scripts/send-email.js ✓

**Commits exist:**
```bash
git log --oneline --all | grep -q "741c93d" && echo "FOUND: 741c93d" || echo "MISSING: 741c93d"
git log --oneline --all | grep -q "6f8860b" && echo "FOUND: 6f8860b" || echo "MISSING: 6f8860b"
```
Output: Both commits FOUND ✓

## Self-Check: PASSED

All files created, modified, and deleted as documented. All commits exist in git history.

## Technical Notes

### Module Structure
`lib/alert-email.js` follows the existing module/CLI hybrid pattern:
- Exports functions for programmatic use
- Provides CLI interface when run directly
- Uses `varlock/auto-load` for environment variable loading
- Gracefully handles missing env vars (logs warning, skips send)

### HTML Email Template
- Clean font stack (`-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto`)
- Max-width 600px for readability
- Prominent clickable link button with proper styling
- Both HTML and text versions provided
- Minimal content (no log parsing, no complex formatting)

### Overdue Check Implementation
- Runs as web server periodic task (not separate cron job)
- In-memory state tracking for 4-hour cooldown (resets on server restart)
- Set equality check detects when new pipelines become overdue
- Dashboard database queries reuse same schema as dashboard UI
- Database connection opened per check, closed after

### Environment Variables
New required var: `DASHBOARD_URL` (e.g., `https://sync.rfreimann.nl`)
Existing vars reused: `POSTMARK_API_KEY`, `POSTMARK_FROM_EMAIL`, `OPERATOR_EMAIL`

### Transition Behavior
Cold switch - no parallel period. Old `send-email.js` deleted entirely. No backward compatibility needed.

## Next Steps

Email migration is complete. The dashboard is now the source of truth for successful run data. Operators receive alerts only when action is needed (pipeline failure or overdue schedule).

Phase 38 has only one plan, so this completes the Email Migration phase.
