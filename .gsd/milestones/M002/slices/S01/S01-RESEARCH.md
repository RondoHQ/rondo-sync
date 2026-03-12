# S01: Invoice data and side-effects — Research

**Date:** 2026-03-12

## Summary

The individual sync (`pipelines/sync-individual.js`) currently handles person data, functions/committees, parents, and player history — but skips three data flows that the bulk people sync exercises: (1) invoice/financial data from Sportlink's `/financial` tab, (2) financial block activity logging to Rondo Club, and (3) volunteer status capture from Rondo Club.

All the building blocks already exist and are well-tested in the bulk pipeline. The work is purely wiring: add a `fetchMemberFinancialData()` call during the `--fetch` browser session, pass the invoice data to `preparePerson()`, export and call `logFinancialBlockActivity()` after person update/create, and call `updateVolunteerStatus()` after reading the existing person from Rondo Club. No new APIs, no new database tables, no new libraries.

The main technical risk is the additional page navigation (financial tab) extending the browser session duration and increasing session timeout probability. The existing retry pattern for memberships fetch provides a proven mitigation strategy.

## Recommendation

Wire the three missing data flows into `sync-individual.js` by following the exact patterns already used in the bulk sync:

1. **Invoice data:** In `fetchFreshDataFromSportlink()`, call the already-exported `fetchMemberFinancialData()` after the `/other` page visit. Store via `upsertMemberInvoiceData()`. Return it in the result object. In `syncIndividual()`, read invoice data from DB via `getMemberInvoiceDataByKnvbId()` and pass to `preparePerson()` instead of `null`.

2. **Financial block activity:** Export `logFinancialBlockActivity()` from `submit-rondo-club-sync.js`. In the individual sync's update path, compare `existingData.acf['financiele-blokkade']` with the new value and call `logFinancialBlockActivity()` if changed. In the create path, log activity if initially blocked.

3. **Volunteer status:** After the GET of existing person data (update path) or POST response (create path), read `huidig-vrijwilliger` and call `updateVolunteerStatus()`.

4. **Dry-run output:** Add invoice fields and volunteer/financial block status to the `--dry-run` display.

## Don't Hand-Roll

| Problem | Existing Solution | Why Use It |
|---------|------------------|------------|
| Fetch invoice data from Sportlink | `fetchMemberFinancialData()` in `steps/download-functions-from-sportlink.js` | Already exported, handles page navigation, response parsing, error handling |
| Store invoice data in DB | `upsertMemberInvoiceData()` in `lib/rondo-club-db.js` | Already exported, handles upsert with hash computation |
| Read invoice data from DB | `getMemberInvoiceDataByKnvbId()` in `lib/rondo-club-db.js` | Already exported, returns shape expected by `preparePerson()` |
| Log financial block activity | `logFinancialBlockActivity()` in `steps/submit-rondo-club-sync.js` | Needs exporting; handles activity API call with graceful failure |
| Update volunteer status in DB | `updateVolunteerStatus()` in `lib/rondo-club-db.js` | Already imported in `submit-rondo-club-sync.js`; simple UPDATE query |
| Transform invoice data to ACF | `preparePerson()` already accepts `invoiceData` parameter | Just pass real data instead of `null` |

## Existing Code and Patterns

- `pipelines/sync-individual.js:90-205` — `fetchFreshDataFromSportlink()`: browser session visits general → functions → other → memberships. Financial tab fetch inserts after "other" visit (line ~145), before memberships. Returns result object that needs `invoiceData` field added.
- `pipelines/sync-individual.js:377` — `preparePerson(member, freeFields, null, freeFieldMappings)`: the third argument is `invoiceData`, currently hardcoded `null`. Change to pass actual data.
- `steps/submit-rondo-club-sync.js:145-168` — `logFinancialBlockActivity()`: Posts activity to `rondo/v1/people/{id}/activities`. Gracefully handles failures (non-critical). Not currently exported — add to `module.exports`.
- `steps/submit-rondo-club-sync.js:247-253` — Bulk sync's update path: reads `huidig-vrijwilliger` from existing data, calls `updateVolunteerStatus()`, compares financial block and logs activity. This is the pattern to replicate in individual sync.
- `steps/submit-rondo-club-sync.js:289-296` — Bulk sync's create path: captures volunteer status from POST response, logs initial block status for new persons.
- `steps/download-functions-from-sportlink.js:271-328` — `fetchMemberFinancialData()`: navigates to `/financial` tab, captures `MemberPaymentInvoiceAddress` and `MemberPaymentInvoiceInformation` API responses. Already exported.
- `steps/prepare-rondo-club-members.js:228-249` — Invoice data handling in `preparePerson()`: adds invoice address to addresses repeater (if not default), sets `factuur-email` and `factuur-referentie`. Already works when non-null invoiceData is passed.

## Constraints

- **Page visit order decision:** "Page visit order: general -> other -> financial (consistent ordering)" — but individual sync has an extra "functions" step. The order will be: general → functions → other → financial → memberships.
- **Session timeout risk:** Adding one more page navigation increases total browser session time by ~2-5 seconds per member. The existing membership retry pattern (re-login + retry) can be reused if financial tab fails.
- **`logFinancialBlockActivity` not exported:** Must add to `module.exports` in `submit-rondo-club-sync.js` to make it available to individual sync.
- **`updateVolunteerStatus` not imported in individual sync:** Must add import from `lib/rondo-club-db.js`.
- **Non-fetch mode:** When `--fetch` is not used, invoice data should still be read from the DB (from a previous bulk sync run). The current code path for non-fetch already reads `freeFields` from DB — same pattern applies to invoice data.

## Common Pitfalls

- **Passing null vs DB-sourced invoice data in non-fetch mode** — When `--fetch` is not used, must still read invoice data from DB via `getMemberInvoiceDataByKnvbId()` and pass to `preparePerson()`. Without this, non-fetch individual syncs would still produce incomplete data. The fix is simple: always read invoice data from DB, same as free fields are already read.
- **Financial block comparison using wrong types** — The bulk sync compares `existingData.acf?.['financiele-blokkade'] || false` with `updateData.acf?.['financiele-blokkade'] || false`. The Rondo Club API may return the field as a boolean, string `"1"`, or integer. Follow the exact comparison pattern from the bulk sync.
- **Activity logging failure blocking sync** — `logFinancialBlockActivity()` already wraps its API call in try/catch and logs warnings instead of throwing. Follow this non-critical pattern.
- **Session timeout on financial tab** — If the Sportlink session expires between "other" and "financial" tab visits, the API response will be empty/HTML login page. The function returns `null` in this case, which is safe — invoice data simply won't be included this run. Consider using the same re-auth retry pattern used for memberships, but this is optional since invoice data is non-critical.

## Open Risks

- **Browser session duration increase:** Adding the financial tab adds ~2-5 seconds to the browser session. Total session time with all pages (general + functions + other + financial + memberships) could approach 15-20 seconds. If Sportlink's session timeout is tight (~5 min), this shouldn't be an issue, but if the TOTP auth has a shorter window, the memberships fetch (last step) could time out more frequently. Mitigation: existing retry pattern for memberships.
- **Invoice data freshness in non-fetch mode:** When `--fetch` is not used, invoice data comes from the last bulk `functions` pipeline run with `--with-invoice`. This runs monthly per the current schedule. Data could be up to a month stale. This matches the current bulk sync behavior, so it's not a regression, but worth noting.

## Skills Discovered

| Technology | Skill | Status |
|------------|-------|--------|
| Playwright | `microsoft/playwright-cli@playwright-cli` (6.1K installs) | available — not needed (existing patterns sufficient) |
| WordPress REST API | `wordpress/agent-skills@wp-rest-api` (380 installs) | available — not needed (existing client library covers all needs) |

No skills are needed for this slice. The work is entirely wiring existing, well-tested building blocks together.

## Sources

- `pipelines/sync-individual.js` — current individual sync implementation (all gaps confirmed by code inspection)
- `pipelines/sync-people.js` — bulk pipeline showing all data flows that individual sync should match
- `steps/submit-rondo-club-sync.js` — `logFinancialBlockActivity()` and `updateVolunteerStatus()` call patterns
- `steps/download-functions-from-sportlink.js` — `fetchMemberFinancialData()` already exported
- `steps/prepare-rondo-club-members.js` — `preparePerson()` already accepts `invoiceData` parameter
- `lib/rondo-club-db.js` — `getMemberInvoiceDataByKnvbId()`, `upsertMemberInvoiceData()`, `updateVolunteerStatus()` all exist
- `.gsd/DECISIONS.md` — "Page visit order: general -> other -> financial" and "Fail-fast: if any page fails, skip entire member"
