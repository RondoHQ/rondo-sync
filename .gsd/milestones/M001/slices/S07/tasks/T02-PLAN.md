# T02: 40-former-member-import-tool 02

**Slice:** S07 — **Milestone:** M001

## Description

Add photo download and upload support to the former member import tool. After syncing former members to Rondo Club, the tool downloads their photos from Sportlink (via MemberHeader API) and uploads them to their Rondo Club person records.

Purpose: Complete the former member import by including profile photos for visual identification.
Output: Updated `tools/import-former-members.js` with photo download/upload steps.

## Must-Haves

- [ ] "Tool downloads photos for former members via MemberHeader API"
- [ ] "Photos upload to their Rondo Club person records"
- [ ] "Photo download/upload integrates into the existing import tool flow"

## Files

- `tools/import-former-members.js`
