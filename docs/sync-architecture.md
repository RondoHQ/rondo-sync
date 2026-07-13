# Sync Architecture

Sportlink Club is the member administration system used by Dutch sports clubs, mandated by the KNVB (Royal Dutch Football Association). It is the single source of truth for member data, but it lacks APIs and has a limited, dated web interface. This tool extracts member data from Sportlink and syncs it to the systems where it's actually needed: Laposta for email marketing, Rondo Club (a WordPress site) for club management, and FreeScout for helpdesk support. It also pulls contribution data from Nikki, a separate financial system. The goal is to keep all downstream systems in sync with Sportlink automatically, so club volunteers never have to enter the same data twice.

This document describes what data flows from where to where, which fields are synced, on what schedule, and how change detection works.

## Table of Contents

- [System Overview](#system-overview)
  - [Why Browser Automation?](#why-browser-automation)
- [Schedules](#schedules)
- [API Load Management](#api-load-management)
- [Pipeline 1: People](#pipeline-1-people)
- [Pipeline 2: Nikki](#pipeline-2-nikki)
- [Pipeline 3: Teams](#pipeline-3-teams)
- [Pipeline 4: Functions (Commissies)](#pipeline-4-functions-commissies)
- [Pipeline 5: FreeScout](#pipeline-5-freescout)
- [Pipeline 6: Discipline](#pipeline-6-discipline)
- [Reverse Sync (Rondo Club to Sportlink)](#reverse-sync-rondo-club-to-sportlink)
- [Databases](#databases)
- [Locking](#locking)

## System Overview

```mermaid
graph LR
    SL[Sportlink Club]
    NK[Nikki]
    SYNC[Rondo Sync Tool<br>+ SQLite databases]
    ST[Rondo Club WordPress]
    LP[Laposta]
    FS[FreeScout]

    SL -->|Members, teams,<br>functions, discipline| SYNC
    NK -->|Contributions| SYNC
    SYNC -->|Members, custom fields| LP
    SYNC -->|Members, parents, teams,<br>commissies, work history,<br>photos| ST
    SYNC -->|Customers| FS
    ST -->|Field changes| SYNC
    SYNC -->|Reverse sync| SL
```

### Why Browser Automation?

Neither Sportlink Club nor Nikki provide APIs. All data is extracted by automating their web applications using **Playwright (headless Chromium)**. The sync tool logs in, navigates pages, and intercepts the internal requests (like `SearchMembers`, `MemberHeader`, `MemberFreeFields`, `UnionTeams`) that the web app makes to its own backend. Nikki is different — it has no internal requests to intercept, so contribution data is scraped from HTML tables and CSV exports. The reverse sync also uses browser automation to fill in Sportlink's web forms.

## Schedules

All times are **Europe/Amsterdam** timezone.

| Pipeline | Schedule | Cron | Notes |
|----------|----------|------|-------|
| People | 4x daily | `0 8,11,14,17 * * *` | Members, parents, photos |
| Nikki | Daily | `0 7 * * *` | Contributions to Rondo Club |
| Functions (recent) | 4x daily | `30 7,10,13,16 * * *` | 30 min before each people sync; members updated in last 2 days + VOG-filtered volunteers |
| Functions (full) | Weekly Sunday | `0 1 * * 0` | All members with `--all` |
| FreeScout | Daily | `0 8 * * *` | Rondo Club members to FreeScout customers |
| Teams | Weekly Sunday | `0 6 * * 0` | Team creation + work history |
| Sponsit | Weekly Sunday | `0 10 * * 0` | Sponsor contacts to Rondo Club and Laposta |
| Discipline | Weekly Monday | `30 23 * * 1` | Discipline cases |
| Reverse Sync | Hourly | `0 * * * *` | Rondo Club changes back to Sportlink (**currently disabled**) |

### Daily Timeline

```
 Every hour    Reverse sync (Rondo Club -> Sportlink) [currently disabled]
 07:00         Nikki sync
 07:30         Functions sync (recent) -> 08:00 People sync (1st) + FreeScout sync
 10:30         Functions sync (recent) -> 11:00 People sync (2nd)
 13:30         Functions sync (recent) -> 14:00 People sync (3rd)
 16:30         Functions sync (recent) -> 17:00 People sync (4th)
```

### Weekly

```
 Sunday  01:00  Functions sync (full --all)
 Sunday  06:00  Teams sync
 Sunday  10:00  Sponsit sync
 Monday  23:30  Discipline sync
```

## API Load Management

Every pipeline is designed to keep data as fresh as possible while minimizing API calls and avoiding overload on external services.

### Selective Sync via Hash-Based Change Detection

All pipelines use **hash-based change detection**. Each record gets a SHA-256 hash of its data (`source_hash`). On sync, the hash is compared to `last_synced_hash`. API calls only happen when hashes differ. This means:

- Local work (reading SQLite, computing hashes) runs every time -- this is cheap
- Expensive work (API calls to Laposta/Rondo Club/FreeScout) only runs for actual changes
- On a typical run with no changes, zero API calls are made

The Functions pipeline takes this further: the daily run only scrapes data for members updated in Sportlink within the last 2 days (plus VOG-filtered volunteers), avoiding the need to scrape all ~1000+ members every day.

### Rate Limiting and Delays

When API calls are needed, all pipelines insert delays between requests to avoid overwhelming external services:

| Target | Delay | Notes |
|--------|-------|-------|
| Laposta API | 2s between requests | Fixed delay via `waitForRateLimit()` |
| Rondo Club WordPress API | Exponential backoff on errors | 1s, 2s, 4s on retries |
| Rondo Club photo uploads | 2s between uploads | Both upload and delete operations |
| Nikki to Rondo Club | 500ms between updates | |
| Photo downloads (Sportlink) | 500ms-1.5s between members | Playwright-based, random jitter |
| FreeScout API | Exponential backoff on errors | 1s, 2s, 4s on 5xx errors |
| Sportlink browser scraping | 500ms-1.5s between members | Random jitter to avoid patterns |
| Reverse sync (Sportlink) | 1-2s between members | Random jitter, exponential backoff on errors |

---

## Pipeline 1: People

Runs 4x daily. Downloads member data from Sportlink, syncs to Laposta (email marketing), Rondo Club (WordPress), and handles photos.

```mermaid
graph TD
    SL[Sportlink Club<br>SearchMembers + MemberHeader]
    DB1[(laposta-sync.sqlite)]
    DB2[(rondo-sync.sqlite)]
    LP[Laposta API]
    ST[Rondo Club WordPress API]
    PH[Rondo Club Photo API]

    SL -->|steps/download-data-from-sportlink.js| DB1
    SL -->|steps/download-data-from-sportlink.js| DB2
    DB1 -->|steps/prepare-laposta-members.js| LP_PREP[Prepared Laposta members]
    LP_PREP -->|steps/submit-laposta-list.js| LP
    DB2 -->|steps/submit-rondo-club-sync.js| ST
    SL -->|steps/download-photos-from-api.js| DB2
    DB2 -->|photo_url| PHOTOS[photos/ directory]
    PHOTOS -->|steps/upload-photos-to-rondo-club.js| PH
```

### Sportlink to Laposta: Field Mapping

Source: Sportlink `SearchMembers` internal request. Destination: Laposta custom fields. Configured in `config/field-mapping.json`.

| Laposta Field | Sportlink Field | Notes |
|---|---|---|
| *(email)* | `Email` | Primary list email |
| `voornaam` | `FirstName` | |
| `tussenvoegsel` | `Infix` | Dutch name particle (van, de) |
| `achternaam` | `LastName` | |
| `geboortedatum` | `DateOfBirth` | YYYY-MM-DD |
| `team` | `UnionTeams` | Comma-separated |
| `geslacht` | `GenderCode` | Normalized: Male->M, Female->V |
| `leeftijdscategorie` | `AgeClassDescription` | |
| `relatiecode` | `PublicPersonId` | KNVB ID |
| `datumpasfoto` | `PersonImageDate` | |
| `lidsinds` | `MemberSince` | |
| `emailadres2` | `EmailAlternative` | |
| `mobielnummer` | `Mobile` | |
| `mobielnummer2` | `MobileAlternative` | |
| `telefoonnummer` | `Telephone` | |
| `telefoonnummer2` | `TelephoneAlternative` | |
| `straatnaam` | `StreetName` | |
| `huisnummer` | `AddressNumber` | |
| `huisnummertoevoeging` | `AddressNumberAppendix` | |
| `postcode` | `ZipCode` | |
| `plaats` | `City` | |
| `naamouder1` | `NameParent1` | |
| `naamouder2` | `NameParent2` | |
| `emailouder1` | `EmailAddressParent1` | Creates separate parent list entry |
| `emailouder2` | `EmailAddressParent2` | Creates separate parent list entry |
| `telefoonouder1` | `TelephoneParent1` | |
| `telefoonouder2` | `TelephoneParent2` | |
| `oudervan` | *(aggregated)* | Comma-separated child names for parent entries |

Parent emails create separate Laposta list entries (deduplicated across lists).

### Sportlink to Rondo Club Members: Field Mapping

Source: Sportlink `SearchMembers` internal request + free fields from SQLite. Destination: Rondo Club `wp/v2/people` ACF fields.

**Core person fields:**

| Rondo Club ACF Field | Source | Notes |
|---|---|---|
| `first_name` | `FirstName` | Required on every PUT |
| `infix` | `Infix` | Lowercased tussenvoegsel (optional, omitted when empty) |
| `last_name` | `LastName` | Required on every PUT |
| `knvb-id` | `PublicPersonId` | |
| `gender` | `GenderCode` | Normalized: Male->male, Female->female |
| `birth_year` | `DateOfBirth` | Year extracted |

**Contact info** (ACF repeater `contact_info`):

| Contact Type | Source |
|---|---|
| `email` | `Email` |
| `mobile` | `Mobile` |
| `phone` | `Telephone` |

**Address** (ACF repeater `addresses`):

| Address Field | Source |
|---|---|
| `street` | `StreetName` + `AddressNumber` + `AddressNumberAppendix` |
| `postal_code` | `ZipCode` |
| `city` | `City` |
| `country` | Hardcoded "Nederland" |

**Membership metadata:**

| Rondo Club ACF Field | Source |
|---|---|
| `lid-sinds` | `MemberSince` |
| `leeftijdsgroep` | `AgeClassDescription` |
| `type-lid` | `TypeOfMemberDescription` |
| `datum-foto` | `PersonImageDate` |

**Free fields** (from `sportlink_member_free_fields` table, populated by Functions pipeline):

| Rondo Club ACF Field | SQLite Column | Origin |
|---|---|---|
| `freescout-id` | `freescout_id` | Sportlink `Remarks3` |
| `datum-vog` | `vog_datum` | Sportlink `Remarks8` |
| `financiele-blokkade` | `has_financial_block` | Sportlink `MemberHeader` |

**Invoice data** (from `sportlink_member_invoice_data` table, optional `--with-invoice`):

| Rondo Club ACF Field | SQLite Column |
|---|---|
| `factuur-adres` | `invoice_street` + `invoice_house_number` + etc. |
| `factuur-email` | `invoice_email` |
| `factuur-referentie` | `invoice_external_code` |

### Sportlink to Rondo Club Parents

Parent entries are created as separate Rondo Club person posts from `NameParent1`/`NameParent2` fields. They are:
- Deduplicated by email address
- Linked to children via ACF `relationships` field (relationship_type 9 = child)
- Given aggregated contact info from all their children

### Sportlink to Rondo Club Birthdays

**v2.3+:** Birthdate syncs as ACF field on person record.

Source: `DateOfBirth`. Destination: `wp/v2/people` (person ACF field).

| Rondo Club Field | Value |
|---|---|
| `acf.birthdate` | `DateOfBirth` (YYYY-MM-DD) |

**Previous versions** (pre-v2.3): Used separate `wp/v2/important-dates` posts (now deprecated).

### Photo Sync

Photos flow in three steps across two pipelines:

1. **Detection** (People Step 1): Bulk download detects `PersonImageDate` changes, sets `photo_state = 'pending_download'`
2. **Download** (People Step 5): Playwright visits `/other` tab per member, captures `MemberHeader` for signed photo URL, downloads photo to `photos/{knvb_id}.{ext}`, sets `photo_state = 'downloaded'`
3. **Upload** (People Step 6): `POST /wp-json/rondo/v1/people/{rondo_club_id}/photo` (multipart form-data), sets `photo_state = 'synced'`

Photo states tracked in `rondo_club_members.photo_state`: `pending_download` -> `downloaded` -> `synced`. Removed photos go through `pending_delete` -> `no_photo`.

---

## Pipeline 2: Nikki

Runs daily at 7:00 AM. Downloads contribution data from Nikki and writes per-year financial fields to Rondo Club person posts.

```mermaid
graph LR
    NK[Nikki Web App<br>HTML table + CSV export]
    DB[(nikki-sync.sqlite)]
    ST[Rondo Club WordPress API<br>PUT /wp/v2/people]

    NK -->|steps/download-nikki-contributions.js<br>Playwright scraping| DB
    DB -->|steps/sync-nikki-to-rondo-club.js| ST
```

### Nikki to SQLite: Fields Extracted

A single person can have **multiple contribution lines per year** in Nikki (e.g. separate amounts for different family members or contribution types). Each line is stored as a separate row in SQLite, keyed by `(knvb_id, year, nikki_id)`.

| Source | Field | Type | Notes |
|---|---|---|---|
| HTML table | `knvb_id` | string | Member number column |
| HTML table | `year` | integer | Year column |
| HTML table | `nikki_id` | string | Nikki internal ID (unique per contribution line) |
| HTML table | `saldo` | number | Balance, parsed from European format (e.g. "EUR 1.234,56" -> 1234.56) |
| HTML table | `status` | string | Contribution status (e.g. "Betaald") |
| CSV export | `hoofdsom` | number | Total amount, parsed from European format |

### SQLite to Rondo Club: Field Mapping

When a person has multiple contribution lines for a year, `saldo` and `hoofdsom` are **summed** across all lines for that member+year combination.

For each contribution year, three ACF fields are written per person:

| Rondo Club ACF Field | Source | Example |
|---|---|---|
| `_nikki_{YEAR}_total` | `hoofdsom` | `_nikki_2025_total`: 1500.00 |
| `_nikki_{YEAR}_saldo` | `saldo` | `_nikki_2025_saldo`: 250.00 |
| `_nikki_{YEAR}_status` | `status` | `_nikki_2025_status`: "Betaald" |

Up to 4 years of history are retained. The PUT request always includes `first_name` and `last_name` (required by Rondo Club API).

---

## Pipeline 3: Teams

Runs weekly on Sunday at 6:00 AM. Downloads team rosters from Sportlink, creates team posts in Rondo Club, and links members to teams via work history.

```mermaid
graph TD
    SL[Sportlink Club<br>UnionTeams + ClubTeams]
    DB[(rondo-sync.sqlite)]
    ST_T[Rondo Club Teams API<br>wp/v2/teams]
    ST_P[Rondo Club People API<br>wp/v2/people<br>work_history field]

    SL -->|steps/download-teams-from-sportlink.js| DB
    DB -->|steps/submit-rondo-club-teams.js| ST_T
    DB -->|steps/submit-rondo-club-work-history.js| ST_P
```

### Sportlink to Rondo Club Teams: Field Mapping

Source: Sportlink `UnionTeams` / `ClubTeams` internal requests. Destination: `wp/v2/teams`.

| Rondo Club Field | Sportlink Field | Notes |
|---|---|---|
| `title` | `TeamName` / `Name` | Post title |
| `acf.publicteamid` | `PublicTeamId` | Sportlink team ID |
| `acf.activiteit` | `GameActivityDescription` | Activity type |
| `acf.gender` | `Gender` | Mapped: Mannen->male, Vrouwen->female, Gemengd->skipped |

Fields stored in SQLite but not sent to Rondo Club: `team_code`, `player_count`, `staff_count`.

### Sportlink to Rondo Club Work History: Field Mapping

Links members to their teams via the ACF `work_history` repeater on person posts.

| Rondo Club ACF Field | Source | Notes |
|---|---|---|
| `work_history[].team` | `rondo_club_teams.rondo_club_id` | WordPress post ID of the team |
| `work_history[].job_title` | `role_description` from `sportlink_team_members`, or fallback based on `KernelGameActivities` | "Speler" for players, "Staflid" for staff |
| `work_history[].is_current` | Computed | `true` if currently on team |
| `work_history[].start_date` | Computed | Today's date for new assignments, empty for backfill |
| `work_history[].end_date` | Computed | Empty if current, today's date when removed |

When a member is removed from a team, the entry is kept with `is_current: false` and `end_date` set to today.

---

## Pipeline 4: Functions (Commissies)

Runs 4x daily (recent updates, 30 min before each people sync) and weekly (full). Scrapes committee/function memberships and free fields from Sportlink via browser automation. Running before the people sync ensures fresh free fields (FreeScout ID, VOG, financial block) are available.

```mermaid
graph TD
    SL[Sportlink Browser<br>/member-details/.../functions<br>/member-details/.../other]
    DB[(rondo-sync.sqlite)]
    ST_C[Rondo Club Commissies API<br>wp/v2/commissies]
    ST_P[Rondo Club People API<br>wp/v2/people<br>work_history field]
    PP[People Pipeline<br>uses free fields]

    SL -->|steps/download-functions-from-sportlink.js<br>functions + committees| DB
    SL -->|steps/download-functions-from-sportlink.js<br>free fields from /other page| DB
    DB -->|steps/submit-rondo-club-commissies.js| ST_C
    DB -->|steps/submit-rondo-club-commissie-work-history.js| ST_P
    DB -.->|free fields used by<br>steps/prepare-rondo-club-members.js| PP
```

### Daily vs Full Mode

| Mode | Flag | Members Processed | Table Handling |
|---|---|---|---|
| Daily (recent) | *(default)* | Members with `LastUpdate` in last 2 days + VOG-filtered volunteers | Upsert only (preserves existing) |
| Weekly (full) | `--all` | All tracked members (~1069) | Clear + replace atomically |

### Sportlink to Rondo Club Commissies: Field Mapping

Source: browser scraping of `/functions` tab. Destination: `wp/v2/commissies`.

| Rondo Club Field | Source | Notes |
|---|---|---|
| `title` | `CommitteeName` | Post title |
| `status` | Hardcoded `publish` | |

A synthetic "Verenigingsbreed" commissie is created for club-level functions (not tied to a specific committee).

### Sportlink to Rondo Club Commissie Work History: Field Mapping

Links members to commissies via the ACF `work_history` repeater on person posts.

| Rondo Club ACF Field | Source | Notes |
|---|---|---|
| `work_history[].team` | `rondo_club_commissies.rondo_club_id` | WordPress post ID of the commissie |
| `work_history[].job_title` | `role_name` from `sportlink_member_committees`, or "Lid" as fallback | Role within committee |
| `work_history[].is_current` | `is_active` | Based on `RelationEnd` and `Status` |
| `work_history[].start_date` | `relation_start` | Normalized to YYYY-MM-DD |
| `work_history[].end_date` | `relation_end` | Empty if current |

### Free Fields (scraped during Functions pipeline, used by People pipeline)

Scraped from the member's `/other` page via two internal Sportlink requests:

| Internal Request | Sportlink Field | SQLite Column | Used By |
|---|---|---|---|
| `MemberFreeFields` | `Remarks3.Value` | `freescout_id` | People pipeline -> Rondo Club `freescout-id` |
| `MemberFreeFields` | `Remarks8.Value` | `vog_datum` | People pipeline -> Rondo Club `datum-vog` |
| `MemberHeader` | `HasFinancialTransferBlockOwnClub` | `has_financial_block` | People pipeline -> Rondo Club `financiele-blokkade` |
| `MemberHeader` | `Photo.Url` | `photo_url` | Stored but not used by Functions (photo download is in People Step 5) |
| `MemberHeader` | `Photo.PhotoDate` | `photo_date` | Stored but not used by Functions (photo detection is in People Step 1) |

---

## Pipeline 5: FreeScout

Runs daily at 8:00 AM. Reads member data from the local Rondo Club SQLite database and syncs to FreeScout as customers.

```mermaid
graph LR
    DB_S[(rondo-sync.sqlite<br>rondo_club_members +<br>rondo_club_work_history)]
    DB_N[(nikki-sync.sqlite<br>nikki_contributions)]
    DB_F[(freescout-sync.sqlite)]
    FS[FreeScout API]

    DB_S -->|steps/prepare-freescout-customers.js| DB_F
    DB_N -->|steps/prepare-freescout-customers.js| DB_F
    DB_F -->|steps/submit-freescout-sync.js| FS
```

### Rondo Club/Nikki to FreeScout: Field Mapping

**Standard customer fields** (sent to `POST/PUT /api/customers`):

| FreeScout Field | Source | Origin |
|---|---|---|
| `firstName` | `acf.first_name` | rondo_club_members |
| `lastName` | `acf.last_name` | rondo_club_members |
| `emails[].value` | `acf.contact_info` (type=email) | rondo_club_members |
| `phones[].value` | `acf.contact_info` (type=mobile) | rondo_club_members |

**Custom fields** (sent to `PUT /api/customers/{id}/customer_fields`):

| FreeScout Custom Field | Field ID | Source | Origin |
|---|---|---|---|
| `union_teams` | 1 | All `team_name` values, comma-separated | rondo_club_work_history |
| `public_person_id` | 4 | `knvb_id` | rondo_club_members |
| `member_since` | 5 | `acf['lid-sinds']` | rondo_club_members |
| `nikki_saldo` | 7 | Most recent year's `saldo` | nikki_contributions |
| `nikki_status` | 8 | Most recent year's `status` | nikki_contributions |

Field IDs are configurable via `FREESCOUT_FIELD_*` environment variables.

---

## Pipeline 6: Discipline

Runs weekly on Monday at 11:30 PM. Downloads discipline cases from Sportlink and syncs to Rondo Club.

```mermaid
graph LR
    SL[Sportlink Browser<br>Discipline cases]
    DB[(rondo-sync.sqlite)]
    ST[Rondo Club WordPress API]

    SL -->|steps/download-discipline-cases.js| DB
    DB -->|steps/submit-rondo-club-discipline.js| ST
```

Cases are linked to person posts in Rondo Club using `knvb_id` -> `rondo_club_id` mapping.

---

## Reverse Sync (Rondo Club to Sportlink)

> **Status: currently disabled.** Needs to be fixed and re-enabled.

Scheduled hourly. Detects field changes in Rondo Club and pushes them back to Sportlink via browser automation.

```mermaid
graph LR
    ST[Rondo Club WordPress]
    DET[Change Detection<br>rondo_club_change_detections table]
    SL[Sportlink Browser<br>Playwright automation]

    ST -->|Detect field changes| DET
    DET -->|pipelines/reverse-sync.js| SL
```

### Fields Synced Back

| Field | Direction |
|---|---|
| `email` | Rondo Club -> Sportlink |
| `email2` | Rondo Club -> Sportlink |
| `mobile` | Rondo Club -> Sportlink |
| `phone` | Rondo Club -> Sportlink |
| `datum-vog` | Rondo Club -> Sportlink |
| `freescout-id` | Rondo Club -> Sportlink |
| `financiele-blokkade` | Rondo Club -> Sportlink |

Conflict resolution: compares timestamps with 5-second tolerance. Newer timestamp wins; if equal, Sportlink wins by default.

---

## Databases

Four SQLite databases on the server track sync state:

| Database | Purpose | Key Tables |
|---|---|---|
| `laposta-sync.sqlite` | Laposta sync + Sportlink run data | `members`, `laposta_fields`, `sportlink_runs` |
| `rondo-sync.sqlite` | Rondo Club ID mappings + all Sportlink scraped data | `rondo_club_members`, `rondo_club_parents`, `rondo_club_teams`, `rondo_club_commissies`, `rondo_club_work_history`, `rondo_club_commissie_work_history`, `rondo_club_important_dates` (deprecated), `sportlink_member_functions`, `sportlink_member_committees`, `sportlink_member_free_fields`, `sportlink_member_invoice_data`, `sportlink_team_members` |
| `nikki-sync.sqlite` | Nikki contribution data | `nikki_contributions` |
| `freescout-sync.sqlite` | FreeScout customer mappings | `freescout_customers` |

The `rondo_club_id` mapping (knvb_id -> WordPress post ID) is critical: without it, syncs create duplicate entries instead of updating existing ones. All databases live on the production server only.

---

## Locking

Each sync type uses `flock` via `scripts/sync.sh` to prevent overlapping runs of the same type. Different sync types can run in parallel. Lock files: `.sync-{type}.lock` in the project directory.
