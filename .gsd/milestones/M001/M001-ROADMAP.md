# M001: Migration

**Vision:** A sync system with web dashboard that synchronizes member data bidirectionally between Sportlink Club (a Dutch sports club management system) and multiple destinations: Laposta email marketing lists and Rondo Club (a WordPress-based member management app).

## Success Criteria


## Slices

- [x] **S01: Infrastructure Foundation** `risk:medium` `depends:[]`
  > After this: Add WAL journal mode and busy_timeout to all 5 existing SQLite database modules, and create the dashboard database module with run tracking schema.
- [x] **S02: Run Tracking** `risk:medium` `depends:[S01]`
  > After this: Create a run-tracker library and instrument all 6 pipelines (plus sync-all) to persist structured run data to the dashboard database.
- [x] **S03: Web Server And Authentication** `risk:medium` `depends:[S02]`
  > After this: Create the complete Fastify web server application with session-based authentication, login UI, password hashing utility, and deployment configuration files (systemd + nginx).
- [x] **S04: Dashboard Ui** `risk:medium` `depends:[S03]`
  > After this: Build the pipeline overview page, run history page, and run detail page for the dashboard.
- [x] **S05: Email Migration** `risk:medium` `depends:[S04]`
  > After this: Replace always-send email reports with error-only alerts containing dashboard links.
- [x] **S06: Multi Club Readiness — deferred until second club onboards** `risk:medium` `depends:[S05]`
  > After this: unit tests prove Multi-Club Readiness — deferred until second club onboards works
- [x] **S07: Former Member Import Tool** `risk:medium` `depends:[S06]`
  > After this: Create the former member import tool: a Playwright-based download step that toggles Sportlink status filters to INACTIVE, and an orchestrator tool that downloads, prepares, and syncs former members to Rondo Club with `acf.
- [x] **S08: Database Migration** `risk:medium` `depends:[S07]`
  > After this: Add the stadion-to-rondo_club migration function to `lib/rondo-club-db.
- [x] **S09: Code References** `risk:medium` `depends:[S08]`
  > After this: Rename all stadion references to rondo_club in the people-pipeline step files: member sync, parent sync, photo upload, FreeScout customer prep, Nikki sync, and function download.
- [x] **S10: Documentation** `risk:medium` `depends:[S09]`
  > After this: Update all stadion references to rondo_club in the rondo-sync repository's documentation files, CLAUDE.
- [x] **S11: Relationend Field Mapping** `risk:medium` `depends:[S10]`
  > After this: Add RelationEnd date synchronization to the FreeScout customer sync pipeline.
- [x] **S12: Photo Url Sync To Freescout** `risk:medium` `depends:[S11]`
  > After this: Enable member photos from Rondo Club to appear as FreeScout customer avatars by syncing photo URLs through the existing FreeScout sync pipeline.
- [x] **S13: Freescout Conversations As Activities** `risk:medium` `depends:[S12]`
  > After this: Create the FreeScout conversations database tracking module, download step with pagination and incremental sync, and prepare step that transforms conversations into Rondo Club activity payloads.
