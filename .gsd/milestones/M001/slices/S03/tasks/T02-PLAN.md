# T02: 36-web-server-and-authentication 02

**Slice:** S03 — **Milestone:** M001

## Description

Deploy the web server to the production server: create user accounts, configure nginx with TLS, enable systemd service, and verify the full HTTPS login flow works in a real browser.

Purpose: Makes the authenticated web server live and accessible at https://sync.rondo.club.

Output: Running web server on production, accessible via HTTPS, with working login/session.

## Must-Haves

- [ ] "A user can navigate to https://sync.rondo.club and see the login page"
- [ ] "A user can log in with their credentials and their session persists across browser refreshes"
- [ ] "All dashboard routes redirect unauthenticated visitors to /login"
- [ ] "The web server process restarts automatically after a crash (systemd)"
- [ ] "The web server runs as the sportlink user, not root"
