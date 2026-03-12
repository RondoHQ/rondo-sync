---
id: T02
parent: S02
milestone: M002
provides:
  - Photo upload wired into syncIndividual UPDATE and CREATE paths
  - Dry-run output shows photo availability and date
  - Verification script scripts/verify-s02.sh covering all S02 structural checks
key_files:
  - pipelines/sync-individual.js
  - scripts/verify-s02.sh
key_decisions:
  - fetchResult hoisted from inside `if (fetch)` block to outer scope (let fetchResult = null) so photo download status is accessible in UPDATE/CREATE paths
  - Photo upload "else if (fetch)" branch logs "skipped (not available)" so operator sees photo was considered but not actionable
patterns_established:
  - Non-critical photo upload in syncIndividual follows same try/catch pattern as photo download in fetchFreshDataFromSportlink and financial block sync
observability_surfaces:
  - Console log lines after person sync: "Photo: uploaded successfully", "Photo: upload failed: <message>", "Photo: skipped (not available)", "Photo: skipped (file not found after download)"
  - Dry-run output includes Photo section with availability and date
  - photo_state column transitions: downloaded → synced on successful upload; stays downloaded on upload failure
duration: 8m
verification_result: passed
completed_at: 2026-03-12T20:11Z
blocker_discovered: false
---

# T02: Wire photo upload into syncIndividual and add dry-run display and verification script

**Wired photo upload (findPhotoFile → uploadPhotoToRondoClub → updatePhotoState) into both UPDATE and CREATE paths of syncIndividual, added dry-run photo display, and created verify-s02.sh.**

## What Happened

Three changes to `pipelines/sync-individual.js` plus one new script:

1. **Imports added**: `uploadPhotoToRondoClub` and `findPhotoFile` from `steps/upload-photos-to-rondo-club.js`; `updatePhotoState` added to existing `rondo-club-db` destructuring. `fetchResult` hoisted to outer scope so both UPDATE and CREATE paths can check `fetchResult.photoDownload.success`.

2. **Dry-run photo display**: After the "Financial/volunteer status" block, a new "Photo" section shows whether a photo is available (`freeFields.photo_url`) and the photo date if present.

3. **Photo upload in UPDATE path**: After player history sync and before `return`, guarded by `fetch && fetchResult?.photoDownload?.success`. Finds the downloaded file via `findPhotoFile()`, uploads via `uploadPhotoToRondoClub()`, updates state to `synced` via `updatePhotoState()`. Wrapped in try/catch — failures logged but not propagated.

4. **Photo upload in CREATE path**: Identical pattern using `newId` instead of `rondoClubId`.

5. **Verification script**: `scripts/verify-s02.sh` with 14 structural checks covering exports, imports, dry-run display, try/catch pattern, and upload block counts.

## Verification

All task-level checks passed:
- `bash scripts/verify-s02.sh` → 14/14 passed, 0 failed ✅
- `node -e "require('./pipelines/sync-individual')"` → no require-time errors ✅
- `grep -c 'uploadPhotoToRondoClub' pipelines/sync-individual.js` → 3 (import + UPDATE + CREATE) ✅
- `grep -c 'updatePhotoState' pipelines/sync-individual.js` → 3 (import + UPDATE + CREATE) ✅

All slice-level checks passed:
- Check 1 (exports): ✅ `function function`
- Check 2 (require-time load): ✅ OK
- Check 3 (downloadPhotoFromUrl count ≥ 1): ✅ count = 2
- Check 4 (uploadPhotoToRondoClub count ≥ 2): ✅ count = 3
- Check 5 (updatePhotoState count ≥ 2): ✅ count = 3
- Check 6 (Photo in dry-run): ✅ PASS
- Check 7 (verify-s02.sh): ✅ PASS

## Diagnostics

- Run `node pipelines/sync-individual.js <knvb-id> --dry-run` to see photo availability without making changes
- Run `node pipelines/sync-individual.js <knvb-id> --fetch --verbose` to see full photo download+upload flow
- Query `SELECT knvb_id, photo_state, photo_state_updated_at FROM rondo_club_members WHERE knvb_id = '<id>'` to check state (should be `synced` after successful upload)
- Photo upload failures leave `photo_state` at `downloaded` (not `synced`) — visible in DB query

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `pipelines/sync-individual.js` — Added imports (uploadPhotoToRondoClub, findPhotoFile, updatePhotoState), hoisted fetchResult, added dry-run photo display, added photo upload blocks in UPDATE and CREATE paths
- `scripts/verify-s02.sh` — New verification script with 14 structural checks for S02
