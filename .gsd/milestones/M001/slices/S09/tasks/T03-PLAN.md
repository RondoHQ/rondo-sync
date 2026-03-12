# T03: 42-code-references 03

**Slice:** S09 — **Milestone:** M001

## Description

Rename all stadion references to rondo_club in pipeline files, tool files, and the one remaining lib file (http-client.js).

Purpose: Complete the code reference rename across the entire codebase. After this plan, zero stadion references should remain outside of Phase 41 migration code in lib/rondo-club-db.js and lib/discipline-db.js.

Output: 17 files with zero stadion references. Full codebase clean of stadion naming.

## Must-Haves

- [ ] "All stadion references in pipeline files are renamed to rondo_club"
- [ ] "All stadion references in tool files are renamed to rondo_club"
- [ ] "SQL queries in pipelines and tools use rondo_club_* table names"
- [ ] "Variable names use rondo_club_id throughout pipelines and tools"
- [ ] "Zero stadion references remain in the codebase outside of migration code in lib/"

## Files

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
