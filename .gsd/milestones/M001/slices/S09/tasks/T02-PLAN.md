# T02: 42-code-references 02

**Slice:** S09 — **Milestone:** M001

## Description

Rename all stadion references to rondo_club in the team, commissie, discipline, and important dates step files.

Purpose: These step files consume DB layer output from rondo-club-db.js (updated in Phase 41) and must now destructure and reference the new column names (rondo_club_id, rondo_club_work_history_id, etc.).

Output: 6 step files with zero stadion references.

## Must-Haves

- [ ] "All stadion references in team/commissie/discipline step files are renamed to rondo_club"
- [ ] "SQL queries in steps use rondo_club_members table name"
- [ ] "Variable names use rondo_club_id instead of stadion_id throughout"
- [ ] "Function parameter names and local variable names use rondo_club naming"

## Files

- `steps/submit-rondo-club-teams.js`
- `steps/submit-rondo-club-work-history.js`
- `steps/submit-rondo-club-commissies.js`
- `steps/submit-rondo-club-commissie-work-history.js`
- `steps/submit-rondo-club-discipline.js`
- `steps/sync-important-dates.js`
