# T01: 40-former-member-import-tool 01

**Slice:** S07 — **Milestone:** M001

## Description

Create the former member import tool: a Playwright-based download step that toggles Sportlink status filters to INACTIVE, and an orchestrator tool that downloads, prepares, and syncs former members to Rondo Club with `acf.former_member = true`.

Purpose: Enable one-time import of former members for tracking outstanding payments/equipment.
Output: `tools/import-former-members.js` (orchestrator with dry-run) and `steps/download-inactive-members.js` (Sportlink download).

## Must-Haves

- [ ] "Tool authenticates to Sportlink and downloads INACTIVE members via status filter toggle"
- [ ] "Former members sync to Rondo Club with acf.former_member = true"
- [ ] "Active members already in stadion_members are skipped (no duplicates created)"
- [ ] "Dry-run mode shows what would be synced without making changes"
- [ ] "Tool outputs progress counts (downloaded, synced, skipped, failed)"

## Files

- `tools/import-former-members.js`
- `steps/download-inactive-members.js`
