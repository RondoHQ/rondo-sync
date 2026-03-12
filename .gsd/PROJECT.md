# Rondo Sync

## What This Is

A sync system with web dashboard that synchronizes member data bidirectionally between Sportlink Club (a Dutch sports club management system) and multiple destinations: Laposta email marketing lists and Rondo Club (a WordPress-based member management app). It downloads member data via browser automation, transforms it according to field mappings, syncs changes to both destinations including photos and team assignments, enables corrections in Rondo Club to flow back to Sportlink via browser automation, runs automatically on scheduled intervals, and provides a web dashboard for monitoring sync status, browsing run history, and investigating errors with per-user authentication and error-only email alerts.

## Core Value

Keep downstream systems (Laposta, Rondo Club) automatically in sync with Sportlink member data without manual intervention — now bidirectionally, with web-based monitoring.

## Current State (v3.3 Shipped)

**Shipped:** 2026-02-12

Everything from v3.2 plus deep FreeScout integration:
- Sportlink RelationEnd (lid-tot) date syncs to FreeScout "Lid tot" custom field (ID 9) with multi-format date normalization
- Member photos from Rondo Club display as FreeScout customer avatars via WordPress REST API ?_embed
- FreeScout conversations download with incremental sync, pagination, and per-customer error handling
- Conversations transform to Rondo Club email activities with HTML content and FreeScout deep links
- Complete conversations pipeline (download → prepare → submit) with RunTracker, defensive deduplication, and CLI/sync-all integration
- Separate SQLite database (freescout-conversations.sqlite) for conversation tracking

<details>
<summary>Previous: v3.2 Stadion-to-Rondo Rename (2026-02-11)</summary>

Everything from v3.1 plus complete stadion-to-rondo_club rename:
- All database tables use `rondo_club_*` naming (8 tables migrated via CREATE+INSERT+DROP)
- All column names use `rondo_club_id`, `*_rondo_club_modified` convention
- All code references (80+ SQL functions, variables, function names) use rondo_club naming
- All documentation (internal docs, developer docs site, CLAUDE.md) updated

</details>

<details>
<summary>Previous: v3.1 Fetch Former Members (2026-02-09)</summary>

Everything from v3.0 plus a one-time former member import tool:
- One-time import tool fetches inactive members from Sportlink and syncs to Rondo Club as former members with photos
- 3-strategy fallback status filter toggle for Sportlink UI resilience
- Cached download results for resume-after-failure workflow

</details>

<details>
<summary>Previous: v3.0 Web Dashboard (2026-02-09)</summary>

Full bidirectional sync pipeline operational with web monitoring dashboard:
- All SQLite databases use WAL mode with busy_timeout for concurrent cron + web server access
- Dashboard database (dashboard.sqlite) stores structured run data
- RunTracker class instruments all 7 pipelines with safety-wrapped methods
- Fastify web server at https://sync.rondo.club with Argon2id auth, SQLite sessions, nginx/TLS, systemd
- Pipeline overview, run history, run detail, error browser
- Error-only email alerts with 4-hour cooldown
- Server-rendered HTML (EJS templates), responsive layout, no build step

</details>

## Requirements

### Validated

- ✓ Download member data from Sportlink via browser automation with OTP — existing
- ✓ Transform Sportlink fields to Laposta format via configurable mapping — existing
- ✓ Sync members to up to 4 Laposta lists — existing
- ✓ Track sync state in SQLite to only submit changed members — existing
- ✓ Support parent/child member associations — existing
- ✓ Deduplicate parent entries across lists — existing
- ✓ Inspect pending changes before sync — existing
- ✓ Cronjob setup for scheduled automated sync — v1.0
- ✓ Reduced/formatted output suitable for email reports — v1.0
- ✓ Send sync reports via Postmark transactional email — v1.1
- ✓ Sync creates/updates person in Rondo Club via WordPress REST API — v1.3
- ✓ Match members by KNVB ID first, email fallback — v1.3
- ✓ Sync parents as separate person records with bidirectional linking — v1.3
- ✓ Download and sync photos from Sportlink to Rondo Club — v1.4
- ✓ Extract and sync teams with work history — v1.5
- ✓ MemberHeader API capture for financial block and photo optimization — v1.7
- ✓ Bidirectional sync with last-write-wins conflict resolution — v2.0
- ✓ Reverse sync pushes corrections from Rondo Club to Sportlink — v2.0
- ✓ Nikki contributions sync with CSV download and per-year ACF fields — v2.1
- ✓ Discipline cases download and sync with season-based organization — v2.2
- ✓ Birthdate syncs as ACF field on person (simplified from important_date posts) — v2.3
- ✓ All SQLite databases use WAL mode with busy_timeout for concurrent access — v3.0
- ✓ Dashboard database with structured run tracking schema — v3.0
- ✓ RunTracker instruments all pipelines with per-step counts and error recording — v3.0
- ✓ Fastify web server with Argon2id auth, SQLite sessions, nginx/TLS, systemd — v3.0
- ✓ Dashboard with pipeline overview, run history, run detail, error browser — v3.0
- ✓ Overdue pipeline detection with configurable thresholds — v3.0
- ✓ Error-only email alerts with dashboard links replace always-send reports — v3.0
- ✓ Responsive server-rendered HTML dashboard (EJS, no build step) — v3.0
- ✓ Search Sportlink for INACTIVE members via browser automation — v3.1
- ✓ Download former member data (name, contact, address, photo, KNVB ID) — v3.1
- ✓ Sync former members to Rondo Club with `acf.former_member = true` — v3.1
- ✓ One-time onboarding tool (not a scheduled pipeline) — v3.1
- ✓ All stadion_* tables renamed to rondo_club_* with safe live migration — v3.2
- ✓ All stadion_id columns renamed to rondo_club_id — v3.2
- ✓ All code references (SQL, variables, functions) updated to rondo_club naming — v3.2
- ✓ All documentation updated to rondo_club naming — v3.2
- ✓ FreeScout email conversations visible as activities on Rondo Club person records — v3.3
- ✓ Member photos from Rondo Club sync to FreeScout as customer avatars — v3.3
- ✓ Sportlink RelationEnd syncs to FreeScout "Lid tot" custom field (ID 9) — v3.3

### Active

(None — next milestone requirements TBD)

### Out of Scope

- Real-time sync — scheduled batch sync is appropriate for member data
- Slack/Discord notifications — Email alerts are sufficient for 3-10 users
- Delete sync — Members removed from Sportlink stay in downstream systems
- Three-way merge — Last-edit-wins is simpler and predictable
- Bidirectional photo sync — Photos only flow Sportlink → Rondo Club
- Full bidirectional sync — Only specific fields sync back; Sportlink remains primary source
- Real-time auto-refresh (<60s) — Pipelines run 4x/day max; 60-second polling sufficient
- Full log streaming via WebSocket — Over-engineered for internal tool
- Member data CRUD — That is WordPress/Sportlink's job
- Pipeline configuration UI — Too dangerous; SSH for config changes
- React/SPA frontend — Massive overhead for read-only dashboard
- Docker/containerization — Single-server deployment; adds complexity for no benefit
- TypeScript migration — Would split codebase; project is pure JavaScript

## Context

**Codebase:**
- ~25,100 lines of JavaScript + shell
- Node.js 22 with Playwright for browser automation
- SQLite for state tracking (7 databases: Laposta, Rondo Club, FreeScout Customers, FreeScout Conversations, Nikki, Discipline, Dashboard)
- Fastify v5 web server with EJS templates
- Shell scripts for cron automation

**Tech stack:** Node.js 22, Playwright/Chromium, SQLite (WAL mode), Fastify, EJS, Bash, Postmark, WordPress REST API, nginx, systemd, Argon2id

**Server:** Single server at 46.202.155.16, web dashboard at https://sync.rondo.club

**Known issues:**
- INFRA-04 partial: web server runs as root (no sportlink user on server)
- MULTI-02 deferred: multi-club architecture for when second club onboards

## Constraints

- **Runtime**: Node.js 22 with Playwright browser automation
- **Dependencies**: Requires Chromium for Sportlink scraping
- **Network**: Needs access to club.sportlink.com, api.laposta.nl, api.postmarkapp.com, and Rondo Club WordPress site
- **Credentials**: Sportlink username/password/OTP secret, Laposta API key, Postmark API key, Rondo Club application password, SESSION_SECRET in `.env`
- **Deployment**: Single server, no containerization

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Browser automation for Sportlink | No API available, must scrape web interface | ✓ Good |
| SQLite for state tracking | Simple, no external database needed, portable | ✓ Good |
| Hash-based change detection | Avoids timestamp issues, reliable diff detection | ✓ Good |
| Module/CLI hybrid pattern | Scripts work standalone and as imports | ✓ Good |
| KNVB ID as primary match key | Stable identifier from Sportlink (relatiecode) | ✓ Good |
| Parents as separate persons | Enables proper relationship modeling | ✓ Good |
| MemberHeader API capture | Already fetched during scraping, zero overhead | ✓ Good |
| Per-field timestamp tracking | Enables field-level conflict detection | ✓ Good |
| Playwright for reverse sync | Sportlink lacks API for member updates | ✓ Good |
| Birthdate as ACF field | Eliminates complex important_date lifecycle | ✓ Good |
| WAL mode + busy_timeout | Enables concurrent cron + web server database access | ✓ Good |
| RunTracker safety wrapping | Tracking failures never crash pipelines | ✓ Good |
| Fastify + EJS (no SPA) | Server-rendered HTML, no build step, minimal overhead | ✓ Good |
| Argon2id password hashing | OWASP recommended, memory-hard | ✓ Good |
| SQLite session store | Persistence across restarts, no memory leak | ✓ Good |
| Error-only email alerts | Dashboard is source of truth, emails only for action needed | ✓ Good |
| Periodic overdue checks in web server | 30-min interval with 4-hour cooldown prevents spam | ✓ Good |
| Systemd service runs as root | No sportlink user on server; accepted for now | ⚠️ Revisit |
| 3-strategy status filter toggle | Resilient to Sportlink UI changes (ID → text → role fallback) | ✓ Good |
| Dry-run-by-default import tool | Safe-by-default; --import flag required to execute | ✓ Good |
| Cached download results | Resume-after-failure without re-downloading from Sportlink | ✓ Good |
| Photo steps in import tool | Atomic operation; photo failures don't block member sync | ✓ Good |
| CREATE+INSERT+DROP for table migration | Avoids ALTER TABLE RENAME bugs seen in dashboard-db migration | ✓ Good |
| Migration in openDb() after pragmas | WAL mode set before migration, migration before initDb | ✓ Good |
| ALTER TABLE RENAME COLUMN for discipline | Safe for single-process weekly pipeline (unlike concurrent rondo-club-db) | ✓ Good |
| rondoClub camelCase / rondo_club_id snake_case | JavaScript conventions for code, SQL conventions for DB columns | ✓ Good |
| Separate SQLite DB for conversations | Different concern from customer sync; independent lifecycle | ✓ Good |
| Incremental sync via createdSince | Only fetch new conversations; full re-sync with --force flag | ✓ Good |
| Defensive deduplication before POST | Two-layer defense: SQLite tracking + pre-POST check | ✓ Good |
| Conversations as Step 7b in sync-all | Non-critical; follows discipline pattern for graceful failures | ✓ Good |
| Date normalization utility | Multi-format date handling (YYYYMMDD, YYYY-MM-DD, ISO 8601) | ✓ Good |

---
*Last updated: 2026-02-12 after v3.3 milestone*
