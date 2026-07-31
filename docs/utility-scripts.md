# Utility Scripts

Reference for all utility, cleanup, inspection, and recovery scripts.

## Cleanup Scripts

### delete-duplicates.js

Finds and removes duplicate member entries in Rondo Club by KNVB ID, keeping the oldest record.

```bash
node tools/delete-duplicates.js --verbose   # Dry run (default)
node tools/delete-duplicates.js --apply      # Actually delete
```

**Safe by default:** Dry-run mode shows what would be deleted without making changes.

---

### merge-duplicate-person.js

Merges a parent record into a member record, reassigning all child relationships, then deletes the parent.

```bash
node tools/merge-duplicate-person.js --parent=123 --member=456
```

**Destructive:** Immediately performs the merge and deletion. No dry-run mode.

---

### cleanup-duplicate-relationships.js

Scans all people and removes duplicate relationships (same person + type) and self-referential relationships.

```bash
node tools/cleanup-duplicate-relationships.js
```

**Destructive:** Immediately removes duplicates. No dry-run mode.

---

### cleanup-orphan-relationships.js

Finds people with relationships pointing to non-existent person IDs and removes those orphaned relationships.

```bash
node tools/cleanup-orphan-relationships.js --verbose  # Dry run (default)
node tools/cleanup-orphan-relationships.js --fix       # Remove orphaned relationships
```

---

### cleanup-comma-teams.js

Deletes teams whose names contain commas (artifact of bad sync data).

```bash
node tools/cleanup-comma-teams.js --verbose    # Dry run (default)
node tools/cleanup-comma-teams.js              # Delete bad teams
```

---

### cleanup-rondo-club-duplicates.js

Compares Rondo Club records against expected Sportlink members and identifies/deletes members not in Sportlink.

```bash
node tools/cleanup-rondo-club-duplicates.js --verbose   # Dry run (default)
node tools/cleanup-rondo-club-duplicates.js --delete     # Delete duplicates
```

---

### clear-commissie-work-history.js

Clears the `work_history` field for all members who have active functions or committees. Used to reset commissie work history for a fresh re-sync.

```bash
node tools/clear-commissie-work-history.js
```

**Destructive:** Immediately clears work history. No dry-run mode.

---

### find-orphan-dates.js (DEPRECATED)

**DEPRECATED (v2.3):** Birthdays now sync as `fields.birthdate` on person records, not as separate `important_date` posts.

Finds important dates (birthdays) that reference people who no longer exist in Rondo Club.

```bash
node tools/find-orphan-dates.js --verbose   # List orphans (default)
node tools/find-orphan-dates.js --delete     # Delete orphaned dates
```

---

### dedupe-laposta-list.js

Finds and removes duplicate parent entries (by email) across Laposta lists, keeping entries from the lowest-numbered list.

```bash
node tools/dedupe-laposta-list.js                # Dry run, all lists
node tools/dedupe-laposta-list.js --apply        # Delete duplicates, all lists
node tools/dedupe-laposta-list.js 2 --apply      # Delete duplicates, list 2 only
node tools/dedupe-laposta-list.js --state=inactive  # Target inactive members
```

---

## Validation Scripts

### verify-rondo-club-data.js

Validates SQLite tracking data against Rondo Club WordPress. Identifies invalid `rondo_club_id` mappings, orphans, and missing mappings.

```bash
node tools/verify-rondo-club-data.js --verbose           # Report only (default)
node tools/verify-rondo-club-data.js --fix --verbose      # Nullify invalid IDs for re-sync
```

Checks: `rondo_club_members`, `rondo_club_parents`, `rondo_club_teams`, `rondo_club_commissies`, `rondo_club_important_dates`.

---

### validate-rondo-club-ids.js

Simpler version of verify-rondo-club-data: validates that all tracked `rondo_club_id` values still exist in Rondo Club.

```bash
node tools/validate-rondo-club-ids.js                # Dry run (default)
node tools/validate-rondo-club-ids.js --apply        # Nullify invalid IDs
```

---

### check-photo-consistency.js

Verifies that photo files on disk match the `photo_state` in the database. Finds members marked as `downloaded` or `synced` whose files are missing.

```bash
node tools/check-photo-consistency.js --verbose  # Report only (default)
node tools/check-photo-consistency.js --fix      # Update database states
```

---

## Recovery Scripts

### repopulate-rondo-club-ids.js

Fetches all people from Rondo Club API by KNVB ID and repopulates missing `rondo_club_id` mappings in the local database.

```bash
node tools/repopulate-rondo-club-ids.js --dry-run --verbose  # Preview
node tools/repopulate-rondo-club-ids.js --verbose             # Apply
```

Use this after database loss or corruption to restore ID mappings without creating duplicates.

---

### reset-photo-states.js

Resets `photo_state` to `pending_download` for members marked as `no_photo` but who have photo URLs or image dates.

```bash
node tools/reset-photo-states.js              # Dry run (default)
node tools/reset-photo-states.js --apply      # Fix states
```

---

## Inspection Scripts

### show-laposta-changes.js

Shows pending Laposta sync changes with field-level diffs.

```bash
node tools/show-laposta-changes.js            # Changes only, list 0
node tools/show-laposta-changes.js 2          # Changes only, list 2
node tools/show-laposta-changes.js --all      # All members with diffs
```

**Read-only:** No modifications made.

---

### show-laposta-member.js

Looks up a member in the Laposta tracking database by email.

```bash
node tools/show-laposta-member.js someone@example.com
node tools/show-laposta-member.js someone@example.com 2  # List 2
```

**Read-only:** No modifications made.

---

### show-sportlink-member.js

Looks up a member in cached Sportlink data by email.

```bash
node tools/show-sportlink-member.js someone@example.com
```

**Read-only:** No modifications made.

---

### show-nikki-contributions.js

Displays Nikki contribution records with filtering options.

```bash
node tools/show-nikki-contributions.js                          # All records
node tools/show-nikki-contributions.js KNVB123456               # Specific member
node tools/show-nikki-contributions.js --year 2025              # Specific year
node tools/show-nikki-contributions.js --outstanding            # Members with balance > 0
node tools/show-nikki-contributions.js --json                   # JSON output
```

**Read-only:** No modifications made.

---

### detect-rondo-club-changes.js

Detects field changes in Rondo Club for reverse sync (currently disabled).

```bash
node tools/detect-rondo-club-changes.js --verbose
```

**Read-only:** Reports detected changes but doesn't sync them.

---

## Sync Scripts

### sync-individual.js

Syncs a single member to Rondo Club by KNVB ID. Useful for debugging or fixing individual records.

```bash
node pipelines/sync-individual.js KNVB123456 --verbose               # Full sync
node pipelines/sync-individual.js KNVB123456 --dry-run --verbose      # Preview only
node pipelines/sync-individual.js KNVB123456 --fetch --verbose        # Fetch fresh data from Sportlink first
node pipelines/sync-individual.js KNVB123456 --force --verbose        # Ignore change detection
node pipelines/sync-individual.js KNVB123456 --skip-functions         # Skip functions/commissie sync
node pipelines/sync-individual.js --search "Jan Jansen"               # Search by name
```

---

## Infrastructure Scripts

### send-email.js

Sends sync report logs as formatted HTML email via Postmark.

```bash
node scripts/send-email.js <log-file-path> [sync-type]
```

Requires `POSTMARK_API_KEY`, `POSTMARK_FROM_EMAIL`, `OPERATOR_EMAIL` in `.env`.

---

### install-cron.sh

Interactive cron job installer. Prompts for Postmark credentials and installs all sync schedules.

```bash
npm run install-cron
# or
bash scripts/install-cron.sh
```

---

### sync.sh

Unified sync wrapper for cron. Handles locking (flock), logging, and email report delivery.

```bash
scripts/sync.sh {people|photos|teams|functions|invoice|nikki|freescout|reverse|discipline|all}
```

Pass extra flags after the sync type:
```bash
scripts/sync.sh functions --all    # Full functions sync
```

---

## Quick Reference

| Script | Default Mode | Purpose |
|--------|-------------|---------|
| `tools/delete-duplicates.js` | Dry-run | Remove duplicate Rondo Club members |
| `tools/merge-duplicate-person.js` | **Destructive** | Merge parent into member |
| `tools/cleanup-duplicate-relationships.js` | **Destructive** | Remove duplicate relationships |
| `tools/clear-commissie-work-history.js` | **Destructive** | Clear commissie work history |
| `tools/find-orphan-dates.js` | Dry-run | Find/delete orphaned birthdays (DEPRECATED v2.3) |
| `tools/verify-rondo-club-data.js` | Report-only | Validate ID mappings |
| `tools/reset-photo-states.js` | Dry-run | Fix photo state mismatches |
| `tools/cleanup-rondo-club-duplicates.js` | Dry-run | Remove non-Sportlink members |
| `tools/cleanup-orphan-relationships.js` | Dry-run | Remove orphaned relationships |
| `tools/cleanup-comma-teams.js` | Dry-run | Delete malformed teams |
| `tools/check-photo-consistency.js` | Report-only | Verify photo files vs database |
| `tools/validate-rondo-club-ids.js` | Dry-run | Validate rondo_club_id existence |
| `tools/repopulate-rondo-club-ids.js` | Dry-run | Restore missing ID mappings |
| `tools/dedupe-laposta-list.js` | Dry-run | Deduplicate Laposta entries |
| `pipelines/sync-individual.js` | Sync | Sync single member |
| `tools/show-laposta-changes.js` | Read-only | View pending Laposta changes |
| `tools/show-laposta-member.js` | Read-only | Look up Laposta member |
| `tools/show-sportlink-member.js` | Read-only | Look up Sportlink member |
| `tools/show-nikki-contributions.js` | Read-only | View Nikki contributions |
| `tools/detect-rondo-club-changes.js` | Read-only | Detect reverse sync changes |
