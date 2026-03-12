# T01: 45-photo-url-sync-to-freescout 01

**Slice:** S12 — **Milestone:** M001

## Description

Enable member photos from Rondo Club to appear as FreeScout customer avatars by syncing photo URLs through the existing FreeScout sync pipeline.

Purpose: Support agents see member photos in FreeScout ticket views without switching to Rondo Club, improving identification and workflow efficiency.
Output: Modified prepare and submit steps that fetch photo URLs from Rondo Club API and include them in FreeScout customer payloads.

## Must-Haves

- [ ] "Members with photo_state='synced' get their Rondo Club photo URL sent as FreeScout customer photoUrl"
- [ ] "Members without synced photos are skipped (no broken image URLs in FreeScout)"
- [ ] "Photo URL changes trigger re-sync via existing hash-based change detection"
- [ ] "Null/missing photoUrl is omitted from FreeScout API payload (not sent as null)"

## Files

- `steps/prepare-freescout-customers.js`
- `steps/submit-freescout-sync.js`
