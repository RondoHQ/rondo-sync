# S11: Relationend Field Mapping

**Goal:** Add RelationEnd date synchronization to the FreeScout customer sync pipeline.
**Demo:** Add RelationEnd date synchronization to the FreeScout customer sync pipeline.

## Must-Haves


## Tasks

- [x] **T01: 44-relationend-field-mapping 01** `est:1m 27s`
  - Add RelationEnd date synchronization to the FreeScout customer sync pipeline.

Purpose: Support agents need membership expiration dates visible in FreeScout without switching to Sportlink. The `lid-tot` ACF field from Rondo Club contains this data but is not yet included in FreeScout custom field submissions.

Output: Three modified files that together extract, normalize, and submit RelationEnd dates as FreeScout custom field ID 9 ("Lid tot").

## Files Likely Touched

- `lib/utils.js`
- `steps/prepare-freescout-customers.js`
- `steps/submit-freescout-sync.js`
