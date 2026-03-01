# People Pipeline

Syncs member data from Sportlink Club to Laposta email marketing lists and Rondo Club WordPress, including photos.

## Schedule

Runs **4x daily** at 8:00, 11:00, 14:00, and 17:00 (Amsterdam time).

```bash
scripts/sync.sh people          # Production (with locking + email report)
node pipelines/sync-people.js --verbose   # Direct execution (verbose)
```

## Pipeline Flow

```
pipelines/sync-people.js
├── Step 1: steps/download-data-from-sportlink.js    → data/laposta-sync.sqlite, data/rondo-sync.sqlite
├── Step 2: steps/prepare-laposta-members.js         → data/laposta-sync.sqlite (members table)
├── Step 3: steps/submit-laposta-list.js             → Laposta API
├── Step 4: steps/submit-rondo-club-sync.js       → Rondo Club WordPress API (members + parents + birthdate)
├── Step 5: steps/sync-laposta-deliverability-tasks.js → Rondo Club todo API (unsubscribe/bounce follow-up)
├── Step 6: steps/download-photos-from-api.js     → photos/ directory
├── Step 7: steps/upload-photos-to-rondo-club.js  → Rondo Club WordPress API (media)
└── Step 8: lib/reverse-sync-sportlink.js         → Sportlink Club (currently disabled)
```

## Step-by-Step Details

### Step 1: Download from Sportlink

**Script:** `steps/download-data-from-sportlink.js`
**Function:** `runDownload({ logger, verbose })`

1. Launches headless Chromium via Playwright
2. Logs into `https://club.sportlink.com/` using `lib/sportlink-login.js`
3. Handles TOTP 2FA with `lib/totp.js`
4. Calls Sportlink `SearchMembers` API to get all members
5. Calls `MemberHeader` API for each member (photo URLs, financial block status)
6. Stores raw JSON results in `data/laposta-sync.sqlite` → `sportlink_runs` table
7. Upserts member data into `data/rondo-sync.sqlite` → `rondo_club_members` table

**Output:** `{ success, memberCount }`

**Databases written:**
- `data/laposta-sync.sqlite`: `sportlink_runs` (full JSON dump)
- `data/rondo-sync.sqlite`: `rondo_club_members` (per-member data with `source_hash`)

### Step 2: Prepare Laposta Members

**Script:** `steps/prepare-laposta-members.js`
**Function:** `runPrepare({ logger, verbose })`

1. Reads latest Sportlink results from `data/laposta-sync.sqlite` → `sportlink_runs`
2. Applies field mappings from `config/field-mapping.json` to transform Sportlink fields to Laposta custom fields
3. Handles parent extraction: creates separate list entries for `EmailAddressParent1` / `EmailAddressParent2`
4. Deduplicates parent entries across lists
5. Computes `source_hash` for each member (SHA-256 of email + custom fields)
6. Upserts into `data/laposta-sync.sqlite` → `members` table

**Output:** `{ success, lists: [{ total }], excluded }`

**Key transformations** (configured in `config/field-mapping.json`):
- `GenderCode`: "Male" → "M", "Female" → "V"
- `UnionTeams`: comma-separated team list
- Parent entries: creates person entries with `oudervan` (child names) field

### Step 3: Submit to Laposta

**Script:** `steps/submit-laposta-list.js`
**Function:** `runSubmit({ logger, verbose, force })`

1. Reads members from `data/laposta-sync.sqlite` where `source_hash != last_synced_hash`
2. For each changed member, calls Laposta API:
   - **New member** (no existing Laposta record): `POST /api/v2/member`
   - **Updated member**: `POST /api/v2/member` with update
3. Updates `last_synced_hash` on success
4. Rate limited: 2s delay between API calls

**Output:** `{ lists: [{ index, listId, total, synced, added, updated, errors }] }`

**CLI flags:**
- `--force`: Sync all members regardless of hash (ignores change detection)

### Step 4: Sync to Rondo Club

**Script:** `steps/submit-rondo-club-sync.js`
**Function:** `runSync({ logger, verbose, force })`

1. Reads members from `data/rondo-sync.sqlite` where `source_hash != last_synced_hash`
2. Reads free fields from `sportlink_member_free_fields` table (FreeScout ID, VOG date, financial block)
3. Builds WordPress API payload with ACF fields (see field mappings below)
4. For each changed member:
   - **No `rondo_club_id`**: `POST /wp/v2/people` (create new person)
   - **Has `rondo_club_id`**: `PUT /wp/v2/people/{rondo_club_id}` (update existing)
5. Stores returned WordPress post ID as `rondo_club_id`
6. Updates `last_synced_hash` on success
7. Then processes **parent members** (from `rondo_club_parents` table):
   - Identified by email (no KNVB ID)
   - Linked to children via ACF `relationships` field
   - Deduplicated across multiple children's parent fields

**Output:** `{ total, synced, created, updated, skipped, errors, parents: { ... } }`

**Important:** `first_name` and `last_name` are required on every PUT request, even for partial ACF updates.

**Birthday field:** As of v2.3, birthdate is synced as `acf.birthdate` (YYYY-MM-DD) on the person record during Step 4. Previous versions used a separate `important_date` post type which is now deprecated.

### Step 5: Laposta Deliverability Follow-up Tasks

**Script:** `steps/sync-laposta-deliverability-tasks.js`  
**Function:** `runSyncLapostaDeliverabilityTasks({ logger, verbose })`

1. Fetches Laposta members in state `unsubscribed` and `cleaned` (hard bounce) for each configured list.
2. Upserts events into `data/laposta-sync.sqlite` → `member_deliverability_events`.
3. Matches events to existing members by email via `data/rondo-sync.sqlite` → `rondo_club_members`.
4. Creates todo tasks on matched person records via `POST /wp-json/rondo/v1/people/{id}/todos`.
5. Marks processed events with the created todo ID to avoid duplicate tasks on later runs.
6. If configured, reassigns created tasks to a specific WordPress user (`LAPOSTA_TASK_ASSIGNEE_USER_ID`), otherwise tasks remain owned by the authenticated sync user.

**Output:** `{ scanned, pending, matched, created, unresolved, errors }`

### Step 6: Photo Download

**Script:** `steps/download-photos-from-api.js`
**Function:** `runPhotoDownload({ logger, verbose })`

1. Queries `rondo_club_members` for members with `photo_state = 'pending_download'`
2. If none pending, returns early (no browser launched)
3. Launches headless Chromium via Playwright
4. Logs into Sportlink Club
5. For each pending member: navigates to `/member/member-details/{knvbId}/other`, captures `MemberHeader` API response
6. Extracts signed photo URL via `parseMemberHeaderResponse()` from `lib/photo-utils.js`
7. Downloads photo from CDN URL via `downloadPhotoFromUrl()` from `lib/photo-utils.js`
8. Saves to `photos/{knvb_id}.{ext}`
9. Updates `photo_state` to `'downloaded'`
10. Rate limited: 500ms-1.5s random jitter between members

**Output:** `{ success, total, downloaded, failed, errors }`

### Step 7: Photo Upload

**Script:** `steps/upload-photos-to-rondo-club.js`
**Function:** `runPhotoSync({ logger, verbose })`

1. Queries `rondo_club_members` for `photo_state = 'downloaded'` or `'pending_upload'`
2. Uploads each photo to `POST /wp-json/rondo/v1/people/{rondo_club_id}/photo` (multipart form-data)
3. Updates `photo_state` to `'synced'` on success
4. Also handles photo **deletion**: members with `photo_state = 'pending_delete'` get their Rondo Club photo removed
5. Rate limited: 2s between uploads/deletes

**Output:** `{ upload: { synced, skipped, errors }, delete: { deleted, errors } }`

### Step 8: Reverse Sync (Currently Disabled)

**Script:** `lib/reverse-sync-sportlink.js`
**Function:** `runReverseSync({ logger, verbose })`

Detects field changes made in Rondo Club and pushes them back to Sportlink via browser automation. Currently disabled pending fixes.

## Field Mappings

### Sportlink → Laposta

See `config/field-mapping.json` for the complete mapping. Key fields:

| Laposta Field | Sportlink Source |
|---|---|
| *(email)* | `Email` |
| `voornaam` | `FirstName` |
| `tussenvoegsel` | `Infix` |
| `achternaam` | `LastName` |
| `geboortedatum` | `DateOfBirth` |
| `team` | `UnionTeams` |
| `geslacht` | `GenderCode` (Male→M, Female→V) |
| `relatiecode` | `PublicPersonId` (KNVB ID) |

### Sportlink → Rondo Club Members

| Rondo Club ACF Field | Source |
|---|---|
| `first_name` | `FirstName` |
| `infix` | `Infix` (lowercased tussenvoegsel) |
| `last_name` | `LastName` |
| `knvb-id` | `PublicPersonId` |
| `gender` | `GenderCode` (Male→male, Female→female) |
| `birth_year` | Year from `DateOfBirth` |
| `birthdate` | `DateOfBirth` (YYYY-MM-DD format, v2.3+) |
| `contact_info` (repeater) | `Email`, `Mobile`, `Telephone` |
| `addresses` (repeater) | `StreetName` + `AddressNumber`, `ZipCode`, `City` |
| `lid-sinds` | `MemberSince` |
| `leeftijdsgroep` | `AgeClassDescription` |
| `type-lid` | `TypeOfMemberDescription` |
| `meta.team` | `UnionTeams` (fallback: `ClubTeams`) |
| `freescout-id` | From `sportlink_member_free_fields.freescout_id` |
| `datum-vog` | From `sportlink_member_free_fields.vog_datum` |
| `financiele-blokkade` | From `sportlink_member_free_fields.has_financial_block` |

## Database Tables Used

| Database | Table | Usage |
|---|---|---|
| `laposta-sync.sqlite` | `sportlink_runs` | Raw download results |
| `laposta-sync.sqlite` | `members` | Prepared Laposta members with hashes |
| `laposta-sync.sqlite` | `laposta_fields` | Cached field definitions |
| `laposta-sync.sqlite` | `member_deliverability_events` | Unsubscribe/bounce events + created todo linkage |
| `rondo-sync.sqlite` | `rondo_club_members` | Member → WordPress ID mapping + hashes |
| `rondo-sync.sqlite` | `rondo_club_parents` | Parent → WordPress ID mapping |
| `rondo-sync.sqlite` | `sportlink_member_free_fields` | Free fields (read by Step 4) |
| `rondo-sync.sqlite` | `sportlink_member_functions` | Secretaris function lookup for task assignment |

## CLI Flags

| Flag | Effect |
|------|--------|
| `--verbose` | Detailed per-member logging |
| `--force` | Skip change detection, sync all members |

## Error Handling

- Each step runs in a try/catch; failures are logged but don't stop the pipeline
- Rondo Club sync failure is non-critical (Laposta sync still completes)
- Photo download/upload failures are non-critical
- All errors are collected and included in the email summary report
- Exit code 1 if any errors occurred

## Source Files

| File | Purpose |
|------|---------|
| `pipelines/sync-people.js` | Pipeline orchestrator |
| `steps/download-data-from-sportlink.js` | Sportlink browser automation |
| `steps/prepare-laposta-members.js` | Field transformation for Laposta |
| `steps/submit-laposta-list.js` | Laposta API sync |
| `steps/submit-rondo-club-sync.js` | Rondo Club WordPress API sync (members + parents + birthdate) |
| `steps/sync-laposta-deliverability-tasks.js` | Laposta unsubscribe/bounce follow-up task creation |
| `steps/prepare-rondo-club-members.js` | Rondo Club member data preparation |
| `steps/prepare-rondo-club-parents.js` | Parent extraction and dedup |
| `steps/download-photos-from-api.js` | Photo download (Playwright) |
| `steps/upload-photos-to-rondo-club.js` | Photo upload/delete |
| `lib/photo-utils.js` | Shared photo helpers (MIME types, download, MemberHeader parsing) |
| `config/field-mapping.json` | Laposta field mapping config |
| `lib/laposta-db.js` | Laposta SQLite operations |
| `lib/rondo-club-db.js` | Rondo Club SQLite operations |
| `lib/rondo-club-client.js` | Rondo Club HTTP client |
| `lib/laposta-client.js` | Laposta HTTP client |
| `lib/sportlink-login.js` | Sportlink authentication |
