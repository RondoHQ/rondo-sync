# Operations Guide

Day-to-day server operations, monitoring, and maintenance.

## Server Access

```bash
ssh root@46.202.155.16
cd /home/rondo
```

## Checking Sync Status

### View Cron Schedule

```bash
crontab -l
```

### View Recent Logs

```bash
# List recent log files
ls -lt logs/cron/ | head -20

# View latest people sync log
cat logs/cron/$(ls -t logs/cron/ | grep sync-people | head -1)

# Tail a running sync
tail -f logs/cron/sync-people-*.log
```

### Check if a Sync is Running

```bash
# Check for running Node processes
ps aux | grep "node sync-"

# Check lock files
ls -la .sync-*.lock
```

## Manual Sync Runs

### Individual Pipelines

```bash
scripts/sync.sh people           # Members, parents, photos → Laposta + Rondo Club
scripts/sync.sh nikki            # Nikki contributions → Rondo Club
scripts/sync.sh sponsit          # Sponsor contacts → Rondo Club + Laposta
scripts/sync.sh freescout        # Rondo Club members → FreeScout customers
scripts/sync.sh teams            # Teams + work history → Rondo Club
scripts/sync.sh functions        # Commissies + free fields (recent updates)
scripts/sync.sh functions --all  # Commissies + free fields (all members)
scripts/sync.sh discipline       # Discipline cases → Rondo Club
scripts/sync.sh all              # All pipelines sequentially
```

### Single Member Sync

Sync a specific member by KNVB ID:

```bash
node pipelines/sync-individual.js KNVB123456 --verbose          # Full sync
node pipelines/sync-individual.js KNVB123456 --dry-run --verbose # Preview only
node pipelines/sync-individual.js KNVB123456 --fetch --verbose   # Fetch fresh data from Sportlink first
node pipelines/sync-individual.js --search "Jan Jansen"          # Search by name
```

### Direct Script Execution

For debugging individual steps:

```bash
node steps/download-data-from-sportlink.js --verbose   # Download only
node steps/prepare-laposta-members.js --verbose         # Prepare Laposta data
node steps/submit-laposta-list.js --verbose             # Submit to Laposta
node steps/submit-rondo-club-sync.js --verbose             # Submit to Rondo Club (includes birthdate)
node steps/download-photos-from-api.js --verbose        # Download photos
node steps/upload-photos-to-rondo-club.js --verbose        # Upload photos
```

## Database Inspection

### Member Lookups

```bash
# Find member in Sportlink data
node tools/show-sportlink-member.js member@example.com

# Find member in Laposta tracking
node tools/show-laposta-member.js member@example.com
node tools/show-laposta-member.js member@example.com 2   # Specific list

# Show pending Laposta changes
node tools/show-laposta-changes.js        # Changes only
node tools/show-laposta-changes.js --all  # All members with diffs
```

### Direct SQLite Queries

```bash
# Member count
sqlite3 data/rondo-sync.sqlite "SELECT COUNT(*) FROM rondo_club_members"

# Members needing sync (hash mismatch)
sqlite3 data/rondo-sync.sqlite "SELECT COUNT(*) FROM rondo_club_members WHERE last_synced_hash IS NULL OR last_synced_hash != source_hash"

# Photo state distribution
sqlite3 data/rondo-sync.sqlite "SELECT photo_state, COUNT(*) FROM rondo_club_members GROUP BY photo_state"

# Team count
sqlite3 data/rondo-sync.sqlite "SELECT COUNT(*) FROM rondo_club_teams WHERE rondo_club_id IS NOT NULL"

# Commissie count
sqlite3 data/rondo-sync.sqlite "SELECT COUNT(*) FROM rondo_club_commissies WHERE rondo_club_id IS NOT NULL"

# Recent Sportlink downloads
sqlite3 data/laposta-sync.sqlite "SELECT id, created_at FROM sportlink_runs ORDER BY id DESC LIMIT 5"

# Nikki contributions with outstanding balance
node tools/show-nikki-contributions.js --outstanding

# FreeScout customer count
sqlite3 data/freescout-sync.sqlite "SELECT COUNT(*) FROM freescout_customers WHERE freescout_id IS NOT NULL"
```

## Deploying Updates

```bash
# On local machine: commit and push
git add . && git commit -m "description" && git push

# On server: pull and install
ssh root@46.202.155.16 "cd /home/rondo && git pull && npm install"
```

Only run `npm install` if dependencies changed (check `package.json` diff).

## Data Validation

### Verify Rondo Club ID Mappings

Checks that all tracked `rondo_club_id` values still point to valid WordPress posts:

```bash
node tools/verify-rondo-club-data.js --verbose     # Report only
node tools/verify-rondo-club-data.js --fix --verbose  # Fix invalid IDs
```

### Repopulate Missing Rondo Club IDs

If IDs were lost (e.g., database restored from backup):

```bash
node tools/repopulate-rondo-club-ids.js --dry-run --verbose  # Preview
node tools/repopulate-rondo-club-ids.js --verbose             # Apply
```

### Validate Photo Consistency

Check that photo files on disk match database state:

```bash
node tools/check-photo-consistency.js --verbose   # Report
node tools/check-photo-consistency.js --fix       # Fix mismatches
```

## Cleanup Operations

### Remove Duplicate Members

```bash
node tools/delete-duplicates.js --verbose   # Dry run
node tools/delete-duplicates.js --apply      # Delete duplicates
```

### Merge Duplicate Person Records

When a parent and member record exist for the same person:

```bash
node tools/merge-duplicate-person.js --parent=123 --member=456
```

### Remove Orphaned Data

```bash
# Orphaned relationships
node tools/cleanup-orphan-relationships.js --verbose
node tools/cleanup-orphan-relationships.js --fix

# Duplicate relationships
node tools/cleanup-duplicate-relationships.js
```

### Deduplicate Laposta Lists

```bash
node tools/dedupe-laposta-list.js              # Dry run, all lists
node tools/dedupe-laposta-list.js --apply      # Delete duplicates
node tools/dedupe-laposta-list.js 2 --apply    # List 2 only
```

## Log Management

Logs accumulate in `logs/cron/`. Clean up old logs periodically:

```bash
# Delete logs older than 30 days
find logs/cron/ -name "*.log" -mtime +30 -delete

# Check disk usage
du -sh logs/
```

## Monitoring Checklist

Daily checks:
- [ ] People sync email report arrives (4x daily)
- [ ] No errors in latest sync report

Weekly checks:
- [ ] Team sync ran on Sunday (check `logs/cron/sync-teams-*`)
- [ ] Sponsit sync ran on Sunday (check `logs/cron/sync-sponsit-*`)
- [ ] Full functions sync ran on Sunday (check `logs/cron/sync-functions-*`)
- [ ] Discipline sync ran on Monday (check `logs/cron/sync-discipline-*`)
- [ ] Disk usage reasonable (`du -sh /home/rondo/`)

Monthly checks:
- [ ] Log files cleaned up (`find logs/cron/ -name "*.log" -mtime +30 | wc -l`)
- [ ] Photo directory size reasonable (`du -sh photos/`)
- [ ] Database sizes stable (`ls -lh data/*.sqlite`)
