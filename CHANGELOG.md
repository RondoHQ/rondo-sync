# Changelog

## [0.13.3] - 2026-10-04

### Changed

- Read historical financial tables with at most four independent browser pages while keeping imports ordered and sequential; source failures stop further writes and drain pending reads.

## [0.13.2] - 2026-10-04

### Fixed

- Preserve product classifications by trimming export names like the former report parser.
- Avoid unnecessary date-filter changes and leave days without source rows absent instead of creating zero reports.

## [0.13.1] - 2026-10-04

### Fixed

- Anchor browser date selectors to January before changing years, preventing Twelve from moving the opposite boundary during a year transition.

## [0.13.0] - 2026-10-04

### Added

- Two-hour Twelve browser import with immutable CSV snapshots and daily financial tables, matching revenue and no-sale totals before idempotent Rondo writes.
- Current-day cutoff, provisional reports, historical replay, run tracking and watchdog coverage.

## [0.12.2] - 2026-10-04

### Fixed

- Set the Twelve end-date filter before the start date so its automatic range adjustment does not broaden historical download periods.

## [0.12.1] - 2026-10-04

### Fixed

- Reconcile Twelve tab settlements, reversed product rows, split payments, deposit-inclusive amounts, and repeated virtual discounts without double-counting revenue; round allocation fractions only after daily summation.
- Include partial no-sale payments with their category and amount while explicitly leaving their individual consumed products unknown.

## [0.12.0] - 2026-10-04

### Added

- Read-only Twelve browser downloader with bounded date ranges, private snapshots, checksums, screen/export row-count verification, and explicit incomplete-run detection.
- Offline comparison with existing PDF report totals and detailed no-sale transactions/products; preserves source discrepancies and leaves Rondo data, PDF imports, and schedules unchanged.

## [0.11.9] - 2026-10-04

### Fixed

- Normalize Sportlink team-name whitespace when matching and writing player history, preventing repeated imports from adding duplicate external-team rows after WordPress sanitization.

## [0.11.8] - 2026-10-04

### Fixed

- Exclude obsolete and retired source identities from player-history checks while preserving their tracking mappings, quarantine settings, and retry signatures.

## [0.11.7] - 2026-10-03

### Fixed

- Resolve merged person references before onboarding source checks, including unchanged and deferred Sportlink registrations.
- Preserve retired KNVB identities without observing or updating a survivor with another KNVB ID; keep these source checks incomplete without failing each People run.

## [0.11.6] - 2026-10-01

### Fixed

- Retry a temporarily missing player-history panel once after refreshing the Sportlink session, including the shared session in the full pipeline.
- Report Sportlink's explicit missing-person response without retrying authentication or treating it as an empty history.

## [0.11.5] - 2026-09-26

### Fixed

- Import the newest downloaded Sportlink photo when an older cached photo uses a different file format, for both scheduled and individual syncs.

## [0.11.4] - 2026-09-26

### Fixed

- Audit current Rondo team roles against Sportlink rosters during history sync, including members with an unchanged empty team signature or missing work-history tracking. Fetch authoritative history before correcting ended roles.
- Require verified Sportlink membership responses and report unmatched roles for review without inventing end dates or treating a failed page load as an empty history.

## [0.11.3] - 2026-09-23

### Fixed

- Keep same-named teams separate: use unique team IDs and member roster evidence instead of overwriting shared team names or codes.
- Preserve unmatched historical team IDs as external history instead of assigning them to a current namesake.

## [0.11.2] - 2026-09-19

### Fixed

- Preserve explicitly active Sportlink team roles without an end date when their season label refers to an earlier season, preventing current staff roles and guest-pass eligibility from disappearing.

## [0.11.1] - 2026-09-18

### Fixed

- Detect disappeared teams using the fresh Sportlink team snapshot, excluding stale cached rows.
- Preserve historical team names, roles and dates before moving missing teams to draft; verify both changes before removing their sync mapping.
- Keep untracked teams and teams with unended roles untouched, and skip cleanup after failed, malformed or empty downloads.

## [0.11.0] - 2026-09-18

### Added

- Automatically unsubscribe former members and their unused parent addresses from
  the member Laposta lists after a complete source refresh and successful submission.
- Protect shared addresses still used by active members or their parents, preserve
  opt-outs and sponsor subscriptions, and verify each removal with a separate read.
- Provide a production-only preview/apply cleanup tool using the same selection.
- Journal intentional removals so they do not create contact-check tasks.
