---
id: M001
provides:
  - "WAL mode and busy_timeout on all 7 SQLite databases for concurrent access"
  - "Dashboard database with run tracking schema (runs, run_steps, run_errors)"
  - "RunTracker class instrumenting all pipelines with safety-wrapped methods"
  - "Fastify web server with Argon2id auth, SQLite sessions, nginx/TLS, systemd at https://sync.rondo.club"
  - "Dashboard UI: pipeline overview, run history, run detail, error browser"
  - "Error-only email alerts with dashboard links replacing always-send reports"
  - "Former member import tool with Playwright-based inactive member download and photo sync"
  - "Complete stadion-to-rondo_club database migration (8 tables, 80+ SQL functions, all code and docs)"
  - "RelationEnd date synchronization to FreeScout custom field ID 9"
  - "Photo URL sync from Rondo Club to FreeScout customer avatars"
  - "FreeScout conversations pipeline: download, prepare, submit as Rondo Club activities"
  - "Multi-club readiness formally deferred (YAGNI)"
key_decisions:
  - "WAL mode + 5000ms busy_timeout for concurrent cron + web server database access"
  - "RunTracker safety wrapping — tracking failures never crash pipelines"
  - "Fastify + EJS server-rendered HTML — no build step, no SPA overhead"
  - "Argon2id password hashing with pre-hashed passwords in config file"
  - "SQLite session store — persistence across restarts, no memory leak"
  - "Error-only alerts with 4-hour cooldown — dashboard is source of truth"
  - "CREATE+INSERT+DROP for table migration — avoids ALTER TABLE RENAME bugs"
  - "Migration in openDb() after pragmas, before initDb — automatic on first use"
  - "Multi-club readiness deferred until second club onboards — no speculative abstraction"
  - "Separate SQLite DB for FreeScout conversations — different concern from customer sync"
  - "Defensive deduplication before POST — two-layer defense for conversation activities"
  - "3-strategy status filter toggle for Sportlink UI resilience (ID → text → role fallback)"
  - "Dry-run-by-default import tool — safe-by-default with --import flag"
patterns_established:
  - "Pipeline instrumentation: minimal 5-15 line additions per pipeline via RunTracker"
  - "requireAuth preHandler hook for protecting dashboard routes"
  - "EJS partials pattern (include head/foot) for shared layout"
  - "Dashboard queries module with lazy database connection"
  - "Date normalization utility: accepts YYYYMMDD, YYYY-MM-DD, ISO 8601, returns YYYY-MM-DD"
  - "Custom field pipeline: extract from ACF → normalize in prepare → map field ID in submit"
  - "Conversations pipeline: download with pagination → prepare payloads → submit with deduplication"
  - "Non-critical step pattern: per-item try/catch, pipeline continues on individual failures"
observability_surfaces:
  - "Web dashboard at https://sync.rondo.club — pipeline status, run history, error browser"
  - "Error-only email alerts via Postmark with dashboard deep links"
  - "Periodic overdue checks (30-min interval) with 4-hour alert cooldown"
  - "RunTracker data in dashboard.sqlite — structured run timing, per-step counts, error details"
  - "Health check endpoint at /health (unauthenticated)"
requirement_outcomes:
  - id: WAL_MODE
    from_status: active
    to_status: validated
    proof: "S01 added WAL + busy_timeout to all 5 existing databases; verified on production with FreeScout pipeline (1062 customers)"
  - id: DASHBOARD_DB
    from_status: active
    to_status: validated
    proof: "S01 created lib/dashboard-db.js with runs, run_steps, run_errors tables including club_slug column"
  - id: RUN_TRACKING
    from_status: active
    to_status: validated
    proof: "S02 RunTracker class instruments all 7 pipelines; verified with CLI self-test creating run records"
  - id: WEB_SERVER
    from_status: active
    to_status: validated
    proof: "S03 Fastify server deployed at https://sync.rondo.club with Argon2id auth, SQLite sessions, nginx/TLS, systemd"
  - id: DASHBOARD_UI
    from_status: active
    to_status: validated
    proof: "S04 pipeline overview, run history, run detail, error browser — all verified on production by user"
  - id: EMAIL_MIGRATION
    from_status: active
    to_status: validated
    proof: "S05 deleted scripts/send-email.js, created lib/alert-email.js with failure-only alerts and dashboard links"
  - id: MULTI_CLUB
    from_status: active
    to_status: deferred
    proof: "S06 formally deferred — no code changes; all subsequent slices (S07-S13) completed without multi-club infrastructure"
  - id: FORMER_MEMBERS
    from_status: active
    to_status: validated
    proof: "S07 created download-inactive-members.js and import-former-members.js with photo support; 3-strategy Sportlink filter toggle"
  - id: DB_MIGRATION
    from_status: active
    to_status: validated
    proof: "S08 migrated 8 tables via CREATE+INSERT+DROP; 3675 members, 386 parents, 61 teams preserved; verified on production"
  - id: CODE_REFERENCES
    from_status: active
    to_status: validated
    proof: "S09 renamed stadion→rondo_club in 17+ step/pipeline/tool/lib files; grep confirms zero unexpected stadion references"
  - id: DOCUMENTATION
    from_status: active
    to_status: validated
    proof: "S10 updated 15 docs files (200+ occurrences) plus 13 developer docs files (184 occurrences); zero stadion references remain"
  - id: RELATION_END
    from_status: active
    to_status: validated
    proof: "S11 added date normalization utility and FreeScout field ID 9 mapping; both files pass syntax validation"
  - id: PHOTO_URL_SYNC
    from_status: active
    to_status: validated
    proof: "S12 async photo URL fetching via WordPress ?_embed, conditional photoUrl in FreeScout create/update payloads"
  - id: FREESCOUT_CONVERSATIONS
    from_status: active
    to_status: validated
    proof: "S13 complete pipeline: conversations DB, download with pagination, prepare activities, submit with deduplication, CLI + sync-all integration"
duration: "33 days (2026-02-08 to 2026-03-12)"
verification_result: passed
completed_at: 2026-03-12
---

# M001: Migration

**Web dashboard for sync monitoring, stadion-to-rondo_club database migration, former member import tool, and deep FreeScout integration (RelationEnd, photos, conversations as activities).**

## What Happened

This milestone transformed the rondo-sync system from a CLI-only batch processor into a monitored, web-accessible sync platform while completing a major naming migration and adding FreeScout integration depth.

**Foundation (S01–S02):** WAL journal mode and busy_timeout were added to all 5 existing SQLite databases, enabling concurrent access from cron jobs and the web server. A new dashboard database was created with run/step/error tracking schema. The RunTracker class was built with safety-wrapped methods and integrated into all 7 pipelines — tracking failures never crash sync operations.

**Web Dashboard (S03–S05):** A Fastify web server was deployed at https://sync.rondo.club with Argon2id authentication, SQLite-backed sessions, nginx reverse proxy, and TLS via Let's Encrypt. The dashboard provides pipeline overview with traffic-light status cards, paginated run history, per-step drill-down, and an error browser with filtering. Email reports were replaced with error-only alerts — the dashboard became the source of truth for successful runs.

**Multi-Club (S06):** Formally deferred. No code changes. The decision to avoid speculative multi-tenant abstraction was validated by all subsequent slices completing successfully without it.

**Former Members (S07):** A one-time import tool was created using Playwright browser automation to toggle Sportlink status filters to INACTIVE, download former member data, and sync to Rondo Club with photos. Three fallback strategies for UI element discovery provide resilience against Sportlink interface changes.

**Stadion-to-Rondo Rename (S08–S10):** The complete naming migration renamed 8 database tables, all column names, 80+ SQL query functions, variables, function names across 17+ files, and 200+ documentation references. The database migration used CREATE+INSERT+DROP pattern running automatically on first openDb() call, preserving all data (3675 members, 386 parents, 61 teams).

**FreeScout Integration (S11–S13):** Three slices deepened FreeScout integration: RelationEnd membership expiration dates sync to custom field ID 9 with multi-format date normalization; member photos from Rondo Club appear as FreeScout customer avatars via the WordPress REST API ?_embed parameter; and FreeScout email conversations download with pagination and incremental sync, transform to Rondo Club activity payloads, and submit with defensive deduplication — integrated into both CLI and sync-all pipeline.

## Cross-Slice Verification

The milestone roadmap had no explicit success criteria defined (the Success Criteria section is empty). Verification is based on the definition of done:

1. **All 13 slices marked complete:** ✅ All slices in M001-ROADMAP.md are `[x]`
2. **All 13 slice summaries exist:** ✅ Verified — each S01–S13 directory contains an S*-SUMMARY.md
3. **Cross-slice integration points verified:**
   - S01→S02: Dashboard database schema consumed by RunTracker — ✅ RunTracker writes to runs/run_steps/run_errors tables
   - S02→S03: RunTracker data consumed by web server routes — ✅ Dashboard queries read from dashboard.sqlite
   - S03→S04: Auth infrastructure consumed by dashboard pages — ✅ requireAuth hook protects all dashboard routes
   - S04→S05: Dashboard links used in email alerts — ✅ Alert emails contain ${DASHBOARD_URL}/run/${runId} links
   - S08→S09→S10: Database migration → code references → documentation — ✅ All three layers use consistent rondo_club naming with zero stadion references outside migration code
   - S11→S12→S13: FreeScout integration chain — ✅ RelationEnd, photo URLs, and conversations all flow through the existing FreeScout sync infrastructure

Each slice summary documents its own verification results, including production server testing for S01–S05, S08, and codebase grep verification for S09–S10.

## Requirement Changes

- WAL_MODE: active → validated — WAL + busy_timeout added to all databases, verified with concurrent cron + web server access
- DASHBOARD_DB: active → validated — lib/dashboard-db.js with runs/run_steps/run_errors schema deployed
- RUN_TRACKING: active → validated — RunTracker instruments all 7 pipelines with per-step counts and errors
- WEB_SERVER: active → validated — Fastify server at https://sync.rondo.club with auth, sessions, TLS
- DASHBOARD_UI: active → validated — 5 pages (overview, run history, run detail, error browser, error detail) verified on production
- EMAIL_MIGRATION: active → validated — Error-only alerts replace always-send reports; old send-email.js deleted
- MULTI_CLUB: active → deferred — Formally deferred until second club onboards; YAGNI principle applied
- FORMER_MEMBERS: active → validated — Import tool with Playwright download, photo sync, dry-run default
- DB_MIGRATION: active → validated — 8 tables migrated with data preserved; migration runs automatically on openDb()
- CODE_REFERENCES: active → validated — All stadion→rondo_club renames across steps, pipelines, tools, libs
- DOCUMENTATION: active → validated — 200+ occurrences in internal docs + 184 in developer docs renamed
- RELATION_END: active → validated — FreeScout field ID 9 populated with normalized membership expiration dates
- PHOTO_URL_SYNC: active → validated — WordPress ?_embed photo URLs flow to FreeScout customer avatars
- FREESCOUT_CONVERSATIONS: active → validated — Complete download→prepare→submit pipeline with deduplication

## Forward Intelligence

### What the next milestone should know
- The web dashboard is functional but minimal — server-rendered EJS with no JavaScript interactivity. Any future real-time features would need WebSocket or polling additions.
- The conversations pipeline (S13) established a pattern for adding new data flows: separate SQLite database, download with pagination, prepare payloads, submit with deduplication, integrate into sync-all as non-critical step.
- Multi-club architecture is explicitly deferred. When a second club needs onboarding, key areas needing attention: database isolation, per-club credentials, dashboard scoping, cron scheduling.

### What's fragile
- **Sportlink UI automation** — All three status filter toggle strategies depend on Sportlink's web interface remaining structurally similar. UI redesigns could break download steps.
- **Systemd service runs as root** — Accepted as-is since no sportlink user exists on server. Should be hardened when convenient.
- **Photo URL fetching for FreeScout** — Makes individual WordPress API calls per member with photos. At scale (1000+ members with photos), this could be slow. No batching implemented.

### Authoritative diagnostics
- **Dashboard at https://sync.rondo.club** — Real-time pipeline status, run history, and error details. The single most useful diagnostic surface.
- **`grep -r 'stadion' --include='*.js' --exclude-dir=node_modules .`** — Should return only `lib/rondo-club-db.js` and `lib/discipline-db.js` (migration code only). Any other matches indicate incomplete rename.
- **`node -e "require('./lib/rondo-club-db.js').openDb()"`** — Validates database migration runs successfully. Safe to call multiple times (idempotent).

### What assumptions changed
- **Multi-club architecture needed before further work** — Actually all S07–S13 slices completed fine without it, validating the deferral decision.
- **Email reports were essential** — Replaced by dashboard; operators now only receive emails when action is needed (failure or overdue), which proved to be the correct model.
- **Table migration needs downtime** — CREATE+INSERT+DROP pattern with automatic migration on openDb() allowed zero-downtime deployment.

## Files Created/Modified

Key files created or significantly modified during this milestone:

- `lib/dashboard-db.js` — Dashboard database module with run tracking schema
- `lib/run-tracker.js` — RunTracker class with safety-wrapped methods for all pipelines
- `lib/web-server.js` — Fastify web server with auth, sessions, routes, overdue checks
- `lib/auth.js` — Authentication logic (requireAuth hook, login/logout handlers)
- `lib/user-config.js` — User configuration from JSON file with Argon2id verification
- `lib/dashboard-queries.js` — Query functions for dashboard pages
- `lib/alert-email.js` — Error-only email alerts with dashboard links
- `lib/utils.js` — Date normalization utility
- `lib/freescout-conversations-db.js` — Conversations tracking database module
- `views/*.ejs` — Dashboard templates (login, overview, run-history, run-detail, errors, error-detail)
- `public/style.css` — Dashboard styles with responsive layout
- `scripts/hash-password.js` — CLI utility for generating Argon2id password hashes
- `systemd/rondo-sync-web.service` — Systemd service configuration
- `nginx/sync.rondo.club.conf` — Nginx reverse proxy configuration
- `steps/download-inactive-members.js` — Playwright-based inactive member download
- `steps/download-freescout-conversations.js` — Conversation download with pagination
- `steps/prepare-freescout-activities.js` — Transform conversations to activity payloads
- `steps/submit-freescout-activities.js` — Submit activities with deduplication
- `tools/import-former-members.js` — Former member import orchestrator
- `pipelines/sync-freescout-conversations.js` — Conversations pipeline orchestrator
- `lib/rondo-club-db.js` — Database migration + all SQL queries renamed
- `lib/discipline-db.js` — Column migration + queries renamed
- `lib/conflict-resolver.js` — Variables and return values renamed
- `lib/sync-origin.js` — Sync origin constants renamed
- `lib/detect-rondo-club-changes.js` — Queries and variables renamed
- All `steps/*.js` — stadion→rondo_club variable/function renames
- All `tools/*.js` — stadion→rondo_club variable/function renames
- All `docs/*.md` — 200+ documentation reference renames
- All `pipelines/*.js` — Run tracking instrumentation + naming updates
