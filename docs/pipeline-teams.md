# Teams Pipeline

Downloads team rosters from Sportlink, creates team posts in Rondo Club WordPress, and links members to teams via work history.

## Schedule

Runs **weekly** on Sunday at 6:00 AM (Amsterdam time).

```bash
scripts/sync.sh teams           # Production (with locking + email report)
node pipelines/sync-teams.js --verbose    # Direct execution (verbose)
```

## Pipeline Flow

```
pipelines/sync-teams.js
├── Step 1: steps/download-teams-from-sportlink.js   → data/rondo-sync.sqlite
├── Step 2: steps/submit-rondo-club-teams.js            → Rondo Club WordPress API (teams)
└── Step 3: steps/submit-rondo-club-work-history.js     → Rondo Club WordPress API (person work_history)
```

## Step-by-Step Details

### Step 1: Download Teams from Sportlink

**Script:** `steps/download-teams-from-sportlink.js`
**Function:** `runTeamDownload({ logger, verbose })`

1. Launches headless Chromium via Playwright
2. Logs into Sportlink Club
3. Calls Sportlink API to fetch team data:
   - `UnionTeams` (KNVB-assigned teams, preferred source)
   - `ClubTeams` (club-assigned teams, fallback)
4. For each team, fetches the team roster:
   - Players with their roles (Speler, Keeper, etc.)
   - Staff members with their roles (Trainer, Leider, etc.)
5. Stores team metadata in `data/rondo-sync.sqlite` → `rondo_club_teams`:
   - `team_name`, `sportlink_id`, `game_activity`, `gender`, `player_count`, `staff_count`
6. Stores team membership in `data/rondo-sync.sqlite` → `sportlink_team_members`:
   - `sportlink_team_id`, `sportlink_person_id`, `role_description`

**Output:** `{ success, teamCount, memberCount }`

**Rate limiting:** 500ms-1.5s random jitter between member scrapes.

### Step 2: Sync Teams to Rondo Club

**Script:** `steps/submit-rondo-club-teams.js`
**Function:** `runSync({ logger, verbose, force, currentSportlinkIds })`

1. Reads all teams from `data/rondo-sync.sqlite` → `rondo_club_teams`
2. For each team where `source_hash != last_synced_hash`:
   - **No `rondo_club_id`**: `POST /wp/v2/teams` (create new team)
   - **Has `rondo_club_id`**: `PUT /wp/v2/teams/{rondo_club_id}` (update existing)
3. Stores returned WordPress post ID as `rondo_club_id`
4. Updates `last_synced_hash` on success
5. Detects **orphan teams** (teams in Rondo Club DB but not in current Sportlink download) and optionally removes them

**Output:** `{ total, synced, created, updated, skipped, deleted, errors }`

**Team renames:** Uses `sportlink_id` as the conflict key, so renamed teams update the existing WordPress post instead of creating duplicates.

### Step 3: Sync Work History

**Script:** `steps/submit-rondo-club-work-history.js`
**Function:** `runSync({ logger, verbose, force })`

1. Reads team membership from `sportlink_team_members` joined with `rondo_club_teams` and `rondo_club_members`
2. Compares current team assignments against `rondo_club_work_history` table
3. For each member with changes:
   - Fetches current `work_history` native field repeater from Rondo Club
   - Adds new team assignments (creates new rows in the repeater)
   - Ends removed assignments (sets `is_current: false`, `end_date: today`)
   - Only modifies sync-created entries (manual entries are preserved)
4. Sends `PUT /wp/v2/people/{rondo_club_id}` with updated `work_history` repeater
5. Skips members without a `rondo_club_id`

**Output:** `{ total, synced, created, ended, skipped, errors }`

**Important:** The work history sync only touches entries it previously created (tracked via `rondo_club_work_history` table). Manually added work history entries in Rondo Club are left untouched.

## Field Mappings

### Sportlink → Rondo Club Teams

| Rondo Club Field | Sportlink Source | Notes |
|---|---|---|
| `title` | `TeamName` / `Name` | Post title |
| `fields.publicteamid` | `PublicTeamId` | Sportlink team identifier |
| `fields.activiteit` | `GameActivityDescription` | "Veld" or "Zaal" |
| `fields.gender` | `Gender` | Mannen→male, Vrouwen→female, Gemengd→skipped |

### Sportlink → Rondo Club Work History

The native field `work_history` is a repeater field on person posts:

| Repeater Field | Source | Notes |
|---|---|---|
| `team` | `rondo_club_teams.rondo_club_id` | WordPress post ID of the team |
| `job_title` | `role_description` or fallback | "Speler", "Keeper", "Trainer", "Staflid" |
| `is_current` | Computed | `true` if currently on team |
| `start_date` | Computed | Today for new assignments, empty for backfill |
| `end_date` | Computed | Empty if current, today when removed |

## Database Tables Used

| Database | Table | Usage |
|---|---|---|
| `rondo-sync.sqlite` | `rondo_club_teams` | Team → WordPress ID mapping + metadata |
| `rondo-sync.sqlite` | `sportlink_team_members` | Raw team roster data from Sportlink |
| `rondo-sync.sqlite` | `rondo_club_work_history` | Tracks which work_history entries sync created |
| `rondo-sync.sqlite` | `rondo_club_members` | KNVB ID → Rondo Club ID lookup (for work history) |

## CLI Flags

| Flag | Effect |
|------|--------|
| `--verbose` | Detailed per-team/per-member logging |
| `--force` | Skip change detection, sync all teams and work history |

## Error Handling

- Team download failure doesn't prevent team sync (uses cached data)
- Individual team sync failures don't stop the pipeline
- Work history sync skips members not yet in Rondo Club (counted as `skipped`)
- All errors collected in summary report

## Source Files

| File | Purpose |
|------|---------|
| `pipelines/sync-teams.js` | Pipeline orchestrator |
| `steps/download-teams-from-sportlink.js` | Sportlink team scraping (Playwright) |
| `steps/submit-rondo-club-teams.js` | Rondo Club team API sync |
| `steps/submit-rondo-club-work-history.js` | Rondo Club work history API sync |
| `steps/prepare-rondo-club-teams.js` | Team data preparation |
| `lib/rondo-club-db.js` | SQLite operations |
| `lib/rondo-club-client.js` | Rondo Club HTTP client |
| `lib/sportlink-login.js` | Sportlink authentication |
