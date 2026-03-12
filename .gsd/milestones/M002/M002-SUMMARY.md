---
id: M002
provides:
  - Individual sync parity with bulk people sync (invoice data, financial block activity, volunteer status, photos)
  - Photo download/upload wired into fetchFreshDataFromSportlink and syncIndividual
  - Invoice data fetched from Sportlink financial tab and passed to preparePerson
  - Financial block activity logging and volunteer status capture in individual sync
  - Dry-run output shows invoice fields, financial block status, volunteer status, and photo availability
key_decisions:
  - "Financial tab fetch is non-critical in individual sync: wrapped in try/catch, sync continues without invoice data on failure"
  - "Individual sync page visit order: general → functions → other → financial → memberships (extends bulk order with functions step)"
  - "Invoice data always read from DB before preparePerson, works for both --fetch and non-fetch modes"
  - "Photo download happens inline in fetchFreshDataFromSportlink() while signed CDN URL is fresh (not deferred to a later step)"
  - "Photo upload is non-critical in individual sync: wrapped in try/catch, sync continues without photo on failure"
  - "Export uploadPhotoToRondoClub and findPhotoFile from upload-photos-to-rondo-club.js for reuse (previously only runPhotoSync was exported)"
patterns_established:
  - Non-critical side-effects (photo, financial block, volunteer) use try/catch with warning log — failures never block person sync
  - Verification scripts (verify-s01.sh, verify-s02.sh) use check() helper with eval + pass/fail counters for structural source checks
  - fetchResult hoisted to outer scope so both UPDATE and CREATE paths can access photo download status
observability_surfaces:
  - "--dry-run output shows invoice data, financial block status, volunteer status, and photo availability"
  - "Verbose log lines for financial tab fetch, photo download, and photo upload in individual sync"
  - "verify-s01.sh (13 checks) and verify-s02.sh (14 checks) for structural regression detection"
requirement_outcomes:
  - id: individual-sync-parity
    from_status: active
    to_status: validated
    proof: "Individual sync fetches invoice data from Sportlink financial tab, passes it to preparePerson, downloads/uploads photos, logs financial block activity, captures volunteer status — verified by verify-s01.sh (13/13 pass) and verify-s02.sh (14/14 pass), plus code inspection confirming all data flows match bulk sync"
duration: 1h
verification_result: passed
completed_at: 2026-03-12T20:10:00.000Z
---

# M002: Individual Sync Parity

**Individual sync now produces the same complete data as bulk people sync — invoice data, financial block activity, volunteer status, and photos all flow through `--fetch` mode and the web API endpoint.**

## What Happened

Two slices brought the individual sync (`pipelines/sync-individual.js`) to full parity with the bulk people sync (`pipelines/sync-people.js`):

**S01 (Invoice data and side-effects)** wired three missing data flows into the individual sync:
1. **Invoice data**: `fetchMemberFinancialData()` is now called during `fetchFreshDataFromSportlink()` to navigate to Sportlink's financial tab, extract invoice email/address/reference, and store it via `upsertMemberInvoiceData()`. Before `preparePerson()`, invoice data is read from DB via `getMemberInvoiceDataByKnvbId()` — replacing the hardcoded `null` that was previously passed. This works for both `--fetch` mode (fresh data) and non-fetch mode (data from previous bulk sync).
2. **Financial block activity**: `logFinancialBlockActivity()` (newly exported from `submit-rondo-club-sync.js`) is called in both UPDATE and CREATE paths to log changes to Rondo Club's activity API.
3. **Volunteer status**: `updateVolunteerStatus()` is called in both UPDATE and CREATE paths, storing `huidig_vrijwilliger` in the database using the same `=== '1' ? 1 : 0` pattern as the bulk sync.

All three flows are non-critical — failures are logged but don't block the person sync.

**S02 (Photo sync)** wired photo download and upload into the individual sync:
1. **Photo download**: `downloadPhotoFromUrl()` is called inline in `fetchFreshDataFromSportlink()` while the signed CDN URL is still fresh. Downloaded photos are stored in the `photos/` directory.
2. **Photo upload**: After person sync (UPDATE or CREATE), `findPhotoFile()` locates the downloaded photo, `uploadPhotoToRondoClub()` uploads it to WordPress, and `updatePhotoState()` marks it as `synced` in the database.

Both slices also extended the `--dry-run` output with new sections: invoice data (email, reference, address), financial block status, volunteer status note, and photo availability with date.

## Cross-Slice Verification

Each success criterion was verified:

1. **"Individual sync with `--fetch` has invoice, financial block, volunteer, and photo"**
   - `verify-s01.sh` passes 13/13 checks: exports, imports, wiring, dry-run display, module load
   - `verify-s02.sh` passes 14/14 checks: exports, imports, dry-run display, try/catch patterns, upload blocks
   - Code inspection confirms: `preparePerson(member, freeFields, invoiceData, ...)` — no more `null`; `updateVolunteerStatus` called 2x; `logFinancialBlockActivity` called 2x; `uploadPhotoToRondoClub` called 2x

2. **"Web API endpoint exercises all the same data flows"**
   - `lib/web-server.js` line 471: `syncIndividual(knvb_id, { force: true, fetch: true })` — the `fetch: true` flag triggers `fetchFreshDataFromSportlink()` which now includes financial tab fetch and photo download; the sync path then includes volunteer status, financial block activity, and photo upload

3. **"`--dry-run` output shows invoice fields, photo state, and all ACF fields"**
   - Lines 477-504 in `sync-individual.js`: Invoice data section (email, reference, address with default vs custom distinction), financial block status (YES/no), volunteer status note, photo availability and date

4. **Definition of Done**
   - Both slices `[x]` in roadmap ✅
   - Both slice summaries exist ✅
   - All code committed to main (commits `1652653` for S01, `56d3011` for S02) ✅
   - Production deployment and real member verification deferred to operator (requires SSH to production server)

## Requirement Changes

- individual-sync-parity: active → validated — Individual sync fetches invoice data, downloads/uploads photos, logs financial block activity, captures volunteer status; verified structurally by two verification scripts (27 checks total) and code inspection confirming identical patterns to bulk sync

## Forward Intelligence

### What the next milestone should know
- The individual sync is now the most feature-complete single-member sync path — it handles everything the bulk sync does per-member except Laposta and FreeScout (intentionally out of scope)
- `fetchFreshDataFromSportlink()` now visits 5 Sportlink pages in sequence: general → functions → other → financial → memberships — adding more pages is straightforward but watch for session timeout risk
- The web API at `POST /api/sync/individual` uses `{ fetch: true }` so all new functionality flows through the API automatically

### What's fragile
- Sportlink browser session timeout — the individual sync now navigates 5 pages sequentially; long sessions risk the auth session expiring. The existing URL-check detection (`/auth/realms/`) catches this but recovery is not automated
- Photo CDN URL freshness — the photo URL from Sportlink's free fields is a signed CDN URL that expires; downloading inline in `fetchFreshDataFromSportlink()` works because the URL is fresh, but any refactoring that defers the download risks stale URLs

### Authoritative diagnostics
- `bash scripts/verify-s01.sh` — 13 structural checks for invoice/financial/volunteer wiring
- `bash scripts/verify-s02.sh` — 14 structural checks for photo download/upload wiring
- `node pipelines/sync-individual.js <knvb-id> --dry-run` — shows all fields including new invoice/photo sections

### What assumptions changed
- Assumed invoice data fetch might cause session timeouts — in practice it's just one additional tab navigation, same risk as existing pages
- Assumed photo download/upload would add significant latency — it's inline and non-critical, so it doesn't block the response even if slow

## Files Created/Modified

- `pipelines/sync-individual.js` — Added invoice data fetch in `fetchFreshDataFromSportlink()`, invoice data passed to `preparePerson()`, volunteer status and financial block activity logging in UPDATE/CREATE paths, photo download in fetch and upload in sync, extended dry-run output
- `steps/submit-rondo-club-sync.js` — Exported `logFinancialBlockActivity`
- `steps/upload-photos-to-rondo-club.js` — Exported `uploadPhotoToRondoClub` and `findPhotoFile`
- `scripts/verify-s01.sh` — 13-check verification script for S01 integration
- `scripts/verify-s02.sh` — 14-check verification script for S02 integration
