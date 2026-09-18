# Changelog

## [0.11.0] - 2026-09-18

### Added

- Automatically unsubscribe former members and their unused parent addresses from
  the member Laposta lists after a complete source refresh and successful submission.
- Protect shared addresses still used by active members or their parents, preserve
  opt-outs and sponsor subscriptions, and verify each removal with a separate read.
- Provide a production-only preview/apply cleanup tool using the same selection.
- Journal intentional removals so they do not create contact-check tasks.
