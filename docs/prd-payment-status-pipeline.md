# PRD: Payment Status Pipeline

## Problem

When an invoice is sent from Rondo Club, a Rabobank betaalverzoek (payment request) is created and the payment link is emailed to the member. However, there is currently **no mechanism to detect when the member actually pays**. The invoice status stays at "Verstuurd" (sent) indefinitely, and a club administrator must manually mark invoices as "Betaald" (paid).

This creates:
- Extra manual work for the penningmeester (treasurer)
- Stale invoice statuses that don't reflect reality
- No way to easily see which invoices are still outstanding

## Solution

Add a new **Payment Status pipeline** to rondo-sync that periodically checks the Rabobank Payment Request API for payment status updates and automatically transitions invoice statuses in Rondo Club.

## Data Flow

```
Rabobank API                    Rondo Club WordPress
GET /payment-requests    →      POST /rondo/v1/invoices/{id}/status
(list all requests)             (update to "paid")
```

This is a **Rabobank → Rondo Club** pipeline — it does not involve Sportlink or any other existing data source.

## Rabobank API Research

### Available Endpoints

The [Rabobank Payment Request API](https://docs.developer.rabobank.com/payments/reference/pr) provides:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/payment-requests` | List all payment requests (includes transaction data) |
| `GET` | `/payment-requests/{id}` | Single payment request details |
| `GET` | `/payment-requests/{id}/transactions/{txId}` | Individual transaction status |
| `DELETE` | `/payment-requests/{id}` | Delete/revoke a payment request |

### Key Finding: Batch Status Check

The `GET /payment-requests` list endpoint returns each payment request with:
- `id` — the payment request ID (matches our stored `_payment_request_id`)
- `transactions[]` — array of transaction objects
- `expired` — boolean indicating if the request has expired

This means we can check **all payment statuses in a single API call** rather than making individual requests per invoice. This is the most efficient approach.

### Payment Request Statuses

Based on the API documentation, payment requests can be:
- **Open/unpaid** — no completed transactions, not expired
- **Paid** — has a completed transaction in `transactions[]`
- **Expired** — `expired: true`, payment window has closed

### Authentication

Uses the same OAuth 2.0 Premium flow already implemented in `class-rabobank-oauth.php`. The `GET /payment-requests` endpoint requires:
- `Authorization: Bearer {access_token}`
- `X-IBM-Client-Id: {client_id}`
- mTLS client certificate

### Rate Limits

5 calls/second (shared across all Payment Request endpoints).

## Rondo Club Current State

### Invoice Statuses

Defined in `class-post-types.php`:

| Post Status | Display Name | Meaning |
|-------------|-------------|---------|
| `rondo_draft` | Concept | Invoice created, not yet sent |
| `rondo_sent` | Verstuurd | Sent to member via email |
| `rondo_paid` | Betaald | Payment received |
| `rondo_overdue` | Verlopen | Past due date, unpaid |

### Status Update Endpoint

`POST /rondo/v1/invoices/{id}/status` with `{ "status": "paid" }` — already exists and works. This is what the pipeline will call.

### Stored Payment Data

When a payment request is created (`class-rabobank-payment.php`), the following are stored on the invoice:
- `payment_link` (ACF field) — the betaalverzoek URL
- `_payment_request_id` (post meta) — the Rabobank payment request ID

The `_payment_request_id` is the key for matching Rabobank API responses back to Rondo Club invoices.

### Overdue Detection

`check_overdue_invoices()` in `class-rest-invoices.php` already transitions `sent → overdue` based on `due_date`. The payment status pipeline complements this by handling the `sent/overdue → paid` transition.

## Architecture Decisions

### Where Does This Run?

**Option A: In rondo-sync (recommended)**
- Follows existing pattern: external API → Rondo Club
- Runs on the sync server with existing cron infrastructure
- OAuth token management needs to be handled (tokens are stored in WordPress)

**Option B: In Rondo Club as a WP cron**
- OAuth tokens and API classes already available
- No cross-system coordination needed
- But: WP cron is unreliable (only triggers on page visits) and this diverges from the "external sync → Rondo Club" pattern

**Decision: Option A (rondo-sync)** — consistency with the architecture. The pipeline will need to call a new Rondo Club endpoint to get OAuth credentials and payment request IDs.

### New Rondo Club Endpoint Needed

The pipeline needs invoice data that isn't currently exposed. Add a new REST endpoint:

`GET /rondo/v1/invoices/pending-payments`

Returns all invoices with status `sent` or `overdue` that have a `_payment_request_id`:

```json
[
  {
    "id": 1234,
    "payment_request_id": "abc-123-def",
    "status": "sent",
    "invoice_number": "2026-001"
  }
]
```

This keeps the Rabobank API calls in rondo-sync while Rondo Club just provides the mapping data.

### OAuth Token Access

The pipeline also needs a valid Rabobank access token. Two approaches:

**Option A: Proxy through Rondo Club** — add a new endpoint that returns a fresh access token. Simple but exposes tokens via API.

**Option B: Read tokens directly from WordPress** — SSH into the server and read the WordPress option. Complex and fragile.

**Option C: New endpoint that proxies the Rabobank call** — Rondo Club makes the Rabobank API call and returns results. Keeps OAuth complexity in WordPress.

**Decision: Option C** — add a `POST /rondo/v1/invoices/check-payment-status` endpoint in Rondo Club that:
1. Queries all invoices with pending payment requests
2. Calls `GET /payment-requests` on the Rabobank API (using existing OAuth)
3. Matches results to invoices
4. Updates paid invoices automatically
5. Returns a summary of what changed

This way rondo-sync just triggers the check — all Rabobank API logic stays in Rondo Club where the OAuth tokens already live.

## Implementation Plan

### Phase 1: Rondo Club — Payment Status Check Endpoint

Add to `class-rabobank-payment.php` or a new `class-payment-status-checker.php`:

**`POST /rondo/v1/invoices/check-payment-status`**

1. Query all `rondo_invoice` posts with status `rondo_sent` or `rondo_overdue` that have `_payment_request_id` meta
2. If none found, return early with `{ "checked": 0, "updated": 0 }`
3. Call `GET /payment-requests` on Rabobank API (using existing OAuth flow)
4. For each payment request in the response:
   - Match `id` to a pending invoice via `_payment_request_id`
   - If `transactions[]` contains a completed payment → update invoice to `rondo_paid`
   - If `expired: true` and invoice is `rondo_sent` → update invoice to `rondo_overdue`
5. Return summary: `{ "checked": N, "paid": N, "expired": N, "errors": [] }`

**Permission:** `financieel` capability (consistent with other invoice endpoints).

### Phase 2: Rondo Sync — Payment Status Pipeline

New pipeline: `pipelines/check-payment-status.js`

**Steps:**
1. Call `POST /rondo/v1/invoices/check-payment-status` on Rondo Club
2. Log the results
3. That's it — the heavy lifting is in Rondo Club

**Schedule:** Every 15 minutes during business hours (8:00–20:00), or hourly 24/7.

Suggested cron: `*/15 8-20 * * *` (every 15 min, 8 AM to 8 PM)

**Pipeline file structure:**
```
pipelines/check-payment-status.js    # Pipeline orchestrator
steps/check-rondo-club-payments.js   # Single step: call the endpoint
```

**Sync script:**
```bash
scripts/sync.sh payment-status    # With locking + email report
```

### Phase 3: UI Feedback (Optional)

Consider adding to the Facturen list page:
- A "Laatst gecontroleerd" (last checked) timestamp
- A manual "Controleer betaalstatus" button that triggers the check on demand

## Schedule Integration

Add to the existing cron schedule in `sync-architecture.md`:

| Pipeline | Schedule | Cron | Notes |
|----------|----------|------|-------|
| Payment Status | Every 15 min (8-20h) | `*/15 8-20 * * *` | Rabobank payment status check |

### Updated Daily Timeline

```
Every 15 min (8-20h)  Payment status check
Every hour            Reverse sync [currently disabled]
07:00                 Nikki sync
07:30                 Functions sync (recent) -> 08:00 People sync + FreeScout sync
...
```

## Edge Cases

1. **Rabobank not connected** — endpoint returns early with appropriate message, no errors
2. **OAuth token expired** — existing refresh logic handles this transparently
3. **No pending invoices** — endpoint returns `{ "checked": 0 }`, pipeline logs and exits
4. **Partial payment** — Rabobank betaalverzoek requires exact amount, so partial payments shouldn't occur. If they do, the transaction won't show as completed.
5. **Multiple payments for same request** — Rabobank's `numPayers: 1` setting prevents this
6. **Payment request deleted externally** — the `GET /payment-requests` response won't include it; invoice stays at current status
7. **Race condition with manual status update** — if a treasurer manually marks an invoice as paid before the pipeline detects it, the pipeline simply won't find it in the pending list (it filters on `sent`/`overdue` status)

## Success Criteria

- [ ] Invoices automatically transition from `sent` → `paid` when Rabobank payment is completed
- [ ] Expired payment requests trigger `sent` → `overdue` transition
- [ ] Pipeline runs on schedule without manual intervention
- [ ] No false positives (invoices incorrectly marked as paid)
- [ ] Pipeline handles Rabobank API errors gracefully (logs error, retries next run)
- [ ] Existing manual status management continues to work alongside automatic detection

## Out of Scope

- Webhook-based real-time notifications (Rabobank Payment Request API uses polling, not webhooks)
- Automatic email notifications when payment is received (can be added later)
- Refund handling
- Payment reminder emails for overdue invoices
