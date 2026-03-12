# S07: Former Member Import Tool

**Goal:** Create the former member import tool: a Playwright-based download step that toggles Sportlink status filters to INACTIVE, and an orchestrator tool that downloads, prepares, and syncs former members to Rondo Club with `acf.
**Demo:** Create the former member import tool: a Playwright-based download step that toggles Sportlink status filters to INACTIVE, and an orchestrator tool that downloads, prepares, and syncs former members to Rondo Club with `acf.

## Must-Haves


## Tasks

- [x] **T01: 40-former-member-import-tool 01** `est:2min`
  - Create the former member import tool: a Playwright-based download step that toggles Sportlink status filters to INACTIVE, and an orchestrator tool that downloads, prepares, and syncs former members to Rondo Club with `acf.former_member = true`.

Purpose: Enable one-time import of former members for tracking outstanding payments/equipment.
Output: `tools/import-former-members.js` (orchestrator with dry-run) and `steps/download-inactive-members.js` (Sportlink download).
- [x] **T02: 40-former-member-import-tool 02** `est:2min`
  - Add photo download and upload support to the former member import tool. After syncing former members to Rondo Club, the tool downloads their photos from Sportlink (via MemberHeader API) and uploads them to their Rondo Club person records.

Purpose: Complete the former member import by including profile photos for visual identification.
Output: Updated `tools/import-former-members.js` with photo download/upload steps.

## Files Likely Touched

- `tools/import-former-members.js`
- `steps/download-inactive-members.js`
- `tools/import-former-members.js`
