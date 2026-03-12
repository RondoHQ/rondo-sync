# S03: Web Server And Authentication

**Goal:** Create the complete Fastify web server application with session-based authentication, login UI, password hashing utility, and deployment configuration files (systemd + nginx).
**Demo:** Create the complete Fastify web server application with session-based authentication, login UI, password hashing utility, and deployment configuration files (systemd + nginx).

## Must-Haves


## Tasks

- [x] **T01: 36-web-server-and-authentication 01** `est:3.4min`
  - Create the complete Fastify web server application with session-based authentication, login UI, password hashing utility, and deployment configuration files (systemd + nginx).

Purpose: Builds all application code and config files for Phase 36. After this plan, the web server can be started locally for testing and is ready for server deployment.

Output: Working Fastify server with login/logout, session persistence, rate limiting, plus systemd and nginx config files ready for production deployment.
- [x] **T02: 36-web-server-and-authentication 02** `est:5min`
  - Deploy the web server to the production server: create user accounts, configure nginx with TLS, enable systemd service, and verify the full HTTPS login flow works in a real browser.

Purpose: Makes the authenticated web server live and accessible at https://sync.rondo.club.

Output: Running web server on production, accessible via HTTPS, with working login/session.

## Files Likely Touched

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
