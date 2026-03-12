# S02: Run Tracking

**Goal:** Create a run-tracker library and instrument all 6 pipelines (plus sync-all) to persist structured run data to the dashboard database.
**Demo:** Create a run-tracker library and instrument all 6 pipelines (plus sync-all) to persist structured run data to the dashboard database.

## Must-Haves


## Tasks

- [x] **T01: 35-run-tracking 01** `est:67min`
  - Create a run-tracker library and instrument all 6 pipelines (plus sync-all) to persist structured run data to the dashboard database.

Purpose: Every pipeline run produces queryable data (run timing, per-step counts, individual errors) that the web dashboard (Phase 37) will display. Without this, there is nothing to show.

Output: `lib/run-tracker.js` with RunTracker class, and all 7 pipeline files modified to use it.

## Files Likely Touched

- `lib/run-tracker.js`
- `pipelines/sync-people.js`
- `pipelines/sync-nikki.js`
- `pipelines/sync-teams.js`
- `pipelines/sync-functions.js`
- `pipelines/sync-discipline.js`
- `pipelines/sync-freescout.js`
- `pipelines/sync-all.js`
