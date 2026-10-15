# Rondo GlitchTip operations

GlitchTip runs in `/opt/glitchtip` on the Rondo Sync VPS. Nginx serves
`https://errors.rondo.club` with a Certbot certificate and proxies to loopback
port 8000. Docker restarts both containers after reboot. GlitchTip has a 1.5 GiB
memory limit and one CPU; PostgreSQL has a 512 MiB memory limit.

The private `postgres.env` and `glitchtip.env` files are provisioned on the server,
not in Git. GlitchTip uses the `all_in_one` command, a 30-day event retention period,
and `lettermint_backend.EmailBackend`. Open registration and organization creation
are disabled. Do not print or copy environment files into tickets or logs.

The projects are `rondo-react`, `rondo-wordpress`, and `rondo-sync`. Club reads the
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

`rondo-glitchtip-backup.timer` runs daily around 04:20 server time. The private
archives in `/opt/glitchtip/backups` contain a PostgreSQL custom-format dump,
uploads, performance cold storage, Compose configuration and secret environment files. Retention is 14 days.
These are **local backups**; a lost VPS also loses these archives. Existing external
Rondo Sync heartbeat monitoring remains in place to detect a lost VPS.

Check with `systemctl status rondo-glitchtip-backup.timer` and
`journalctl -u rondo-glitchtip-backup.service`. Run `/opt/glitchtip/backup.sh` before
an upgrade. Restore the dump to a separate database first and verify it before
switching production. Restore `uploads.tar` into the uploads volume and keep the
original GlitchTip secret key when restoring the environment.

The initial database backup was restored into a temporary database and its three
projects were verified. TLS, SDK ingestion, privacy filtering and frontend source
resolution are checked separately from deployment success.

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
