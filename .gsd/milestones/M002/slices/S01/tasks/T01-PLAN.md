---
estimated_steps: 5
estimated_files: 3
---

# T01: Export logFinancialBlockActivity and wire invoice fetch into fetchFreshDataFromSportlink

**Slice:** S01 — Invoice data and side-effects
**Milestone:** M002

## Description

Two foundational changes: (1) export `logFinancialBlockActivity` from `submit-rondo-club-sync.js` so the individual sync can use it, and (2) add the financial tab visit to `fetchFreshDataFromSportlink()` in `sync-individual.js` so invoice data is fetched, stored in the DB, and returned in the result object.

The financial tab call goes after the "other" page visit and before memberships, following the page order decision: general → functions → other → financial → memberships. The existing `fetchMemberFinancialData()` is already exported from `download-functions-from-sportlink.js` and handles all page navigation, response parsing, and error handling.

## Steps

1. In `steps/submit-rondo-club-sync.js`, add `logFinancialBlockActivity` to the `module.exports` object (line 976, currently exports `{ runSync, syncParent }`).

2. In `pipelines/sync-individual.js`, add `fetchMemberFinancialData` to the existing import block from `download-functions-from-sportlink.js` (around line 29).

3. In `pipelines/sync-individual.js`, add `upsertMemberInvoiceData` to the existing import block from `rondo-club-db.js` (around line 4).

4. In `fetchFreshDataFromSportlink()`, after the "Fetch free fields (Other tab)" block (~line 140) and before the "Fetch memberships" block (~line 148), add:
   ```javascript
   // Fetch financial/invoice data
   log(`Fetching financial data for ${knvbId}...`);
   let invoiceData = null;
   try {
     invoiceData = await fetchMemberFinancialData(page, knvbId, logger);
     if (invoiceData) {
       upsertMemberInvoiceData(db, [invoiceData]);
       log(`  Invoice email: ${invoiceData.invoice_email || 'none'}`);
     } else {
       log('  No financial data captured');
     }
   } catch (error) {
     log(`  Warning: Could not fetch financial data: ${error.message}`);
   }
   ```

5. Add `invoiceData` to the return object of `fetchFreshDataFromSportlink()` alongside the existing fields (`success`, `memberData`, `functions`, `committees`, `freeFields`, `teamMemberships`).

## Must-Haves

- [ ] `logFinancialBlockActivity` added to `module.exports` in `submit-rondo-club-sync.js`
- [ ] `fetchMemberFinancialData` imported in `sync-individual.js`
- [ ] `upsertMemberInvoiceData` imported in `sync-individual.js`
- [ ] Financial tab fetched after "other" page and before memberships in `fetchFreshDataFromSportlink()`
- [ ] Invoice data stored via `upsertMemberInvoiceData(db, [invoiceData])` when non-null
- [ ] `invoiceData` included in return object of `fetchFreshDataFromSportlink()`
- [ ] Financial tab failure is non-critical (try/catch, continue sync)

## Verification

- `node -e "const m = require('./steps/submit-rondo-club-sync'); console.log(typeof m.logFinancialBlockActivity)"` prints `function`
- `node -e "require('./pipelines/sync-individual')"` loads without require-time errors
- `grep -q 'fetchMemberFinancialData' pipelines/sync-individual.js` exits 0
- `grep -q 'upsertMemberInvoiceData' pipelines/sync-individual.js` exits 0
- `grep -q 'invoiceData' pipelines/sync-individual.js` exits 0 (appears in return object and fetch block)

## Observability Impact

- Signals added/changed: Verbose log lines for financial tab fetch progress and results (`Fetching financial data for <knvbId>...`, invoice email display, warning on failure)
- How a future agent inspects this: Check verbose output during `--fetch` runs; query `sportlink_member_invoice_data` table for stored invoice data
- Failure state exposed: Financial tab failure logged as warning (non-critical) — sync continues without invoice data this run

## Inputs

- `steps/submit-rondo-club-sync.js` — existing `logFinancialBlockActivity` function at line 145; current exports at line 976
- `steps/download-functions-from-sportlink.js` — `fetchMemberFinancialData` already exported (line 909)
- `lib/rondo-club-db.js` — `upsertMemberInvoiceData` already exported (line 3476)
- `pipelines/sync-individual.js` — `fetchFreshDataFromSportlink()` function at lines 90-205; existing imports at top

## Expected Output

- `steps/submit-rondo-club-sync.js` — `logFinancialBlockActivity` added to module.exports
- `pipelines/sync-individual.js` — new imports for `fetchMemberFinancialData` and `upsertMemberInvoiceData`; financial tab fetch block in `fetchFreshDataFromSportlink()`; `invoiceData` in return object
