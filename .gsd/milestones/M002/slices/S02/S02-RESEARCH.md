# S02: Photo Sync — Research

**Date:** 2026-03-12

## Summary

The individual sync (`sync-individual.js`) already captures photo metadata during `--fetch` mode — `fetchMemberDataFromOtherPage()` returns `photo_url` and `photo_date` from the MemberHeader API response, and this is stored in `sportlink_member_free_fields` via `upsertMemberFreeFields()`. What's missing is the actual **download** of the photo from Sportlink and **upload** to Rondo Club WordPress.

The bulk pipeline handles photos in a two-step state machine: (1) `upsertMembers()` sets `photo_state` to `pending_download` based on `person_image_date` changes, (2) `download-photos-from-api.js` opens a new Playwright session to capture signed photo URLs and download them, (3) `upload-photos-to-rondo-club.js` uploads downloaded files via the Rondo Club REST API. For individual sync, we can bypass the state machine entirely — the photo URL is already available in the same browser session (from MemberHeader response during the `/other` page visit), so we can download inline and upload immediately.

The `sync-former-members.js` pipeline already demonstrates this inline pattern: download photo from URL → save to `photos/` → upload to Rondo Club — all in one flow without state machine transitions.

## Recommendation

Wire photo download + upload directly into `syncIndividual()` after the person sync completes (both UPDATE and CREATE paths). The approach:

1. **In `fetchFreshDataFromSportlink()`**: The `photo_url` is already captured via `freeFieldsData.photo_url`. Return it in the result so `syncIndividual()` can use it. Also download the photo inline using `downloadPhotoFromUrl()` while the signed URL is fresh (Sportlink CDN URLs expire).
2. **In `syncIndividual()`**: After the person is synced (and we have a `rondoClubId`), upload the downloaded photo file via `uploadPhotoToRondoClub()`. Update `photo_state` in the DB to `synced` on success.
3. **Non-critical wrapper**: The entire photo flow should be wrapped in try/catch — photo failures must not block the person sync (matches existing non-critical pattern for photos).
4. **Dry-run display**: Show photo status in `--dry-run` output (photo available: yes/no, photo date).
5. **Non-fetch mode**: When `--fetch` is not used, no photo sync happens (we don't have a signed URL without the browser session).

Key constraint: `uploadPhotoToRondoClub()` and `findPhotoFile()` are currently **not exported** from `upload-photos-to-rondo-club.js`. They need to be added to `module.exports`, or the upload logic can be extracted to a shared utility.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Photo URL extraction from Sportlink | `parseMemberHeaderResponse()` in `lib/photo-utils.js` | Already handles null Photo objects, extracts URL and date |
| Photo download from signed URL | `downloadPhotoFromUrl()` in `lib/photo-utils.js` | Handles timeout, minimum size validation, MIME→extension mapping, permanent 404 detection |
| Photo upload to Rondo Club | `uploadPhotoToRondoClub()` in `steps/upload-photos-to-rondo-club.js` | Handles multipart form upload, auth, timeout, error codes |
| Photo file lookup by KNVB ID | `findPhotoFile()` in `steps/upload-photos-to-rondo-club.js` | Checks all supported extensions (jpg, jpeg, png, webp, gif) |
| Photo state management | `updatePhotoState()` / `clearPhotoState()` in `lib/rondo-club-db.js` | Atomic state transitions with timestamp tracking |
| Photos directory creation | `fs.mkdir(photosDir, { recursive: true })` | Already used in `download-photos-from-api.js` |

## Existing Code and Patterns

- `pipelines/sync-individual.js` — `fetchFreshDataFromSportlink()` already captures `freeFieldsData.photo_url` during `/other` page visit. The return value includes `freeFields: freeFieldsData` which has `photo_url` and `photo_date`. This is the signed CDN URL needed for download.
- `lib/photo-utils.js` — `downloadPhotoFromUrl(photoUrl, knvbId, photosDir, logger)` downloads a photo to `photos/<knvbId>.<ext>`. Returns `{ success, path, bytes }` or `{ success: false, permanent_error: true }` for 404s. Has 10s timeout and 100-byte minimum validation.
- `steps/upload-photos-to-rondo-club.js` — `uploadPhotoToRondoClub(rondoClubId, photoPath, options)` uploads via `POST /wp-json/rondo/v1/people/{id}/photo`. Uses multipart/form-data with `https` module. 30s timeout. **Not exported** — only `runPhotoSync` is exported.
- `steps/upload-photos-to-rondo-club.js` — `findPhotoFile(knvbId, photosDir)` checks all supported image extensions. Returns `{ found, path, ext }`. **Not exported**.
- `pipelines/sync-former-members.js` — Lines 340-440 demonstrate the inline photo download+upload pattern without state machine. This is the pattern to follow.
- `lib/rondo-club-db.js` — `updatePhotoState(db, knvbId, newState)` updates `photo_state` and `photo_state_updated_at`. `upsertMembers()` handles photo state transitions based on `person_image_date` changes — individual sync already calls this via the `upsertMembers(rondoClubDb, [prepared])` call, so the `person_image_date` field on the prepared data triggers proper state transitions in the DB.
- `steps/prepare-rondo-club-members.js` — `preparePerson()` returns `person_image_date` from `sportlinkMember.PersonImageDate`. This flows through `upsertMembers()` which sets `photo_state` to `pending_download` if the date changed.

## Constraints

- **Signed URLs expire quickly** — Sportlink CDN photo URLs are signed and time-limited. The photo must be downloaded during or immediately after the browser session, not stored for later. This rules out saving the URL and downloading later.
- **`uploadPhotoToRondoClub` and `findPhotoFile` not exported** — These functions are defined in `steps/upload-photos-to-rondo-club.js` but only `runPhotoSync` is in `module.exports`. Must add them to exports.
- **Photo directory must exist** — `photos/` directory must be created with `fs.mkdir(photosDir, { recursive: true })` before download (gitignored).
- **Rate limiting** — Bulk pipeline uses 2s delays between uploads. For single member, no delay needed.
- **rondoClubId required for upload** — Photo upload goes to `POST /wp-json/rondo/v1/people/{rondoClubId}/photo`. For new members (CREATE path), the rondoClubId is available from the POST response. For existing members (UPDATE path), it's already known.
- **Non-critical pattern required** — Photo sync must be wrapped in try/catch. Failure must not prevent person sync completion (established project convention).
- **Only with `--fetch`** — Photo download requires a Sportlink browser session for the signed URL. Without `--fetch`, there's no URL to download from.

## Common Pitfalls

- **Downloading after browser closes** — The signed photo URL from MemberHeader must be downloaded while the browser session is active (or immediately after, since it's a CDN URL not a session-bound URL). However, the `fetchFreshDataFromSportlink()` function closes the browser in its `finally` block. Solution: download the photo inside `fetchFreshDataFromSportlink()` before the browser closes, or download immediately after since the signed URL doesn't require the browser session (it's a CDN URL with time-based signature, not cookie-based).
- **Forgetting to update photo_state** — After successful download+upload, must update photo_state to `synced` via `updatePhotoState()`. Otherwise, the bulk pipeline will try to re-download/re-upload the same photo.
- **Photo cleanup on re-sync** — Downloaded photo files in `photos/` persist between runs. For individual sync this is fine — the file gets overwritten on re-download. But state must be correct so bulk sync doesn't re-process.
- **Logger mismatch** — `downloadPhotoFromUrl()` expects a logger with `verbose()` method. The individual sync's inline logger (`log`) is a plain function. Need to pass a compatible logger object.

## Open Risks

- **Photo download latency** — Downloading a photo adds ~1-3 seconds to the sync. Upload adds another ~1-3 seconds. Total photo overhead ~2-6 seconds on top of the existing ~15-20 second Sportlink browser session. Within the 30-second API timeout but worth monitoring.
- **CDN URL expiration window** — If `fetchFreshDataFromSportlink()` downloads the photo inline, it happens during the browser session (fine). If we download after browser close, the signed URL may have expired by the time we attempt download. The `downloadPhotoFromUrl()` function handles this gracefully (returns `{ success: false }`) but we need to verify the typical expiration window.
- **No photo state for non-fetch syncs** — When individual sync runs without `--fetch`, the `person_image_date` from bulk Sportlink data still flows through `upsertMembers()` and may set `photo_state` to `pending_download`. This is correct behavior — the next bulk photo download will pick it up.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Playwright | `currents-dev/playwright-best-practices-skill@playwright-best-practices` | available (8.4K installs) — not needed, Playwright usage is minimal (reusing existing login+page patterns) |
| WordPress REST API | `wordpress/agent-skills@wp-rest-api` | available (381 installs) — not needed, photo endpoint already implemented and working |

No skills are recommended for installation — the photo sync uses existing project patterns and utility functions throughout. The work is wiring, not novel implementation.

## Sources

- `pipelines/sync-individual.js` — Current individual sync code, entry point for all changes
- `steps/download-photos-from-api.js` — Bulk photo download step (pattern reference for download flow)
- `steps/upload-photos-to-rondo-club.js` — Bulk photo upload/delete step (contains `uploadPhotoToRondoClub` and `findPhotoFile` to be exported)
- `lib/photo-utils.js` — `downloadPhotoFromUrl()` and `parseMemberHeaderResponse()` utilities
- `lib/rondo-club-db.js` — Photo state management functions (`updatePhotoState`, `getMembersByPhotoState`)
- `pipelines/sync-former-members.js` lines 340-440 — Inline photo download+upload pattern (prior art for single-member flow)
- `.gsd/milestones/M002/slices/S01/tasks/T01-SUMMARY.md` — S01 pattern: non-critical try/catch for financial tab, page visit order
- `.gsd/milestones/M002/slices/S01/tasks/T02-SUMMARY.md` — S01 pattern: side-effects after both UPDATE and CREATE paths
