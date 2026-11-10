# srv1 backups on the mini

The mini pulls srv1 every six hours (00:30, 06:30, 12:30, 18:30 in its local
Europe/Amsterdam timezone), then stores an encrypted restic snapshot. srv1 has
no key, password, or filesystem access to the repository on the mini.

The export includes production and demo WordPress files, uploads, credentials,
current deployed themes, sync code/configuration/photos/data, and server
configuration. MySQL uses separate InnoDB transaction-consistent dumps. SQLite
uses its online backup API, including committed WAL data, with integrity checks.
These are individually consistent databases, not a globally atomic snapshot of
all applications. Logs, caches, dependencies, old deployment releases, and the
one-time migration archives are excluded. Git and the package inventory support
reinstalling dependencies; the frozen migration archives remain on srv1.

The tar export preserves Linux ownership, permissions, ACLs and extended
attributes. SQLite files are stored separately with original ownership/mode in
the manifest. The mini checks the export SHA-256 before encrypting it and deletes
its plaintext incoming copy afterwards. Only the newest three completed exports
are retained locally on srv1.

## Hourly local production database backups

`rondo-prod-db-backup.timer` also backs up **only `rondo.svawc.nl`'s database**
on srv1 at ten minutes past every hour (Europe/Amsterdam), independently of the
mini. `Persistent=true` catches up after server downtime. It retains seven days
under `/var/lib/rondo-backup/hourly-mysql/rondo_prod/` with root-only permissions.

Each timestamped directory contains `database.sql.gz` and a checksum/table-count
manifest. The job uses the same transaction-consistent MySQL exporter as the
off-server backups, verifies the complete gzip stream, publishes the directory
atomically, then removes only its own expired snapshots. A failed dump or failed
verification never prunes older backups. These local copies are not encrypted;
the encrypted backups on the mini still provide the separate off-server copy.

Check `systemctl status rondo-prod-db-backup.timer` and
`journalctl -u rondo-prod-db-backup.service`. To run a backup immediately, use
`sudo systemctl start rondo-prod-db-backup.service`. Restore testing must import
the decompressed SQL into a disposable database, never the live database.

## Locations and access

- srv1 scripts: `/usr/local/libexec/rondo-backup/`
- srv1 export directory: `/var/lib/rondo-backup/exports/`, root-only
- mini scripts: `/Users/joost/.local/lib/rondo-backup/`
- mini repository: `/Users/joost/Library/Application Support/Rondo Backup/repository`
- mini config: `/Users/joost/.config/rondo-backup/`, mode 0700
- mini status: `/Users/joost/Library/Application Support/Rondo Backup/status.json`
- mini launch agent: `club.rondo.srv1-backup`
- mini logs: `/Users/joost/Library/Logs/rondo-backup{,-error}.log`

The dedicated `rondo-backup` SSH account accepts only `prepare` and read-only
rsync through a forced command. Its sudo permission is restricted to the
root-owned command dispatcher. It cannot request a shell, forward ports, upload
files, or delete exports. The SSH known-host entry is copied from the host key
verified through the existing administrator connection.

Retain all snapshots for two days, then 14 daily, eight weekly and twelve monthly
restore points. Restic checks repository metadata every run and reads all stored
data weekly. Failures exit nonzero and are recorded in `status.json`, preserving
the previous success timestamp. This does not send email or external alerts.
Check the status timestamp as well as launchd's exit code. The agent needs the
mini running, online, and the `joost` login session available; `RunAtLoad` catches
up after login. The first install also runs an immediate backup.

The mini initially had 48 GiB free. Each run requires at least 12 GiB free before
starting. Retention does not guarantee a fixed disk footprint; monitor free
space and move the repository to a larger drive if growth requires it.

## Recover a snapshot

On the mini, set these variables in the shell (they contain paths, not secrets):

```sh
export RESTIC_REPOSITORY="$HOME/Library/Application Support/Rondo Backup/repository"
export RESTIC_PASSWORD_FILE="$HOME/.config/rondo-backup/password"
/opt/homebrew/bin/restic snapshots
/opt/homebrew/bin/restic restore SNAPSHOT_ID --target /private/tmp/rondo-restore --verify
```

The restored `srv1.tar` is under the snapshot's original incoming-directory path.
Check it against the adjacent `export.json` SHA-256. Extract only into an isolated,
private directory for inspection, never over a live installation.

For full recovery on a replacement Linux host:

1. Recreate service accounts with the backed-up numeric UIDs/GIDs and install
   the required packages/runtime versions from `packages.tsv`.
2. Extract the tar with GNU tar `--acls --xattrs --same-owner` into a private
   recovery directory. Review host-specific paths before copying `files/` to `/`.
3. Import each `databases/mysql/*.sql` into its own empty MySQL database using
   the preserved database credentials/configuration. Do not import into a live
   database. Validate tables and the WordPress `home`/`siteurl` values.
4. Restore `databases/sqlite/srv/rondo-sync/` over the corresponding application
   files, with UID/GID/mode from `manifest.json`. Remove stale WAL/SHM files on the
   replacement only. Run `PRAGMA integrity_check` on restored databases.
5. Install Node dependencies and the required Playwright browser; deployed themes
   are backed up as ordinary directories. Reestablish atomic deployment layout
   through the deployment workflow when appropriate.
6. Keep cron, mail and sync writes disabled until private verification passes.
   Reopen only one application origin as writer, then restore DNS and schedules.

The repository password is also retained outside the mini in the operator's
private recovery directory. Losing both copies makes the backups unrecoverable.
Never commit the password, SSH private key, exported SQL, tar files or member data.

## Verification

Run `python3 -m unittest discover -s ops/backups/tests` for the SQLite/WAL backup
regressions. The initial live restore must download/decrypt a real restic snapshot,
verify its export checksum, check the restored SQLite databases, and import both
MySQL dumps into disposable isolated schemas before claiming recovery works.
