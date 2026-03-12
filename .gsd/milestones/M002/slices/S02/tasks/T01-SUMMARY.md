---
id: T01
parent: S02
milestone: M002
provides:
  - uploadPhotoToRondoClub and findPhotoFile exported for use by T02
  - Photo download wired into fetchFreshDataFromSportlink with photoDownload in return value
key_files:
  - steps/upload-photos-to-rondo-club.js
  - pipelines/sync-individual.js
key_decisions:
  - Photo download uses existing logger object in fetchFreshDataFromSportlink (has verbose/error methods) rather than creating a new one
  - photoDownload set to null (not { success: false }) when no photo_url — distinguishes "no URL" from "download attempted and failed"
patterns_established:
  - Non-critical photo download in fetchFreshDataFromSportlink wrapped in try/catch; failure logged but does not affect function return success
observability_surfaces:
  - Verbose log lines: "Downloading photo for <knvbId>...", "Photo downloaded: <bytes> bytes to <path>", "No photo URL available for <knvbId>"
  - Error log: "Photo download failed for <knvbId>: <message>"
  - photoDownload in return value: null (no URL), { success: true, path, bytes } (downloaded), or { success: false } (failed)
duration: 8m
verification_result: passed
completed_at: 2026-03-12T20:10Z
blocker_discovered: false
---

# T01: Export uploadPhotoToRondoClub and findPhotoFile, wire photo download into fetchFreshDataFromSportlink

**Exported photo upload/find functions and wired inline photo download into fetchFreshDataFromSportlink using downloadPhotoFromUrl while signed CDN URL is fresh.**

## What Happened

Two changes made as specified:

1. **Export functions**: Added `uploadPhotoToRondoClub` and `findPhotoFile` to `module.exports` in `steps/upload-photos-to-rondo-club.js` (previously only `runPhotoSync` was exported).

2. **Wire photo download**: In `pipelines/sync-individual.js`, added `downloadPhotoFromUrl`, `fs/promises`, and `path` imports. After `upsertMemberFreeFields` in `fetchFreshDataFromSportlink()`, added a photo download block that:
   - Creates `photos/` directory with `{ recursive: true }`
   - Downloads photo via `downloadPhotoFromUrl()` when `freeFieldsData.photo_url` is truthy
   - Logs download outcome (bytes + path on success, skip on no URL, error on failure)
   - Wraps download in try/catch so failures are non-critical
   - Returns `photoDownload` in the function's return object

## Verification

All task-level checks passed:
- `node -e "const m = require('./steps/upload-photos-to-rondo-club'); console.log(typeof m.uploadPhotoToRondoClub, typeof m.findPhotoFile)"` → `function function` ✅
- `node -e "require('./pipelines/sync-individual')"` → loads without error ✅
- `grep -q 'downloadPhotoFromUrl' pipelines/sync-individual.js` → exit 0 ✅
- `grep -q 'photoDownload' pipelines/sync-individual.js` → exit 0 ✅
- `grep -q 'photos' pipelines/sync-individual.js` → exit 0 ✅

Slice-level checks (partial — T01 is intermediate):
- Check 1 (exports): ✅ PASS
- Check 2 (require-time load): ✅ PASS
- Check 3 (downloadPhotoFromUrl count ≥ 1): ✅ PASS (count = 2)
- Check 4 (uploadPhotoToRondoClub count ≥ 2): ❌ Expected — T02 adds import + usage
- Check 5 (updatePhotoState count ≥ 2): ❌ Expected — T02 adds import + usage
- Check 6 (Photo in dry-run): ❌ Expected — T02 adds dry-run display
- Check 7 (verify-s02.sh): ❌ Expected — T02 creates the script

## Diagnostics

- Run with `--fetch --verbose` and look for photo download log lines in `fetchFreshDataFromSportlink()` output
- Check `photos/` directory for downloaded file after a `--fetch` run
- `photoDownload` in return value: `null` = no photo URL, `{ success: true, path, bytes }` = downloaded, `{ success: false }` = download failed

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `steps/upload-photos-to-rondo-club.js` — Added `uploadPhotoToRondoClub` and `findPhotoFile` to `module.exports`
- `pipelines/sync-individual.js` — Added imports (`downloadPhotoFromUrl`, `fs/promises`, `path`) and photo download block in `fetchFreshDataFromSportlink()`
