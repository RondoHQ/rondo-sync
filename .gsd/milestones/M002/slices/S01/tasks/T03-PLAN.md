---
estimated_steps: 4
estimated_files: 2
---

# T03: Add invoice and side-effect fields to --dry-run output, create verification script

**Slice:** S01 — Invoice data and side-effects
**Milestone:** M002

## Description

Make the new data flows visible: extend `--dry-run` output to display invoice fields, financial block status, and volunteer status. Then create a verification script that proves all wiring is in place through structural source code checks — this is the slice's objective stopping condition.

## Steps

1. In `syncIndividual()`'s `dryRun` block (around line 393-420), after the existing data display and before the `return { success: true, action: 'dry-run' }`, add an invoice data section:
   ```javascript
   // Invoice data
   console.log('\nInvoice data:');
   if (invoiceData) {
     if (invoiceData.invoice_email) console.log(`  Email: ${invoiceData.invoice_email}`);
     if (invoiceData.invoice_external_code) console.log(`  Reference: ${invoiceData.invoice_external_code}`);
     if (invoiceData.invoice_address_is_default === 0) {
       console.log(`  Custom address: ${invoiceData.invoice_street || ''} ${invoiceData.invoice_house_number || ''}, ${invoiceData.invoice_postal_code || ''} ${invoiceData.invoice_city || ''}`);
     } else {
       console.log('  Address: (default - same as home address)');
     }
   } else {
     console.log('  (none - run functions sync with --with-invoice first, or use --fetch)');
   }

   // Financial block and volunteer status
   console.log('\nFinancial/volunteer status:');
   console.log(`  Financial block: ${prepared.data.acf['financiele-blokkade'] ? 'YES' : 'no'}`);
   if (rondoClubId) {
     console.log('  Volunteer status: (available after sync - stored in Rondo Club)');
   } else {
     console.log('  Volunteer status: (will be captured on first sync)');
   }
   ```

2. Ensure `invoiceData` variable is accessible in the `dryRun` block. It's read before `preparePerson` (from T02) which is before the dry-run check, so it should already be in scope.

3. Create `scripts/verify-s01.sh`:
   ```bash
   #!/bin/bash
   # Verification script for S01: Invoice data and side-effects
   set -e
   PASS=0
   FAIL=0

   check() {
     if eval "$2" > /dev/null 2>&1; then
       echo "✓ $1"
       PASS=$((PASS + 1))
     else
       echo "✗ $1"
       FAIL=$((FAIL + 1))
     fi
   }

   echo "=== S01 Verification ==="
   echo ""

   # Export checks
   check "logFinancialBlockActivity exported" \
     "node -e \"const m = require('./steps/submit-rondo-club-sync'); if (typeof m.logFinancialBlockActivity !== 'function') process.exit(1)\""

   # Import checks in sync-individual
   check "fetchMemberFinancialData imported" \
     "grep -q 'fetchMemberFinancialData' pipelines/sync-individual.js"
   check "upsertMemberInvoiceData imported" \
     "grep -q 'upsertMemberInvoiceData' pipelines/sync-individual.js"
   check "getMemberInvoiceDataByKnvbId imported" \
     "grep -q 'getMemberInvoiceDataByKnvbId' pipelines/sync-individual.js"
   check "updateVolunteerStatus imported" \
     "grep -q 'updateVolunteerStatus' pipelines/sync-individual.js"
   check "logFinancialBlockActivity imported" \
     "grep -q 'logFinancialBlockActivity' pipelines/sync-individual.js"

   # Wiring checks
   check "Invoice data passed to preparePerson (not null)" \
     "grep -q 'preparePerson(member, freeFields, invoiceData,' pipelines/sync-individual.js"
   check "No null invoice param in preparePerson call" \
     "! grep -q 'preparePerson(member, freeFields, null,' pipelines/sync-individual.js"
   check "Volunteer status updated in sync" \
     "grep -c 'updateVolunteerStatus' pipelines/sync-individual.js | grep -q '[2-9]'"
   check "Financial block activity logged in sync" \
     "grep -c 'logFinancialBlockActivity' pipelines/sync-individual.js | grep -q '[2-9]'"

   # Dry-run display checks
   check "Dry-run shows invoice section" \
     "grep -q 'Invoice data' pipelines/sync-individual.js"
   check "Dry-run shows financial block status" \
     "grep -q 'Financial block\\|financiele-blokkade' pipelines/sync-individual.js"

   # Module loads without error
   check "sync-individual.js loads without error" \
     "node -e \"require('./pipelines/sync-individual')\""

   echo ""
   echo "Results: $PASS passed, $FAIL failed"
   [ $FAIL -eq 0 ] || exit 1
   ```

4. Make the script executable and run it to confirm all checks pass.

## Must-Haves

- [ ] `--dry-run` output includes invoice email, reference, and address (when available)
- [ ] `--dry-run` output includes financial block status
- [ ] `--dry-run` output includes volunteer status note
- [ ] `scripts/verify-s01.sh` exists and is executable
- [ ] Verification script checks all key integration points (exports, imports, wiring, dry-run display)
- [ ] Verification script passes with exit code 0

## Verification

- `bash scripts/verify-s01.sh` exits with code 0 and all checks pass
- `grep 'Invoice data' pipelines/sync-individual.js` finds the dry-run display section

## Observability Impact

- Signals added/changed: `--dry-run` output now shows invoice fields and financial/volunteer status — primary inspection surface for individual sync debugging
- How a future agent inspects this: Run `node pipelines/sync-individual.js <knvb-id> --dry-run` to see all data that would be synced, including invoice data
- Failure state exposed: None additional — dry-run is a diagnostic tool itself

## Inputs

- `pipelines/sync-individual.js` — with T01 and T02 changes: invoice fetch, invoice data flow, volunteer/financial block side-effects all wired
- Bulk sync dry-run patterns (not formally in bulk sync — this is new for individual sync)

## Expected Output

- `pipelines/sync-individual.js` — dry-run block extended with invoice, financial block, and volunteer status display
- `scripts/verify-s01.sh` — new verification script covering all S01 integration points, passing with exit code 0
