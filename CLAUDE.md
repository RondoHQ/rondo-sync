# Rondo Sync

CLI tool that synchronizes member data from Sportlink Club to Laposta email marketing lists, Rondo Club WordPress, FreeScout, and more.

## Quick Reference

```bash
scripts/sync.sh people           # 4x daily: members, parents, photos
scripts/sync.sh nikki            # Daily: Nikki contributions to Rondo Club
scripts/sync.sh sponsit          # Read-only: Sponsit contacts to local mirror
scripts/sync.sh freescout        # Daily: FreeScout customer sync
scripts/sync.sh teams            # Weekly: team sync + work history
scripts/sync.sh functions        # 4x daily: commissies + free fields (recent updates)
scripts/sync.sh functions --all  # Weekly: full commissies sync (all members)
scripts/sync.sh discipline       # Weekly: discipline cases
scripts/sync.sh all              # Full sync (all pipelines)
npm run install-cron             # Set up automated sync schedules
```

## Documentation

Detailed documentation lives in the **Rondo Developer docs site** (`~/Code/rondo/developer/`), under the `src/content/docs/sync/` section. Update docs there, not in this repo's `docs/` directory.

Run the dev server: `cd ~/Code/rondo/developer && npm run dev` → http://localhost:4321/sync/architecture/

## CRITICAL: Never Run Sync Locally

**Sync scripts must only run on the production server.** Running locally causes duplicate entries because each machine has its own SQLite database with different `rondo_club_id` mappings.

```bash
ssh root@46.202.155.16
cd /home/rondo
scripts/sync.sh people    # or any other pipeline
```

Deploy code: `git push` then `ssh root@46.202.155.16 "cd /home/rondo && git pull"`

## Claude specific instructions
Prefer Read over `cat`, Grep over `grep/rg` in Bash, and Glob over `find` in Bash. Use Bash only for: running tests, executing build commands, git operations, and multi-step shell scripts. 

## Remote Server

IP: `46.202.155.16`, path: `/home/rondo/`
Login with the user's SSH key.

## Environment Variables

Required in `.env`:

```bash
SPORTLINK_USERNAME=          # Sportlink Club login
SPORTLINK_PASSWORD=          # Sportlink Club password
SPORTLINK_OTP_SECRET=        # TOTP secret for 2FA (base32)
LAPOSTA_API_KEY=             # Laposta API key
LAPOSTA_LIST=                # Primary Laposta list ID
LAPOSTA_LIST2=               # Optional additional lists (up to 4)
RONDO_URL=                   # WordPress site URL (https://...)
RONDO_USERNAME=              # WordPress username
RONDO_APP_PASSWORD=          # WordPress application password
RONDO_PERSON_TYPE=person     # Custom post type
OPERATOR_EMAIL=              # Receives sync reports
LETTERMINT_API_TOKEN=        # Lettermint API token
LETTERMINT_FROM_EMAIL=       # Verified sender email
FREESCOUT_API_KEY=           # FreeScout API key (optional)
FREESCOUT_URL=               # FreeScout URL (optional)
NIKKI_API_KEY=               # Nikki API key (optional)
NIKKI_URL=                   # Nikki URL (optional)
SPONSIT_URL=                 # Sponsit account URL
SPONSIT_USERNAME=            # Sponsit login email
SPONSIT_PASSWORD=            # Sponsit password
SPONSIT_OTP_SECRET=          # Base32 TOTP secret for unattended 2FA
LAPOSTA_SPONSIT_LIST=        # Dedicated Laposta list for active Sponsit contacts
SYNC_API_KEY=                # API key for programmatic sync endpoints (used by Rondo Club)
HEALTHCHECK_PEOPLE_URL=      # Optional: healthchecks.io ping URL for People sync dead-man's switch
                             # (add HEALTHCHECK_<PIPELINE>_URL per pipeline as needed)
RONDO_SYNC_HTTP_DEADLINE_MS= # Optional: hard total-time deadline per HTTP request (default 45000ms).
                             # Applies to every call through lib/http-client.js (Rondo Club + FreeScout).
```

## Sponsit sync

`npm run sync-sponsit` refreshes the local encrypted-transport/0600 SQLite mirror only. Use `npm run preview-sponsit-rondo` and `npm run preview-sponsit-laposta` before their corresponding `sync-*` apply commands.

Sponsorship is an independent Rondo role: existing Sportlink people remain `person_type=member` and receive `is_sponsor=true`; new external sponsors are created as `person_type=contact`. Matching prefers stable Sponsit IDs and otherwise requires a unique email plus matching identity. Shared emails are quarantined.

The dedicated Laposta list must expose `voornaam`, `achternaam`, `businessclub`, `bedrijfsnaam`, `sponsorvariant`, `sponsitcontactid`, `sponsitpersoonid`, and `islid`. Never remove the opt-out protections: upserts use `suppress_reactivation`, cleaned/unsubscribed relations are skipped, and automatic unsubscription is limited to active relations carrying a Sponsit source ID.

## Directory Layout

```
pipelines/     Pipeline orchestrators (entry points called by sync.sh)
steps/         Pipeline step scripts (download-*, prepare-*, submit-*, upload-*)
tools/         Inspection + maintenance scripts (show-*, cleanup-*, validate-*)
lib/           Shared libraries (DB layers, API clients, utilities)
config/        Configuration files (field-mapping.json, sportlink-fields.json)
scripts/       Shell scripts (sync.sh, install-cron.sh) + send-email.js
docs/          Documentation
```

## Code Patterns

### Module/CLI Hybrid

All scripts export functions AND work as CLI:

```javascript
async function runDownload(options) { /* ... */ }
module.exports = { runDownload };
if (require.main === module) { runDownload({ verbose: true }); }
```

### Logging

```javascript
const { createSyncLogger } = require('../lib/logger');
const logger = createSyncLogger({ verbose });
logger.log('Always shown');
logger.verbose('Only in verbose mode');
logger.error('Error messages');
```

### Error Handling

- Graceful failures with detailed logging
- Each pipeline step is non-critical (failures don't stop the pipeline)
- Exit codes: **`0` = success, `2` = partial (non-fatal per-item errors, e.g. one photo
  failed to download), `1` = fatal (download/prepare aborted, or the top-level catch).**
  The CLI derives partial-vs-fatal from the pipeline result: a non-`success` result with
  no `error` field is partial (`2`); one carrying `error` is fatal (`1`).
- **`sync.sh` treats `2` like `0` for the Healthchecks.io dead-man switch** — a partial run
  pings the success URL so the check stays green; only a fatal `1` pings `/fail`. This is
  deliberate: before 2026-07-01 a single photo-download failure made a whole people run exit
  `1`, which pinged `/fail` (Healthchecks "down") **and** sent a failure email even though
  members/parents/Laposta/Rondo Club all synced fine. Partial runs still send the operator
  alert email (any non-zero exit) and record `outcome='partial'` in the dashboard, so
  per-item errors stay visible — they just no longer trip the dead-man. If you add a new
  pipeline, mirror the `process.exitCode = result.error ? 1 : 2` pattern or it will
  false-alarm Healthchecks on every partial.

## Rondo Club API Gotchas

**Required fields on ACF updates:** When updating a person via PUT, `first_name` and `last_name` are always required, even for single-field updates. Partial ACF updates require a GET first.

**Relationship type term IDs:** The `relationship_type` taxonomy in WordPress has these term IDs (verified in production):
- `2` = Parent (the related person is a parent of this person)
- `3` = Child (the related person is a child of this person)
- `4` = Sibling

These are defined as `RELATIONSHIP_TYPE` constants in `steps/submit-rondo-club-sync.js`. Do NOT use hardcoded integers. Rondo Club's `class-inverse-relationships.php` automatically creates bidirectional and sibling relations server-side when valid type IDs are used.

**Rondo Club API docs** are in the developer docs site at `~/Code/rondo/developer/src/content/docs/api/`.

**HTTP client has a hard total-time deadline — don't bypass it.** Every call to Rondo Club + FreeScout goes through `lib/http-client.js:makeRequest`, which enforces both a socket-idle `timeout` AND a total-time `deadline` (default 45s, configurable via `RONDO_SYNC_HTTP_DEADLINE_MS` or per-call). The deadline exists because on 2026-05-28 a single PUT through Cloudflare hung for 20+ minutes — the socket-idle handler never fired because the connection was technically active, and SIGTERM couldn't kill the process because Node was awaiting a Promise that never settled. If you write a new client or add a raw `https.request`/`fetch`/`axios` somewhere, give it the same deadline-with-single-settle pattern or you'll reintroduce the hang. Deadline rejections look like `Error: Request deadline exceeded: <apiName> did not complete within <N> seconds` with `code: 'ERR_REQUEST_DEADLINE'` — per-member catches treat them as normal errors and the pipeline continues.

## Sportlink Patterns

### Always use `SportlinkSession` for browser work — never call `chromium.launch + loginToSportlink` directly

`lib/sportlink-session.js` owns Playwright launch + login. It transparently:
- Reuses an in-process page across multiple step calls (pass `sharedPage` option).
- Loads a disk-cached `storageState` (`data/sportlink-storage-state.json`) so cron-launched processes skip the 30–60s OTP login dance.
- Coordinates concurrent refreshes via an O_EXCL lockfile so two cron ticks don't both burn a TOTP code.
- Exposes `session.relogin()` for the mid-run reauth path; uses the same lock so the new state is persisted for siblings.

Bypassing it (raw `chromium.launch + loginToSportlink`) re-introduces the per-process login burn AND the TOTP-collision class of bug that shows up as `Login failed: Could not find dashboard element` when multiple syncs overlap. Every existing step file uses it (`steps/download-*-from-sportlink.js`, `pipelines/sync-individual.js`, `pipelines/sync-former-members.js`, `steps/submit-rondo-club-player-history.js`). Stay consistent.

### Stale-session self-heal — pass the `session` (not just the `page`) to `runDownload`

A *partially*-valid cached session is the nastiest Sportlink failure mode: the cookies load `/` and `/dashboard` fine, so `SportlinkSession._tryReuse` (which only probes the root URL) accepts them — but navigating to `/member/search` silently 30x-redirects back to `/dashboard`, where the member download waits 20s for a `#btnShowMore` that isn't there and dies. `steps/download-data-from-sportlink.js` detects this (`page.url()` not on `/member/search` after navigation) and recovers via `invalidateCachedSession()` + `session.relogin()`. **For that recovery to fire on the pipeline path, the caller must pass `session: sportlinkSession` alongside `page:` — `runDownload` keys the self-heal off having a session handle.** `pipelines/sync-people.js` and `pipelines/sync-all.js` do this; a new pipeline that passes only `page:` silently loses the self-heal and will fail the 06:00 (first-of-day) run whenever the cached session goes stale overnight (diagnosed 2026-06-08).

`session.relogin()` calls `this._context.clearCookies()` **before** `_login()`. This is load-bearing: `loginToSportlink` navigates to `/`, and with the stale cookies still present Sportlink stays "authenticated" and redirects to `/dashboard`, so the `#username` login form never renders (45s `waitForSelector` timeout). `invalidateCachedSession()` only deletes the on-disk `storageState` — it does NOT touch the live browser context. Don't remove the `clearCookies()` call.

### `#btnShowMore` can load `disabled` — wait for enabled state, don't just click

The advanced-search toggle (`#btnShowMore`) on `/member/search` opens the panel holding the union-teams checkbox + search field. It renders **visible but `disabled`** (`data-test-disabled="true"`) for 30s+ when Sportlink's member-search component initialises slowly. Waiting only for visibility (`waitForSelector('#btnShowMore')`) then `click()` makes Playwright burn its 30s actionability timeout on "element is not enabled" and aborts the whole download (0 members). Rare (seen 2026-04-24, 2026-06-09) but fatal to the run. `steps/download-data-from-sportlink.js:openAdvancedSearch` gates on `#btnShowMore:not([disabled])` (matches only once enabled) and reload-retries up to 3× — a fresh page load clears the stuck state. Both the initial open and per-term recovery (`setupSearchPage`) go through it; keep new call sites on that helper rather than re-adding a bare `click('#btnShowMore')`.

### `/navajo/entity/common/clubweb/*` endpoints reject direct `page.request.get()` calls with 401

The Sportlink SPA's data endpoints require an in-page auth header that Playwright's `page.request.get(...)` doesn't carry. Direct fetches always return 401, even from a fully-logged-in browser context.

The working pattern (used by every Sportlink fetch in the repo): trigger the SPA to make the request itself — navigate to the matching member-details URL, optionally interact with UI to drive parameters (e.g. click the "Show inactive" toggle), and intercept the response with `page.waitForResponse(url => url.includes('/navajo/.../EndpointName'))`. See `fetchMemberTeamMemberships`, `fetchMemberFunctions` in `steps/download-functions-from-sportlink.js` for canonical examples. **Don't try to call the endpoints directly** — you'll just waste a TOTP code chasing a 401 that has no auth-side fix.

### Player-history quarantine — manual skip list for Sportlink-broken members

Sportlink's `/member/member-details/{knvb_id}/memberships` SPA hangs forever for some members' data (verified against the Sportlink UI, not our code). Without intervention every player-history run wastes a 45s navigation timeout + a chained 45s relogin timeout on the affected member, every run, forever.

Currently quarantined on prod:
- **PKWR41Q** (Nic Stenssen, rondo_club_id=437) — Sportlink endpoint hangs; reported upstream 2026-05-29.

Manage via `tools/player-history-quarantine.js`. **Always run as the `rondo` user on prod** so the SQLite write is owned correctly:

```bash
# List currently quarantined
ssh root@46.202.155.16 'cd /home/rondo && sudo -u rondo node tools/player-history-quarantine.js list'

# Add a quarantine (reason is required and stored verbatim — be specific)
ssh root@46.202.155.16 'cd /home/rondo && sudo -u rondo node tools/player-history-quarantine.js add <KNVB_ID> "<reason>"'

# Lift the quarantine — do this once Sportlink confirms the fix
ssh root@46.202.155.16 'cd /home/rondo && sudo -u rondo node tools/player-history-quarantine.js remove PKWR41Q'
```

The data lives in the `player_history_skip_reason` column on `rondo_club_members`. `--force` on the pipeline does NOT lift quarantine — that's an explicit human action only.

After lifting: the next player-history run will fully re-fetch the member (their `last_player_history_team_signature` is still NULL) and backfill the missing work-history rows.

### `upsertMembers(db, members)` reads `member.data` (object), NOT `member.data_json` (string)

The function takes the prepared ACF blob as an OBJECT in the `data` field and computes `data_json` + `source_hash` internally. Passing `data_json: JSON.stringify(prepared.data)` silently leaves `member.data` undefined, so it defaults to `{}` and the row gets written with literal `"{}"` as data_json. The change detector then sees Rondo Club's real ACF differ from the empty stored mirror and re-flags every field as a "change" every cycle — the reverse-sync loop we kept hitting.

Caller shape:
```js
upsertMembers(db, [{
  knvb_id: '...',
  email: prepared.email,
  data: prepared.data,                  // ← object, not the string version
  person_image_date: prepared.person_image_date
}]);
```

**Diagnosing "the sync re-syncs hundreds of members and runs for an hour" — rollover vs. a real churn loop.** Before assuming a hash bug, check the *eligible-pending* count right after a run completes: rows where the hash mismatches AND the row is actually syncable (`data_json != '{}'` — the vast majority of `rondo_club_members` rows are `'{}'` former-member sentinels that never sync, so an unfiltered mismatch count is meaningless and will look huge).

```bash
ssh root@46.202.155.16 'cd /home/rondo && sudo -u rondo node -e "
  const { openDb } = require(\"./lib/rondo-club-db\");
  const db = openDb();
  const c = db.prepare(\"SELECT COUNT(*) c FROM rondo_club_members WHERE (last_synced_hash IS NULL OR last_synced_hash != source_hash) AND data_json != char(123)||char(125)\").get().c;
  console.log(\"eligible pending:\", c); db.close();"'
```

If eligible-pending is **0** after the run, the detector converged — the large batch was legitimate (e.g. the **July 1 season rollover**: memberships expire/renew, team assignments + age categories move club-wide, so hundreds of members genuinely change at once; a single day of admin edits also spikes it). A real churn loop would still be non-zero and would NOT settle on the next run — the giveaway is a spike that clears to 0 changes on subsequent runs (as the 2026-06-29 15:00 spike did across all of 06-30). Long duration on those days is throughput, not a bug: the forward sync does a sequential GET-then-PUT per member through Cloudflare (~8s each), so ~750 members ≈ ~100 min. Only chase a volatile-field hash bug if eligible-pending stays non-zero across consecutive runs with no real Sportlink change.

## Documentation Maintenance

After functional changes, update:
- `README.md` - User-facing docs
- `CLAUDE.md` - This file (AI assistant context)
- Relevant docs in `~/Code/rondo/developer/src/content/docs/sync/` (the developer docs site)

## Tech Stack

Node.js 18+, Playwright (Chromium), better-sqlite3, otplib (TOTP), lettermint, dotenv (env loading).
