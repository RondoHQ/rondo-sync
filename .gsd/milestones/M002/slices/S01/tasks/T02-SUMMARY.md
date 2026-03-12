---
id: T02
parent: S01
milestone: M002
provides:
  - Invoice data read from DB and passed to preparePerson (replaces null)
  - Volunteer status captured after both UPDATE and CREATE paths
  - Financial block activity logged on status change (UPDATE) or initial block (CREATE)
key_files:
  - pipelines/sync-individual.js
key_decisions:
  - Side-effects (volunteer status, financial block activity) placed after updateSyncState but before console.log, matching the bulk sync ordering
patterns_established:
  - Volunteer status extraction uses `=== '1' ? 1 : 0` pattern (matches bulk sync)
  - Financial block comparison uses `|| false` pattern (matches bulk sync)
  - logFinancialBlockActivity called with `{ verbose }` options object (individual sync doesn't have a logger object)
observability_surfaces:
  - Verbose log line "Invoice data: found/none" shows whether invoice data was available
  - Financial block activity logged via Rondo Club activity API endpoint on status change
  - Volunteer status stored in rondo_club_members.huidig_vrijwilliger column after every sync
duration: 5m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T02: Pass invoice data to preparePerson and add volunteer/financial block side-effects to syncIndividual

**Wired invoice data, volunteer status capture, and financial block activity logging into individual sync — matching the bulk sync patterns exactly.**

## What Happened

Three changes to `pipelines/sync-individual.js`:

1. **Invoice data passed to `preparePerson`** — Added `getMemberInvoiceDataByKnvbId` import and call before `preparePerson()`. The `null` third argument is replaced with actual `invoiceData` read from the DB. This works for both `--fetch` mode (data just stored by `fetchFreshDataFromSportlink`) and non-fetch mode (data from a previous bulk sync or fetch run).

2. **Volunteer status captured after UPDATE and CREATE** — Added `updateVolunteerStatus` import and calls in both paths. In the UPDATE path, reads `existingData.acf['huidig-vrijwilliger']` from the GET response. In the CREATE path, reads `response.body.acf['huidig-vrijwilliger']` from the POST response. Both use the `=== '1' ? 1 : 0` pattern from the bulk sync.

3. **Financial block activity logged** — Added `logFinancialBlockActivity` import (from T01's export) and calls in both paths. In the UPDATE path, compares `existingData` previous status with `prepared.data` new status and logs on change. In the CREATE path, logs only if the new person has a block set. Both use the `|| false` coercion pattern from the bulk sync.

## Verification

All task-level must-have checks passed:

- `node -e "require('./pipelines/sync-individual')"` → loads without require-time errors ✅
- `grep 'preparePerson(member, freeFields, invoiceData,' pipelines/sync-individual.js` → found (no more `null`) ✅
- `grep -c 'updateVolunteerStatus' pipelines/sync-individual.js` → 3 (1 import + 2 usage) ✅
- `grep -c 'logFinancialBlockActivity' pipelines/sync-individual.js` → 3 (1 import + 2 usage) ✅
- `grep -c 'getMemberInvoiceDataByKnvbId' pipelines/sync-individual.js` → 2 (1 import + 1 usage) ✅
- `grep 'preparePerson.*null' pipelines/sync-individual.js` → no matches (no hardcoded null remaining) ✅
- Pattern verification: `|| false` used 3 times, `=== '1' ? 1 : 0` used 2 times — matches bulk sync ✅

Slice-level checks (all 4 applicable checks pass):

- ✅ `--help` shows `--fetch` option
- ✅ `logFinancialBlockActivity` exports as `function`
- ✅ `syncIndividual` exports as `function` (no require-time errors)
- ⏳ `verify-s01.sh` — not yet created (T03 scope)

## Diagnostics

- Run with `--verbose` to see "Invoice data: found/none" log for any member
- Financial block changes are logged as activities in Rondo Club via `POST /rondo/v1/people/{id}/activities`
- Volunteer status is stored in `rondo_club_members.huidig_vrijwilliger` — query with: `SELECT knvb_id, huidig_vrijwilliger FROM rondo_club_members WHERE knvb_id = '<id>'`
- `logFinancialBlockActivity` failures are non-critical (try/catch with warning, inherited from bulk sync pattern)

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `pipelines/sync-individual.js` — Added imports for `getMemberInvoiceDataByKnvbId`, `updateVolunteerStatus`, `logFinancialBlockActivity`; invoice data read from DB and passed to `preparePerson`; volunteer status captured after UPDATE and CREATE; financial block activity logged on change or initial block
