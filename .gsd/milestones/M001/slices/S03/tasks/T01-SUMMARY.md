---
id: T01
parent: S03
milestone: M001
provides:
  - Fastify web server with session-based authentication
  - User management via JSON config file with Argon2id password hashing
  - Login/logout handlers with session fixation prevention
  - Rate-limited login endpoint (5 attempts per minute per IP)
  - SQLite-backed sessions with 7-day expiry
  - Minimal login UI (EJS template with centered form)
  - Dashboard placeholder route (Phase 37 will replace)
  - Systemd service configuration for production deployment
  - Nginx reverse proxy configuration with TLS placeholders
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 3.4min
verification_result: passed
completed_at: 2026-02-09
blocker_discovered: false
---
# T01: 36-web-server-and-authentication 01

**# Phase 36 Plan 01: Web Server and Authentication Summary**

## What Happened

# Phase 36 Plan 01: Web Server and Authentication Summary

**Fastify server with Argon2id auth, SQLite sessions, rate-limited login, systemd service, and nginx reverse proxy**

## Performance

- **Duration:** 3.4 min
- **Started:** 2026-02-09T09:19:07Z
- **Completed:** 2026-02-09T09:22:32Z
- **Tasks:** 2
- **Files modified:** 12

## Accomplishments

- Fastify web server with all plugins registered (session, cookie, static, rate-limit, formbody, view)
- Session-based authentication with Argon2id password verification and SQLite session persistence
- Login UI with minimal, functional design (centered form, error display)
- Rate limiting on login endpoint (5 attempts per minute per IP)
- Production deployment configs (systemd unit file, nginx reverse proxy)

## Task Commits

Each task was committed atomically:

1. **Task 1: Install dependencies and create Fastify web server with authentication** - `d5c4304` (feat)
2. **Task 2: Create systemd and nginx deployment configs** - `5c00932` (chore)

## Files Created/Modified

**Created:**
- `lib/web-server.js` - Fastify server setup with plugin registration and routes
- `lib/auth.js` - Authentication logic (requireAuth hook, login/logout handlers)
- `lib/user-config.js` - Load and validate user configuration from JSON file
- `views/login.ejs` - Minimal login page template
- `public/style.css` - Functional styles for login and dashboard
- `scripts/hash-password.js` - CLI utility to generate Argon2id password hashes
- `config/users.example.json` - Example user configuration file
- `systemd/rondo-sync-web.service` - Systemd unit file (non-root, restart policy)
- `nginx/sync.rondo.club.conf` - Nginx reverse proxy configuration

**Modified:**
- `package.json` - Added Fastify and authentication dependencies
- `package-lock.json` - Dependency lockfile updated
- `.gitignore` - Excluded config/users.json (contains password hashes)

## Decisions Made

**1. SQLite session store**
- Rationale: Persistence across restarts, no memory leak (default in-memory store leaks), single server sufficient for 2-5 users
- Alternative considered: Redis (adds external dependency, overkill for this scale)

**2. Argon2id password hashing**
- Rationale: OWASP recommended, memory-hard (resistant to GPU attacks), secure defaults
- Alternative considered: bcrypt (still secure but Argon2 is current best practice)

**3. Pre-hashed passwords in users.json**
- Rationale: Passwords never in plain text, even during setup. Generated via hash-password.js utility
- Alternative considered: Runtime hashing (would require storing plain passwords temporarily)

**4. Rate limiting: 5 attempts per minute per IP**
- Rationale: Balance between security (prevent brute force) and usability (allow typos)
- Implementation: Per-route config on POST /login, uses X-Forwarded-For header behind nginx

**5. Session fixation prevention**
- Rationale: OWASP best practice - regenerate session ID on login to prevent session hijacking
- Implementation: `request.session.regenerate()` in loginHandler

**6. Non-root systemd service**
- Rationale: INFRA-04 requirement - web server runs as sportlink user, not root
- Security hardening: NoNewPrivileges=true, PrivateTmp=true

## Deviations from Plan

**Auto-fixed Issues:**

**1. [Rule 3 - Blocking] Fixed SqliteStore initialization**
- **Found during:** Task 1 verification (server startup)
- **Issue:** SqliteStore constructor expected Database instance directly, not wrapped in object. Error: "sqlite3db.exec is not a function"
- **Fix:** Changed `new SqliteStore({ db: new Database(...) })` to `new SqliteStore(new Database(...))`
- **Files modified:** lib/web-server.js
- **Verification:** Server started successfully, health endpoint returned 200
- **Committed in:** d5c4304 (Task 1 commit, after inline fix)

---

**Total deviations:** 1 auto-fixed (1 blocking issue)
**Impact on plan:** Fix was necessary to unblock verification. No scope creep - corrected API usage for third-party library.

## Issues Encountered

None beyond the SqliteStore API usage (documented in Deviations).

## User Setup Required

**Server deployment requires manual steps. See 36-02-PLAN.md for:**
- Add SESSION_SECRET to .env on server (min 32 chars)
- Create config/users.json with hashed passwords
- Copy nginx config to /etc/nginx/sites-available/ and enable
- Run certbot for TLS certificate
- Copy systemd service to /etc/systemd/system/ and enable
- Start and verify web server

**Local testing:**
- Set SESSION_SECRET env var (min 32 chars)
- Create config/users.json with test user
- Run: `node lib/web-server.js`
- Verify: curl http://127.0.0.1:3000/health

## Next Phase Readiness

**Ready for Plan 36-02 (Server Deployment):**
- All application code complete and tested
- Systemd and nginx configs ready to deploy
- Health check endpoint available for verification

**Ready for Phase 37 (Dashboard UI):**
- Authentication infrastructure in place
- requireAuth hook available for protecting dashboard routes
- Session data accessible via `request.session.user`
- Dashboard placeholder at / ready to be replaced with real UI

**No blockers or concerns.**

---
*Phase: 36-web-server-and-authentication*
*Completed: 2026-02-09*
