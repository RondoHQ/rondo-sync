# Rondo Sync

CLI tool that synchronizes member data from Sportlink Club to Laposta email marketing lists, Rondo Club WordPress, FreeScout, and more.

## Quick Reference

```bash
scripts/sync.sh people           # 4x daily: members, parents, photos
scripts/sync.sh nikki            # Daily: Nikki contributions to Rondo Club
scripts/sync.sh freescout        # Daily: FreeScout customer sync
scripts/sync.sh teams            # Weekly: team sync + work history
scripts/sync.sh functions        # 4x daily: commissies + free fields (recent updates)
scripts/sync.sh functions --all  # Weekly: full commissies sync (all members)
scripts/sync.sh discipline       # Weekly: discipline cases
scripts/sync.sh all              # Full sync (all pipelines)
npm run install-cron             # Set up automated sync schedules
```

## Documentation

Detailed documentation lives in the **Rondo Developer docs site** (`~/Code/rondo/developer/`), under the `src/content/docs/sync/` section. Update docs there, not in this repo's `docs/` directory.

Run the dev server: `cd ~/Code/rondo/developer && npm run dev` → http://localhost:4321/sync/architecture/

## CRITICAL: Never Run Sync Locally

**Sync scripts must only run on the production server.** Running locally causes duplicate entries because each machine has its own SQLite database with different `rondo_club_id` mappings.

```bash
ssh root@46.202.155.16
cd /home/rondo
scripts/sync.sh people    # or any other pipeline
```

Deploy code: `git push` then `ssh root@46.202.155.16 "cd /home/rondo && git pull"`

## Claude specific instructions
Prefer Read over `cat`, Grep over `grep/rg` in Bash, and Glob over `find` in Bash. Use Bash only for: running tests, executing build commands, git operations, and multi-step shell scripts. 

## Remote Server

IP: `46.202.155.16`, path: `/home/rondo/`
Login with the user's SSH key.

## Environment Variables

Required in `.env`:

```bash
SPORTLINK_USERNAME=          # Sportlink Club login
SPORTLINK_PASSWORD=          # Sportlink Club password
SPORTLINK_OTP_SECRET=        # TOTP secret for 2FA (base32)
LAPOSTA_API_KEY=             # Laposta API key
LAPOSTA_LIST=                # Primary Laposta list ID
LAPOSTA_LIST2=               # Optional additional lists (up to 4)
RONDO_URL=                   # WordPress site URL (https://...)
RONDO_USERNAME=              # WordPress username
RONDO_APP_PASSWORD=          # WordPress application password
RONDO_PERSON_TYPE=person     # Custom post type
OPERATOR_EMAIL=              # Receives sync reports
LETTERMINT_API_TOKEN=        # Lettermint API token
LETTERMINT_FROM_EMAIL=       # Verified sender email
FREESCOUT_API_KEY=           # FreeScout API key (optional)
FREESCOUT_URL=               # FreeScout URL (optional)
NIKKI_API_KEY=               # Nikki API key (optional)
NIKKI_URL=                   # Nikki URL (optional)
SYNC_API_KEY=                # API key for programmatic sync endpoints (used by Rondo Club)
```

## Directory Layout

```
pipelines/     Pipeline orchestrators (entry points called by sync.sh)
steps/         Pipeline step scripts (download-*, prepare-*, submit-*, upload-*)
tools/         Inspection + maintenance scripts (show-*, cleanup-*, validate-*)
lib/           Shared libraries (DB layers, API clients, utilities)
config/        Configuration files (field-mapping.json, sportlink-fields.json)
scripts/       Shell scripts (sync.sh, install-cron.sh) + send-email.js
docs/          Documentation
```

## Code Patterns

### Module/CLI Hybrid

All scripts export functions AND work as CLI:

```javascript
async function runDownload(options) { /* ... */ }
module.exports = { runDownload };
if (require.main === module) { runDownload({ verbose: true }); }
```

### Logging

```javascript
const { createSyncLogger } = require('../lib/logger');
const logger = createSyncLogger({ verbose });
logger.log('Always shown');
logger.verbose('Only in verbose mode');
logger.error('Error messages');
```

### Error Handling

- Graceful failures with detailed logging
- Each pipeline step is non-critical (failures don't stop the pipeline)
- Exit codes: 0 = success, 1 = errors occurred

## Rondo Club API Gotchas

**Required fields on ACF updates:** When updating a person via PUT, `first_name` and `last_name` are always required, even for single-field updates. Partial ACF updates require a GET first.

**Rondo Club API docs** are in the developer docs site at `~/Code/rondo/developer/src/content/docs/api/`.

## Documentation Maintenance

After functional changes, update:
- `README.md` - User-facing docs
- `CLAUDE.md` - This file (AI assistant context)
- Relevant docs in `~/Code/rondo/developer/src/content/docs/sync/` (the developer docs site)

## Tech Stack

Node.js 18+, Playwright (Chromium), better-sqlite3, otplib (TOTP), lettermint, dotenv (env loading).
