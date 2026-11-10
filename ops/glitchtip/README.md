# Rondo GlitchTip operations

GlitchTip runs in `/opt/glitchtip` on **yolo1** (`dev1.yolo.online`,
`81.24.10.124`). Connect with `ssh yolo1` and use `sudo` for operations. Nginx serves
`https://errors.rondo.club` with a Certbot certificate and proxies to loopback
port 8000. Docker restarts both containers after reboot. GlitchTip has a 1.5 GiB
memory limit and one CPU; PostgreSQL has a 512 MiB memory limit.

The host runs AlmaLinux 8 with Plesk. Docker packages come from Docker's RHEL
repository; the CentOS 8 repository stops at an older Docker release. Both
container images are pinned to the versions transferred during migration.
The Lettermint bind mount uses `:ro,Z` for SELinux compatibility.

The proxy is `/etc/nginx/conf.d/glitchtip.conf`, outside Plesk's generated
configuration. Certbot uses the `/var/www/letsencrypt` HTTP challenge webroot.
`certbot-renew.timer` handles renewal, and the deploy hook in
`/etc/letsencrypt/renewal-hooks/deploy/reload-glitchtip-nginx.sh` validates and
reloads nginx. Check renewal with
`sudo certbot renew --cert-name errors.rondo.club --dry-run`.

The private `postgres.env` and `glitchtip.env` files are provisioned on the server,
not in Git. GlitchTip uses the `all_in_one` command, a 30-day event retention period,
and `lettermint_backend.EmailBackend`. Open registration and organization creation
are disabled. Do not print or copy environment files into tickets or logs.

The Rondo projects include `rondo-react`, `rondo-wordpress`, and `rondo-sync`. Club reads the
`RONDO_GLITCHTIP_REACT_DSN`, `RONDO_GLITCHTIP_DSN`, and
`RONDO_GLITCHTIP_ENVIRONMENT` WordPress constants. Sync reads `GLITCHTIP_DSN`
and `GLITCHTIP_ENVIRONMENT` from its existing private environment.

Club Actions uses the `GLITCHTIP_AUTH_TOKEN` repository secret. Its permissions
are limited to `org:read`, `project:read`, and `project:releases`. Production builds
upload hidden sourcemaps and fail if the token is absent or map files remain.
PHP's MU-plugin loads the SDK before normal plugins and reads the release version
from the current theme, including after a rollback.

Only allowlisted diagnostic metadata is sent. Raw messages, member data, request
headers, request bodies and breadcrumbs stay out of events. Use private application
logs for original messages. Monitoring failures must not interrupt normal syncs.

`/health` checks the Sync dashboard. `/health/sync` checks completed runs against
editable schedules: interval jobs have one hour of grace, other jobs four hours.
Disabled/manual schedules and newly changed schedules before their first due slot
are exempt. Completed partial runs count as active; their errors are tracked
separately. Failed or missing runs return 503. The route exposes aggregate status only.

## Backups and maintenance

`rondo-glitchtip-backup.timer` runs daily around 04:20 Europe/Amsterdam, regardless
of the host timezone. The private
archives in `/opt/glitchtip/backups` contain a PostgreSQL custom-format dump,
uploads, performance cold storage, Compose configuration and secret environment files. Retention is 14 days.
These are **local backups**; a lost yolo1 also loses these archives. Rondo Sync's
separate heartbeat monitors do not monitor the GlitchTip host.

Check with `systemctl status rondo-glitchtip-backup.timer` and
`journalctl -u rondo-glitchtip-backup.service`. Run `/opt/glitchtip/backup.sh` before
an upgrade. Restore the dump to a separate database first and verify it before
switching production. Restore `uploads.tar` into the uploads volume and keep the
original GlitchTip secret key when restoring the environment.

TLS, SDK ingestion, privacy filtering and frontend source resolution are checked
separately from deployment success.

## Migration from the old Sync host

On 2026-11-10, GlitchTip 6.2.6 and PostgreSQL 18 were moved from
`rondo-sync-old` (`46.202.155.16`) to yolo1 without changing the public hostname,
project keys, API tokens or application secret. All ten projects were preserved.
Every database table count and SHA256 checksum of files in the uploads and
cold-storage volumes matched the final snapshot before starting the new worker.
The authenticated API, public transaction ingestion and a new backup were tested.

Both old GlitchTip containers are stopped, its backup timer is disabled, and its
certificate renewal configuration is archived. The old nginx virtual host forwards
cached-DNS traffic to yolo1 over certificate-verified HTTPS. Viscerno remains on
the old host; this migration does not make that server ready for retirement.

The source containers, volumes, backup history and final snapshot remain available
for recovery. Private migration files live in `/opt/glitchtip/migration-20261110`
on both hosts. **Do not start the stale source copy.** A rollback after cutover must
first pause ingestion on yolo1 and transfer its current database, uploads and cold
storage back. Then restore the original proxy, renewal configuration and backup
timer and change DNS. Starting the pre-migration snapshot would discard new data.

## Performance monitoring

Club React and website page views sample 10%; PHP REST requests inherit a parent
sampling decision or sample 10%. Sync sends one transaction per completed run and
step, including long steps, using the existing RunTracker timestamps. It sends
aggregate created/updated/skipped/failed counts, never a member-level span.
All SDKs use the static transaction envelope supported by the deployed server.
Performance payloads have separate allowlist filters; error-event filters do not
protect transactions. No request bodies, query strings, user fields or raw SQL
are collected. Route parameters become placeholders.

Disable independently with WordPress constants `RONDO_GLITCHTIP_REACT_PERFORMANCE`
and `RONDO_GLITCHTIP_PHP_PERFORMANCE` (false), Sync `GLITCHTIP_PERFORMANCE=false`,
website build variable `PUBLIC_GLITCHTIP_PERFORMANCE=false`, and Pages runtime
`GLITCHTIP_PERFORMANCE=false`. Error reporting remains enabled. The website
contact handler samples all POST requests subject to a soft 1,000/day KV budget;
KV's eventual consistency means concurrent requests can exceed that budget.
If its dedicated PERFORMANCE_BUDGET binding is absent/unavailable, contact traces are dropped.

Set `GLITCHTIP_TRANSACTION_RETENTION_DAYS=14` and
`GLITCHTIP_SPAN_RAW_RETENTION_DAYS=14` in the private GlitchTip environment;
keep error retention at 30 days. Back up before recreating the web container.
After rollout verify TransactionGroup counts, recent span names, and storage
usage on the server. Incoming HTTP success alone does not prove ingestion.

Detailed spans require `GLITCHTIP_ENABLE_DUCKDB=true` and
`GLITCHTIP_COLD_STORAGE_DIR=/code/cold-storage`. The dedicated `cold-storage`
Docker volume must be owned by the image app user (5000:5000); it is not served
by the public web server. The existing daily backup includes `cold-storage.tar`;
restore it into that volume alongside the database and uploads. DuckDB also
handles event archival using the existing 30-day error retention. The same
1.5 GiB container memory limit remains in force.
