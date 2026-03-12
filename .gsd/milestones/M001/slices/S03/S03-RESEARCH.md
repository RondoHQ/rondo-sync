# Phase 36: Web Server and Authentication - Research

**Researched:** 2026-02-08
**Domain:** Node.js web server with authentication (Fastify, sessions, TLS, systemd)
**Confidence:** HIGH

## Summary

Phase 36 implements an authenticated Fastify web server accessible via HTTPS at sync.rondo.club. The standard stack for this in 2026 consists of Fastify v5 as the web framework, @fastify/session with an SQLite session store for authentication, argon2 for password hashing, nginx as a TLS-terminating reverse proxy, and systemd for process management. The user has decided on a JSON config file for user management (2-5 users, no roles, no admin UI), unlimited concurrent sessions, and a minimal login UI.

The architecture follows proven patterns: nginx handles TLS termination on port 443 and proxies to Fastify on localhost (not directly exposed), systemd manages the Node.js process as a non-root user with automatic restart on crash, sessions persist via secure httpOnly cookies stored in SQLite, and all dashboard routes use preHandler hooks to enforce authentication. Rate limiting prevents brute-force attacks on the login endpoint.

Critical security considerations include never running as root (INFRA-04 requirement), using Argon2id for password hashing (AUTH-02), securing session cookies (httpOnly, secure, SameSite), implementing rate limiting on login, and ensuring the web server cannot read Sportlink/Laposta API credentials.

**Primary recommendation:** Use @fastify/session with fastify-session-better-sqlite3-store, argon2 for password hashing with default secure settings, nginx with Let's Encrypt for TLS, and systemd with Restart=on-failure policy. Keep the implementation simple and follow the minimal design decisions from CONTEXT.md.

## Standard Stack

The established libraries/tools for Node.js authenticated web servers in 2026:

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| fastify | ^5.x | Web framework | Official Fastify v5 is current stable; fast, low overhead, strong TypeScript/plugin ecosystem |
| @fastify/session | ^11.1.1+ | Session management | Official Fastify session plugin, supports external stores, battle-tested |
| @fastify/cookie | (dependency) | Cookie parsing | Required by @fastify/session, official Fastify plugin |
| argon2 | ^0.44.0+ | Password hashing | Industry standard for Argon2id hashing, OWASP recommended, native bindings for performance |
| better-sqlite3 | latest | SQLite database | Already in use (Phase 35), synchronous API, production-ready |
| fastify-session-better-sqlite3-store | latest | Session store | Integrates @fastify/session with better-sqlite3 |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| @fastify/static | latest | Serve static files | Required for CSS, client-side JS if needed |
| @fastify/view | latest | Template rendering | Optional: if using EJS/Handlebars for server-rendered login page |
| @fastify/rate-limit | latest | Rate limiting | Essential for login endpoint protection |
| ejs | latest | Template engine | If using server-rendered templates (alternative: hand-written HTML) |

### Infrastructure

| Tool | Purpose | Why Standard |
|------|---------|--------------|
| nginx | Reverse proxy + TLS termination | Industry standard, handles TLS better than Node.js, widely understood |
| certbot | Let's Encrypt automation | Official Let's Encrypt client, automatic renewal |
| systemd | Process management | Standard Linux init system, reliable restart policies |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| @fastify/session | @fastify/secure-session | Stateless (encrypted cookie) vs stateful (SQLite). Stateless means no session invalidation capability, but simpler (no store needed). User decided on SQLite store approach. |
| argon2 | bcrypt | Argon2id is newer, memory-hard, resistant to GPU attacks. bcrypt still secure but Argon2 is current OWASP recommendation. |
| SQLite session store | Redis + @fastify/rate-limit-redis | Redis adds external dependency. SQLite sufficient for 2-5 users, single server. |
| nginx | Caddy | Caddy has automatic HTTPS but less familiar. nginx is production standard on this server. |
| systemd | PM2 | PM2 adds Node.js dependency. systemd is native Linux, already managing cron jobs. |

**Installation:**
```bash
npm install fastify @fastify/session @fastify/cookie @fastify/static @fastify/rate-limit argon2 fastify-session-better-sqlite3-store
# ejs only if using templates (optional)
npm install ejs @fastify/view
```

## Architecture Patterns

### Recommended Project Structure

```
lib/
├── web-server.js          # Fastify server setup and lifecycle
├── auth.js                # Authentication logic (login, session check)
├── user-config.js         # Load/validate user config JSON
├── dashboard-db.js        # Already exists (Phase 35)
└── run-tracker.js         # Already exists (Phase 35)

views/                     # Optional: if using templates
├── login.ejs              # Login page
└── layout.ejs             # Optional layout

public/                    # Static assets
└── style.css              # Optional minimal CSS

config/
└── users.json             # User configuration (server only, not in git)

scripts/
└── hash-password.js       # Utility: generate Argon2 hashes for users.json

systemd/
└── rondo-sync-web.service # Systemd unit file

nginx/
└── sync.rondo.club.conf   # Nginx site config (example)
```

### Pattern 1: Session-Based Authentication with preHandler Hook

**What:** Use @fastify/session to persist login state, preHandler hook to protect routes

**When to use:** Standard session-based authentication for traditional web apps (not APIs)

**Example:**
```javascript
// Source: https://github.com/fastify/session + https://kevincunningham.co.uk/posts/protect-fastify-routes-with-authorization/

const fastify = require('fastify')();
const fastifySession = require('@fastify/session');
const fastifyCookie = require('@fastify/cookie');
const SqliteStore = require('fastify-session-better-sqlite3-store');
const Database = require('better-sqlite3');

// Register session plugin
fastify.register(fastifyCookie);
fastify.register(fastifySession, {
  secret: process.env.SESSION_SECRET, // min 32 chars
  cookie: {
    httpOnly: true,
    secure: true,       // HTTPS only (nginx terminates TLS)
    sameSite: 'lax',    // CSRF protection
    maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
  },
  store: new SqliteStore({
    db: new Database('./data/sessions.sqlite')
  })
});

// Authentication check hook
async function requireAuth(request, reply) {
  if (!request.session.user) {
    return reply.redirect('/login');
  }
}

// Protected route
fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
  return reply.send({ message: 'Dashboard' });
});
```

### Pattern 2: Argon2id Password Hashing

**What:** Hash passwords with Argon2id using default secure settings

**When to use:** All password storage (users.json uses pre-hashed passwords)

**Example:**
```javascript
// Source: https://www.npmjs.com/package/argon2

const argon2 = require('argon2');

// Hash a password (use script, NOT in web server)
async function hashPassword(password) {
  // Default options are secure (timeCost, memoryCost, parallelism)
  const hash = await argon2.hash(password);
  return hash; // Store this in users.json
}

// Verify password (in web server login handler)
async function verifyPassword(hash, password) {
  try {
    return await argon2.verify(hash, password);
  } catch (err) {
    return false; // Hash malformed or verification failed
  }
}
```

### Pattern 3: Rate Limiting on Login Endpoint

**What:** Limit login attempts per IP to prevent brute force

**When to use:** All authentication endpoints

**Example:**
```javascript
// Source: https://github.com/fastify/fastify-rate-limit

const rateLimit = require('@fastify/rate-limit');

await fastify.register(rateLimit, {
  global: false // Apply per-route, not globally
});

fastify.post('/login', {
  config: {
    rateLimit: {
      max: 5,              // 5 attempts
      timeWindow: '1 minute',
      skipOnError: false   // Count errors too
    }
  }
}, async (request, reply) => {
  // Login handler
});
```

### Pattern 4: Nginx TLS Reverse Proxy

**What:** Nginx terminates TLS, proxies to Fastify on localhost

**When to use:** Production deployment with HTTPS

**Example:**
```nginx
# Source: https://blog.logrocket.com/how-to-run-node-js-server-nginx/

server {
  listen 443 ssl http2;
  server_name sync.rondo.club;

  ssl_certificate /etc/letsencrypt/live/sync.rondo.club/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sync.rondo.club/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
  }
}

# Redirect HTTP to HTTPS
server {
  listen 80;
  server_name sync.rondo.club;
  return 301 https://$server_name$request_uri;
}
```

### Pattern 5: Systemd Service with Non-Root User

**What:** Run Fastify as a systemd service with automatic restart

**When to use:** Production deployment

**Example:**
```ini
# Source: https://nodesource.com/blog/running-your-node-js-app-with-systemd-part-1

[Unit]
Description=Rondo Sync Dashboard Web Server
After=network.target

[Service]
Type=simple
User=sportlink
WorkingDirectory=/home/sportlink
ExecStart=/usr/bin/node /home/sportlink/lib/web-server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rondo-sync-web

# Security: minimal permissions (INFRA-04 requirement)
NoNewPrivileges=true
PrivateTmp=true

# Environment
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

**Systemd commands:**
```bash
sudo systemctl daemon-reload
sudo systemctl enable rondo-sync-web.service
sudo systemctl start rondo-sync-web.service
sudo systemctl status rondo-sync-web.service
sudo journalctl -u rondo-sync-web.service -f  # View logs
```

### Pattern 6: User Configuration File

**What:** JSON file with username, hashed password, display name

**When to use:** As decided in CONTEXT.md - no admin UI, no CLI tool, 2-5 users

**Example:**
```javascript
// config/users.json (server only, .gitignore)
[
  {
    "username": "admin",
    "passwordHash": "$argon2id$v=19$m=65536,t=3,p=4$...",
    "displayName": "Administrator"
  },
  {
    "username": "board",
    "passwordHash": "$argon2id$v=19$m=65536,t=3,p=4$...",
    "displayName": "Board Member"
  }
]
```

**Validation:**
```javascript
function loadUsers() {
  const users = require('../config/users.json');

  // Validate structure
  for (const user of users) {
    if (!user.username || !user.passwordHash) {
      throw new Error('Invalid user config: missing username or passwordHash');
    }
    if (!user.passwordHash.startsWith('$argon2id$')) {
      throw new Error(`Invalid hash for ${user.username}: must be Argon2id`);
    }
  }

  // Check for duplicate usernames
  const usernames = users.map(u => u.username);
  if (new Set(usernames).size !== usernames.length) {
    throw new Error('Duplicate usernames in user config');
  }

  return users;
}
```

### Anti-Patterns to Avoid

- **Running as root:** NEVER run the web server as root. Use a dedicated non-root user (sportlink). This is a BLOCKING requirement (INFRA-04).
- **Exposing Node.js directly:** NEVER bind Fastify to 0.0.0.0 or public IP. Always localhost, with nginx as public-facing proxy.
- **Plain text passwords:** NEVER store plain passwords or basic hashes. Always use Argon2id.
- **Ignoring session secret:** The SESSION_SECRET must be strong (min 32 chars), random, and kept in .env. NEVER commit to git.
- **Default session store:** The in-memory store leaks memory. ALWAYS use a persistent store (SQLite for this project).
- **Forgetting secure cookie flags:** ALWAYS set httpOnly, secure, sameSite on session cookies.
- **Revealing which field failed:** Login errors should be generic ("Invalid username or password") - don't reveal which field was wrong.
- **No rate limiting:** ALWAYS rate limit login endpoints. 5 attempts per minute per IP is a reasonable default.

## Don't Hand-Roll

Problems that look simple but have existing solutions:

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Session management | Custom cookie encryption/signing | @fastify/session | Handles rotation, timing attacks, secure defaults, battle-tested |
| Password hashing | bcrypt with hardcoded salt, SHA-256 | argon2 library | Argon2id is memory-hard (resists GPU attacks), has secure defaults, OWASP recommended |
| Rate limiting | Manual IP tracking in memory | @fastify/rate-limit | Handles distributed scenarios, sliding windows, IP extraction, header responses (429, Retry-After) |
| TLS termination in Node.js | Node HTTPS server with certs | nginx reverse proxy | nginx outperforms Node.js in TLS, handles certificate reload without restart, battle-tested |
| Process management | While-loop restart wrapper | systemd | Handles crashes, resource limits, logging, startup dependencies, already on server |
| Let's Encrypt renewal | Manual certbot cron | certbot systemd timer | Already installed, handles renewal + nginx reload, exponential backoff on failure |

**Key insight:** Authentication and session management have subtle security issues (timing attacks, session fixation, cookie security). Use proven libraries rather than implementing from scratch. The fastify-session-better-sqlite3-store package has only ~100 lines of code but handles edge cases (cleanup, locking) correctly.

## Common Pitfalls

### Pitfall 1: Session Secret in Code

**What goes wrong:** Developer puts SESSION_SECRET in code or commits .env to git. Secret gets exposed, attacker can forge session cookies.

**Why it happens:** Convenience during development, lack of awareness about session security.

**How to avoid:**
- Store SESSION_SECRET in .env on server
- Generate with `openssl rand -base64 32`
- NEVER commit .env to git (.gitignore it)
- Validate secret is at least 32 bytes on startup

**Warning signs:**
- SESSION_SECRET is hardcoded string
- .env file tracked in git
- Error: "secret must be 32 bytes" on startup

### Pitfall 2: Session Store Memory Leak

**What goes wrong:** Using default in-memory session store in production. Memory grows unbounded as users log in, eventually crashes server.

**Why it happens:** Documentation warns against it, but default example uses in-memory store. Developer doesn't notice until production traffic.

**How to avoid:**
- Always use persistent store (SQLite for this project)
- Set up session cleanup (old sessions deleted after expiry)
- Monitor memory usage in production

**Warning signs:**
- Server memory grows steadily over days
- No sessions.sqlite file exists
- "Using in-memory store" warning in logs

### Pitfall 3: Binding to 0.0.0.0 Instead of localhost

**What goes wrong:** Fastify binds to 0.0.0.0:3000, exposing it to the internet. Users bypass nginx and TLS, hitting Node.js directly over HTTP.

**Why it happens:** 0.0.0.0 is used in development to test from other devices, carried to production.

**How to avoid:**
- Bind to 127.0.0.1 in production
- Test with firewall rules (block external access to port 3000)
- Document that only nginx should be public-facing

**Warning signs:**
- Can curl http://sync.rondo.club:3000 from external IP
- TLS is skippable
- X-Forwarded-For headers missing in logs

### Pitfall 4: Forgetting X-Forwarded-For for Rate Limiting

**What goes wrong:** Rate limiting uses IP from socket, which is always 127.0.0.1 behind nginx. All users share the same limit bucket.

**Why it happens:** Default rate limiting config doesn't account for reverse proxy.

**How to avoid:**
- Configure @fastify/rate-limit to use X-Forwarded-For header
- Ensure nginx sets X-Forwarded-For (see pattern 4)
- Test rate limiting with multiple source IPs

**Warning signs:**
- Rate limit triggers for all users at once
- All requests log IP as 127.0.0.1

### Pitfall 5: Systemd Restart Loop

**What goes wrong:** Service crashes immediately on start (e.g., missing .env), systemd restarts it repeatedly, hitting start limit, enters failed state.

**Why it happens:** Misconfiguration (wrong WorkingDirectory, missing dependencies) + Restart=always without rate limit.

**How to avoid:**
- Use Restart=on-failure (not always)
- Set RestartSec=10 to avoid rapid loops
- Set StartLimitBurst=5 and StartLimitIntervalSec=300
- Test startup manually before enabling service

**Warning signs:**
- Service in "failed" state immediately after enable
- Journal shows rapid crash-restart cycles
- "Start request repeated too quickly" error

### Pitfall 6: SQLite Busy Timeout

**What goes wrong:** Web server and sync pipelines both access dashboard.sqlite, causing SQLITE_BUSY errors during concurrent writes.

**Why it happens:** SQLite default busy_timeout is 0 (immediate failure).

**How to avoid:**
- Already handled in Phase 35: `db.pragma('busy_timeout = 5000')`
- Web server opens read-only connection for dashboard queries
- Only run-tracker writes to dashboard.sqlite

**Warning signs:**
- "database is locked" errors in web server logs
- 500 errors when sync is running

### Pitfall 7: Node.js Critical Vulnerabilities (January 2026)

**What goes wrong:** Using Node.js versions with known vulnerabilities (CVE-2026-xxx: async_hooks stack overflow, TLS memory leak, TLS error handling DoS).

**Why it happens:** Server runs outdated Node.js version, not applying security patches.

**How to avoid:**
- Use Node.js 22.x LTS (current as of January 2026)
- Apply security updates promptly
- Subscribe to Node.js security mailing list
- Check node version: `node --version`

**Warning signs:**
- "Maximum call stack size exceeded" crashes
- Memory growth over time with TLS connections
- Process crashes on certain TLS errors

**Source:** https://nodejs.org/en/blog/vulnerability/january-2026-dos-mitigation-async-hooks

## Code Examples

Verified patterns from official sources:

### Login Handler with Argon2 Verification

```javascript
// Source: https://daily.dev/blog/fastify-authentication-strategy

const argon2 = require('argon2');

fastify.post('/login', {
  config: {
    rateLimit: { max: 5, timeWindow: '1 minute' }
  }
}, async (request, reply) => {
  const { username, password } = request.body;

  // Load users from config
  const users = loadUsers(); // From config/users.json
  const user = users.find(u => u.username === username);

  if (!user) {
    // Generic error - don't reveal if username exists
    return reply.code(401).send({ error: 'Invalid username or password' });
  }

  const valid = await argon2.verify(user.passwordHash, password);
  if (!valid) {
    return reply.code(401).send({ error: 'Invalid username or password' });
  }

  // Session fixation prevention: regenerate session ID
  request.session.regenerate();

  // Set session data
  request.session.user = {
    username: user.username,
    displayName: user.displayName
  };

  // Redirect to dashboard
  return reply.redirect('/');
});
```

### Logout Handler

```javascript
fastify.post('/logout', { preHandler: requireAuth }, async (request, reply) => {
  // Destroy session
  request.session.destroy();
  return reply.redirect('/login');
});
```

### Minimal Login Page (Plain HTML)

```html
<!-- views/login.html or inline in handler -->
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Login - Rondo Sync</title>
  <style>
    body { font-family: sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #f5f5f5; }
    form { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); width: 300px; }
    h1 { margin: 0 0 1.5rem; font-size: 1.5rem; }
    input { width: 100%; padding: 0.5rem; margin-bottom: 1rem; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
    button { width: 100%; padding: 0.5rem; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer; }
    button:hover { background: #0056b3; }
    .error { color: red; margin-bottom: 1rem; }
  </style>
</head>
<body>
  <form method="POST" action="/login">
    <h1>Rondo Sync</h1>
    <% if (error) { %><p class="error"><%= error %></p><% } %>
    <input type="text" name="username" placeholder="Username" required autofocus>
    <input type="password" name="password" placeholder="Password" required>
    <button type="submit">Log In</button>
  </form>
</body>
</html>
```

### Health Check Endpoint (for monitoring)

```javascript
// Unauthenticated endpoint for uptime monitoring
fastify.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Passport.js + Express | @fastify/session + preHandler hooks | Fastify v3+ | Simpler, less middleware overhead, built for Fastify architecture |
| bcrypt | Argon2id | 2015+ (Argon2 won PHC) | Better resistance to GPU attacks, memory-hard |
| Redis required for sessions | SQLite session stores available | 2020+ | Simpler deployment for small-scale apps (no external service) |
| Manual Let's Encrypt renewal | certbot systemd timer | 2018+ (certbot 0.28) | Automatic renewal, no cron jobs |
| PM2 for process management | systemd native | Always available on Linux | One less dependency, better OS integration |

**Deprecated/outdated:**
- **fastify-session (unmaintained)**: Replaced by @fastify/session in Fastify v4+. Use the official @fastify namespace packages.
- **fastify-static (deprecated)**: Now @fastify/static. All official plugins moved to @fastify namespace.
- **TLSv1.0, TLSv1.1**: Disabled by default in modern nginx. Use only TLSv1.2 and TLSv1.3.

## Open Questions

Things that couldn't be fully resolved:

1. **Fastify v5 Compatibility with @fastify/session**
   - What we know: @fastify/session version 11.1.1 is current (published 3 months ago as of research date)
   - What's unclear: Explicit compatibility statement for Fastify v5 not found in search results
   - Recommendation: Check package.json peerDependencies during implementation. If incompatible, use Fastify v4.x (well-supported) or wait for @fastify/session update.

2. **Existing nginx Configuration on Server**
   - What we know: Server is at 46.202.155.16, nginx likely already installed (common for PHP servers)
   - What's unclear: Current nginx sites, existing TLS setup, whether sync.rondo.club DNS exists
   - Recommendation: SSH to server, check `/etc/nginx/sites-enabled/`, verify DNS points to server, run `certbot certificates` to see existing certs.

3. **Session Cleanup Strategy**
   - What we know: SQLite session store needs periodic cleanup (expired sessions)
   - What's unclear: Whether fastify-session-better-sqlite3-store handles automatic cleanup
   - Recommendation: Check library docs/code during implementation. If no automatic cleanup, add daily cron job: `DELETE FROM sessions WHERE expires < unixepoch()`

4. **Pre-hashed vs Runtime Hashing Decision**
   - What we know: User decided JSON config file with usernames/passwords
   - What's unclear: Whether passwords should be stored pre-hashed (in JSON) or hashed at runtime
   - Recommendation: Pre-hash is more secure (passwords never in plain text, even during setup). Provide `scripts/hash-password.js` utility. If runtime hashing preferred, add "first-run setup" flow.

5. **Cross-Origin Request Considerations**
   - What we know: Dashboard is server-side rendered, sessions via cookies
   - What's unclear: Whether any JavaScript will make cross-origin requests (e.g., to Rondo Club WordPress)
   - Recommendation: Assume no CORS needed (same-origin). If Phase 37 needs it, add @fastify/cors with restrictive origins.

## Sources

### Primary (HIGH confidence)

- [@fastify/session GitHub](https://github.com/fastify/session) - Official session plugin, compatibility, configuration
- [argon2 npm](https://www.npmjs.com/package/argon2) - Current version (0.44.0), API usage
- [@fastify/rate-limit GitHub](https://github.com/fastify/fastify-rate-limit) - Rate limiting configuration, examples
- [Node.js Security Best Practices](https://nodejs.org/en/learn/getting-started/security-best-practices) - Official Node.js security guide
- [Node.js January 2026 Security Release](https://nodejs.org/en/blog/vulnerability/january-2026-dos-mitigation-async-hooks) - Critical vulnerabilities affecting production apps
- [Fastify Hooks Documentation](https://fastify.dev/docs/latest/Reference/Hooks/) - Official preHandler hook documentation

### Secondary (MEDIUM confidence)

- [LogRocket: How to use Nginx as a reverse proxy for Node.js](https://blog.logrocket.com/how-to-run-node-js-server-nginx/) - Nginx reverse proxy patterns, TLS configuration
- [Better Stack: Configure Nginx as Reverse Proxy for Node.js](https://betterstack.com/community/guides/scaling-nodejs/nodejs-reverse-proxy-nginx/) - Current best practices
- [NodeSource: Running Node.js with Systemd](https://nodesource.com/blog/running-your-node-js-app-with-systemd-part-1) - Systemd service configuration
- [Daily.dev: Fastify Authentication Strategy](https://daily.dev/blog/fastify-authentication-strategy) - Authentication patterns, security best practices
- [Kevin Cunningham: Protect Fastify Routes with Authorization](https://kevincunningham.co.uk/posts/protect-fastify-routes-with-authorization/) - preHandler hook patterns
- [GetPageSpeed: Free SSL for NGINX with Let's Encrypt](https://www.getpagespeed.com/server-setup/nginx/nginx-ssl-certificate-letsencrypt) - Let's Encrypt + nginx automation

### Tertiary (LOW confidence - requires validation)

- [fastify-session-better-sqlite3-store GitHub](https://github.com/mrdcvlsc/fastify-session-better-sqlite3-store) - SQLite session store integration (requires implementation testing)
- WebSearch results for "Fastify preHandler authentication hook pattern example 2026" - Community patterns (not official docs)
- WebSearch results for "systemd restart policies nodejs web server production 2026" - Community best practices (cross-verify with official systemd docs)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - Official packages well-documented, current versions verified
- Architecture: HIGH - Patterns sourced from official Fastify docs and established Node.js practices
- Pitfalls: HIGH - Based on official Node.js security releases and documented session security issues
- Session store compatibility: MEDIUM - fastify-session-better-sqlite3-store is third-party, needs implementation testing
- Nginx/certbot specifics: MEDIUM - Server environment needs verification (SSH required)

**Research date:** 2026-02-08
**Valid until:** 2026-03-08 (30 days - stable technologies, but Node.js security updates frequent)

**Notes:**
- User decisions from CONTEXT.md constrain implementation (JSON config file, no admin UI, minimal login design)
- Phase 35 completed: dashboard.sqlite exists with runs/run_steps/run_errors tables
- Phase 37 will build on this foundation (dashboard UI implementation)
- Security is critical: INFRA-04 (non-root), AUTH-02 (Argon2id), AUTH-03 (secure cookies), AUTH-04 (all routes require auth)