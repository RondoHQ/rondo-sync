# T01: 42-code-references 01

**Slice:** S09 — **Milestone:** M001

## Description

Rename all stadion references to rondo_club in the people-pipeline step files: member sync, parent sync, photo upload, FreeScout customer prep, Nikki sync, and function download.

Purpose: Phase 41 migrated the database layer (tables and columns renamed, query functions updated). These step files consume the DB layer output and must now use the new naming (rondo_club_id instead of stadion_id, rondo_club_members instead of stadion_members, etc.).

Output: 5 step files with zero stadion references (except inside migration-related comments if any).

## Must-Haves

- [ ] "All stadion references in people-pipeline step files are renamed to rondo_club"
- [ ] "SQL queries in steps use rondo_club_members and rondo_club_parents table names"
- [ ] "Variable names use rondo_club_id instead of stadion_id throughout"
- [ ] "Function names use RondoClub instead of Stadion throughout"

## Files

- `steps/submit-rondo-club-sync.js`
- `steps/upload-photos-to-rondo-club.js`
- `steps/prepare-freescout-customers.js`
- `steps/sync-nikki-to-rondo-club.js`
- `steps/download-functions-from-sportlink.js`
