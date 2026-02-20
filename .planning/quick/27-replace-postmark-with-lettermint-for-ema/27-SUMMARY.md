---
phase: 27-replace-postmark-with-lettermint
plan: 01
subsystem: infra
tags: [lettermint, postmark, email, alert, npm]

# Dependency graph
requires: []
provides:
  - Alert emails sent via Lettermint SDK instead of Postmark
  - Env vars LETTERMINT_API_TOKEN and LETTERMINT_FROM_EMAIL replace POSTMARK_API_KEY and POSTMARK_FROM_EMAIL
affects: [alert-email, install-cron, sync-sh]

# Tech tracking
tech-stack:
  added: [lettermint ^1.5.0]
  patterns: [Lettermint fluent API for email: lettermint.email.from().to().subject().html().text().send()]

key-files:
  created: []
  modified:
    - lib/alert-email.js
    - scripts/sync.sh
    - scripts/install-cron.sh
    - .env.example
    - CLAUDE.md
    - package.json

key-decisions:
  - "Used lettermint CommonJS require (works natively, no dynamic import needed)"
  - "Replaced both sendFailureAlert and sendOverdueAlert sending blocks with Lettermint fluent API"

patterns-established:
  - "Lettermint fluent API: lettermint.email.from().to().subject().html().text().send()"

# Metrics
duration: 10min
completed: 2026-02-20
---

# Quick Task 27: Replace Postmark with Lettermint Summary

**Migrated all alert email sending from Postmark to Lettermint SDK using fluent API, renaming env vars from POSTMARK_* to LETTERMINT_*, removing postmark npm package and installing lettermint.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-02-20T08:09:00Z
- **Completed:** 2026-02-20T08:19:18Z
- **Tasks:** 2 of 3 (Task 3 skipped — deployment handled separately by orchestrator)
- **Files modified:** 6

## Accomplishments
- Replaced `require('postmark')` with `const { Lettermint } = require('lettermint')` in lib/alert-email.js
- Replaced both email sending blocks (sendFailureAlert and sendOverdueAlert) with Lettermint fluent API
- Updated all POSTMARK_API_KEY -> LETTERMINT_API_TOKEN and POSTMARK_FROM_EMAIL -> LETTERMINT_FROM_EMAIL env var references across all files
- Removed postmark npm package, installed lettermint ^1.5.0
- Updated install-cron.sh prompts, status messages, and variable names for Lettermint

## Task Commits

Each task was committed atomically:

1. **Task 1: Replace Postmark with Lettermint in alert-email.js and swap npm packages** - `d30f301` (feat)
2. **Task 2: Update shell scripts, env example, and documentation** - `a5a5851` (chore)

## Files Created/Modified
- `lib/alert-email.js` - Replaced postmark require with Lettermint, updated env var checks, rewritten send blocks using Lettermint fluent API, updated CLI help text
- `scripts/sync.sh` - Updated comment and env var check from POSTMARK_* to LETTERMINT_*
- `scripts/install-cron.sh` - Updated all Postmark references to Lettermint (variable names, prompts, status messages)
- `.env.example` - Replaced POSTMARK_API_KEY/POSTMARK_FROM_EMAIL with LETTERMINT_API_TOKEN/LETTERMINT_FROM_EMAIL
- `CLAUDE.md` - Updated env var docs and Tech Stack line
- `package.json` / `package-lock.json` - Removed postmark, added lettermint ^1.5.0

## Decisions Made
- lettermint package loads fine in CommonJS (`const { Lettermint } = require('lettermint')`) — no dynamic import needed
- Used Lettermint fluent API pattern: `.from().to().subject().html().text().send()`

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None — lettermint worked in CommonJS immediately, no fallback to dynamic import was needed.

## User Setup Required

Server deployment required (Task 3, handled by orchestrator):
- `git push` then `ssh root@46.202.155.16 "cd /home/rondo && git pull && npm install"`
- On server, update `.env`: remove `POSTMARK_API_KEY` and `POSTMARK_FROM_EMAIL`, add `LETTERMINT_API_TOKEN` and `LETTERMINT_FROM_EMAIL`
- Test with: `node lib/alert-email.js send-failure-alert --pipeline people`
- Restart web server if needed: `systemctl restart rondo-sync-web`

## Next Phase Readiness
- Code is fully migrated; server deployment + .env update remain to activate in production
- No further code changes needed

---
*Phase: 27-replace-postmark-with-lettermint*
*Completed: 2026-02-20*

## Self-Check: PASSED

- lib/alert-email.js: FOUND
- package.json: FOUND (lettermint ^1.5.0 present, postmark absent)
- .env.example: FOUND (LETTERMINT_API_TOKEN present)
- 27-SUMMARY.md: FOUND
- Commit d30f301 (Task 1): FOUND
- Commit a5a5851 (Task 2): FOUND
