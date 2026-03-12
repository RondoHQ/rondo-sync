# T01: 35-run-tracking 01

**Slice:** S02 — **Milestone:** M001

## Description

Create a run-tracker library and instrument all 6 pipelines (plus sync-all) to persist structured run data to the dashboard database.

Purpose: Every pipeline run produces queryable data (run timing, per-step counts, individual errors) that the web dashboard (Phase 37) will display. Without this, there is nothing to show.

Output: `lib/run-tracker.js` with RunTracker class, and all 7 pipeline files modified to use it.

## Must-Haves

- [ ] "After any pipeline runs, dashboard.sqlite contains a row in runs with start time, end time, duration_ms, and outcome"
- [ ] "Each run has per-step rows in run_steps with created/updated/skipped/failed counts"
- [ ] "Individual sync errors are stored in run_errors with member identifier, step name, error message, and timestamp"
- [ ] "All 6 pipelines write run data without modifying their core sync logic"
- [ ] "Run tracking is a thin wrapper that adds 5-15 lines per pipeline"
- [ ] "If the run tracker itself fails, the pipeline still completes normally"

## Files

- `lib/run-tracker.js`
- `pipelines/sync-people.js`
- `pipelines/sync-nikki.js`
- `pipelines/sync-teams.js`
- `pipelines/sync-functions.js`
- `pipelines/sync-discipline.js`
- `pipelines/sync-freescout.js`
- `pipelines/sync-all.js`
