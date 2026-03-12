# M002: Individual Sync Parity — Context

**Gathered:** 2026-03-12
**Status:** Ready for planning

## Project Description

The individual sync (`pipelines/sync-individual.js`) syncs a single member by KNVB ID to Rondo Club. It's triggered from the web API (`POST /api/sync/individual`) when a member is edited in Rondo Club, or manually via CLI. Currently it covers core person data, functions/committees, parents, and player history — but misses several data flows that the bulk people sync (`pipelines/sync-people.js`) handles.

## Why This Milestone

The individual sync was built as a fast single-member alternative to the full people pipeline. Over time, the people pipeline grew to include invoice data, photo sync, financial block activity logging, volunteer status capture, and Laposta deliverability. The individual sync never caught up, so a member synced individually ends up with incomplete data compared to the same member processed through the bulk pipeline.

This is particularly problematic because the individual sync is the primary mechanism for on-demand member updates from Rondo Club's admin UI — it's the sync that matters most for immediate feedback.

## User-Visible Outcome

### When this milestone is complete, the user can:

- Trigger an individual sync for a member and get the same data coverage as the bulk people sync (photos, invoice data, financial block activity, volunteer status)
- Trust that a member synced individually has complete, up-to-date data without waiting for the next scheduled bulk sync

### Entry point / environment

- Entry point: `POST /api/sync/individual` (web API) and `node pipelines/sync-individual.js <knvb-id> --fetch` (CLI)
- Environment: production server at 46.202.155.16
- Live dependencies involved: Sportlink Club (browser automation), Rondo Club WordPress (REST API)

## Completion Class

- Contract complete means: individual sync produces identical ACF/meta payloads to bulk sync for the same member, and exercises all the same side-effects (photo, activity log, volunteer status)
- Integration complete means: a member synced via `POST /api/sync/individual` on the production server has the same data as if processed through the bulk people pipeline
- Operational complete means: none (existing deployment/systemd infrastructure unchanged)

## Final Integrated Acceptance

To call this milestone complete, we must prove:

- A member synced via individual sync (with `--fetch`) has invoice data, photos, financial block activity logging, and volunteer status identical to what the bulk sync would produce
- The individual sync's `--dry-run` output shows all the fields that the bulk sync would set

## Risks and Unknowns

- **Browser session complexity** — Adding financial tab fetch to the individual Sportlink session adds another page navigation; risk of session timeout or stale state. Mitigation: existing retry pattern for memberships fetch can be reused.
- **Photo sync timing** — Downloading and uploading a photo inline during individual sync may slow the API response. Mitigation: photo sync is already non-critical in bulk; same pattern applies.

## Existing Codebase / Prior Art

- `pipelines/sync-individual.js` — Current individual sync, handles person data, functions, parents, player history
- `pipelines/sync-people.js` — Bulk pipeline with all data flows (the "source of truth" for what individual sync should match)
- `steps/prepare-rondo-club-members.js` — `preparePerson()` function that transforms Sportlink data; already accepts `invoiceData` parameter but individual sync passes null
- `steps/submit-rondo-club-sync.js` — `syncPerson()` with `logFinancialBlockActivity()` and `updateVolunteerStatus()` that individual sync doesn't call
- `steps/download-functions-from-sportlink.js` — `fetchMemberFinancialData()` exists but individual sync doesn't call it
- `steps/download-photos-from-api.js` / `steps/upload-photos-to-rondo-club.js` — Photo pipeline not wired into individual sync
- `lib/rondo-club-db.js` — `getMemberInvoiceDataByKnvbId()` and `upsertMemberInvoiceData()` already exist

> See `.gsd/DECISIONS.md` for all architectural and pattern decisions — it is an append-only register; read it during planning, append to it during execution.

## Relevant Requirements

- Individual sync should be functionally equivalent to the member-specific parts of the people sync pipeline

## Scope

### In Scope

- Fetch invoice/financial data from Sportlink during `--fetch` mode
- Pass invoice data to `preparePerson()` in individual sync
- Download and upload member photo during individual sync (when `--fetch`)
- Log financial block activity changes (like bulk sync does)
- Capture volunteer status from Rondo Club (like bulk sync does)
- Update individual sync's `--dry-run` output to show all fields

### Out of Scope / Non-Goals

- Laposta sync for individual members (Laposta is a bulk mailing list — syncing one member individually adds complexity for no practical benefit; the next scheduled bulk sync handles it within hours)
- Laposta deliverability task creation (only meaningful in bulk context)
- FreeScout customer sync for individual members (separate pipeline with its own schedule)
- Former member marking (only meaningful in bulk context — needs full member list comparison)
- Any changes to the bulk sync pipeline
- Reverse sync (currently disabled project-wide)

## Technical Constraints

- Must not slow the web API response beyond acceptable limits (~30s current timeout with Sportlink browser automation)
- Photo download/upload should be non-critical (failures don't block person sync)
- Must run on production server only (same constraint as all sync scripts)

## Integration Points

- Sportlink Club — Adding financial tab navigation to the `--fetch` browser session
- Rondo Club WordPress — Same REST API endpoints already used
- SQLite databases — Same rondo-club-db already used

## Open Questions

- None — all patterns already exist in the bulk sync and just need wiring into individual sync
