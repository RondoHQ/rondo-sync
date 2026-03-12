# S09: Code References

**Goal:** Rename all stadion references to rondo_club in the people-pipeline step files: member sync, parent sync, photo upload, FreeScout customer prep, Nikki sync, and function download.
**Demo:** Rename all stadion references to rondo_club in the people-pipeline step files: member sync, parent sync, photo upload, FreeScout customer prep, Nikki sync, and function download.

## Must-Haves


## Tasks

- [x] **T01: 42-code-references 01**
  - Rename all stadion references to rondo_club in the people-pipeline step files: member sync, parent sync, photo upload, FreeScout customer prep, Nikki sync, and function download.

Purpose: Phase 41 migrated the database layer (tables and columns renamed, query functions updated). These step files consume the DB layer output and must now use the new naming (rondo_club_id instead of stadion_id, rondo_club_members instead of stadion_members, etc.).

Output: 5 step files with zero stadion references (except inside migration-related comments if any).
- [x] **T02: 42-code-references 02**
  - Rename all stadion references to rondo_club in the team, commissie, discipline, and important dates step files.

Purpose: These step files consume DB layer output from rondo-club-db.js (updated in Phase 41) and must now destructure and reference the new column names (rondo_club_id, rondo_club_work_history_id, etc.).

Output: 6 step files with zero stadion references.
- [x] **T03: 42-code-references 03**
  - Rename all stadion references to rondo_club in pipeline files, tool files, and the one remaining lib file (http-client.js).

Purpose: Complete the code reference rename across the entire codebase. After this plan, zero stadion references should remain outside of Phase 41 migration code in lib/rondo-club-db.js and lib/discipline-db.js.

Output: 17 files with zero stadion references. Full codebase clean of stadion naming.

## Files Likely Touched

- `steps/submit-rondo-club-sync.js`
- `steps/upload-photos-to-rondo-club.js`
- `steps/prepare-freescout-customers.js`
- `steps/sync-nikki-to-rondo-club.js`
- `steps/download-functions-from-sportlink.js`
- `steps/submit-rondo-club-teams.js`
- `steps/submit-rondo-club-work-history.js`
- `steps/submit-rondo-club-commissies.js`
- `steps/submit-rondo-club-commissie-work-history.js`
- `steps/submit-rondo-club-discipline.js`
- `steps/sync-important-dates.js`
- `pipelines/sync-individual.js`
- `pipelines/sync-all.js`
- `pipelines/sync-former-members.js`
- `pipelines/reverse-sync.js`
- `lib/http-client.js`
- `tools/verify-rondo-club-data.js`
- `tools/reset-photo-states.js`
- `tools/merge-duplicate-person.js`
- `tools/clear-commissie-work-history.js`
- `tools/cleanup-orphan-relationships.js`
- `tools/cleanup-duplicate-former-members.js`
- `tools/cleanup-rondo-club-duplicates.js`
- `tools/validate-rondo-club-ids.js`
- `tools/merge-duplicate-parents.js`
- `tools/unmerge-parent-from-child.js`
- `tools/repopulate-rondo-club-ids.js`
- `tools/verify-all.js`
