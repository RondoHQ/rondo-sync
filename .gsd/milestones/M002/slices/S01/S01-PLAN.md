# S01: Invoice data and side-effects

**Goal:** Individual sync fetches financial data from Sportlink, passes invoice data to `preparePerson`, logs financial block activities, and captures volunteer status — matching the bulk people sync.
**Demo:** Run `node pipelines/sync-individual.js <id> --fetch --dry-run` and see invoice fields (`factuur-email`, `factuur-referentie`, invoice address) in the output. Run a real sync and verify financial block activity log and volunteer status in Rondo Club.

## Must-Haves

- `fetchFreshDataFromSportlink()` calls `fetchMemberFinancialData()` and returns `invoiceData` in its result object
- Invoice data stored via `upsertMemberInvoiceData()` during fetch
- `preparePerson()` receives real invoice data instead of `null` (both `--fetch` and non-fetch paths)
- Financial block status compared between existing and new data; `logFinancialBlockActivity()` called on change (update path) or on initial block (create path)
- Volunteer status captured from Rondo Club response and stored via `updateVolunteerStatus()`
- `--dry-run` output shows invoice fields and financial/volunteer status
- `logFinancialBlockActivity` exported from `submit-rondo-club-sync.js`

## Proof Level

- This slice proves: integration
- Real runtime required: yes (verified by `--dry-run` with local DB, and described production verification)
- Human/UAT required: no

## Verification

- `node pipelines/sync-individual.js --help` shows `--fetch` option (existing, confirms no crash)
- `node -e "const m = require('./steps/submit-rondo-club-sync'); console.log(typeof m.logFinancialBlockActivity)"` prints `function` — confirms export
- `node -e "const m = require('./pipelines/sync-individual'); console.log(typeof m.syncIndividual)"` prints `function` — confirms no require-time errors after changes
- `bash scripts/verify-s01.sh` — a verification script that:
  1. Confirms `logFinancialBlockActivity` is exported
  2. Confirms `getMemberInvoiceDataByKnvbId` and `updateVolunteerStatus` are importable in sync-individual context
  3. Confirms `fetchMemberFinancialData` is imported in sync-individual
  4. Greps for key integration points: invoice data passed to `preparePerson`, volunteer status update, financial block activity logging
  5. Confirms dry-run output includes invoice-related display code

## Observability / Diagnostics

- Runtime signals: Verbose logging for financial tab fetch (`Fetching financial data for <knvbId>...`), invoice data storage, financial block activity changes, volunteer status capture — all using existing `log()` pattern
- Inspection surfaces: `--dry-run` output shows invoice fields, financial block status, and volunteer status for any member
- Failure visibility: Financial tab fetch failure logged as warning (non-critical); activity logging failure logged as warning (non-critical, matching bulk pattern); both use existing graceful failure patterns
- Redaction constraints: None (invoice data is organizational, not PII beyond what's already synced)

## Integration Closure

- Upstream surfaces consumed: `fetchMemberFinancialData()` from `download-functions-from-sportlink.js`, `upsertMemberInvoiceData()` / `getMemberInvoiceDataByKnvbId()` / `updateVolunteerStatus()` from `rondo-club-db.js`, `logFinancialBlockActivity()` from `submit-rondo-club-sync.js`, `preparePerson()` invoice parameter from `prepare-rondo-club-members.js`
- New wiring introduced in this slice: `fetchFreshDataFromSportlink()` → financial tab → DB storage → `preparePerson()` invoice param; post-sync volunteer status capture; post-sync financial block activity logging
- What remains before the milestone is truly usable end-to-end: S02 (photo sync) — after which individual sync has full parity with bulk people sync

## Tasks

- [x] **T01: Export logFinancialBlockActivity and wire invoice fetch into fetchFreshDataFromSportlink** `est:30m`
  - Why: The two foundational changes needed before the individual sync can use invoice data and financial block logging — export the function and add the financial tab visit to the browser session
  - Files: `steps/submit-rondo-club-sync.js`, `pipelines/sync-individual.js`, `steps/download-functions-from-sportlink.js`
  - Do: (1) Add `logFinancialBlockActivity` to module.exports in `submit-rondo-club-sync.js`. (2) Import `fetchMemberFinancialData` in `sync-individual.js`. (3) Import `upsertMemberInvoiceData` from `rondo-club-db.js`. (4) In `fetchFreshDataFromSportlink()`, after the "other" page visit and before memberships, call `fetchMemberFinancialData(page, knvbId, logger)`. Store result via `upsertMemberInvoiceData(db, [invoiceData])` when non-null. (5) Return `invoiceData` in the result object.
  - Verify: `node -e "const m = require('./steps/submit-rondo-club-sync'); console.log(typeof m.logFinancialBlockActivity)"` prints `function`; `node -e "require('./pipelines/sync-individual')"` loads without error
  - Done when: `logFinancialBlockActivity` is exported; `fetchFreshDataFromSportlink` fetches financial data, stores it, and returns it in result object

- [x] **T02: Pass invoice data to preparePerson and add volunteer/financial block side-effects to syncIndividual** `est:45m`
  - Why: Completes the data flow — invoice data reaches the WordPress payload, and the post-sync side-effects (volunteer status, financial block activity) match bulk sync behavior
  - Files: `pipelines/sync-individual.js`
  - Do: (1) Import `getMemberInvoiceDataByKnvbId` and `updateVolunteerStatus` from `rondo-club-db.js`. Import `logFinancialBlockActivity` from `submit-rondo-club-sync.js`. (2) In `syncIndividual()`, after getting `freeFields`, read invoice data: `const invoiceData = getMemberInvoiceDataByKnvbId(rondoClubDb, knvbId)`. (3) Replace `preparePerson(member, freeFields, null, freeFieldMappings)` with `preparePerson(member, freeFields, invoiceData, freeFieldMappings)`. (4) In the UPDATE path, after successful PUT: capture volunteer status `const volunteerStatus = existingData.acf?.['huidig-vrijwilliger'] === '1' ? 1 : 0;` then `updateVolunteerStatus(rondoClubDb, knvbId, volunteerStatus)`. Compare financial block: `const previousBlockStatus = existingData.acf?.['financiele-blokkade'] || false; const newBlockStatus = prepared.data.acf?.['financiele-blokkade'] || false; if (previousBlockStatus !== newBlockStatus) { await logFinancialBlockActivity(rondoClubId, newBlockStatus, { verbose }); }`. (5) In the CREATE path, after successful POST: capture volunteer status from `response.body.acf?.['huidig-vrijwilliger']` and call `updateVolunteerStatus`. Log initial block if `prepared.data.acf?.['financiele-blokkade']` is truthy. (6) Follow exact same comparison patterns as bulk sync in `submit-rondo-club-sync.js` lines 190-253 and 289-296.
  - Verify: `node -e "require('./pipelines/sync-individual')"` loads without error; grep confirms `preparePerson(member, freeFields, invoiceData,` and `updateVolunteerStatus` and `logFinancialBlockActivity` calls in sync-individual.js
  - Done when: Invoice data flows from DB to `preparePerson`; volunteer status captured after create/update; financial block activity logged on change

- [x] **T03: Add invoice and side-effect fields to --dry-run output, create verification script** `est:30m`
  - Why: Makes the new data flows visible for verification and future debugging; provides the slice's objective verification script
  - Files: `pipelines/sync-individual.js`, `scripts/verify-s01.sh`
  - Do: (1) In the `dryRun` block of `syncIndividual()`, add invoice data display: read `invoiceData` (already available from earlier in the function), show `factuur-email`, `factuur-referentie`, invoice address fields if present. Show financial block status from `prepared.data.acf['financiele-blokkade']`. Show volunteer status note (only available when person exists in Rondo Club). (2) Create `scripts/verify-s01.sh` that runs structural checks: confirms `logFinancialBlockActivity` export, confirms imports exist in sync-individual.js, greps for invoice data being passed to `preparePerson`, greps for volunteer/financial block side-effect code, confirms dry-run includes invoice display section. All checks use `grep` against source files — no runtime dependencies needed.
  - Verify: `bash scripts/verify-s01.sh` passes all checks with exit code 0
  - Done when: `--dry-run` shows invoice fields and financial/volunteer status; verification script passes

## Files Likely Touched

- `pipelines/sync-individual.js` — main changes: imports, financial fetch, invoice data flow, side-effects, dry-run output
- `steps/submit-rondo-club-sync.js` — export `logFinancialBlockActivity`
- `scripts/verify-s01.sh` — new verification script
