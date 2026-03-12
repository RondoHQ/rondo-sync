---
estimated_steps: 5
estimated_files: 1
---

# T02: Pass invoice data to preparePerson and add volunteer/financial block side-effects to syncIndividual

**Slice:** S01 — Invoice data and side-effects
**Milestone:** M002

## Description

Wire the three remaining data flows into `syncIndividual()`: (1) read invoice data from DB and pass to `preparePerson()` instead of `null`, (2) capture volunteer status from Rondo Club response after create/update, and (3) compare financial block status and log activity on change. All three patterns are copied directly from the bulk sync in `submit-rondo-club-sync.js`.

## Steps

1. Add imports to `pipelines/sync-individual.js`:
   - `getMemberInvoiceDataByKnvbId` from `lib/rondo-club-db.js` (add to existing import block)
   - `updateVolunteerStatus` from `lib/rondo-club-db.js` (add to existing import block)
   - `logFinancialBlockActivity` from `steps/submit-rondo-club-sync.js` (add to existing import: `const { syncParent, logFinancialBlockActivity } = require(...)`)

2. In `syncIndividual()`, after the `freeFields` and `freeFieldMappings` reads (~line 370), add:
   ```javascript
   const invoiceData = getMemberInvoiceDataByKnvbId(rondoClubDb, knvbId);
   log(`Invoice data: ${invoiceData ? 'found' : 'none'}`);
   ```
   Then change line 377 from `preparePerson(member, freeFields, null, freeFieldMappings)` to `preparePerson(member, freeFields, invoiceData, freeFieldMappings)`.

3. In the UPDATE path (after successful PUT, around the `console.log('Updated person...')` line), add the volunteer status capture and financial block activity logging, following the exact pattern from `submit-rondo-club-sync.js` lines 247-253:
   ```javascript
   // Capture volunteer status from Rondo Club
   const volunteerStatus = existingData.acf?.['huidig-vrijwilliger'] === '1' ? 1 : 0;
   updateVolunteerStatus(rondoClubDb, knvbId, volunteerStatus);

   // Compare financial block status and log activity if changed
   const previousBlockStatus = existingData.acf?.['financiele-blokkade'] || false;
   const newBlockStatus = prepared.data.acf?.['financiele-blokkade'] || false;
   if (previousBlockStatus !== newBlockStatus) {
     await logFinancialBlockActivity(rondoClubId, newBlockStatus, { verbose });
   }
   ```

4. In the CREATE path (after successful POST, around the `console.log('Created person...')` line), add volunteer status and initial block logging, following `submit-rondo-club-sync.js` lines 289-296:
   ```javascript
   // Capture volunteer status from newly created person
   const createVolunteerStatus = response.body.acf?.['huidig-vrijwilliger'] === '1' ? 1 : 0;
   updateVolunteerStatus(rondoClubDb, knvbId, createVolunteerStatus);

   // Log initial block status for newly created persons
   const newBlockStatus = prepared.data.acf?.['financiele-blokkade'] || false;
   if (newBlockStatus) {
     await logFinancialBlockActivity(newId, true, { verbose });
   }
   ```

5. Verify the complete data flow: DB read → `preparePerson` → API call → side-effects. Confirm no `null` is still hardcoded for the invoice parameter.

## Must-Haves

- [ ] `getMemberInvoiceDataByKnvbId` imported and called before `preparePerson`
- [ ] `preparePerson` receives actual `invoiceData` instead of `null`
- [ ] `updateVolunteerStatus` imported and called after both UPDATE and CREATE paths
- [ ] `logFinancialBlockActivity` imported and called on financial block change (UPDATE) or initial block (CREATE)
- [ ] Financial block comparison uses same `|| false` pattern as bulk sync
- [ ] Volunteer status extraction uses same `=== '1' ? 1 : 0` pattern as bulk sync
- [ ] Invoice data read from DB works for both `--fetch` and non-fetch modes (same code path)

## Verification

- `node -e "require('./pipelines/sync-individual')"` loads without require-time errors
- `grep 'preparePerson(member, freeFields, invoiceData,' pipelines/sync-individual.js` finds the updated call (no more `null`)
- `grep -c 'updateVolunteerStatus' pipelines/sync-individual.js` returns at least 2 (one for update path, one for create path)
- `grep -c 'logFinancialBlockActivity' pipelines/sync-individual.js` returns at least 2 (one for update path, one for create path)
- `grep 'getMemberInvoiceDataByKnvbId' pipelines/sync-individual.js` confirms import and usage

## Observability Impact

- Signals added/changed: Verbose log for invoice data availability (`Invoice data: found/none`); financial block activity logged via existing activity API endpoint; volunteer status stored in DB
- How a future agent inspects this: Query `rondo_club_members.huidig_vrijwilliger` for volunteer status; check Rondo Club activity log for financial block changes; `--dry-run` (T03) will show all fields
- Failure state exposed: `logFinancialBlockActivity` already wraps in try/catch with warning (non-critical pattern inherited from bulk sync)

## Inputs

- `pipelines/sync-individual.js` — with T01's changes: financial data fetch in `fetchFreshDataFromSportlink()`, `invoiceData` in return object
- `steps/submit-rondo-club-sync.js` — `logFinancialBlockActivity` now exported (T01)
- `lib/rondo-club-db.js` — `getMemberInvoiceDataByKnvbId` and `updateVolunteerStatus` already exported
- Bulk sync patterns from `submit-rondo-club-sync.js` lines 190-253 (update) and 289-296 (create)

## Expected Output

- `pipelines/sync-individual.js` — invoice data read from DB and passed to `preparePerson`; volunteer status captured after create/update; financial block activity logged on change/initial block
