---
id: T01
parent: S01
milestone: M002
provides:
  - logFinancialBlockActivity exported from submit-rondo-club-sync.js
  - fetchFreshDataFromSportlink fetches financial tab data, stores it, and returns invoiceData
key_files:
  - steps/submit-rondo-club-sync.js
  - pipelines/sync-individual.js
key_decisions:
  - Financial tab fetch placed after "other" page and before memberships, matching page order: general → functions → other → financial → memberships
patterns_established:
  - Non-critical financial tab fetch with try/catch (matches existing graceful failure pattern for memberships)
observability_surfaces:
  - Verbose log lines: "Fetching financial data for <knvbId>...", invoice email display, warning on failure
  - sportlink_member_invoice_data table populated during individual --fetch runs
duration: 5m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T01: Export logFinancialBlockActivity and wire invoice fetch into fetchFreshDataFromSportlink

**Exported `logFinancialBlockActivity` and wired financial tab fetch into `fetchFreshDataFromSportlink()` with DB storage and non-critical error handling.**

## What Happened

Two changes made:

1. **Export `logFinancialBlockActivity`** — Added to `module.exports` in `submit-rondo-club-sync.js` alongside `runSync` and `syncParent`. This function was already defined (line 145) but not exported; T02 needs it for financial block activity logging in the individual sync path.

2. **Wire financial tab into `fetchFreshDataFromSportlink()`** — Added a new block in `pipelines/sync-individual.js` that calls `fetchMemberFinancialData(page, knvbId, logger)` after the "Other tab" fetch and before memberships. When data is returned, it's stored via `upsertMemberInvoiceData(db, [invoiceData])`. The result is included as `invoiceData` in the return object. Failure is non-critical (try/catch with warning log).

Both `fetchMemberFinancialData` and `upsertMemberInvoiceData` were already exported from their respective modules — only the imports in `sync-individual.js` were needed.

## Verification

All 5 task-level checks passed:

- `node -e "const m = require('./steps/submit-rondo-club-sync'); console.log(typeof m.logFinancialBlockActivity)"` → `function`
- `node -e "require('./pipelines/sync-individual')"` → loads without error
- `grep -q 'fetchMemberFinancialData' pipelines/sync-individual.js` → exit 0
- `grep -q 'upsertMemberInvoiceData' pipelines/sync-individual.js` → exit 0
- `grep -q 'invoiceData' pipelines/sync-individual.js` → exit 0

Slice-level checks (3 of 4 applicable to T01):

- ✅ `--help` shows `--fetch` option
- ✅ `logFinancialBlockActivity` exports as `function`
- ✅ `syncIndividual` exports as `function` (no require-time errors)
- ⏳ `verify-s01.sh` — not yet created (T03 scope)

## Diagnostics

- Run with `--fetch --verbose` to see financial tab fetch logs during individual sync
- Query `sportlink_member_invoice_data` table after a `--fetch` run to verify stored invoice data
- Financial tab failures appear as `Warning: Could not fetch financial data: <message>` in verbose output

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `steps/submit-rondo-club-sync.js` — Added `logFinancialBlockActivity` to module.exports
- `pipelines/sync-individual.js` — Added imports for `fetchMemberFinancialData` and `upsertMemberInvoiceData`; added financial tab fetch block in `fetchFreshDataFromSportlink()`; added `invoiceData` to return object
