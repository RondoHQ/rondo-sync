# T01: 44-relationend-field-mapping 01

**Slice:** S11 — **Milestone:** M001

## Description

Add RelationEnd date synchronization to the FreeScout customer sync pipeline.

Purpose: Support agents need membership expiration dates visible in FreeScout without switching to Sportlink. The `lid-tot` ACF field from Rondo Club contains this data but is not yet included in FreeScout custom field submissions.

Output: Three modified files that together extract, normalize, and submit RelationEnd dates as FreeScout custom field ID 9 ("Lid tot").

## Must-Haves

- [ ] "RelationEnd date from Sportlink appears in FreeScout custom field ID 9 as YYYY-MM-DD"
- [ ] "Null or invalid RelationEnd dates result in empty string sent to FreeScout (no API errors)"
- [ ] "Date normalization handles YYYYMMDD, YYYY-MM-DD, and ISO 8601 formats correctly"

## Files

- `lib/utils.js`
- `steps/prepare-freescout-customers.js`
- `steps/submit-freescout-sync.js`
