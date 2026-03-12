---
estimated_steps: 5
estimated_files: 3
---

# T01: Export uploadPhotoToRondoClub and findPhotoFile, wire photo download into fetchFreshDataFromSportlink

**Slice:** S02 — Photo sync
**Milestone:** M002

## Description

Two independent changes that enable the photo flow:

1. **Export functions**: `uploadPhotoToRondoClub` and `findPhotoFile` are defined in `steps/upload-photos-to-rondo-club.js` but only `runPhotoSync` is exported. Add them to `module.exports` so `sync-individual.js` can import them in T02.

2. **Wire photo download**: Inside `fetchFreshDataFromSportlink()` in `pipelines/sync-individual.js`, download the photo using the signed CDN URL from `freeFieldsData.photo_url` while it's fresh. The signed URL is captured during the `/other` page visit via MemberHeader and is time-limited. Download must happen before the function returns (browser close in `finally` doesn't affect CDN URLs, but the URL signature will expire).

The inline download follows the same pattern used in `sync-former-members.js` (lines 340-440) and uses the existing `downloadPhotoFromUrl()` utility from `lib/photo-utils.js`.

## Steps

1. In `steps/upload-photos-to-rondo-club.js`, change `module.exports = { runPhotoSync };` to `module.exports = { runPhotoSync, uploadPhotoToRondoClub, findPhotoFile };`

2. In `pipelines/sync-individual.js`, add imports:
   - `const { downloadPhotoFromUrl } = require('../lib/photo-utils');`
   - `const fs = require('fs/promises');` (for `mkdir`)
   - `const path = require('path');` (for `photosDir` construction)

3. In `fetchFreshDataFromSportlink()`, after the `upsertMemberFreeFields` call and before the `return` statement, add the photo download block:
   - Define `const photosDir = path.join(process.cwd(), 'photos')`
   - Create dir: `await fs.mkdir(photosDir, { recursive: true })`
   - If `freeFieldsData?.photo_url` is truthy, call `downloadPhotoFromUrl(freeFieldsData.photo_url, knvbId, photosDir, logger)`
   - Store result in `photoDownload` variable
   - Log outcome: downloaded bytes on success, skip message on no URL, error message on failure

4. Add `photoDownload` to the return object of `fetchFreshDataFromSportlink()` (alongside `success`, `memberData`, `functions`, etc.)

5. Verify: run export check and require-time load check

## Must-Haves

- [ ] `uploadPhotoToRondoClub` and `findPhotoFile` added to `module.exports` in `steps/upload-photos-to-rondo-club.js`
- [ ] `downloadPhotoFromUrl` imported in `pipelines/sync-individual.js`
- [ ] `fs/promises` and `path` imported in `pipelines/sync-individual.js` (check if `path` is already imported)
- [ ] Photo download happens inside `fetchFreshDataFromSportlink()` when `freeFieldsData.photo_url` is truthy
- [ ] `photos/` directory created with `{ recursive: true }` before download attempt
- [ ] Photo download result returned as `photoDownload` in function return value
- [ ] Logger passed to `downloadPhotoFromUrl` has `verbose()` method (use the `logger` object already created in the function)
- [ ] No photo download attempted when `freeFieldsData` is null or `photo_url` is falsy

## Verification

- `node -e "const m = require('./steps/upload-photos-to-rondo-club'); console.log(typeof m.uploadPhotoToRondoClub, typeof m.findPhotoFile)"` → `function function`
- `node -e "require('./pipelines/sync-individual')"` → loads without error
- `grep -q 'downloadPhotoFromUrl' pipelines/sync-individual.js` → exit 0
- `grep -q 'photoDownload' pipelines/sync-individual.js` → exit 0
- `grep -q 'photos' pipelines/sync-individual.js` → exit 0

## Observability Impact

- Signals added/changed: Verbose log lines during `fetchFreshDataFromSportlink()`: "Downloading photo for <knvbId>...", "Photo downloaded: <bytes> bytes to <path>", "No photo URL available for <knvbId>"
- How a future agent inspects this: Run with `--fetch --verbose` and look for photo download log lines; check `photos/` directory for downloaded file
- Failure state exposed: Download failure logged with error message but does not fail the function (non-critical — photo download failure is a log line, not an exception)

## Inputs

- `steps/upload-photos-to-rondo-club.js` — current `module.exports` has only `runPhotoSync`; `uploadPhotoToRondoClub` defined at line ~95, `findPhotoFile` at line ~37
- `pipelines/sync-individual.js` — `fetchFreshDataFromSportlink()` already captures `freeFieldsData.photo_url` from the `/other` page visit; return object at end of try block
- `lib/photo-utils.js` — `downloadPhotoFromUrl(photoUrl, knvbId, photosDir, logger)` already exported; returns `{ success, path, bytes }` or `{ success: false }`

## Expected Output

- `steps/upload-photos-to-rondo-club.js` — `module.exports` includes `uploadPhotoToRondoClub` and `findPhotoFile`
- `pipelines/sync-individual.js` — `fetchFreshDataFromSportlink()` downloads photo inline when URL is available and returns `photoDownload` in result object
