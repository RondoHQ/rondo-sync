# Database Schema

Complete schema documentation for all four SQLite databases used by rondo-sync.

## Table of Contents

- [Overview](#overview)
- [Change Detection Pattern](#change-detection-pattern)
- [Database 1: laposta-sync.sqlite](#database-1-laposta-syncsqlite)
- [Database 2: rondo-sync.sqlite](#database-2-rondo-syncsqlite)
- [Database 3: nikki-sync.sqlite](#database-3-nikki-syncsqlite)
- [Database 4: freescout-sync.sqlite](#database-4-freescout-syncsqlite)
- [Photo State Machine](#photo-state-machine)
- [Key Relationships](#key-relationships)

---

## Overview

The rondo-sync system uses four SQLite databases to track sync state between Sportlink Club (source) and downstream systems (Laposta, Rondo Club WordPress, Nikki, FreeScout).

**Critical:** These databases must only exist on the production server. Running sync from a local machine creates duplicate entries because each machine tracks its own `rondo_club_id` mappings.

### Database Locations

All databases are stored in the `data/` directory on the server at `/home/rondo/data/`.

| Database | Purpose | Module |
|---|---|---|
| `laposta-sync.sqlite` | Laposta email list sync + Sportlink run history | `lib/laposta-db.js` |
| `rondo-sync.sqlite` | Rondo Club WordPress sync (members, teams, commissies, photos, discipline, reverse sync) | `lib/rondo-club-db.js` |
| `nikki-sync.sqlite` | Nikki contribution tracking | `lib/nikki-db.js` |
| `freescout-sync.sqlite` | FreeScout customer sync | `lib/freescout-db.js` |

---

## Change Detection Pattern

All databases use **hash-based change detection** to minimize API calls and avoid redundant updates.

### How It Works

Each trackable record has two hash fields:

- **`source_hash`** - SHA-256 hash of current data from source system
- **`last_synced_hash`** - Hash of data last successfully synced to destination

### Sync Logic

```sql
-- Only sync if data has changed
WHERE last_synced_hash IS NULL OR last_synced_hash != source_hash
```

**On successful sync:** `last_synced_hash` is updated to match `source_hash`

**Benefits:**
- Idempotent: can re-run sync without duplicate API calls
- Efficient: only sends changed data
- Recoverable: failed syncs leave `last_synced_hash` unchanged, will retry next run

---

## Database 1: laposta-sync.sqlite

**Purpose:** Tracks email list synchronization between Sportlink and Laposta marketing platform.

**Module:** `lib/laposta-db.js`

### sportlink_runs

Stores raw JSON results from each Sportlink Club download for audit trail.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `created_at` | TEXT | ISO timestamp of download |
| `results_json` | TEXT | Complete JSON results from Sportlink download |

**Purpose:** Historical record of all Sportlink downloads. Used for debugging and data recovery.

---

### laposta_fields

Caches Laposta list custom field definitions to avoid repeated API calls.

| Column | Type | Description |
|---|---|---|
| `list_id` | TEXT | Laposta list ID |
| `field_id` | TEXT | Laposta field ID |
| `custom_name` | TEXT | Field tag/name (e.g., "voornaam") |
| `datatype` | TEXT | Field data type (text, numeric, select) |
| `required` | INTEGER | 1 = required, 0 = optional |
| `options_json` | TEXT | JSON array of select options |
| `updated_at` | TEXT | Last cache refresh timestamp |

**Primary Key:** `(list_id, field_id)`

---

### members

Central table tracking all members across up to 4 Laposta lists.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `list_index` | INTEGER | Which list: 1=LAPOSTA_LIST, 2=LAPOSTA_LIST2, 3=LAPOSTA_LIST3, 4=LAPOSTA_LIST4 |
| `list_id` | TEXT | Laposta list ID (UUID) |
| `email` | TEXT | Member email address |
| `custom_fields_json` | TEXT | JSON object of current custom field values |
| `source_hash` | TEXT | SHA-256 hash of email + custom_fields |
| `last_seen_at` | TEXT | Last time member appeared in Sportlink data |
| `last_synced_at` | TEXT | Last successful sync to Laposta |
| `last_synced_hash` | TEXT | Hash of last synced data |
| `last_synced_custom_fields_json` | TEXT | Previous custom_fields JSON (for diff display) |
| `created_at` | TEXT | First seen timestamp |

**Unique Constraint:** `(list_index, email)`

**Indexes:** `idx_members_list_hash` on `(list_index, source_hash, last_synced_hash)`

---

### member_deliverability_events

Tracks Laposta deliverability signals (`unsubscribed`, `cleaned`) and links each processed event to a created Rondo Club todo.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `list_index` | INTEGER | Laposta list index (1-4) |
| `list_id` | TEXT | Laposta list ID |
| `member_id` | TEXT | Laposta member ID (if provided) |
| `email` | TEXT | Member email address |
| `state` | TEXT | Laposta state (`unsubscribed` or `cleaned`) |
| `modified_at` | TEXT | Laposta modification timestamp |
| `signup_date` | TEXT | Laposta signup timestamp |
| `event_key` | TEXT | Unique idempotency key for this event |
| `payload_json` | TEXT | Raw Laposta member payload snapshot |
| `first_seen_at` | TEXT | First time event was observed |
| `last_seen_at` | TEXT | Last time event was observed |
| `matched_knvb_id` | TEXT | KNVB ID matched by email (if any) |
| `matched_rondo_club_id` | INTEGER | Matched WordPress person ID (if any) |
| `assigned_user_id` | INTEGER | WordPress user ID assigned to the todo |
| `rondo_todo_id` | INTEGER | Created Rondo Club todo ID |
| `task_created_at` | TEXT | Timestamp when todo was created |

**Unique Constraint:** `event_key`

**Indexes:**
- `idx_member_deliverability_events_pending` on `(task_created_at, last_seen_at)`
- `idx_member_deliverability_events_email` on `(email, state)`

---

## Database 2: rondo-sync.sqlite

**Purpose:** Tracks WordPress Rondo Club synchronization including members, parents, teams, committees, work history, photos, discipline cases, and reverse sync state.

**Module:** `lib/rondo-club-db.js`

### rondo_club_members

Primary member/person records synced to WordPress.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | KNVB public person ID - UNIQUE |
| `rondo_club_id` | INTEGER | WordPress post ID |
| `email` | TEXT | Member email address |
| `data_json` | TEXT | Full member data as JSON |
| `source_hash` | TEXT | SHA-256 hash of knvb_id + data |
| `last_seen_at` | TEXT | Last time member appeared in Sportlink data |
| `last_synced_at` | TEXT | Last successful sync to Rondo Club |
| `last_synced_hash` | TEXT | Hash of last synced data |
| `created_at` | TEXT | First seen timestamp |
| `person_image_date` | TEXT | Date of photo in Sportlink (change detection) |
| `photo_state` | TEXT | Photo sync state (see [Photo State Machine](#photo-state-machine)) |
| `photo_state_updated_at` | TEXT | When photo state last changed |
| `photo_url` | TEXT | Photo download URL from MemberHeader API |
| `photo_date` | TEXT | Photo date from MemberHeader API |
| `sync_origin` | TEXT | Last edit source: `user_edit`, `sync_sportlink_to_rondo_club`, `sync_rondo_club_to_sportlink` |
| `tracked_fields_hash` | TEXT | Hash of reverse-sync tracked fields (for change detection) |

**Reverse sync timestamp columns** (per-field modification tracking):

| Column Pattern | Fields Tracked |
|---|---|
| `{field}_rondo_club_modified` | When the field was last modified in Rondo Club |
| `{field}_sportlink_modified` | When the field was last modified in Sportlink |

Tracked fields: `email`, `email2`, `mobile`, `phone`, `datum_vog`, `freescout_id`, `financiele_blokkade`

**Indexes:**
- `idx_rondo_club_members_hash` on `(source_hash, last_synced_hash)`
- `idx_rondo_club_members_email` on `(email)`

**Critical:** `rondo_club_id` maps KNVB ID to WordPress post ID. Without this mapping, sync creates duplicates.

---

### rondo_club_parents

Parent/guardian records (identified by email, no KNVB ID).

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `email` | TEXT | Parent email - UNIQUE |
| `rondo_club_id` | INTEGER | WordPress post ID |
| `data_json` | TEXT | Parent data + `childKnvbIds` array as JSON |
| `source_hash` | TEXT | SHA-256 hash of email + data |
| `last_seen_at` | TEXT | Last time parent appeared in Sportlink data |
| `last_synced_at` | TEXT | Last successful sync |
| `last_synced_hash` | TEXT | Hash of last synced data |
| `created_at` | TEXT | First seen timestamp |

**Indexes:** `idx_rondo_club_parents_hash` on `(source_hash, last_synced_hash)`

---

### rondo_club_important_dates (DEPRECATED - v2.3)

**DEPRECATED:** Birthday sync migrated to `acf.birthdate` on person records. Table retained for backward compatibility.

Birth dates and other important dates synced to Rondo Club.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | Member KNVB ID |
| `date_type` | TEXT | Date type (e.g., "birth_date") |
| `date_value` | TEXT | Date value (YYYY-MM-DD) |
| `rondo_club_date_id` | INTEGER | WordPress important_date post ID |
| `source_hash` | TEXT | SHA-256 hash |
| `last_synced_hash` | TEXT | Hash of last synced data |
| `last_synced_at` | TEXT | Last successful sync |
| `created_at` | TEXT | First seen timestamp |

**Unique Constraint:** `(knvb_id, date_type)`

**Indexes:** `idx_rondo_club_important_dates_sync` on `(source_hash, last_synced_hash)`

---

### rondo_club_teams

Team records from Sportlink.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `team_name` | TEXT | Team name (COLLATE NOCASE) |
| `sportlink_id` | TEXT | Sportlink team ID - UNIQUE |
| `team_code` | TEXT | Team code |
| `rondo_club_id` | INTEGER | WordPress team post ID |
| `source_hash` | TEXT | SHA-256 hash |
| `last_seen_at` | TEXT | Last time team appeared in Sportlink |
| `last_synced_at` | TEXT | Last successful sync |
| `last_synced_hash` | TEXT | Hash of last synced data |
| `created_at` | TEXT | First seen timestamp |
| `game_activity` | TEXT | "Veld" or "Zaal" |
| `gender` | TEXT | M/V/Mixed |
| `player_count` | INTEGER | Number of players |
| `staff_count` | INTEGER | Number of staff |

**Indexes:**
- `idx_rondo_club_teams_hash` on `(source_hash, last_synced_hash)`
- `idx_rondo_club_teams_name` on `(team_name COLLATE NOCASE)`

**Team renames:** Uses `sportlink_id` as conflict key so renamed teams update existing WordPress posts.

---

### rondo_club_work_history

Member-team assignments synced to WordPress ACF repeater.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | Member KNVB ID |
| `team_name` | TEXT | Team name |
| `rondo_club_work_history_id` | INTEGER | WordPress work_history row index |
| `is_backfill` | INTEGER | 1 if from historical backfill, 0 if current |
| `source_hash` | TEXT | SHA-256 hash |
| `last_synced_hash` | TEXT | Hash of last synced data |
| `last_synced_at` | TEXT | Last successful sync |
| `created_at` | TEXT | First seen timestamp |

**Unique Constraint:** `(knvb_id, team_name)`

**Indexes:** `idx_rondo_club_work_history_member` on `(knvb_id)`

---

### sportlink_team_members

Raw team membership data from Sportlink (player/staff roles).

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `sportlink_team_id` | TEXT | Sportlink team ID |
| `sportlink_person_id` | TEXT | KNVB ID |
| `role_description` | TEXT | "Trainer", "Keeper", "Speler", etc. |
| `source_hash` | TEXT | SHA-256 hash |
| `last_seen_at` | TEXT | Last time membership appeared |
| `created_at` | TEXT | First seen timestamp |

**Unique Constraint:** `(sportlink_team_id, sportlink_person_id)`

**Indexes:**
- `idx_sportlink_team_members_person` on `(sportlink_person_id)`
- `idx_sportlink_team_members_team` on `(sportlink_team_id)`

---

### rondo_club_commissies

Committee records from Sportlink.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `commissie_name` | TEXT | Committee name - UNIQUE |
| `sportlink_id` | TEXT | Sportlink committee ID - UNIQUE |
| `rondo_club_id` | INTEGER | WordPress commissie post ID |
| `source_hash` | TEXT | SHA-256 hash |
| `last_seen_at` | TEXT | Last time committee appeared |
| `last_synced_at` | TEXT | Last successful sync |
| `last_synced_hash` | TEXT | Hash of last synced data |
| `created_at` | TEXT | First seen timestamp |

**Indexes:**
- `idx_rondo_club_commissies_hash` on `(source_hash, last_synced_hash)`
- `idx_rondo_club_commissies_name` on `(commissie_name)`

---

### sportlink_member_functions

Club-level functions held by members (e.g., "Voorzitter", "Secretaris").

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | Member KNVB ID |
| `function_description` | TEXT | Function name |
| `relation_start` | TEXT | Start date |
| `relation_end` | TEXT | End date (NULL = active) |
| `is_active` | INTEGER | 1 = active, 0 = ended |
| `source_hash` | TEXT | SHA-256 hash |
| `last_seen_at` | TEXT | Last seen timestamp |
| `created_at` | TEXT | First seen timestamp |

**Unique Constraint:** `(knvb_id, function_description)`

**Indexes:** `idx_sportlink_member_functions_knvb` on `(knvb_id)`

---

### sportlink_member_committees

Committee memberships with roles.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | Member KNVB ID |
| `committee_name` | TEXT | Committee name |
| `sportlink_committee_id` | TEXT | Sportlink committee ID |
| `role_name` | TEXT | Role within committee |
| `relation_start` | TEXT | Start date |
| `relation_end` | TEXT | End date (NULL = active) |
| `is_active` | INTEGER | 1 = active, 0 = ended |
| `source_hash` | TEXT | SHA-256 hash |
| `last_seen_at` | TEXT | Last seen timestamp |
| `created_at` | TEXT | First seen timestamp |

**Unique Constraint:** `(knvb_id, committee_name)`

**Indexes:** `idx_sportlink_member_committees_knvb` on `(knvb_id)`

---

### rondo_club_commissie_work_history

Committee membership work history synced to WordPress ACF repeater.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | Member KNVB ID |
| `commissie_name` | TEXT | Committee name |
| `role_name` | TEXT | Role in committee |
| `rondo_club_work_history_id` | INTEGER | WordPress work_history row index |
| `is_backfill` | INTEGER | 1 if from historical backfill |
| `source_hash` | TEXT | SHA-256 hash |
| `last_synced_hash` | TEXT | Hash of last synced data |
| `last_synced_at` | TEXT | Last successful sync |
| `created_at` | TEXT | First seen timestamp |

**Unique Constraint:** `(knvb_id, commissie_name, role_name)`

**Indexes:** `idx_rondo_club_commissie_work_history_member` on `(knvb_id)`

---

### sportlink_member_free_fields

Free fields from Sportlink /other tab.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | Member KNVB ID - UNIQUE |
| `freescout_id` | INTEGER | FreeScout customer ID (from Remarks3) |
| `vog_datum` | TEXT | VOG certificate date (from Remarks8) |
| `has_financial_block` | INTEGER | Financial transfer block (from MemberHeader) |
| `photo_url` | TEXT | Photo URL (from MemberHeader) |
| `photo_date` | TEXT | Photo date (from MemberHeader) |
| `source_hash` | TEXT | SHA-256 hash |
| `last_seen_at` | TEXT | Last seen timestamp |
| `created_at` | TEXT | First seen timestamp |

**Indexes:** `idx_sportlink_member_free_fields_knvb` on `(knvb_id)`

---

### sportlink_member_invoice_data

Invoice/billing data from Sportlink /financial tab (populated with `--with-invoice` flag).

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | Member KNVB ID - UNIQUE |
| `invoice_street` | TEXT | Invoice street name |
| `invoice_house_number` | TEXT | House number |
| `invoice_house_number_addition` | TEXT | House number addition |
| `invoice_postal_code` | TEXT | Postal code |
| `invoice_city` | TEXT | City |
| `invoice_country` | TEXT | Country |
| `invoice_address_is_default` | INTEGER | 1 if default address |
| `invoice_last_name` | TEXT | Invoice contact last name |
| `invoice_infix` | TEXT | Invoice contact infix |
| `invoice_initials` | TEXT | Invoice contact initials |
| `invoice_email` | TEXT | Invoice email |
| `invoice_external_code` | TEXT | External reference code |
| `source_hash` | TEXT | SHA-256 hash |
| `last_seen_at` | TEXT | Last seen timestamp |
| `created_at` | TEXT | First seen timestamp |

**Indexes:** `idx_sportlink_member_invoice_data_knvb` on `(knvb_id)`

---

### discipline_cases

Discipline (tucht) cases from Sportlink.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `dossier_id` | TEXT | Unique case ID (e.g., T-12345) - UNIQUE |
| `public_person_id` | TEXT | KNVB ID of person involved |
| `match_date` | TEXT | Match date |
| `match_description` | TEXT | Match details |
| `team_name` | TEXT | Team name |
| `charge_codes` | TEXT | KNVB charge code(s) |
| `charge_description` | TEXT | Full charge description |
| `sanction_description` | TEXT | Sanction/penalty description |
| `processing_date` | TEXT | Date case was processed |
| `administrative_fee` | REAL | Fee amount in euros |
| `is_charged` | INTEGER | Whether fee was charged |
| `source_hash` | TEXT | SHA-256 hash |
| `last_seen_at` | TEXT | Last seen timestamp |
| `created_at` | TEXT | First seen timestamp |

**Indexes:** `idx_discipline_cases_person` on `(public_person_id)`

**Module:** `lib/discipline-db.js`

---

### rondo_club_change_detections

Tracks field changes detected in Rondo Club for reverse sync.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | Member KNVB ID |
| `field_name` | TEXT | Changed field name |
| `old_value` | TEXT | Previous value |
| `new_value` | TEXT | New value |
| `detected_at` | TEXT | When change was detected |
| `rondo_club_modified_gmt` | TEXT | WordPress modification timestamp (GMT) |
| `detection_run_id` | TEXT | ID of the detection run |
| `synced_at` | TEXT | When change was synced back to Sportlink |

**Indexes:**
- `idx_rondo_club_change_detections_knvb` on `(knvb_id)`
- `idx_rondo_club_change_detections_detected` on `(detected_at)`

---

### conflict_resolutions

Audit log of conflicts between Rondo Club and Sportlink data during reverse sync.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | Member KNVB ID |
| `field_name` | TEXT | Conflicting field |
| `sportlink_value` | TEXT | Value in Sportlink |
| `rondo_club_value` | TEXT | Value in Rondo Club |
| `sportlink_modified` | TEXT | Sportlink modification timestamp |
| `rondo_club_modified` | TEXT | Rondo Club modification timestamp |
| `winning_system` | TEXT | Which system's value was kept |
| `resolution_reason` | TEXT | Why that system won |
| `resolved_at` | TEXT | When conflict was resolved |

**Indexes:** `idx_conflict_resolutions_knvb` on `(knvb_id)`

---

### reverse_sync_state

Singleton table tracking the last reverse sync detection run.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (always 1) |
| `last_detection_at` | TEXT | Timestamp of last detection run |
| `updated_at` | TEXT | When this record was last updated |

**Constraint:** `CHECK (id = 1)` - Only one row allowed.

---

## Database 3: nikki-sync.sqlite

**Purpose:** Tracks member contribution/dues data from Nikki accounting system.

**Module:** `lib/nikki-db.js`

### nikki_contributions

Member contribution records per year.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | Member KNVB ID |
| `year` | INTEGER | Contribution year |
| `nikki_id` | TEXT | Nikki system ID |
| `saldo` | REAL | Outstanding balance (positive = owes money) |
| `status` | TEXT | Payment status |
| `source_hash` | TEXT | SHA-256 hash |
| `last_seen_at` | TEXT | Last seen timestamp |
| `created_at` | TEXT | First seen timestamp |

**Unique Constraint:** `(knvb_id, year)`

**Indexes:**
- `idx_nikki_contributions_knvb_id` on `(knvb_id)`
- `idx_nikki_contributions_year` on `(year)`
- `idx_nikki_contributions_saldo` on `(saldo)`

---

## Database 4: freescout-sync.sqlite

**Purpose:** Tracks FreeScout customer synchronization.

**Module:** `lib/freescout-db.js`

### freescout_customers

FreeScout customer records mapped from Rondo Club members.

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER | Primary key (auto-increment) |
| `knvb_id` | TEXT | Member KNVB ID - UNIQUE |
| `email` | TEXT | Customer email |
| `freescout_id` | INTEGER | FreeScout customer ID |
| `data_json` | TEXT | Full customer data as JSON |
| `source_hash` | TEXT | SHA-256 hash |
| `last_seen_at` | TEXT | Last seen timestamp |
| `last_synced_at` | TEXT | Last successful sync |
| `last_synced_hash` | TEXT | Hash of last synced data |
| `created_at` | TEXT | First seen timestamp |

**Critical:** `freescout_id` maps KNVB ID to FreeScout customer ID. Without this mapping, sync creates duplicate customers.

---

## Photo State Machine

The `rondo_club_members.photo_state` field implements a state machine for photo synchronization.

### States

| State | Description |
|---|---|
| `no_photo` | Member has no photo in Sportlink |
| `pending_download` | Photo exists, needs to be downloaded |
| `downloaded` | Photo downloaded to local filesystem |
| `pending_upload` | Photo ready to be uploaded to Rondo Club |
| `synced` | Photo successfully uploaded to Rondo Club |
| `pending_delete` | Photo removed from Sportlink, needs deletion |

### State Transitions

```
no_photo → pending_download  (photo added in Sportlink)
pending_download → downloaded (photo downloaded successfully)
downloaded → pending_upload   (ready for upload)
pending_upload → synced       (upload successful)
synced → pending_delete       (photo removed from Sportlink)
pending_delete → no_photo     (deletion successful)
synced → pending_download     (photo changed in Sportlink)
```

### Change Detection

Photo changes are detected by comparing `photo_date` (from MemberHeader API):
- **Added:** `photo_date` changes from NULL to a date
- **Changed:** `photo_date` changes to a different date
- **Removed:** `photo_date` changes to NULL

---

## Key Relationships

### Member Identification

**Primary identifier:** `knvb_id` (KNVB public person ID)
- Used across all systems
- Stable over time
- Links members to teams, committees, contributions

**Parent identification:** `email` (no KNVB ID for parents)
- Linked to children via `childKnvbIds` array in `data_json`

### Cross-Database Relationships

```sql
-- Laposta: find member by email
SELECT * FROM members WHERE email = 'member@example.com';

-- Rondo Club: get WordPress post ID
SELECT rondo_club_id FROM rondo_club_members WHERE knvb_id = 'KNVB123456';

-- Nikki: get contributions
SELECT * FROM nikki_contributions WHERE knvb_id = 'KNVB123456' ORDER BY year DESC;

-- FreeScout: get customer ID
SELECT freescout_id FROM freescout_customers WHERE knvb_id = 'KNVB123456';
```

### Intra-Database Relationships (rondo-sync.sqlite)

```sql
-- Member → Teams (via work history)
SELECT team_name FROM rondo_club_work_history WHERE knvb_id = 'KNVB123456';

-- Member → Committees
SELECT committee_name, role_name FROM sportlink_member_committees WHERE knvb_id = 'KNVB123456';

-- Team → Members
SELECT sportlink_person_id, role_description
FROM sportlink_team_members WHERE sportlink_team_id = 'TEAM_ID';

-- Member → Discipline cases
SELECT * FROM discipline_cases WHERE public_person_id = 'KNVB123456';

-- Parent → Children (requires parsing data_json)
SELECT data_json FROM rondo_club_parents WHERE email = 'parent@example.com';
```

---

## Summary

| Database | Tables | Purpose |
|---|---|---|
| `laposta-sync.sqlite` | 3 | Email marketing sync (Laposta) |
| `rondo-sync.sqlite` | 16 | WordPress sync (members, teams, committees, photos, discipline, reverse sync) |
| `nikki-sync.sqlite` | 1 | Contribution tracking (Nikki) |
| `freescout-sync.sqlite` | 1 | Customer sync (FreeScout) |

**Total:** 21 tables across 4 databases

**Common pattern:** All main tables use `source_hash` / `last_synced_hash` for efficient change detection and idempotent sync operations.
