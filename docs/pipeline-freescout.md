# FreeScout Pipeline

Syncs Rondo Club member data to FreeScout helpdesk as customers, enriching support tickets with member context.

## Schedule

Runs **daily** at 8:00 AM (Amsterdam time).

```bash
scripts/sync.sh freescout           # Production (with locking + email report)
node pipelines/sync-freescout.js --verbose    # Direct execution (verbose)
```

## Pipeline Flow

```
pipelines/sync-freescout.js
├── Check credentials (FREESCOUT_API_KEY + FREESCOUT_URL)
└── steps/submit-freescout-sync.js
    ├── steps/prepare-freescout-customers.js   → data/freescout-sync.sqlite
    └── Submit to FreeScout API          → FreeScout customers
```

## Step-by-Step Details

### Credential Check

Before running, `pipelines/sync-freescout.js` verifies that `FREESCOUT_API_KEY` and `FREESCOUT_URL` are configured in `.env`. If not, the pipeline exits with an error.

### Customer Preparation

**Script:** `steps/prepare-freescout-customers.js` (called internally by `steps/submit-freescout-sync.js`)

1. Reads member data from `data/rondo-sync.sqlite` → `rondo_club_members`
2. Reads team assignments from `data/rondo-sync.sqlite` → `rondo_club_work_history`
3. Reads contribution data from `data/nikki-sync.sqlite` → `nikki_contributions`
4. Builds customer records with:
   - Name, email, phone from Rondo Club member data
   - Team memberships (comma-separated)
   - KNVB ID, member since date
   - Latest Nikki contribution balance and status
5. Computes `source_hash` per customer
6. Upserts into `data/freescout-sync.sqlite` → `freescout_customers`

### Customer Sync

**Script:** `steps/submit-freescout-sync.js`
**Function:** `runSubmit({ logger, verbose, force })`

1. Reads customers from `data/freescout-sync.sqlite` where `source_hash != last_synced_hash`
2. For each changed customer:
   - **No `freescout_id`**: `POST /api/customers` (create new customer)
   - **Has `freescout_id`**: `PUT /api/customers/{freescout_id}` (update existing)
3. After creating/updating, syncs **custom fields** via `PUT /api/customers/{id}/customer_fields`
4. Stores returned FreeScout customer ID as `freescout_id`
5. Updates `last_synced_hash` on success
6. Rate limited: exponential backoff on 5xx errors (1s, 2s, 4s)

**Output:** `{ total, synced, created, updated, skipped, deleted, errors }`

## Field Mappings

### Standard Customer Fields

Sent to `POST/PUT /api/customers`:

| FreeScout Field | Source | Origin |
|---|---|---|
| `firstName` | `fields.first_name` | `rondo_club_members.data_json` |
| `lastName` | `fields.last_name` | `rondo_club_members.data_json` |
| `emails[].value` | Email from `contact_info` repeater | `rondo_club_members.data_json` |
| `phones[].value` | Mobile from `contact_info` repeater | `rondo_club_members.data_json` |

### Custom Fields

Sent to `PUT /api/customers/{id}/customer_fields`:

| FreeScout Custom Field | Field ID | Source | Origin |
|---|---|---|---|
| `union_teams` | 1 | All current team names, comma-separated | `rondo_club_work_history` |
| `public_person_id` | 4 | KNVB ID | `rondo_club_members` |
| `member_since` | 5 | `fields['lid-sinds']` | `rondo_club_members` |
| `nikki_saldo` | 7 | Most recent year's outstanding balance | `nikki_contributions` |
| `nikki_status` | 8 | Most recent year's payment status | `nikki_contributions` |

Field IDs are configurable via `FREESCOUT_FIELD_*` environment variables.

## Database Tables Used

| Database | Table | Usage |
|---|---|---|
| `rondo-sync.sqlite` | `rondo_club_members` | Member data (name, contact, KNVB ID) |
| `rondo-sync.sqlite` | `rondo_club_work_history` | Current team assignments |
| `nikki-sync.sqlite` | `nikki_contributions` | Financial contribution data |
| `freescout-sync.sqlite` | `freescout_customers` | Customer → FreeScout ID mapping + hashes |

## CLI Flags

| Flag | Effect |
|------|--------|
| `--verbose` | Detailed per-customer logging |
| `--force` | Skip change detection, sync all customers |

## Error Handling

- Missing credentials cause immediate exit (not a silent skip)
- Individual customer sync failures don't stop the pipeline
- 5xx errors trigger exponential backoff (up to 3 retries)
- All errors collected in summary report

## Source Files

| File | Purpose |
|------|---------|
| `pipelines/sync-freescout.js` | Pipeline orchestrator |
| `steps/submit-freescout-sync.js` | FreeScout API sync + customer preparation |
| `steps/prepare-freescout-customers.js` | Customer data preparation |
| `lib/freescout-db.js` | FreeScout SQLite operations |
| `lib/freescout-client.js` | FreeScout HTTP client + credential check |
| `lib/rondo-club-db.js` | Rondo Club data lookup |
| `lib/nikki-db.js` | Nikki contribution lookup |
| `lib/http-client.js` | HTTP request utilities |
