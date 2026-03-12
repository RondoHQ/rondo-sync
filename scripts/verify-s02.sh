#!/usr/bin/env bash
set -e

PASS=0
FAIL=0

check() {
  local desc="$1"
  shift
  if eval "$@" > /dev/null 2>&1; then
    echo "  ✅ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $desc"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== S02 Photo Sync Verification ==="
echo ""

echo "Exports:"
check "uploadPhotoToRondoClub is a function" \
  'node -e "const m = require(\"./steps/upload-photos-to-rondo-club\"); if (typeof m.uploadPhotoToRondoClub !== \"function\") process.exit(1)"'
check "findPhotoFile is a function" \
  'node -e "const m = require(\"./steps/upload-photos-to-rondo-club\"); if (typeof m.findPhotoFile !== \"function\") process.exit(1)"'

echo ""
echo "Require-time load:"
check "sync-individual.js loads without error" \
  'node -e "require(\"./pipelines/sync-individual\")"'

echo ""
echo "Imports in sync-individual.js:"
check "downloadPhotoFromUrl imported" \
  'grep -q "downloadPhotoFromUrl" pipelines/sync-individual.js'
check "uploadPhotoToRondoClub imported and used (>=3 occurrences)" \
  '[ $(grep -c "uploadPhotoToRondoClub" pipelines/sync-individual.js) -ge 3 ]'
check "updatePhotoState imported and used (>=3 occurrences)" \
  '[ $(grep -c "updatePhotoState" pipelines/sync-individual.js) -ge 3 ]'
check "findPhotoFile imported and used (>=3 occurrences)" \
  '[ $(grep -c "findPhotoFile" pipelines/sync-individual.js) -ge 3 ]'

echo ""
echo "Dry-run photo display:"
check "Photo section in dry-run output" \
  'grep -q "Photo:" pipelines/sync-individual.js'
check "photo_date referenced in dry-run" \
  'grep -q "photo_date" pipelines/sync-individual.js'
check "photo_url referenced for availability check" \
  'grep -q "photo_url" pipelines/sync-individual.js'

echo ""
echo "Non-critical pattern (try/catch):"
check "try/catch around photo upload in UPDATE path" \
  'grep -A2 "Photo upload.*non-critical" pipelines/sync-individual.js | grep -q "try"'
check "Photo upload guarded by fetch && fetchResult" \
  'grep -q "fetch && fetchResult?.photoDownload?.success" pipelines/sync-individual.js'
check "Two photo upload blocks (UPDATE + CREATE)" \
  '[ $(grep -c "uploadPhotoToRondoClub(.*photoFile.path" pipelines/sync-individual.js) -ge 2 ]'
check "Two updatePhotoState calls (UPDATE + CREATE)" \
  '[ $(grep -c "updatePhotoState(rondoClubDb" pipelines/sync-individual.js) -ge 2 ]'

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
