# S02: Photo sync

**Goal:** Individual sync with `--fetch` downloads the member's photo from Sportlink and uploads it to Rondo Club, matching the bulk pipeline's end state.
**Demo:** Run `node pipelines/sync-individual.js <knvb-id> --fetch --verbose` for a member with a photo → photo file downloaded to `photos/`, uploaded to Rondo Club, and `photo_state` set to `synced` in the database.

## Must-Haves

- `fetchFreshDataFromSportlink()` downloads the photo inline (while the signed URL is fresh) using `downloadPhotoFromUrl()` from `lib/photo-utils.js`
- `syncIndividual()` uploads the downloaded photo to Rondo Club via `uploadPhotoToRondoClub()` after person sync completes (both UPDATE and CREATE paths)
- Photo state updated to `synced` in DB after successful upload via `updatePhotoState()`
- Entire photo flow wrapped in try/catch — photo failures must not block person sync (non-critical pattern)
- `--dry-run` shows photo status (available yes/no, photo date)
- `uploadPhotoToRondoClub` and `findPhotoFile` exported from `steps/upload-photos-to-rondo-club.js` (currently only `runPhotoSync` is exported)
- Without `--fetch`, no photo download/upload happens (no signed URL available)

## Proof Level

- This slice proves: integration
- Real runtime required: no (structural verification — the project has no test framework and uses script-based checks per S01 precedent; real integration verified on production server as a post-deploy manual step)
- Human/UAT required: yes — final verification is syncing a real member with a photo on the production server and confirming the photo appears in Rondo Club

## Verification

- `node -e "const m = require('./steps/upload-photos-to-rondo-club'); console.log(typeof m.uploadPhotoToRondoClub, typeof m.findPhotoFile)"` → prints `function function`
- `node -e "require('./pipelines/sync-individual')"` → loads without require-time errors
- `grep -c 'downloadPhotoFromUrl' pipelines/sync-individual.js` → at least 1 (import + usage)
- `grep -c 'uploadPhotoToRondoClub' pipelines/sync-individual.js` → at least 2 (import + usage in UPDATE + CREATE)
- `grep -c 'updatePhotoState' pipelines/sync-individual.js` → at least 2 (import + usage)
- `grep 'Photo:' pipelines/sync-individual.js | grep -q 'dry-run\|dryRun\|photo_date'` → dry-run section includes photo info
- `bash scripts/verify-s02.sh` → all checks pass (structural verification script covering all must-haves)

## Observability / Diagnostics

- Runtime signals: Verbose log lines during photo download (`Downloading photo for <knvbId>...`, `Photo downloaded: <bytes> bytes`, `Photo uploaded to Rondo Club`) and error messages (`Photo download failed: <message>`, `Photo upload failed: <message>`)
- Inspection surfaces: `photo_state` column in `rondo_club_members` table — query with `SELECT knvb_id, photo_state, photo_state_updated_at FROM rondo_club_members WHERE knvb_id = '<id>'`; photo files in `photos/` directory
- Failure visibility: Photo errors logged to console but not propagated (non-critical); verbose mode shows download/upload failure details; `photo_state` remains `pending_download` or `downloaded` on partial failure (visible in DB)
- Redaction constraints: none (photo URLs are CDN URLs, not secrets)

## Integration Closure

- Upstream surfaces consumed: `fetchMemberDataFromOtherPage()` returns `photo_url` via MemberHeader API response; `downloadPhotoFromUrl()` from `lib/photo-utils.js`; `uploadPhotoToRondoClub()` and `findPhotoFile()` from `steps/upload-photos-to-rondo-club.js` (after export); `updatePhotoState()` from `lib/rondo-club-db.js`
- New wiring introduced in this slice: photo download inside `fetchFreshDataFromSportlink()`, photo upload inside `syncIndividual()` after person sync, photo info in `--dry-run` output
- What remains before the milestone is truly usable end-to-end: nothing — after this slice, individual sync has full feature parity with bulk people sync (photos, invoice data, financial block, volunteer status)

## Tasks

- [x] **T01: Export uploadPhotoToRondoClub and findPhotoFile, wire photo download into fetchFreshDataFromSportlink** `est:25m`
  - Why: The photo upload/find functions are defined but not exported from `upload-photos-to-rondo-club.js`. The photo must be downloaded inside `fetchFreshDataFromSportlink()` while the signed CDN URL is fresh — before the browser closes.
  - Files: `steps/upload-photos-to-rondo-club.js`, `pipelines/sync-individual.js`
  - Do: (1) Add `uploadPhotoToRondoClub` and `findPhotoFile` to `module.exports` in `upload-photos-to-rondo-club.js`. (2) Import `downloadPhotoFromUrl` from `lib/photo-utils.js` in `sync-individual.js`. (3) In `fetchFreshDataFromSportlink()`, after `upsertMemberFreeFields` and before `return`, download the photo if `freeFieldsData.photo_url` is truthy — use `downloadPhotoFromUrl(freeFieldsData.photo_url, knvbId, photosDir, logger)` where `photosDir = path.join(process.cwd(), 'photos')` with `fs.mkdir(photosDir, { recursive: true })`. (4) Return `photoDownload` result (the `{ success, path, bytes }` object) in the function's return value. (5) The logger passed to `downloadPhotoFromUrl` must have a `verbose()` method — use the `logger` object already created in the function.
  - Verify: `node -e "const m = require('./steps/upload-photos-to-rondo-club'); console.log(typeof m.uploadPhotoToRondoClub, typeof m.findPhotoFile)"` → `function function`; `node -e "require('./pipelines/sync-individual')"` → no errors; `grep -q 'downloadPhotoFromUrl' pipelines/sync-individual.js` → exit 0
  - Done when: `uploadPhotoToRondoClub` and `findPhotoFile` are exported; `fetchFreshDataFromSportlink` downloads photo inline when URL is available and returns the result

- [x] **T02: Wire photo upload into syncIndividual and add dry-run display and verification script** `est:30m`
  - Why: After `fetchFreshDataFromSportlink` downloads the photo, `syncIndividual` needs to upload it to Rondo Club after the person is synced (needs `rondoClubId`). Dry-run must show photo status. A verification script proves all wiring is correct.
  - Files: `pipelines/sync-individual.js`, `scripts/verify-s02.sh`
  - Do: (1) Import `uploadPhotoToRondoClub`, `findPhotoFile` from `steps/upload-photos-to-rondo-club.js` and `updatePhotoState` from `lib/rondo-club-db.js` in `sync-individual.js`. (2) In the dry-run section, add a photo block showing: `Photo: available/not available`, `Photo date: <date>`, sourced from `freeFields` in the DB. (3) After person sync completes in both UPDATE and CREATE paths, add a non-critical try/catch block: find the photo via `findPhotoFile(knvbId, photosDir)`, if found call `uploadPhotoToRondoClub(rondoClubId, photoFile.path, { verbose })`, then `updatePhotoState(rondoClubDb, knvbId, 'synced')`. Log success/failure. (4) The `photosDir` and `photoDownload` info should be derived from `fetchResult` (download happened in T01) — only attempt upload if `fetch` was true and photo was downloaded. (5) Create `scripts/verify-s02.sh` that runs all slice-level verification checks (export types, require-time load, grep checks for all wiring points).
  - Verify: `bash scripts/verify-s02.sh` → all checks pass; `node -e "require('./pipelines/sync-individual')"` → no errors
  - Done when: Photo upload wired into both UPDATE and CREATE paths with non-critical error handling; dry-run shows photo status; `scripts/verify-s02.sh` passes all checks

## Files Likely Touched

- `steps/upload-photos-to-rondo-club.js` — add `uploadPhotoToRondoClub` and `findPhotoFile` to exports
- `pipelines/sync-individual.js` — wire photo download into `fetchFreshDataFromSportlink`, wire photo upload into `syncIndividual`, add dry-run photo display
- `scripts/verify-s02.sh` — structural verification script
