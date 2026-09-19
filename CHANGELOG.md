# Changelog

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
