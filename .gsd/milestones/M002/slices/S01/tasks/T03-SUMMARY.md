---
id: T03
parent: S01
milestone: M002
provides:
  - Dry-run output displays invoice email, reference, and address fields
  - Dry-run output displays financial block status and volunteer status note
  - scripts/verify-s01.sh — 13-check verification script covering all S01 integration points
key_files:
  - pipelines/sync-individual.js
  - scripts/verify-s01.sh
key_decisions:
  - Invoice address display distinguishes custom vs default address using invoice_address_is_default field
patterns_established:
  - Verification scripts use check() helper with eval + pass/fail counters for structural source checks
observability_surfaces:
  - "--dry-run output now shows invoice data section, financial block status, and volunteer status — primary inspection surface for individual sync debugging"
duration: 10m
verification_result: passed
completed_at: 2026-03-12
blocker_discovered: false
---

# T03: Add invoice and side-effect fields to --dry-run output, create verification script

**Extended --dry-run output with invoice/financial/volunteer display and created 13-check verification script proving all S01 wiring is in place.**

## What Happened

1. Extended the `dryRun` block in `syncIndividual()` with three new sections:
   - **Invoice data**: Shows email, reference, and address (distinguishing custom vs default address using `invoice_address_is_default` flag). When no invoice data exists, shows guidance to use `--with-invoice` or `--fetch`.
   - **Financial block status**: Shows YES/no based on `prepared.data.acf['financiele-blokkade']`.
   - **Volunteer status**: Shows context-appropriate note — either "available after sync" (existing person) or "will be captured on first sync" (new person).

2. Created `scripts/verify-s01.sh` with 13 structural checks covering:
   - Export verification (logFinancialBlockActivity)
   - Import verification (5 functions in sync-individual.js)
   - Wiring verification (invoice data passed to preparePerson, no null params, volunteer/financial block code present with multiple call sites)
   - Dry-run display verification (invoice section, financial block reference)
   - Module load verification (sync-individual.js loads without error)

## Verification

All checks pass:

```
bash scripts/verify-s01.sh
# 13 passed, 0 failed (exit code 0)
```

Slice-level verification (all pass):
- `node pipelines/sync-individual.js --help` — shows `--fetch` option, no crash
- `node -e "const m = require('./steps/submit-rondo-club-sync'); console.log(typeof m.logFinancialBlockActivity)"` → `function`
- `node -e "const m = require('./pipelines/sync-individual'); console.log(typeof m.syncIndividual)"` → `function`
- `bash scripts/verify-s01.sh` → 13/13 pass
- `grep 'Invoice data' pipelines/sync-individual.js` → finds dry-run display section

## Diagnostics

- Run `node pipelines/sync-individual.js <knvb-id> --dry-run` to see all data including invoice fields, financial block status, and volunteer status
- Run `node pipelines/sync-individual.js <knvb-id> --fetch --dry-run` to fetch fresh data from Sportlink first, then display
- Run `bash scripts/verify-s01.sh` to verify all S01 integration points are intact

## Deviations

None.

## Known Issues

None.

## Files Created/Modified

- `pipelines/sync-individual.js` — Extended dry-run block with invoice data, financial block, and volunteer status display
- `scripts/verify-s01.sh` — New 13-check verification script for S01 integration points
