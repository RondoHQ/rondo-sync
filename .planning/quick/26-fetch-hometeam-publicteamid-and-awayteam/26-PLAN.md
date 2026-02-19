---
phase: 26-fetch-hometeam-publicteamid-and-awayteam
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - lib/discipline-db.js
  - steps/download-discipline-cases.js
  - steps/submit-rondo-club-discipline.js
  - ../rondo-club/acf-json/group_discipline_case_fields.json
autonomous: true
must_haves:
  truths:
    - "HomeTeam.PublicTeamId and AwayTeam.PublicTeamId are captured from the Sportlink DisciplineClubCasesPlayer API response"
    - "Both team IDs are stored in the discipline-sync.sqlite database"
    - "When syncing to Rondo Club, PublicTeamIds are resolved to WordPress team post IDs via rondo_club_teams table"
    - "Rondo Club discipline cases have home_team and away_team ACF fields (post_object type referencing team CPT)"
  artifacts:
    - path: "lib/discipline-db.js"
      provides: "home_team_id and away_team_id columns in discipline_cases table"
      contains: "home_team_id"
    - path: "steps/download-discipline-cases.js"
      provides: "Extraction of HomeTeam.PublicTeamId and AwayTeam.PublicTeamId from API response"
      contains: "HomeTeam"
    - path: "steps/submit-rondo-club-discipline.js"
      provides: "Mapping of PublicTeamId to rondo_club_id and sending as home_team/away_team ACF fields"
      contains: "home_team"
    - path: "../rondo-club/acf-json/group_discipline_case_fields.json"
      provides: "home_team and away_team ACF post_object fields"
      contains: "home_team"
  key_links:
    - from: "steps/download-discipline-cases.js"
      to: "lib/discipline-db.js"
      via: "upsertCases mapping HomeTeam.PublicTeamId to home_team_id column"
      pattern: "HomeTeam.*PublicTeamId"
    - from: "steps/submit-rondo-club-discipline.js"
      to: "lib/rondo-club-db.js"
      via: "getTeamBySportlinkId to resolve PublicTeamId to rondo_club_id"
      pattern: "getTeamBySportlinkId"
---

<objective>
Capture HomeTeam.PublicTeamId and AwayTeam.PublicTeamId from the Sportlink DisciplineClubCasesPlayer API response, store them in the local discipline database, and sync them as linked team references (post_object ACF fields) to Rondo Club discipline cases.

Purpose: Links discipline cases to the specific home and away teams involved in the match, enabling team-level discipline reporting and navigation in Rondo Club.
Output: Updated discipline pipeline that captures and syncs team IDs end-to-end.
</objective>

<execution_context>
@/Users/joostdevalk/.claude/get-shit-done/workflows/execute-plan.md
@/Users/joostdevalk/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
Key files to understand before implementing:

@lib/discipline-db.js — Database schema and upsert logic for discipline cases. Has computeCaseHash, upsertCases, getCasesNeedingSync. Columns need extending with home_team_id and away_team_id.

@steps/download-discipline-cases.js — Playwright-based download that intercepts the DisciplineClubCasesPlayer API response. Currently extracts: DossierId, PublicPersonId, MatchDate, MatchDescription, TeamName, ChargeCodes, ChargeDescription, SanctionDescription, ProcessingDate, AdministrativeFee, IsCharged. Needs to also extract HomeTeam.PublicTeamId and AwayTeam.PublicTeamId (nested objects in the API response).

@steps/submit-rondo-club-discipline.js — Syncs discipline cases to Rondo Club via REST API. Builds ACF payload, resolves person IDs. Needs to resolve team PublicTeamIds to rondo_club_id via getTeamBySportlinkId (already exists in lib/rondo-club-db.js).

@lib/rondo-club-db.js — Has getTeamBySportlinkId(db, sportlinkId) which returns { team_name, sportlink_id, rondo_club_id, ... } from rondo_club_teams table. Use this to map PublicTeamId -> WordPress team post ID.

@../rondo-club/acf-json/group_discipline_case_fields.json — ACF field group for discipline cases. Needs two new post_object fields (home_team, away_team) referencing the "team" post type.
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add home/away team columns to discipline DB and capture from Sportlink API</name>
  <files>
    lib/discipline-db.js
    steps/download-discipline-cases.js
  </files>
  <action>
In lib/discipline-db.js:

1. Add `home_team_id` and `away_team_id` columns to the discipline_cases table. Use the existing migration pattern (check PRAGMA table_info, ALTER TABLE ADD COLUMN if missing). These store the Sportlink PublicTeamId strings (TEXT), NOT WordPress post IDs.

2. Update `computeCaseHash` to include `home_team_id` and `away_team_id` in the hash payload so changes to team assignments trigger re-sync:
   ```js
   home_team_id: caseData.HomeTeamPublicTeamId,
   away_team_id: caseData.AwayTeamPublicTeamId
   ```

3. Update `upsertCases` to map and store the new fields. The Sportlink API returns nested objects: `HomeTeam: { PublicTeamId: "..." }` and `AwayTeam: { PublicTeamId: "..." }`. Map these in the rows array:
   ```js
   home_team_id: c.HomeTeam?.PublicTeamId ?? null,
   away_team_id: c.AwayTeam?.PublicTeamId ?? null
   ```
   Add both to the INSERT statement's column list, VALUES, and ON CONFLICT UPDATE SET clause.

4. Update ALL SELECT queries that return case data (getAllCases, getCasesByPersonId, getCasesNeedingSync, getCaseByDossierId) to include `home_team_id` and `away_team_id` in their SELECT column lists.

In steps/download-discipline-cases.js:

No changes needed here — the download step already passes the raw API response objects to `upsertCases`, which will now extract HomeTeam.PublicTeamId and AwayTeam.PublicTeamId via the updated mapping in discipline-db.js.
  </action>
  <verify>
Run `node -e "const db = require('./lib/discipline-db'); const d = db.openDb(); const cols = d.prepare('PRAGMA table_info(discipline_cases)').all(); console.log(cols.map(c => c.name)); d.close();"` from the rondo-sync directory — output should include home_team_id and away_team_id.
  </verify>
  <done>
discipline_cases table has home_team_id and away_team_id TEXT columns. computeCaseHash includes both fields. upsertCases maps HomeTeam.PublicTeamId and AwayTeam.PublicTeamId from the Sportlink API response. All SELECT queries return the new columns.
  </done>
</task>

<task type="auto">
  <name>Task 2: Resolve team IDs and sync home_team/away_team to Rondo Club</name>
  <files>
    steps/submit-rondo-club-discipline.js
    ../rondo-club/acf-json/group_discipline_case_fields.json
  </files>
  <action>
In ../rondo-club/acf-json/group_discipline_case_fields.json:

Add two new ACF fields after the existing `team_name` field (after the field with key `field_discipline_team_name`):

1. `home_team` — post_object field:
   ```json
   {
     "key": "field_discipline_home_team",
     "label": "Thuisteam",
     "name": "home_team",
     "type": "post_object",
     "instructions": "Thuisteam van de wedstrijd (automatisch gekoppeld via Sportlink)",
     "required": 0,
     "post_type": ["team"],
     "multiple": 0,
     "return_format": "id",
     "allow_null": 1,
     "wrapper": { "width": "50", "class": "", "id": "" }
   }
   ```

2. `away_team` — post_object field:
   ```json
   {
     "key": "field_discipline_away_team",
     "label": "Uitteam",
     "name": "away_team",
     "type": "post_object",
     "instructions": "Uitteam van de wedstrijd (automatisch gekoppeld via Sportlink)",
     "required": 0,
     "post_type": ["team"],
     "multiple": 0,
     "return_format": "id",
     "allow_null": 1,
     "wrapper": { "width": "50", "class": "", "id": "" }
   }
   ```

In steps/submit-rondo-club-discipline.js:

1. Import `getTeamBySportlinkId` from `../lib/rondo-club-db`:
   ```js
   const { openDb: openRondoClubDb, getTeamBySportlinkId } = require('../lib/rondo-club-db');
   ```

2. In the `runSync` function, after opening the discipline database and before the for loop, open the rondo-club database for team lookups:
   ```js
   const rondoClubDb = openRondoClubDb();
   ```
   Close it after the for loop (before `db.close()`):
   ```js
   rondoClubDb.close();
   ```

3. Inside the for loop, after the person lookup, resolve home and away team IDs:
   ```js
   // Resolve home team
   let homeTeamRondoClubId = null;
   if (caseData.home_team_id) {
     const homeTeam = getTeamBySportlinkId(rondoClubDb, caseData.home_team_id);
     if (homeTeam?.rondo_club_id) {
       homeTeamRondoClubId = homeTeam.rondo_club_id;
     } else {
       logVerbose(`  Home team ${caseData.home_team_id} not found in Rondo Club`);
     }
   }

   // Resolve away team
   let awayTeamRondoClubId = null;
   if (caseData.away_team_id) {
     const awayTeam = getTeamBySportlinkId(rondoClubDb, caseData.away_team_id);
     if (awayTeam?.rondo_club_id) {
       awayTeamRondoClubId = awayTeam.rondo_club_id;
     } else {
       logVerbose(`  Away team ${caseData.away_team_id} not found in Rondo Club`);
     }
   }
   ```

4. Pass the resolved IDs into the `syncCase` call. Update the `syncCase` function signature to accept `homeTeamRondoClubId` and `awayTeamRondoClubId` as additional parameters.

5. In the `syncCase` function, add the team fields to the `acfFields` object:
   ```js
   'home_team': homeTeamRondoClubId || '',
   'away_team': awayTeamRondoClubId || ''
   ```
   Use empty string (not null) when no team is found, matching the existing pattern for optional post_object fields.

Note: The `openRondoClubDb` is already imported at the top of the file (line 11). Just add `getTeamBySportlinkId` to the existing destructured import.
  </action>
  <verify>
1. Verify JSON validity: `node -e "JSON.parse(require('fs').readFileSync('../rondo-club/acf-json/group_discipline_case_fields.json', 'utf8')); console.log('Valid JSON');"` (run from rondo-sync dir)
2. Verify rondo-sync module loads: `node -e "require('./steps/submit-rondo-club-discipline'); console.log('Module loaded OK');"` (from rondo-sync dir)
3. Count ACF fields: `node -e "const f = JSON.parse(require('fs').readFileSync('../rondo-club/acf-json/group_discipline_case_fields.json', 'utf8')); console.log('Fields:', f.fields.length, f.fields.map(f => f.name));"` — should show 13 fields including home_team and away_team.
  </verify>
  <done>
Rondo Club ACF field group has home_team and away_team post_object fields referencing team CPT. Submit step resolves Sportlink PublicTeamId to WordPress team post IDs via getTeamBySportlinkId and includes them in the ACF payload. Teams not found in Rondo Club are gracefully skipped with verbose logging.
  </done>
</task>

</tasks>

<verification>
1. discipline-db.js: `node -e "const db = require('./lib/discipline-db'); const d = db.openDb(); const cols = d.prepare('PRAGMA table_info(discipline_cases)').all(); console.log(cols.map(c => c.name)); d.close();"` — includes home_team_id and away_team_id
2. ACF JSON: Valid JSON with 13 fields including home_team and away_team
3. Submit module: `node -e "require('./steps/submit-rondo-club-discipline'); console.log('OK');"` loads without error
4. End-to-end: After deploying both repos and running `scripts/sync.sh discipline --force` on the server, discipline cases in Rondo Club should have home_team and away_team ACF fields populated with team post IDs (where teams exist in the system)
</verification>

<success_criteria>
- discipline_cases SQLite table has home_team_id and away_team_id columns
- computeCaseHash includes both team IDs (changes trigger re-sync)
- upsertCases extracts HomeTeam.PublicTeamId and AwayTeam.PublicTeamId from nested API objects
- All SELECT queries return the new columns
- Rondo Club has home_team and away_team ACF fields on discipline_case post type
- Submit step resolves PublicTeamId to WordPress team post IDs using getTeamBySportlinkId
- Missing teams are gracefully handled (empty string sent, logged in verbose mode)
</success_criteria>

<output>
After completion, create `.planning/quick/26-fetch-hometeam-publicteamid-and-awayteam/26-SUMMARY.md`

IMPORTANT: This is a cross-repo change. After implementation:
1. Commit rondo-sync changes in rondo-sync repo
2. Commit rondo-club ACF JSON change in rondo-club repo
3. Deploy rondo-club first (ACF fields must exist before sync sends data)
4. Deploy rondo-sync second (`git pull` + restart if needed on 46.202.155.16)
5. Run `scripts/sync.sh discipline --force` on server to backfill existing cases with team data
</output>
