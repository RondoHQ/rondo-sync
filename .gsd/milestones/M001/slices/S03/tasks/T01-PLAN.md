# T01: 36-web-server-and-authentication 01

**Slice:** S03 — **Milestone:** M001

## Description

Create the complete Fastify web server application with session-based authentication, login UI, password hashing utility, and deployment configuration files (systemd + nginx).

Purpose: Builds all application code and config files for Phase 36. After this plan, the web server can be started locally for testing and is ready for server deployment.

Output: Working Fastify server with login/logout, session persistence, rate limiting, plus systemd and nginx config files ready for production deployment.

## Must-Haves

- [ ] "Fastify server starts on localhost:3000, serves login page at /login"
- [ ] "Unauthenticated requests to / redirect to /login"
- [ ] "Valid credentials (from users.json) create session, redirect to /"
- [ ] "Invalid credentials show generic error on login page"
- [ ] "Session persists across requests (cookie-based, SQLite-backed)"
- [ ] "Logout destroys session and redirects to /login"
- [ ] "Login endpoint is rate-limited (5/min per IP)"
- [ ] "hash-password.js utility generates Argon2id hashes"

## Files

- `package.json`
- `.gitignore`
- `lib/web-server.js`
- `lib/auth.js`
- `lib/user-config.js`
- `views/login.ejs`
- `public/style.css`
- `scripts/hash-password.js`
- `config/users.example.json`
- `systemd/rondo-sync-web.service`
- `nginx/sync.rondo.club.conf`
