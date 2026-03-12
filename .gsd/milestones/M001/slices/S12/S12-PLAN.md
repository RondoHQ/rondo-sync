# S12: Photo Url Sync To Freescout

**Goal:** Enable member photos from Rondo Club to appear as FreeScout customer avatars by syncing photo URLs through the existing FreeScout sync pipeline.
**Demo:** Enable member photos from Rondo Club to appear as FreeScout customer avatars by syncing photo URLs through the existing FreeScout sync pipeline.

## Must-Haves


## Tasks

- [x] **T01: 45-photo-url-sync-to-freescout 01**
  - Enable member photos from Rondo Club to appear as FreeScout customer avatars by syncing photo URLs through the existing FreeScout sync pipeline.

Purpose: Support agents see member photos in FreeScout ticket views without switching to Rondo Club, improving identification and workflow efficiency.
Output: Modified prepare and submit steps that fetch photo URLs from Rondo Club API and include them in FreeScout customer payloads.

## Files Likely Touched

- `steps/prepare-freescout-customers.js`
- `steps/submit-freescout-sync.js`
