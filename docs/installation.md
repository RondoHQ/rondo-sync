# Installation Guide

This guide covers setting up Rondo Sync from scratch on a fresh server.

## Prerequisites

### Server Requirements

- **OS:** Ubuntu/Debian Linux (tested on Ubuntu 22.04)
- **Node.js:** 18+ (required for built-in `fetch`, `FormData`, and `Blob`)
- **RAM:** 1 GB minimum (Chromium browser automation needs headroom)
- **Disk:** 2 GB free (for Node.js, Chromium, SQLite databases, photos, and logs)
- **Network:** Outbound HTTPS access to:
  - `club.sportlink.com` (Sportlink Club)
  - `api.laposta.nl` (Laposta email marketing)
  - Your Rondo Club WordPress instance
  - `api.postmarkapp.com` (email delivery)
  - `nikki-online.nl` (Nikki contributions, if used)
  - Your FreeScout instance (if used)

### External Accounts

You'll need credentials for:

| Service | What you need | Where to get it |
|---------|--------------|-----------------|
| Sportlink Club | Username, password, TOTP secret | Club administrator |
| Laposta | API key, list ID(s) | Laposta dashboard -> Account -> API |
| Rondo Club WordPress | URL, username, application password | WordPress admin -> Users -> Profile -> Application Passwords |
| Postmark | Server API token, verified sender email | Postmark dashboard -> Servers -> API Tokens |
| FreeScout (optional) | API key, instance URL | FreeScout admin panel |
| Nikki (optional) | API key, URL | Nikki administrator |

## Server Setup

### 1. Install Node.js

```bash
# Using NodeSource (recommended)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Verify
node --version  # Should be 18.x or higher
npm --version
```

### 2. Install System Dependencies

Playwright's Chromium needs these system libraries:

```bash
sudo apt-get install -y \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 \
  libcups2 libdrm2 libdbus-1-3 libxkbcommon0 \
  libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2
```

### 3. Clone and Install

```bash
cd /home
git clone <repository-url> rondo
cd rondo

# Install Node.js dependencies
npm install

# Install Chromium for browser automation
npx playwright install chromium
```

### 4. Create Environment File

Create `/home/rondo/.env` with your credentials:

```bash
# Sportlink credentials
SPORTLINK_USERNAME=your-email@example.com
SPORTLINK_PASSWORD=your-password
SPORTLINK_OTP_SECRET=your-totp-base32-secret

# Laposta
LAPOSTA_API_KEY=your-laposta-api-key
LAPOSTA_LIST=your-primary-list-id
LAPOSTA_LIST2=                         # Optional second list
LAPOSTA_LIST3=                         # Optional third list
LAPOSTA_LIST4=                         # Optional fourth list
LAPOSTA_TASK_ASSIGNEE_USER_ID=         # Optional: WP user ID for bounce/unsubscribe todos
LAPOSTA_TASK_ASSIGNEE_EMAIL=           # Optional fallback assignee lookup by WP user email

# Rondo Club WordPress
RONDO_URL=https://your-rondo-club-site.nl
RONDO_USERNAME=your-wp-username
RONDO_APP_PASSWORD=xxxx xxxx xxxx xxxx xxxx xxxx
RONDO_PERSON_TYPE=person

# Email delivery
OPERATOR_EMAIL=operator@example.com
POSTMARK_API_KEY=your-postmark-server-token
POSTMARK_FROM_EMAIL=verified-sender@example.com

# FreeScout (optional)
FREESCOUT_API_KEY=your-freescout-key
FREESCOUT_URL=https://your-freescout-instance.com

# Nikki (optional)
NIKKI_API_KEY=your-nikki-key
NIKKI_URL=https://nikki-online.nl

# Debug (optional)
DEBUG_LOG=false
```

### 5. Verify Installation

Run a test download to confirm Sportlink credentials work:

```bash
node steps/download-data-from-sportlink.js --verbose
```

This should:
1. Launch headless Chromium
2. Log into Sportlink Club
3. Handle TOTP 2FA
4. Download member data
5. Save results to `data/laposta-sync.sqlite`

If it fails, check:
- Credentials in `.env` are correct
- TOTP secret is the base32 secret (not the QR code URL)
- Chromium dependencies are installed (step 2)

### 6. Initial Full Sync

Run a full sync to populate all databases and downstream systems:

```bash
# Run the full sync (all pipelines)
node pipelines/sync-all.js --verbose
```

This takes a while on first run because:
- All members need to be created in Rondo Club (not just updated)
- All teams and commissies need to be created
- All photos need to be downloaded and uploaded
- All member birthdates need to be synced

Subsequent runs are much faster due to hash-based change detection.

### 7. Install Cron Jobs

Set up automated scheduling:

```bash
npm run install-cron
```

This prompts for Postmark credentials (if not already in `.env`) and installs cron entries:

| Schedule | Pipeline | Command |
|----------|----------|---------|
| 4x daily (8am, 11am, 2pm, 5pm) | People | `sync.sh people` |
| Daily 7:00 AM | Nikki | `sync.sh nikki` |
| Daily 8:00 AM | FreeScout | `sync.sh freescout` |
| 4x daily (7:30am, 10:30am, 1:30pm, 4:30pm) | Functions (recent) | `sync.sh functions` |
| Weekly Sunday 1:00 AM | Functions (full) | `sync.sh functions --all` |
| Weekly Sunday 6:00 AM | Teams | `sync.sh teams` |
| Weekly Monday 11:30 PM | Discipline | `sync.sh discipline` |

All times are Europe/Amsterdam timezone.

Verify with:

```bash
crontab -l
```

## Directory Structure After Install

```
/home/rondo/
├── .env                          # Credentials (not in git)
├── data/                         # SQLite databases (created on first run)
│   ├── laposta-sync.sqlite       # Laposta sync state
│   ├── rondo-sync.sqlite       # Rondo Club sync state
│   ├── nikki-sync.sqlite         # Nikki sync state
│   └── freescout-sync.sqlite     # FreeScout sync state
├── photos/                       # Downloaded member photos
├── logs/                         # Sync logs
│   └── cron/                     # Cron-specific logs
├── .sync-*.lock                  # Flock lock files (per sync type)
├── node_modules/                 # Dependencies
├── lib/                          # Shared modules
├── scripts/                      # Shell scripts and utilities
├── docs/                         # Documentation
└── *.js                          # Sync scripts
```

## Updating

To deploy code updates:

```bash
cd /home/rondo
git pull
npm install  # Only needed if dependencies changed
```

## Rondo Club WordPress Requirements

The Rondo Club WordPress site needs:

- **ACF Pro** plugin for custom fields and REST API integration
- **Rondo Club theme** with custom post types: `person`, `team`, `commissie`, `discipline_case`
- **REST API** enabled with `show_in_rest` on all custom post types and ACF field groups
- **Application Passwords** enabled for the sync user
- Custom endpoints provided by the Rondo Club theme:
  - `GET /wp-json/rondo/v1/people/filtered` (for VOG-filtered volunteers)
  - `POST /wp-json/rondo/v1/people/{id}/photo` (for photo uploads)
  - `GET /wp-json/rondo/v1/current-season` (for discipline cases)

Refer to `~/Code/rondo/rondo-club/docs/` for full Rondo Club API documentation.

## Troubleshooting

### Chromium won't start

```
Error: browserType.launch: Executable doesn't exist
```

Run `npx playwright install chromium` to install/reinstall the browser.

### TOTP authentication fails

- Ensure `SPORTLINK_OTP_SECRET` is the **base32 secret key**, not the full otpauth:// URL
- Check that the server's clock is synchronized (TOTP is time-sensitive):
  ```bash
  timedatectl status
  ```

### Duplicate entries in Rondo Club

This happens when sync runs from multiple machines (each has its own SQLite database with different `rondo_club_id` mappings). **Always sync from the production server only.**

To clean up duplicates:
```bash
node tools/delete-duplicates.js --verbose      # Dry run
node tools/delete-duplicates.js --apply         # Actually delete
```

### Sync reports not arriving

Check Postmark credentials in `.env` and verify the sender email is verified in Postmark dashboard.

### Lock file prevents sync

If a sync was interrupted (e.g., server restart), the lock file may remain:
```bash
rm /home/rondo/.sync-people.lock  # Remove stale lock
```
