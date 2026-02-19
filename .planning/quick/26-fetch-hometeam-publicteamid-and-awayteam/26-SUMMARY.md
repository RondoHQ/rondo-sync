---
phase: 26-fetch-hometeam-publicteamid-and-awayteam
plan: 01
subsystem: database, api
tags: [sqlite, sportlink, discipline, acf, rondo-club, teams]

# Dependency graph
requires:
  - phase: discipline-pipeline
    provides: discipline_cases table, download/submit steps
  - phase: teams-pipeline
    provides: rondo_club_teams table with sportlink_id -> rondo_club_id mapping
provides:
  - home_team_id and away_team_id columns in discipline_cases SQLite table
  - HomeTeam.PublicTeamId and AwayTeam.PublicTeamId extraction from Sportlink API
  - home_team and away_team ACF post_object fields on discipline_case CPT in Rondo Club
  - End-to-end resolution of Sportlink team IDs to WordPress team post IDs on sync
affects: [discipline-sync, rondo-club-discipline-cases]

# Tech tracking
tech-stack:
  added: []
  patterns: [getTeamBySportlinkId lookup from rondo-club-db for cross-pipeline ID resolution]

key-files:
  created: []
  modified:
    - lib/discipline-db.js
    - steps/submit-rondo-club-discipline.js
    - ../rondo-club/acf-json/group_discipline_case_fields.json

key-decisions:
  - "Store Sportlink PublicTeamId strings (not WordPress post IDs) in discipline_cases — resolution happens at sync time"
  - "Include home_team_id and away_team_id in computeCaseHash so team changes trigger re-sync"
  - "Send empty string (not null) for missing teams to match existing ACF post_object field pattern"
  - "Open rondoClubDb per runSync call (not per case) to avoid repeated DB opens"

patterns-established:
  - "Cross-pipeline ID resolution: store source IDs in domain DB, resolve to WordPress IDs at sync time via rondo-club-db helpers"

# Metrics
duration: 3min
completed: 2026-02-19
---

# Quick Task 26: Fetch HomeTeam.PublicTeamId and AwayTeam.PublicTeamId Summary

**End-to-end discipline case team linking: Sportlink HomeTeam/AwayTeam PublicTeamIds captured in SQLite and resolved to WordPress team post IDs via getTeamBySportlinkId on sync**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-02-19T15:19:54Z
- **Completed:** 2026-02-19T15:22:24Z
- **Tasks:** 2
- **Files modified:** 3 (across 2 repos)

## Accomplishments

- Added `home_team_id` and `away_team_id` TEXT columns to `discipline_cases` SQLite table via ALTER TABLE migration
- Updated `computeCaseHash` to include both team IDs — changes to team assignments now trigger re-sync
- Updated `upsertCases` to extract `HomeTeam.PublicTeamId` and `AwayTeam.PublicTeamId` from nested Sportlink API objects
- Updated all SELECT queries (`getAllCases`, `getCasesByPersonId`, `getCasesNeedingSync`, `getCaseByDossierId`) to return new columns
- Added `home_team` and `away_team` post_object ACF fields to Rondo Club discipline_case field group
- Submit step resolves Sportlink PublicTeamIds to WordPress team post IDs using existing `getTeamBySportlinkId` helper
- Missing teams are gracefully skipped with verbose logging; empty string sent to ACF

## Task Commits

Each task was committed atomically:

1. **Task 1: Add home/away team columns to discipline DB** - `988e248` (feat) — rondo-sync repo
2. **Task 2: Resolve team IDs and sync to Rondo Club** - `2319068` (feat) — rondo-sync repo
2. **Task 2: ACF field group update** - `b8950ec5` (feat) — rondo-club repo

**Plan metadata:** (docs commit below)

## Files Created/Modified

- `lib/discipline-db.js` - Added home_team_id/away_team_id columns, migration, hash, upsert, and SELECT updates
- `steps/submit-rondo-club-discipline.js` - Import getTeamBySportlinkId, open rondoClubDb in runSync, resolve team IDs per case, pass to syncCase, add to ACF payload
- `../rondo-club/acf-json/group_discipline_case_fields.json` - Added home_team (Thuisteam) and away_team (Uitteam) post_object fields referencing team CPT

## Decisions Made

- Store raw Sportlink `PublicTeamId` strings in the discipline DB (not WordPress post IDs). Resolution happens at sync time using `getTeamBySportlinkId`, matching the established pattern for cross-pipeline ID mapping.
- Include team IDs in `computeCaseHash` so that if Sportlink reassigns teams to a match, the case will re-sync to Rondo Club automatically.
- Send empty string (`''`) for unresolved teams (not `null`) — matches existing pattern for optional post_object ACF fields.

## Deviations from Plan

None — plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

**Deploy sequence required before data flows:**

1. Deploy rondo-club first (ACF fields must exist before sync sends team data):
   ```bash
   cd ~/Code/rondo/rondo-club && ./bin/deploy.sh
   ```

2. Deploy rondo-sync (git pull on server):
   ```bash
   ssh root@46.202.155.16 "cd /home/rondo && git pull"
   ```

3. Run force sync to backfill existing discipline cases with team data:
   ```bash
   ssh root@46.202.155.16 "cd /home/rondo && scripts/sync.sh discipline --force"
   ```

## Next Phase Readiness

- Discipline pipeline now captures team context end-to-end
- Rondo Club discipline case views can now navigate to home/away team posts
- No further changes required unless Sportlink adds additional match context fields

## Self-Check

- `lib/discipline-db.js` — verified present and columns confirmed via `PRAGMA table_info`
- `steps/submit-rondo-club-discipline.js` — module loads cleanly
- `../rondo-club/acf-json/group_discipline_case_fields.json` — valid JSON, 13 fields including home_team and away_team
- Commits `988e248` (rondo-sync task 1), `2319068` (rondo-sync task 2), `b8950ec5` (rondo-club ACF) confirmed

## Self-Check: PASSED

---
*Quick Task: 26-fetch-hometeam-publicteamid-and-awayteam*
*Completed: 2026-02-19*
