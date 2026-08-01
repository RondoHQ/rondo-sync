# Troubleshooting

Common issues and their solutions.

## Duplicate Entries in Rondo Club

**Symptom:** Hundreds of duplicate member posts appear in Rondo Club WordPress.

**Cause:** Sync was run from a local machine. Each machine has its own SQLite database tracking `rondo_club_id` mappings. The local database doesn't know about entries created by the server, so it creates new ones instead of updating.

**Fix:**
```bash
# On the server
node tools/delete-duplicates.js --verbose   # Dry run first
node tools/delete-duplicates.js --apply      # Delete duplicates (keeps oldest per KNVB ID)
```

**Prevention:** All sync scripts enforce a server check that blocks local execution. Always sync from `root@46.202.155.16:/home/rondo/`.

---

## Chromium Won't Start

**Symptom:**
```
Error: browserType.launch: Executable doesn't exist
```

**Fix:** Install/reinstall Chromium:
```bash
npx playwright install chromium
```

If that doesn't work, install system dependencies:
```bash
sudo apt-get install -y libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libdbus-1-3 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
  libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2
```

---

## TOTP Authentication Fails

**Symptom:** Login to Sportlink fails with invalid OTP code.

**Causes and fixes:**

1. **Wrong secret format:** `SPORTLINK_OTP_SECRET` must be the base32 secret key, not the full `otpauth://` URL.

2. **Clock drift:** TOTP is time-sensitive. Check server clock:
   ```bash
   timedatectl status
   ```
   If the clock is off, fix with:
   ```bash
   sudo ntpdate pool.ntp.org
   ```

---

## Sync Reports Not Arriving

**Symptom:** No email reports after cron runs.

**Checks:**
1. Verify Postmark credentials in `.env`:
   ```bash
   grep POSTMARK .env
   grep OPERATOR_EMAIL .env
   ```
2. Verify sender email is verified in Postmark dashboard under Sender Signatures.
3. Test manually:
   ```bash
   node scripts/send-email.js logs/cron/sync-people-2026-01-15_08-00-00.log people
   ```

---

## Lock File Prevents Sync

**Symptom:**
```
Another people sync is running. Exiting.
```

**Cause:** A previous sync was interrupted (e.g., server restart, OOM kill) and the flock lock file wasn't released.

**Fix:**
```bash
rm /home/rondo/.sync-people.lock   # Or whichever sync type
```

**Note:** This is safe because flock automatically releases on process termination. A stale lock file only persists if the process was killed in an unusual way.

---

## Members Missing from Rondo Club

**Symptom:** Some members exist in Sportlink but don't appear in Rondo Club.

**Diagnosis:**
```bash
# Check if member exists in local database
node tools/show-sportlink-member.js member@example.com

# Check Rondo Club mapping
sqlite3 data/rondo-sync.sqlite "SELECT knvb_id, rondo_club_id, last_synced_at FROM rondo_club_members WHERE email = 'member@example.com'"
```

**Possible causes:**
1. **No `rondo_club_id` yet:** Member was downloaded but sync failed. Run `scripts/sync.sh people` to retry.
2. **Invalid `rondo_club_id`:** The WordPress post was deleted. Fix with:
   ```bash
   node tools/verify-rondo-club-data.js --fix --verbose
   ```
   Then re-run sync to recreate the member.
3. **Member has no email:** Sportlink members without an email address may be skipped.

---

## Invalid rondo_club_id Mappings

**Symptom:** Sync fails with 404 errors for specific members, or members appear to "recreate" every run.

**Cause:** The WordPress post was deleted outside the sync tool, but the local database still references the old post ID.

**Fix:**
```bash
# Verify which IDs are invalid
node tools/verify-rondo-club-data.js --verbose

# Fix by nullifying invalid IDs (they'll be recreated on next sync)
node tools/verify-rondo-club-data.js --fix --verbose

# Or use validate-rondo-club-ids for a simpler check
node tools/validate-rondo-club-ids.js              # Dry run
node tools/validate-rondo-club-ids.js --apply      # Fix invalid IDs
```

---

## Photos Not Syncing

**Symptom:** Member photos show in Sportlink but not in Rondo Club.

**Diagnosis:**
```bash
# Check photo state distribution
sqlite3 data/rondo-sync.sqlite "SELECT photo_state, COUNT(*) FROM rondo_club_members GROUP BY photo_state"

# Check consistency between files and database
node tools/check-photo-consistency.js --verbose
```

**Common issues:**

1. **Stuck in `pending_download`:** Photo URL may be expired. Fix:
   ```bash
   # Re-scrape photo URLs via functions sync
   scripts/sync.sh functions
   # Then run people sync to download/upload
   scripts/sync.sh people
   ```

2. **Files missing for `downloaded` state:** Files were cleaned up but state wasn't updated:
   ```bash
   node tools/check-photo-consistency.js --fix
   ```

3. **Members with photos marked `no_photo`:** State got out of sync:
   ```bash
   node tools/reset-photo-states.js         # Dry run
   node tools/reset-photo-states.js --apply  # Fix states
   ```

---

## Free Fields Missing After Functions Sync

**Symptom:** FreeScout ID, VOG date, or financial block data disappears from Rondo Club after a daily functions sync.

**Cause:** This was a critical bug (fixed in commit `9d0136e`): when the daily functions sync processed only a subset of members, it used `clear + replace` on database tables, wiping data for members not in the current run. The fix uses upsert-only for partial runs.

**If data was wiped:** Run a full functions sync to restore:
```bash
ssh root@46.202.155.16 "cd /home/rondo && node pipelines/sync-functions.js --all --verbose"
```

---

## Orphaned Relationships

**Symptom:** Relationships reference people who no longer exist.

**Fix:**
```bash
# Find orphaned relationships
node tools/cleanup-orphan-relationships.js --verbose
node tools/cleanup-orphan-relationships.js --fix     # Remove them

# Find duplicate relationships
node tools/cleanup-duplicate-relationships.js
```

**Note:** As of v2.3, birthdays sync as `fields.birthdate` on person records and no longer use separate `important_date` posts.

---

## Laposta Sync Shows Zero Changes

**Symptom:** `show-laposta-changes` shows no pending changes even though data has changed.

**Cause:** The prepare step may not have run. The sync pipeline runs in order: download → prepare → submit.

**Fix:**
```bash
# Re-prepare Laposta members from latest download
npm run prepare-laposta

# Check for changes now
npm run show-laposta-changes
```

---

## Database Corruption

**Symptom:** SQLite errors like "database is locked" or "malformed".

**Recovery options:**

1. **Database locked:** Usually caused by a sync process that didn't exit cleanly. Kill any lingering Node processes:
   ```bash
   pkill -f "node sync-" || true
   ```

2. **Database corrupted:** The simplest recovery is to delete the database and re-run a full sync. The databases are derived from source systems and can be rebuilt:
   ```bash
   # Back up first
   cp data/rondo-sync.sqlite data/rondo-sync.sqlite.bak

   # Delete and rebuild (this will create all members as new in Rondo Club!)
   # Only do this if you're certain - it may cause duplicate entries
   rm data/rondo-sync.sqlite
   scripts/sync.sh all
   ```

   **Warning:** Deleting `data/rondo-sync.sqlite` loses all `rondo_club_id` mappings. This means the next sync will create new WordPress posts instead of updating existing ones. Use `tools/repopulate-rondo-club-ids.js` afterward to restore mappings:
   ```bash
   node tools/repopulate-rondo-club-ids.js --verbose  # Dry run
   node tools/repopulate-rondo-club-ids.js             # Apply
   ```
