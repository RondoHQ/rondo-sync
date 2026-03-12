# M002: Individual Sync Parity

**Vision:** An individual member sync produces the same complete data as the bulk people sync — photos, invoice data, financial block activity, and volunteer status all included.

## Success Criteria

- A member synced via `node pipelines/sync-individual.js <id> --fetch` has invoice address/email, financial block activity log, volunteer status, and photo — identical to bulk sync output
- The web API endpoint `POST /api/sync/individual` exercises all the same data flows
- `--dry-run` output shows invoice fields, photo state, and all ACF fields

## Key Risks / Unknowns

- Browser session timeout when adding financial tab — Sportlink sessions can expire between page navigations
- Photo download/upload adding latency to API response — could exceed acceptable response time

## Proof Strategy

- Browser session risk → retire in S01 by proving financial tab fetch works in the existing `fetchFreshDataFromSportlink` function
- Photo latency risk → retire in S02 by running an individual sync with photo and measuring total time

## Verification Classes

- Contract verification: `--dry-run` output comparison between individual and bulk sync for same member
- Integration verification: run individual sync on production server and verify person data in Rondo Club WordPress
- Operational verification: none (existing deployment unchanged)
- UAT / human verification: none

## Milestone Definition of Done

This milestone is complete only when all are true:

- All slices are complete and merged to main
- Individual sync with `--fetch` produces same person data as bulk sync
- Photo, invoice, financial block, and volunteer status all flow through individual sync
- Deployed to production server and verified with a real member

## Requirement Coverage

- Covers: individual sync feature parity with people sync
- Partially covers: none
- Leaves for later: Laposta individual sync, FreeScout individual sync
- Orphan risks: none

## Slices

- [ ] **S01: Invoice data and side-effects** `risk:medium` `depends:[]`
  > After this: individual sync fetches financial data from Sportlink, passes invoice data to preparePerson, logs financial block activities, and captures volunteer status — verified by running `--fetch --dry-run` and seeing invoice fields in output, then a real sync showing activity log and volunteer status in Rondo Club

- [ ] **S02: Photo sync** `risk:medium` `depends:[S01]`
  > After this: individual sync with `--fetch` downloads the member's photo from Sportlink and uploads it to Rondo Club — verified by syncing a member with a photo and confirming the photo appears on their person record

## Boundary Map

### S01 → S02

Produces:
- `fetchFreshDataFromSportlink()` returns `invoiceData` alongside existing fields
- `syncIndividual()` calls `logFinancialBlockActivity()` and `updateVolunteerStatus()` after person sync
- `preparePerson()` receives invoice data instead of null

Consumes:
- nothing (first slice)
