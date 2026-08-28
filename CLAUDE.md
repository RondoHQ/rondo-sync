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

Sponsit records with `type=company` become organization sponsors; records with `type=person` become personal sponsors linked to one Rondo person. Existing Sportlink people retain their own `person_type`; new external people are created through the sponsor-contact endpoint so a standalone sponsor contact cannot be left behind. Matching prefers stable relation IDs and otherwise uses email plus identity. An uncertain match blocks only that sponsor's relationship write and never removes an existing relation.

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

## Run Tracking + Self-Heal Watchdog

### Adding a pipeline means touching three places, not one

A new pipeline needs `new RunTracker('<name>')`, a `sync.sh` case, **and** an entry in
`ALL_PIPELINES` + `rerun_args_for()` in `scripts/heal-sync.sh`. Miss the third and the
pipeline runs completely unwatched — that is how `reverse`, `discipline`, `freescout`,
`freescout-conversations` and `sponsit` ended up outside the watchdog while it reported
"all healthy" on the three it did know about (found 2026-07-23).

**The dashboard name is not always the sync.sh argument.** `freescout-conversations`
records under that name but is invoked as `sync.sh conversations`; `functions-full` is
`sync.sh functions --all --with-invoice`. `rerun_args_for()` is the only mapping — do not
assume the strings match, or the heal will re-run the wrong thing (or nothing).

```bash
scripts/heal-sync.sh --all      # sweep every known pipeline (what the hourly routine runs)
scripts/heal-sync.sh --list     # print known pipelines
scripts/heal-sync.sh people     # single pipeline
```

### Staleness: outcome-checking cannot see a pipeline that stopped running

Checking the latest run's *outcome* is blind to a pipeline that never runs at all — no run
means no row, and "no row" looks exactly like a healthy idle pipeline. That is how `nikki`
sat dead for eight weeks (2026-05-29 → 2026-07-23) with a live crontab entry and zero
alerts: a **root-owned `.sync-nikki.lock`** made `sync.sh` die at `exec 200>"$LOCKFILE"`
with "Permission denied" *before* `RunTracker` opened, so there was never anything to fail.

**If a pipeline goes silent, check lockfile ownership first:** `ls -la /home/rondo/.sync-*.lock`.
Every lock must be `rondo:rondo`. One `sync.sh <pipeline>` run as root (instead of
`sudo -u rondo`) permanently wedges that pipeline's cron.

`heal-sync.sh` now compares each pipeline's newest `started_at` against a per-pipeline
`stale_after_hours_for()` budget (longest crontab gap, roughly doubled) and prints a
`STALE` line plus a single summary line:

```
heal[nikki]: STALE — newest run started 55d ago, expected one within 30h
heal: STALE PIPELINES (2): nikki(55d) teams(12d)
```

Staleness **never triggers a heal** — a pipeline that has not run has not failed, and
re-running it could be wrong (deliberately disabled, host maintenance). It reports; a human
decides. Exit codes are unchanged so the hourly routine's parsing keeps working.

Keep `stale_after_hours_for()` in sync with crontab — a cadence change there without a
change here yields either false alarms or a blind spot.

### Retention is tiered — a flat age cutoff cannot serve both ends of the cadence range

`lib/run-tracker.js` `_cleanup()` (called on every `startRun`) keeps a run if **any** of:
it is newer than `RETENTION_RECENT_DAYS` (3); it is a `failure`/`partial` newer than
`RETENTION_FAILURE_DAYS` (90); or it is among the newest `RETENTION_KEEP_PER_PIPELINE` (25)
for its own pipeline. `running` rows are never swept here — `_markStaleRunning()` owns those.

The per-pipeline floor is load-bearing, for two reasons:
1. **Sparse pipelines stay watchable.** Under the old flat 3-day sweep the weekly
   `functions-full` row was deleted ~4 days before its next run, so `heal-sync.sh` read
   "no runs recorded yet" most of the week and its effective heal window was 3 days, not 7.
2. **It prevents a stale-failure re-heal.** Keeping failures for 90 days while sweeping
   successes at 3 would let an old failure become the *latest* row once the newer success
   aged out — and the watchdog would re-heal an episode that already recovered. The floor
   guarantees the newer success outlives the older failure. `test/run-tracker-retention.test.js`
   pins this case specifically.

Note `lib/dashboard-db.js` resolves `data/dashboard.sqlite` from `process.cwd()` **once at
require time** — that is why the retention test chdirs before its requires and shares one
temp DB across cases.

## Rondo Club API Gotchas

**Required fields on native field updates:** When updating a person via PUT, `first_name` and `last_name` are always required, even for single-field updates. Partial native field updates require a GET first.

**Source-owned empty values must be sent explicitly.** Omitting a canonical field from a PUT preserves its existing Rondo Club value. For Sportlink-owned fields that can legitimately become empty, include `null` in the prepared payload. In particular, `preparePerson()` must always include `spelactiviteit`: an active member with an empty `KernelGameActivities` value has stopped playing, so both the People and individual sync must clear the previous activity.

**Individual sync completion uses the hash returned by `upsertMembers()`.** `preparePerson()` returns a payload, not a source hash. After upserting the prepared member, use the returned tracking row's `source_hash` for conflict resolution and `updateSyncState()`. Passing `prepared.source_hash` writes `NULL` as the completed hash and makes the next People run process the same member again.

**Reverse-sync pending rows must be refreshed before browser writes.** A user can save an intermediate contact layout and correct it before the five-minute reverse-sync run. `runReverseSyncMultiPage()` re-reads each pending Rondo person and marks queued values that no longer match the current canonical field as `superseded_at`; only rows with both `synced_at IS NULL` and `superseded_at IS NULL` may reach Sportlink. Never mark obsolete rows as synced: that corrupts the audit trail and makes `hasRecentSyncedNoOp()` suppress a future legitimate value.

**Reverse-sync change detection retries transient Rondo Club reads.** `fetchModifiedMembers()` must use `rondoClubRequestWithRetry()`, which retries 5xx responses, socket timeouts, hard request deadlines, DNS lookup failures, and connection resets with bounded 1s/2s/4s backoff. Permanent 4xx errors fail immediately. This keeps a short production API stall from failing the five-minute reverse-sync run without hiding authentication or validation failures.

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

`SportlinkSession.getPage()` must also close its browser when initial context creation or login throws. Most callers only enter their own `try/finally` after `getPage()` resolves. Without the cleanup inside `getPage()`, a failed OTP login leaves Chromium and Node alive indefinitely, so `sync.sh` keeps the pipeline flock forever even though the run tracker and summary already say the run finished. The dashboard launch endpoint waits briefly for `sync.sh` to exit so lock contention and other immediate failures are shown instead of a false “Started”.

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

The function takes the prepared native field blob as an OBJECT in the `data` field and computes `data_json` + `source_hash` internally. Passing `data_json: JSON.stringify(prepared.data)` silently leaves `member.data` undefined, so it defaults to `{}` and the row gets written with literal `"{}"` as data_json. The change detector then sees Rondo Club's real native field differ from the empty stored mirror and re-flags every field as a "change" every cycle — the reverse-sync loop we kept hitting.

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

**Team work-history indexes are hints, not identities.** The `work_history` native field repeater is shared by team, player-history, and commissie syncs, so another pipeline can insert rows and shift every later array index. Team cleanup must verify `rondo_club_work_history_id` against the expected Rondo team ID and fall back to finding the current row by team ID. Player-history must reconcile a newly ended Sportlink relation with an existing current row; an append-only merge recreates the stale-role bug by adding an ended duplicate while leaving the old row current. Disappearance-only team changes also need explicit set comparison because they create no new source row/hash mismatch.

**Run player-history immediately after team work-history.** Sportlink's fast team-roster response contains the member, team, and role but not `RelationStart` or `RelationEnd`. The member-details memberships response contains those dates. Both the `teams` and `all` pipelines must therefore run `submit-rondo-club-player-history.js` directly after the quick work-history step. Signature skipping keeps this detail pass limited to changed team memberships; the monthly standalone run remains a safety net.

## Documentation Maintenance

After functional changes, update:
- `README.md` - User-facing docs
- `CLAUDE.md` - This file (AI assistant context)
- Relevant docs in `~/Code/rondo/developer/src/content/docs/sync/` (the developer docs site)

## Tech Stack

Node.js 18+, Playwright (Chromium), better-sqlite3, otplib (TOTP), lettermint, dotenv (env loading).
