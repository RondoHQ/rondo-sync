---
estimated_steps: 5
estimated_files: 3
---

# T02: Wire photo upload into syncIndividual and add dry-run display and verification script

**Slice:** S02 — Photo sync
**Milestone:** M002

## Description

Complete the photo sync wiring by:

1. **Importing upload/state functions** into `sync-individual.js` — `uploadPhotoToRondoClub` and `findPhotoFile` from `steps/upload-photos-to-rondo-club.js` (exported in T01), `updatePhotoState` from `lib/rondo-club-db.js` (already exported).

2. **Adding photo upload after person sync** in both UPDATE and CREATE paths of `syncIndividual()` — after the person is synced and we have a `rondoClubId`, find the downloaded photo file via `findPhotoFile()`, upload it via `uploadPhotoToRondoClub()`, and update state to `synced` via `updatePhotoState()`. Entire block wrapped in try/catch (non-critical — matches the pattern from S01 financial tab and from the bulk pipeline).

3. **Adding dry-run photo display** — show photo availability and date in the `--dry-run` output section, using data from `freeFields` (already fetched from DB).

4. **Creating verification script** — `scripts/verify-s02.sh` that checks all must-haves structurally.

## Steps

1. In `pipelines/sync-individual.js`, add imports:
   - `const { uploadPhotoToRondoClub, findPhotoFile } = require('../steps/upload-photos-to-rondo-club');`
   - Add `updatePhotoState` to the existing `require('../lib/rondo-club-db')` destructuring

2. In the dry-run section of `syncIndividual()`, after the existing "Financial/volunteer status" block, add a "Photo" block:
   ```
   console.log('\nPhoto:');
   console.log(`  Available: ${freeFields?.photo_url ? 'yes' : 'no'}`);
   if (freeFields?.photo_date) console.log(`  Photo date: ${freeFields.photo_date}`);
   ```

3. In the UPDATE path of `syncIndividual()`, after the player history sync and before `return`, add a non-critical photo upload block:
   - Only attempt if `fetch` is true (photo download only happens with `--fetch`)
   - Guard: `if (fetch && fetchResult?.photoDownload?.success)` — need to pass `fetchResult` into scope
   - Extract `photosDir = path.join(process.cwd(), 'photos')`
   - Find photo: `const photoFile = await findPhotoFile(knvbId, photosDir)`
   - If found: upload via `uploadPhotoToRondoClub(rondoClubId, photoFile.path, { verbose })`
   - On success: `updatePhotoState(rondoClubDb, knvbId, 'synced')`
   - Log: `console.log('  Photo: uploaded successfully')` or `'  Photo: upload failed: <message>'`
   - Wrap entire block in try/catch — failures logged but not propagated

4. In the CREATE path, add the same non-critical photo upload block (using `newId` instead of `rondoClubId`)

5. Create `scripts/verify-s02.sh`:
   ```bash
   #!/usr/bin/env bash
   set -e
   PASS=0; FAIL=0
   check() { ... }  # helper that runs a command, increments PASS/FAIL
   ```
   Checks:
   - Export types for `uploadPhotoToRondoClub` and `findPhotoFile`
   - Require-time load of `sync-individual.js`
   - grep for `downloadPhotoFromUrl` in sync-individual.js
   - grep for `uploadPhotoToRondoClub` in sync-individual.js (≥2 occurrences: import + usage)
   - grep for `updatePhotoState` in sync-individual.js (≥2 occurrences: import + usage)
   - grep for `Photo:` or `photo` in the dry-run section of sync-individual.js
   - grep for `try` / `catch` around photo upload code (non-critical pattern)

## Must-Haves

- [ ] `uploadPhotoToRondoClub` and `findPhotoFile` imported in `sync-individual.js`
- [ ] `updatePhotoState` imported in `sync-individual.js` (add to existing rondo-club-db import)
- [ ] Photo upload in UPDATE path: `findPhotoFile` → `uploadPhotoToRondoClub` → `updatePhotoState` → log
- [ ] Photo upload in CREATE path: same sequence using `newId` as rondoClubId
- [ ] Both photo upload blocks wrapped in try/catch (non-critical pattern)
- [ ] Photo upload only attempted when `fetch` is true and photo was successfully downloaded
- [ ] Dry-run output shows photo availability and date
- [ ] `scripts/verify-s02.sh` created and passing

## Verification

- `bash scripts/verify-s02.sh` → all checks pass (0 failures)
- `node -e "require('./pipelines/sync-individual')"` → no require-time errors
- `grep -c 'uploadPhotoToRondoClub' pipelines/sync-individual.js` returns ≥ 3 (import + UPDATE + CREATE)
- `grep -c 'updatePhotoState' pipelines/sync-individual.js` returns ≥ 3 (import + UPDATE + CREATE)

## Observability Impact

- Signals added/changed: Console log lines after person sync: "Photo: uploaded successfully" or "Photo: upload failed: <message>" or "Photo: skipped (not available)"; dry-run displays photo date and availability
- How a future agent inspects this: Run `--dry-run` to see photo status without making changes; run `--fetch --verbose` to see full photo download+upload flow; query `SELECT photo_state FROM rondo_club_members WHERE knvb_id = '<id>'` to see state
- Failure state exposed: Photo upload failures logged to console; `photo_state` will be `downloaded` (not `synced`) after upload failure — visible in DB query

## Inputs

- `pipelines/sync-individual.js` — T01 output: `fetchFreshDataFromSportlink()` returns `photoDownload` in result
- `steps/upload-photos-to-rondo-club.js` — T01 output: `uploadPhotoToRondoClub` and `findPhotoFile` exported
- `lib/rondo-club-db.js` — `updatePhotoState(db, knvbId, newState)` already exported

## Expected Output

- `pipelines/sync-individual.js` — photo upload wired into both UPDATE and CREATE paths; dry-run shows photo info; all imports in place
- `scripts/verify-s02.sh` — executable verification script covering all structural checks, all passing
