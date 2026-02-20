---
phase: 27-replace-postmark-with-lettermint
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - lib/alert-email.js
  - scripts/install-cron.sh
  - scripts/sync.sh
  - .env.example
  - package.json
  - CLAUDE.md
autonomous: true
must_haves:
  truths:
    - "Alert emails send via Lettermint instead of Postmark"
    - "All env var references use LETTERMINT_API_TOKEN and LETTERMINT_FROM_EMAIL"
    - "Postmark npm package is removed, lettermint is installed"
  artifacts:
    - path: "lib/alert-email.js"
      provides: "Email sending via Lettermint SDK"
      contains: "lettermint"
    - path: "package.json"
      provides: "lettermint dependency, no postmark"
      contains: "lettermint"
    - path: ".env.example"
      provides: "Updated env var template"
      contains: "LETTERMINT_API_TOKEN"
  key_links:
    - from: "lib/alert-email.js"
      to: "lettermint SDK"
      via: "require or dynamic import"
      pattern: "lettermint"
    - from: "scripts/sync.sh"
      to: "lib/alert-email.js"
      via: "env var check before calling alert-email.js"
      pattern: "LETTERMINT_API_TOKEN"
---

<objective>
Replace Postmark email sending with Lettermint across the entire codebase.

Purpose: Migrate from Postmark to Lettermint for all alert email delivery (failure alerts and overdue alerts).
Output: All email sending uses Lettermint SDK, all env vars renamed, all docs updated, postmark package removed.
</objective>

<execution_context>
@/Users/joostdevalk/.claude/get-shit-done/workflows/execute-plan.md
@/Users/joostdevalk/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@lib/alert-email.js
@scripts/install-cron.sh
@scripts/sync.sh
@.env.example
@package.json
@CLAUDE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Replace Postmark with Lettermint in alert-email.js and swap npm packages</name>
  <files>lib/alert-email.js, package.json</files>
  <action>
1. Run `npm uninstall postmark && npm install lettermint` in the project root.

2. Rewrite the email sending logic in `lib/alert-email.js`:
   - Replace `const postmark = require('postmark');` with a Lettermint import. The project uses CommonJS, so try `const { Lettermint } = require('lettermint');`. If that fails at runtime (ESM-only package), use dynamic import: create an async helper `async function getLettermint() { const { Lettermint } = await import('lettermint'); return Lettermint; }`.
   - Replace all `process.env.POSTMARK_API_KEY` checks with `process.env.LETTERMINT_API_TOKEN`.
   - Replace all `process.env.POSTMARK_FROM_EMAIL` checks with `process.env.LETTERMINT_FROM_EMAIL`.
   - Replace the two email sending blocks (in `sendFailureAlert` and `sendOverdueAlert`) that currently do:
     ```js
     const client = new postmark.ServerClient(process.env.POSTMARK_API_KEY);
     await client.sendEmail({
       From: `Rondo SYNC <${process.env.POSTMARK_FROM_EMAIL}>`,
       To: process.env.OPERATOR_EMAIL,
       Subject: subject,
       HtmlBody: htmlBody,
       TextBody: textBody
     });
     ```
     With Lettermint's fluent API:
     ```js
     const lettermint = new Lettermint({ apiToken: process.env.LETTERMINT_API_TOKEN });
     await lettermint.email
       .from(`Rondo SYNC <${process.env.LETTERMINT_FROM_EMAIL}>`)
       .to(process.env.OPERATOR_EMAIL)
       .subject(subject)
       .html(htmlBody)
       .text(textBody)
       .send();
     ```
   - Update the CLI help text at the bottom of the file: change "POSTMARK_API_KEY" to "LETTERMINT_API_TOKEN", "Postmark Server API Token" to "Lettermint API Token", and "POSTMARK_FROM_EMAIL" to "LETTERMINT_FROM_EMAIL".
   - Update the warning messages: change `[alert-email] POSTMARK_API_KEY not set` to `[alert-email] LETTERMINT_API_TOKEN not set`, and similarly for FROM_EMAIL.

3. Verify `package.json` no longer contains "postmark" and does contain "lettermint" in dependencies.
  </action>
  <verify>
    Run `node -e "const { Lettermint } = require('lettermint'); console.log('OK')"` to confirm the package loads in CommonJS. If it fails with an ERR_REQUIRE_ESM error, switch to dynamic import approach and re-verify with `node -e "import('lettermint').then(m => console.log('OK', Object.keys(m)))"`. Also run `grep -c "postmark" lib/alert-email.js` and confirm it returns 0.
  </verify>
  <done>alert-email.js uses Lettermint SDK for all email sending, postmark package removed from package.json, lettermint installed</done>
</task>

<task type="auto">
  <name>Task 2: Update shell scripts, env example, and documentation</name>
  <files>scripts/install-cron.sh, scripts/sync.sh, .env.example, CLAUDE.md</files>
  <action>
1. **scripts/sync.sh** (line 20 and line 193):
   - Line 20: Change comment `#   - POSTMARK_* for email reports` to `#   - LETTERMINT_* for email reports`
   - Line 193: Change the env var check from:
     `if [ -n "$POSTMARK_API_KEY" ] && [ -n "$POSTMARK_FROM_EMAIL" ] && [ -n "$OPERATOR_EMAIL" ]; then`
     to:
     `if [ -n "$LETTERMINT_API_TOKEN" ] && [ -n "$LETTERMINT_FROM_EMAIL" ] && [ -n "$OPERATOR_EMAIL" ]; then`

2. **scripts/install-cron.sh**: Replace ALL Postmark references with Lettermint equivalents:
   - Variable name `NEED_POSTMARK` -> `NEED_LETTERMINT`
   - Env var checks: `POSTMARK_API_KEY` -> `LETTERMINT_API_TOKEN`
   - Variable name in script: `POSTMARK_API_KEY` -> `LETTERMINT_API_TOKEN`
   - Variable name in script: `POSTMARK_FROM_EMAIL` -> `LETTERMINT_FROM_EMAIL`
   - Prompt text: "Postmark configuration (for email delivery):" -> "Lettermint configuration (for email delivery):"
   - Prompt text: "Get your Server API Token from: Postmark Dashboard -> Servers -> API Tokens" -> "Get your API token from: Lettermint Dashboard -> API Tokens"
   - Prompt text: "Enter Postmark API Key:" -> "Enter Lettermint API Token:"
   - Prompt text: "Sender email must be verified in Postmark Dashboard -> Sender Signatures" -> "Sender email must be verified in your Lettermint account"
   - Prompt text: "Enter verified sender email address:" (keep as is, it's generic)
   - Status messages: "Postmark configuration saved" -> "Lettermint configuration saved"
   - Status messages: "Using existing Postmark configuration" -> "Using existing Lettermint configuration"

3. **.env.example**: Replace:
   - `POSTMARK_API_KEY=` with `LETTERMINT_API_TOKEN=`
   - `POSTMARK_FROM_EMAIL=` with `LETTERMINT_FROM_EMAIL=`

4. **CLAUDE.md**: In the Environment Variables section:
   - Replace `POSTMARK_API_KEY=` line and its comment with `LETTERMINT_API_TOKEN=          # Lettermint API token`
   - Replace `POSTMARK_FROM_EMAIL=` line and its comment with `LETTERMINT_FROM_EMAIL=       # Verified sender email`
   - In the Tech Stack line at the bottom, replace "postmark" with "lettermint" if it appears there.
  </action>
  <verify>
    Run `grep -r "POSTMARK\|postmark" scripts/ .env.example CLAUDE.md --include="*.sh" --include="*.example" --include="*.md" | grep -v node_modules | grep -v ".planning/"` and confirm zero matches (excluding any that might be in package-lock.json or .planning/ directories).
  </verify>
  <done>All shell scripts use LETTERMINT_API_TOKEN and LETTERMINT_FROM_EMAIL, .env.example updated, CLAUDE.md updated, zero remaining Postmark references outside of planning docs and package-lock.json</done>
</task>

<task type="checkpoint:human-action" gate="blocking">
  <name>Task 3: Update server .env and deploy</name>
  <what-built>Lettermint integration replacing Postmark in all code, scripts, and docs</what-built>
  <how-to-verify>
    1. Deploy the code: `git push` then `ssh root@46.202.155.16 "cd /home/rondo && git pull && npm install"`
       (npm install is needed to remove postmark and add lettermint)
    2. On the server, edit `/home/rondo/.env`:
       - Remove `POSTMARK_API_KEY=...` and `POSTMARK_FROM_EMAIL=...`
       - Add `LETTERMINT_API_TOKEN=<your-lettermint-api-token>`
       - Add `LETTERMINT_FROM_EMAIL=<your-verified-sender-email>`
    3. Test by triggering a test failure alert:
       `cd /home/rondo && node lib/alert-email.js send-failure-alert --pipeline people`
       (This will send a failure alert for the latest people run -- check your email)
    4. If the web server uses alert-email.js, restart it: `systemctl restart rondo-sync-web`
  </how-to-verify>
  <resume-signal>Type "deployed" after confirming email delivery works via Lettermint</resume-signal>
</task>

</tasks>

<verification>
- `grep -r "postmark\|POSTMARK" lib/ scripts/ .env.example CLAUDE.md` returns no matches
- `node -e "require('./lib/alert-email')"` loads without error (from project root)
- `package.json` contains "lettermint" and does not contain "postmark" in dependencies
</verification>

<success_criteria>
- All email sending uses Lettermint SDK instead of Postmark
- No references to Postmark remain in source code, scripts, or docs (planning files excluded)
- Lettermint package installed, Postmark package removed
- Server .env updated and email delivery confirmed working
</success_criteria>

<output>
After completion, create `.planning/quick/27-replace-postmark-with-lettermint-for-ema/27-SUMMARY.md`
</output>
