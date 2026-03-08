# Reverse Sync (Rondo Club → Sportlink)

Detects field changes made in Rondo Club WordPress and pushes them back to Sportlink Club via browser automation.

**Status: currently disabled.** The detection and sync code is complete but needs testing and re-enabling.

## Schedule

When enabled: **hourly** via `scripts/sync.sh reverse`.

```bash
scripts/sync.sh reverse                      # Production (with locking + email report)
node tools/detect-rondo-club-changes.js --verbose     # Detection only (no sync)
node pipelines/reverse-sync.js --verbose               # Full reverse sync (all tracked fields)
node pipelines/reverse-sync.js --knvb-id SYBH898 --verbose   # Target one member only
```

## Architecture

The reverse sync operates in two phases:

```
Phase 1: Change Detection (hourly)
    Rondo Club WordPress API → lib/detect-rondo-club-changes.js → rondo_club_change_detections table

Phase 2: Sync to Sportlink (when unsynced changes exist)
    rondo_club_change_detections → lib/reverse-sync-sportlink.js → Sportlink Browser (Playwright)
```

## Tracked Fields

| Field | Rondo Club ACF Location | Sportlink Page | Sportlink Selector | Type |
|---|---|---|---|---|
| `email` | `contact_info` repeater (type=email) | /general | `input[name="Email1"], input[name="Email"]` | text |
| `email2` | `contact_info` repeater (type=email2) | /general | `input[name="Email2"]` | text |
| `mobile` | `contact_info` repeater (type=mobile) | /general | `input[name="Mobile1"], input[name="Mobile"]` | text |
| `phone` | `contact_info` repeater (type=phone) | /general | `input[name="Telephone1"], input[name="Phone"]` | text |
| `datum_vog` | `datum-vog` | /other | `input[name="Remarks8"]` | text |
| `freescout_id` | `freescout-id` | /other | `input[name="Remarks3"]` | text |
| `financiele_blokkade` | `financiele-blokkade` | /financial | `input[name="HasFinancialTransferBlockOwnClub"]` | checkbox |

## Phase 1: Change Detection

**Script:** `lib/detect-rondo-club-changes.js`
**Function:** `detectChanges(options)`

### How It Works

1. Read `last_detection_at` from `reverse_sync_state` table
2. Query Rondo Club API for members modified since that timestamp: `GET /wp/v2/people?modified_after=...`
3. For each modified member:
   - Look up local record in `rondo_club_members`
   - **Skip** if `sync_origin == 'sync_sportlink_to_rondo_club'` (avoids infinite loops — this change came from forward sync)
   - Compute SHA-256 hash of all tracked fields
   - Compare to stored `tracked_fields_hash`
   - If hash differs, compare individual fields to find which ones changed
   - Log each changed field to `rondo_club_change_detections` table
4. Update `last_detection_at` in `reverse_sync_state`

### Infinite Loop Prevention

The `sync_origin` column on `rondo_club_members` tracks who last modified the record:

| Value | Meaning |
|---|---|
| `user_edit` | Manual edit in Rondo Club WordPress UI |
| `sync_sportlink_to_rondo_club` | Forward sync (Sportlink → Rondo Club) |
| `sync_rondo_club_to_sportlink` | Reverse sync (Rondo Club → Sportlink) |

Change detection skips members where `sync_origin == 'sync_sportlink_to_rondo_club'` because those changes came from Sportlink and don't need to be pushed back.

## Phase 2: Sync to Sportlink

**Script:** `lib/reverse-sync-sportlink.js`
**Functions:** `runReverseSync(options)` (contact fields) / `runReverseSyncMultiPage(options)` (all fields)

### How It Works

1. Fetch unsynced changes from `rondo_club_change_detections` (where `synced_at IS NULL`)
2. Group changes by member and by Sportlink page (general / other / financial)
3. Launch headless Chromium and log into Sportlink
4. For each member with changes:
   - Navigate to the appropriate Sportlink page(s)
   - Enter edit mode
   - Fill each changed field (text input or checkbox)
   - Save the form
   - Verify saved values by reading them back
   - Mark changes as synced (`UPDATE ... SET synced_at = ...`)
   - Update `{field}_sportlink_modified` timestamp in `rondo_club_members`
   - Set `sync_origin = 'sync_rondo_club_to_sportlink'`
5. Wait 1-2 seconds between members (rate limiting with random jitter)

### Retry Logic

- Up to 3 attempts per member with exponential backoff (1s, 3s, 7s)
- Session timeout detection: if redirected to Sportlink login page, re-authenticate and retry
- **Fail-fast for multi-page:** if any page fails, no timestamps are updated; all changes remain unsynced for retry on next run

## Conflict Resolution

**Script:** `lib/conflict-resolver.js`
**Function:** `resolveFieldConflicts(member, sportlinkData, rondoClubData, db, logger)`

When both Sportlink and Rondo Club have modified the same field, conflict resolution determines which value wins.

### Resolution Rules

Each tracked field has two timestamp columns in `rondo_club_members`:
- `{field}_rondo_club_modified` — when forward sync last wrote this field to Rondo Club
- `{field}_sportlink_modified` — when reverse sync last wrote this field to Sportlink

Resolution logic:

| Condition | Winner | Reason |
|---|---|---|
| Both timestamps NULL | Sportlink | Default (forward sync is primary) |
| Only Sportlink has timestamp | Sportlink | Has modification history |
| Only Rondo Club has timestamp | Rondo Club | Has modification history |
| Both have timestamps, within 5 seconds | Sportlink | Grace period (clock drift tolerance) |
| Both have timestamps, Rondo Club >5s newer | Rondo Club | More recent edit |
| Both have timestamps, Sportlink >5s newer | Sportlink | More recent edit |
| Values match (timestamps differ) | Neither | No conflict (same data) |

The 5-second grace period handles minor clock differences between systems.

### Conflict Audit Log

All resolutions are logged to the `conflict_resolutions` table:

```sql
SELECT knvb_id, field_name, sportlink_value, rondo_club_value,
       winning_system, resolution_reason, resolved_at
FROM conflict_resolutions
ORDER BY resolved_at DESC;
```

## Database Tables

### rondo_club_change_detections

Audit log of all detected changes.

| Column | Description |
|---|---|
| `knvb_id` | Member KNVB ID |
| `field_name` | Which field changed |
| `old_value` | Previous value |
| `new_value` | New value |
| `detected_at` | When the change was detected |
| `rondo_club_modified_gmt` | WordPress modification timestamp |
| `detection_run_id` | ID of the detection run |
| `synced_at` | When change was synced to Sportlink (NULL = not yet synced) |

### reverse_sync_state

Singleton table tracking detection progress.

| Column | Description |
|---|---|
| `id` | Always 1 |
| `last_detection_at` | Timestamp of last detection run |
| `updated_at` | When this record was last updated |

### conflict_resolutions

Audit log of conflict resolution decisions.

| Column | Description |
|---|---|
| `knvb_id` | Member KNVB ID |
| `field_name` | Conflicting field |
| `sportlink_value` / `rondo_club_value` | Values from each system |
| `sportlink_modified` / `rondo_club_modified` | Timestamps from each system |
| `winning_system` | Which system's value was kept |
| `resolution_reason` | Why (e.g., `rondo_club_newer`, `grace_period_sportlink_wins`) |

### rondo_club_members (reverse sync columns)

Per-field modification timestamps added to the existing table:

| Column Pattern | Example |
|---|---|
| `{field}_rondo_club_modified` | `email_rondo_club_modified` |
| `{field}_sportlink_modified` | `email_sportlink_modified` |
| `sync_origin` | Last edit source |
| `tracked_fields_hash` | Hash for quick change detection |

## Source Files

| File | Purpose |
|------|---------|
| `lib/detect-rondo-club-changes.js` | Change detection (Rondo Club API → SQLite) |
| `lib/reverse-sync-sportlink.js` | Sync to Sportlink (SQLite → Sportlink browser) |
| `lib/conflict-resolver.js` | Timestamp-based conflict resolution |
| `lib/sync-origin.js` | Constants and utilities for sync origin tracking |
| `tools/detect-rondo-club-changes.js` | CLI for running detection standalone |
| `pipelines/reverse-sync.js` | CLI for running contact field sync |
| `steps/reverse-sync-contact-fields.js` | CLI alias for contact field sync |

## Example Flow

1. **Forward sync** downloads member email from Sportlink, writes to Rondo Club → sets `sync_origin = 'sync_sportlink_to_rondo_club'`
2. **User** edits email in Rondo Club WordPress UI → WordPress updates `modified_gmt`
3. **Change detection** (hourly): queries Rondo Club API for recently modified members
   - Finds the member, sees `sync_origin != 'sync_sportlink_to_rondo_club'` (user edit happened after)
   - Computes tracked fields hash, detects email changed
   - Logs to `rondo_club_change_detections`: email, old value, new value
4. **Reverse sync**: reads unsynced changes from `rondo_club_change_detections`
   - Opens Chromium, logs into Sportlink
   - Navigates to member's /general page
   - Enters edit mode, fills email field, saves
   - Verifies saved value
   - Marks change as synced, updates `email_sportlink_modified`, sets `sync_origin = 'sync_rondo_club_to_sportlink'`
5. **Next forward sync**: downloads email from Sportlink (now matches Rondo Club value) → no change detected → no API call
