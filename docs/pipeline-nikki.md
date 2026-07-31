# Nikki Pipeline

Syncs member contribution/dues data from the Nikki accounting system to Rondo Club WordPress canonical fields.

## Schedule

Runs **daily** at 7:00 AM (Amsterdam time).

```bash
scripts/sync.sh nikki           # Production (with locking + email report)
node pipelines/sync-nikki.js --verbose    # Direct execution (verbose)
```

## Pipeline Flow

```
pipelines/sync-nikki.js
├── Step 1: steps/download-nikki-contributions.js    → data/nikki-sync.sqlite
└── Step 2: steps/sync-nikki-to-rondo-club.js           → Rondo Club WordPress API
```

## Step-by-Step Details

### Step 1: Download Nikki Contributions

**Script:** `steps/download-nikki-contributions.js`
**Function:** `runNikkiDownload({ logger, verbose })`

1. Launches headless Chromium via Playwright
2. Navigates to the Nikki web application
3. Scrapes the HTML contribution table:
   - Extracts `knvb_id`, `year`, `nikki_id`, `saldo`, `status` per row
   - Parses European currency format (e.g., "EUR 1.234,56" → 1234.56)
4. Exports CSV data for `hoofdsom` (total amount) values
5. A single member can have **multiple contribution lines per year** (e.g., separate amounts for different family members)
6. Each line is stored as a separate row in SQLite, keyed by `(knvb_id, year, nikki_id)`
7. Computes `source_hash` per contribution record
8. Upserts into `data/nikki-sync.sqlite` → `nikki_contributions` table

**Output:** `{ success, count }`

**Database written:** `data/nikki-sync.sqlite` → `nikki_contributions`

### Step 2: Sync to Rondo Club

**Script:** `steps/sync-nikki-to-rondo-club.js`
**Function:** `runNikkiRondoClubSync({ logger, verbose, force })`

1. Groups contributions by `knvb_id` and `year`
2. For members with multiple lines per year: **sums** `saldo` and `hoofdsom` across all lines
3. Looks up `rondo_club_id` from `data/rondo-sync.sqlite` → `rondo_club_members` (cross-database lookup)
4. Skips members without a `rondo_club_id` (not yet synced to Rondo Club)
5. For each member with changes, sends `PUT /wp/v2/people/{rondo_club_id}` with:
   - `first_name` and `last_name` (always required by Rondo Club API)
   - Per-year Nikki canonical fields (up to 4 years of history)
6. Rate limited: 500ms between updates

**Output:** `{ updated, skipped, noRondoClubId, errors }`

**Important:** The PUT request must include `first_name` and `last_name` even when only updating Nikki fields. This requires a GET request first to fetch existing required fields.

## Field Mappings

### Nikki → Rondo Club native field Fields

For each contribution year, three canonical fields are written per person:

| Rondo Club native field Field | Source | Example |
|---|---|---|
| `_nikki_{YEAR}_total` | Sum of `hoofdsom` for that year | `_nikki_2025_total`: 1500.00 |
| `_nikki_{YEAR}_saldo` | Sum of `saldo` for that year | `_nikki_2025_saldo`: 250.00 |
| `_nikki_{YEAR}_status` | `status` value | `_nikki_2025_status`: "Betaald" |

Up to 4 years of history are retained (e.g., 2023, 2024, 2025, 2026).

### Data Aggregation

When a member has multiple contribution lines for the same year:

```
Member KNVB123 in 2025:
  Line 1: saldo=100, hoofdsom=500, status="Betaald"
  Line 2: saldo=150, hoofdsom=750, status="Open"

Result for Rondo Club:
  _nikki_2025_saldo = 250 (100 + 150)
  _nikki_2025_total = 1250 (500 + 750)
  _nikki_2025_status = "Open" (worst status takes priority)
```

## Database Tables Used

| Database | Table | Usage |
|---|---|---|
| `nikki-sync.sqlite` | `nikki_contributions` | Contribution records per member per year |
| `rondo-sync.sqlite` | `rondo_club_members` | KNVB ID → Rondo Club ID lookup (read-only) |

## CLI Flags

| Flag | Effect |
|------|--------|
| `--verbose` | Detailed per-member logging |
| `--force` | Re-sync all members regardless of change detection |

## Error Handling

- Download failure is logged but doesn't prevent reporting
- Members without a `rondo_club_id` are skipped (counted separately as `noRondoClubId`)
- Individual member update failures don't stop the pipeline
- All errors collected in summary report

## Source Files

| File | Purpose |
|------|---------|
| `pipelines/sync-nikki.js` | Pipeline orchestrator |
| `steps/download-nikki-contributions.js` | Nikki web scraping (Playwright) |
| `steps/sync-nikki-to-rondo-club.js` | Rondo Club API sync |
| `lib/nikki-db.js` | Nikki SQLite operations |
| `lib/rondo-club-db.js` | Rondo Club ID lookup |
| `lib/rondo-club-client.js` | Rondo Club HTTP client |
