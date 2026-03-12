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
  "grep -q 'Financial block\|financiele-blokkade' pipelines/sync-individual.js"

# Module loads without error
check "sync-individual.js loads without error" \
  "node -e \"require('./pipelines/sync-individual')\""

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ $FAIL -eq 0 ] || exit 1
