# Phase 46: FreeScout Conversations as Activities - Research

**Researched:** 2026-02-12
**Domain:** FreeScout API → Rondo Club Activities API integration
**Confidence:** HIGH

## Summary

This phase creates a sync pipeline to fetch FreeScout email conversations for each customer and create them as email activities on the corresponding Rondo Club person timeline. The implementation follows existing sync patterns in rondo-sync (download → prepare → submit) and leverages both FreeScout's conversations API and Rondo Club's Activities REST API.

**Primary recommendation:** Use the established three-step pipeline pattern (download FreeScout conversations, prepare activity payloads, submit to Rondo Club Activities API) with SQLite-based deduplication tracking to prevent duplicate timeline entries on re-sync.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | latest | Local state tracking, deduplication | Already used project-wide for rondo-sync.sqlite, freescout-sync.sqlite, nikki-sync.sqlite |
| Node.js | 18+ | Runtime environment | Current project requirement |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| freescout-client.js | (existing) | FreeScout API wrapper with retry logic | All FreeScout API calls |
| rondo-club-client.js | (existing) | Rondo Club API wrapper with auth | All Rondo Club API calls |
| dashboard-db.js | (existing) | Run tracking for dashboard | Pipeline execution tracking |

**Installation:**
No new dependencies required — all libraries already in package.json.

## Architecture Patterns

### Recommended Project Structure
```
pipelines/
├── sync-freescout-conversations.js  # Pipeline orchestrator (new)

steps/
├── download-freescout-conversations.js  # Fetch conversations via FreeScout API (new)
├── prepare-freescout-activities.js      # Transform to Rondo Club activity format (new)
├── submit-freescout-activities.js       # Create activities via Rondo Club API (new)

lib/
├── freescout-conversations-db.js   # SQLite deduplication tracking (new)
└── freescout-client.js             # FreeScout API client (existing)
```

### Pattern 1: Three-Step Pipeline with Deduplication Tracking

**What:** Download external data → transform to target format → submit with deduplication

**When to use:** Syncing external system data to Rondo Club where duplicates must be prevented

**Example from existing code:**
```javascript
// Pattern from pipelines/sync-nikki.js
async function runNikkiSync(options = {}) {
  const tracker = new RunTracker('nikki');
  tracker.startRun();

  // Step 1: Download from external source
  const downloadStepId = tracker.startStep('nikki-download');
  const downloadResult = await runNikkiDownload({ logger, verbose });
  tracker.endStep(downloadStepId, { outcome: 'success', created: downloadResult.count });

  // Step 2: Transform and sync to Rondo Club
  const syncStepId = tracker.startStep('rondo-club-sync');
  const syncResult = await runNikkiRondoClubSync({ logger, verbose, force });
  tracker.endStep(syncStepId, { outcome: 'success', updated: syncResult.updated });

  tracker.endRun('success', stats);
}
```

**Adaptation for Phase 46:**
```javascript
// New: pipelines/sync-freescout-conversations.js
async function runFreescoutConversationsSync(options = {}) {
  const tracker = new RunTracker('freescout-conversations');
  tracker.startRun();

  // Step 1: Download conversations from FreeScout
  const downloadStepId = tracker.startStep('conversations-download');
  const conversations = await runDownloadConversations({ logger, verbose, incremental });
  tracker.endStep(downloadStepId, { outcome: 'success', created: conversations.length });

  // Step 2: Prepare activity payloads
  const prepareStepId = tracker.startStep('activities-prepare');
  const activities = await runPrepareActivities({ logger, verbose, conversations });
  tracker.endStep(prepareStepId, { outcome: 'success', prepared: activities.length });

  // Step 3: Submit to Rondo Club
  const submitStepId = tracker.startStep('activities-submit');
  const result = await runSubmitActivities({ logger, verbose, activities });
  tracker.endStep(submitStepId, { outcome: 'success', created: result.created });

  tracker.endRun('success', stats);
}
```

### Pattern 2: SQLite Deduplication via Unique Constraints

**What:** Use UNIQUE constraints and source_hash for change detection to prevent duplicates

**When to use:** Tracking external entities that must not create duplicate records

**Example from existing code:**
```javascript
// Pattern from lib/freescout-db.js
function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS freescout_customers (
      id INTEGER PRIMARY KEY,
      knvb_id TEXT NOT NULL UNIQUE,
      email TEXT NOT NULL,
      freescout_id INTEGER,
      source_hash TEXT NOT NULL,
      last_synced_at TEXT,
      last_synced_hash TEXT
    );
  `);
}

function upsertCustomers(db, customers) {
  const stmt = db.prepare(`
    INSERT INTO freescout_customers (knvb_id, email, source_hash, last_seen_at)
    VALUES (@knvb_id, @email, @source_hash, @last_seen_at)
    ON CONFLICT(knvb_id) DO UPDATE SET
      email = excluded.email,
      source_hash = excluded.source_hash,
      last_seen_at = excluded.last_seen_at
  `);
  // ... execute in transaction
}
```

**Adaptation for Phase 46:**
```javascript
// New: lib/freescout-conversations-db.js
function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS freescout_conversations (
      id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL UNIQUE,  -- FreeScout conversation ID
      knvb_id TEXT NOT NULL,
      freescout_customer_id INTEGER NOT NULL,
      subject TEXT,
      created_at TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      rondo_club_activity_id INTEGER,  -- Track created activity
      last_synced_at TEXT,
      FOREIGN KEY (knvb_id) REFERENCES rondo_club_members(knvb_id)
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_knvb_id
      ON freescout_conversations (knvb_id);
  `);
}
```

### Pattern 3: Incremental Sync with Timestamp Tracking

**What:** Store last sync timestamp, fetch only newer items on subsequent runs

**When to use:** External APIs support timestamp-based filtering (createdSince, updatedSince)

**Example from FreeScout API:**
```javascript
// FreeScout supports timestamp filtering via query parameters
const response = await freescoutRequest(
  `/api/conversations?customerId=${customerId}&createdSince=${lastSyncTimestamp}`,
  'GET',
  null,
  options
);
```

**Adaptation for Phase 46:**
```javascript
// New: steps/download-freescout-conversations.js
async function downloadConversationsForCustomer(freescoutCustomerId, knvbId, lastSyncTimestamp, options) {
  const params = new URLSearchParams({
    customerId: freescoutCustomerId,
    sortField: 'createdAt',
    sortOrder: 'asc'
  });

  // Incremental sync: only fetch new conversations since last run
  if (lastSyncTimestamp) {
    params.set('createdSince', lastSyncTimestamp);
  }

  const response = await freescoutRequest(
    `/api/conversations?${params.toString()}`,
    'GET',
    null,
    options
  );

  return response.body._embedded?.conversations || [];
}
```

### Pattern 4: Pagination Handling

**What:** FreeScout returns paginated results (default 50/page) with page metadata

**When to use:** Customers with >50 conversations (common for long-term members)

**FreeScout pagination structure:**
```json
{
  "page": {
    "size": 50,
    "totalElements": 127,
    "totalPages": 3,
    "number": 1
  },
  "_embedded": {
    "conversations": [...]
  }
}
```

**Implementation pattern:**
```javascript
async function fetchAllConversationsForCustomer(customerId, options) {
  let allConversations = [];
  let currentPage = 1;
  let totalPages = 1;

  while (currentPage <= totalPages) {
    const params = new URLSearchParams({
      customerId: customerId,
      page: currentPage,
      pageSize: 50
    });

    const response = await freescoutRequest(
      `/api/conversations?${params.toString()}`,
      'GET',
      null,
      options
    );

    const conversations = response.body._embedded?.conversations || [];
    allConversations.push(...conversations);

    totalPages = response.body.page?.totalPages || 1;
    currentPage++;
  }

  return allConversations;
}
```

### Pattern 5: Rondo Club Activities API Integration

**What:** Create email activities via custom REST endpoint

**When to use:** Adding activity timeline entries to person records

**API structure from activities.md:**
```javascript
// POST /rondo/v1/people/{person_id}/activities
const activityPayload = {
  content: "Email conversation: Subject line here\n\nPreview of content...",
  activity_type: "email",
  activity_date: "2026-02-12",
  activity_time: "14:30",
  participants: [] // Optional
};

const response = await rondoClubRequest(
  `rondo/v1/people/${personId}/activities`,
  'POST',
  activityPayload,
  options
);
```

**Gotcha from existing code:** Rondo Club Activities API requires `person_id` in URL path, so we need the `rondo_club_id` mapping from `rondo_club_members` table.

### Anti-Patterns to Avoid

- **Don't fetch all conversations on every run:** Use `createdSince` parameter for incremental sync after initial run
- **Don't skip deduplication tracking:** FreeScout API doesn't know what we've synced — must track locally
- **Don't ignore pagination:** Customers can have 100+ conversations over time
- **Don't create activities without checking duplicates:** Would create duplicate timeline entries on re-sync
- **Don't assume 1:1 freescout_id mapping:** Must cross-reference via `freescout_customers` table in freescout-sync.sqlite

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Deduplication logic | Custom set/array tracking in memory | SQLite UNIQUE constraint on `conversation_id` | Database constraint prevents race conditions, persists across runs |
| Pagination handling | Manual while loops with broken state | Existing pattern from project (see Pattern 4) | Edge cases: network failures mid-pagination, API changes |
| Timestamp formatting | String manipulation | ISO 8601 from Date.toISOString() | FreeScout requires exact format: `YYYY-MM-DDThh:mm:ssZ` |
| Hash computation | Custom hash function | Existing `stableStringify` + `computeHash` from lib/utils.js | Already handles nested objects, arrays, null handling |
| API retry logic | setTimeout wrapper | Existing `freescoutRequestWithRetry` and `rondoClubRequestWithRetry` | Exponential backoff, 5xx-only retry logic already implemented |

**Key insight:** Deduplication is critical for activity sync because activities are additive (no natural update operation). The SQLite UNIQUE constraint pattern used throughout rondo-sync is the proven solution.

## Common Pitfalls

### Pitfall 1: Syncing Conversations Without Valid Rondo Club Person

**What goes wrong:** FreeScout customer exists but corresponding Rondo Club person doesn't (orphan customer, or member never synced)

**Why it happens:** FreeScout and Rondo Club are separate systems; a customer can exist in FreeScout without a corresponding WordPress person post

**How to avoid:**
1. Query `rondo_club_members` table by `knvb_id` to get `rondo_club_id`
2. Skip conversation sync if `rondo_club_id` is NULL
3. Log skipped customers for manual review

**Warning signs:**
- Spike in API 404 errors when creating activities
- Log messages about missing person IDs

**Code pattern:**
```javascript
// Check mapping before attempting sync
const member = db.prepare(
  'SELECT rondo_club_id FROM rondo_club_members WHERE knvb_id = ?'
).get(knvbId);

if (!member || !member.rondo_club_id) {
  logger.verbose(`Skipping ${knvbId}: no Rondo Club person ID`);
  result.skipped++;
  continue;
}
```

### Pitfall 2: Creating Duplicate Activities on Re-Sync

**What goes wrong:** Running sync twice creates duplicate timeline entries for same conversation

**Why it happens:** Activities API doesn't check for duplicates — every POST creates a new activity

**How to avoid:**
1. Track `conversation_id → rondo_club_activity_id` mapping in SQLite
2. Check tracking table before calling Activities API
3. Only create activity if not already synced

**Warning signs:**
- Users report duplicate emails in timeline
- Activity count grows on every sync run

**Code pattern:**
```javascript
// Check if already synced
const existing = db.prepare(
  'SELECT rondo_club_activity_id FROM freescout_conversations WHERE conversation_id = ?'
).get(conversationId);

if (existing && existing.rondo_club_activity_id) {
  logger.verbose(`Conversation ${conversationId} already synced as activity ${existing.rondo_club_activity_id}`);
  result.skipped++;
  continue;
}

// Create activity and record mapping
const activityResponse = await rondoClubRequest(...);
const activityId = activityResponse.body.id;

db.prepare(`
  UPDATE freescout_conversations
  SET rondo_club_activity_id = ?, last_synced_at = ?
  WHERE conversation_id = ?
`).run(activityId, new Date().toISOString(), conversationId);
```

### Pitfall 3: Ignoring Pagination for High-Volume Customers

**What goes wrong:** Only syncing first 50 conversations for customers with 100+ conversations

**Why it happens:** FreeScout defaults to 50/page, must manually handle pagination

**How to avoid:**
1. Check `response.body.page.totalPages`
2. Loop through all pages if `totalPages > 1`
3. Respect rate limits (delay between requests)

**Warning signs:**
- Customers with long history show incomplete conversation timeline
- Conversation count stops at exactly 50 for some members

**Code pattern:** See Pattern 4 above

### Pitfall 4: Timestamp Format Mismatches

**What goes wrong:** FreeScout API rejects `createdSince` parameter due to incorrect timestamp format

**Why it happens:** FreeScout requires ISO 8601 in UTC: `YYYY-MM-DDThh:mm:ssZ`

**How to avoid:**
1. Always use `new Date().toISOString()` for timestamps
2. Never use locale-specific date formatting
3. Test incremental sync with explicit timestamp

**Warning signs:**
- FreeScout API returns 400 errors on incremental sync
- All conversations downloaded on every run (incremental sync not working)

**Code pattern:**
```javascript
// Store last sync timestamp
const lastSyncTimestamp = new Date().toISOString(); // "2026-02-12T10:30:00.000Z"

// Use in next run
const params = new URLSearchParams({
  customerId: freescoutId,
  createdSince: lastSyncTimestamp  // FreeScout accepts this format
});
```

### Pitfall 5: Not Mapping FreeScout Customer ID to KNVB ID

**What goes wrong:** Can't determine which Rondo Club person to attach activity to

**Why it happens:** FreeScout uses its own customer IDs; must cross-reference via existing tracking table

**How to avoid:**
1. Query `freescout_customers` table (from freescout-sync.sqlite) to get `knvb_id` for each `freescout_id`
2. Use `knvb_id` to look up `rondo_club_id` in `rondo_club_members` table
3. Use `rondo_club_id` in Activities API URL path

**Warning signs:**
- Can't find person ID for FreeScout customers
- Errors about missing KNVB ID mapping

**Code pattern:**
```javascript
// Two-table lookup: freescout_id → knvb_id → rondo_club_id
const freescoutCustomer = freescoutDb.prepare(
  'SELECT knvb_id FROM freescout_customers WHERE freescout_id = ?'
).get(freescoutId);

if (!freescoutCustomer) {
  logger.error(`FreeScout customer ${freescoutId} not in tracking table`);
  continue;
}

const member = rondoClubDb.prepare(
  'SELECT rondo_club_id FROM rondo_club_members WHERE knvb_id = ?'
).get(freescoutCustomer.knvb_id);

if (!member || !member.rondo_club_id) {
  logger.verbose(`No Rondo Club person for ${freescoutCustomer.knvb_id}`);
  continue;
}

// Now have personId for Activities API
const personId = member.rondo_club_id;
```

## Code Examples

Verified patterns from official sources and existing codebase:

### FreeScout Conversations List API
```javascript
// Source: https://api-docs.freescout.net/
// List conversations with customer ID filter and timestamp-based incremental sync
const params = new URLSearchParams({
  customerId: freescoutCustomerId,
  createdSince: '2026-02-01T00:00:00Z',  // ISO 8601 UTC
  sortField: 'createdAt',
  sortOrder: 'asc',
  page: 1,
  pageSize: 50
});

const response = await freescoutRequest(
  `/api/conversations?${params.toString()}`,
  'GET',
  null,
  options
);

// Response structure:
// {
//   page: { size: 50, totalElements: 127, totalPages: 3, number: 1 },
//   _embedded: {
//     conversations: [
//       { id: 123, number: 456, subject: "...", status: "active",
//         createdAt: "2026-02-12T10:30:00Z", customer: { id: 789 } }
//     ]
//   }
// }
```

### Rondo Club Activities Create API
```javascript
// Source: /Users/joostdevalk/Code/rondo/developer/src/content/docs/api/activities.md
// Create email activity on person timeline
const activityPayload = {
  content: "<p>Email conversation: Subject line</p><p>Preview text...</p>",
  activity_type: "email",
  activity_date: "2026-02-12",
  activity_time: "10:30"
};

const response = await rondoClubRequest(
  `rondo/v1/people/${personId}/activities`,
  'POST',
  activityPayload,
  { logger, verbose }
);

// Response: { id: 123, type: "activity", content: "...", ... }
const activityId = response.body.id;
```

### SQLite Deduplication Tracking
```javascript
// Source: lib/freescout-db.js pattern
// Track synced conversations to prevent duplicates
const db = openDb('data/freescout-conversations.sqlite');

db.prepare(`
  INSERT INTO freescout_conversations (
    conversation_id, knvb_id, freescout_customer_id,
    subject, created_at, source_hash
  ) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(conversation_id) DO UPDATE SET
    last_synced_at = excluded.last_synced_at
`).run(
  conversationId,
  knvbId,
  customerId,
  subject,
  createdAt,
  sourceHash
);
```

### Hash-Based Change Detection
```javascript
// Source: lib/utils.js
const { stableStringify, computeHash } = require('../lib/utils');

// Compute hash for conversation to detect changes
function computeConversationHash(conversation) {
  const payload = stableStringify({
    id: conversation.id,
    subject: conversation.subject,
    status: conversation.status,
    createdAt: conversation.createdAt
  });
  return computeHash(payload);
}

// Check if conversation changed since last sync
const storedHash = db.prepare(
  'SELECT source_hash FROM freescout_conversations WHERE conversation_id = ?'
).get(conversationId)?.source_hash;

if (storedHash === newHash) {
  // Unchanged, skip
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual deduplication with in-memory sets | SQLite UNIQUE constraints + tracking tables | Project inception | Prevents race conditions, survives process restarts |
| Full sync on every run | Incremental sync with `createdSince` timestamp | FreeScout API v1.0 | Reduces API load from O(n) to O(new) |
| Separate tracking per entity | Unified `better-sqlite3` pattern across all syncs | Phase 41 migration | Consistent dedup pattern project-wide |
| Custom retry logic per API | Shared `*RequestWithRetry` helpers | Early project | Exponential backoff, 5xx-only retry standardized |

**Deprecated/outdated:**
- N/A — this is a new feature, no deprecated patterns to replace

## Open Questions

1. **Should conversation threads be included in activity content?**
   - What we know: FreeScout conversations can have multiple threads (customer replies, agent replies, notes)
   - What's unclear: Should activity content include all threads, or just conversation subject/summary?
   - Recommendation: Start with subject + preview (first thread snippet) to keep activities concise. Can enhance later if users request full thread history.

2. **How to handle deleted conversations in FreeScout?**
   - What we know: FreeScout supports conversation deletion, but API doesn't expose deletion events
   - What's unclear: Should we detect and remove deleted conversations from Rondo Club timeline?
   - Recommendation: Skip deletion handling in initial implementation. Activities are historical records; once synced, they remain. Can add deletion sync in future phase if needed.

3. **Should sync be per-customer or bulk?**
   - What we know: Must query conversations per customer (no bulk endpoint)
   - What's unclear: Batch by fetching all customers first, or stream process one-by-one?
   - Recommendation: Batch approach — download all customers needing sync, then process. Allows better progress reporting and error recovery.

4. **Rate limiting for FreeScout API?**
   - What we know: FreeScout API documentation doesn't specify rate limits
   - What's unclear: Should we add delay between requests as precaution?
   - Recommendation: Add 100ms delay between customer conversation fetches (same pattern as existing sync code). Monitor for rate limit errors and adjust if needed.

## Sources

### Primary (HIGH confidence)
- [FreeScout API Documentation](https://api-docs.freescout.net/) - Conversations endpoint structure, query parameters, pagination
- Rondo Club Activities API (`/Users/joostdevalk/Code/rondo/developer/src/content/docs/api/activities.md`) - Activity creation endpoint, required fields, activity types
- Existing codebase patterns:
  - `lib/freescout-db.js` - SQLite deduplication pattern
  - `lib/nikki-db.js` - UNIQUE constraint usage, hash-based change detection
  - `pipelines/sync-nikki.js` - Three-step pipeline orchestration
  - `steps/sync-nikki-to-rondo-club.js` - Rondo Club API integration pattern

### Secondary (MEDIUM confidence)
- [WordPress REST API Comments Reference](https://developer.wordpress.org/rest-api/reference/comments/) - Background on WordPress comment architecture (activities are custom comment type)
- [better-sqlite3 npm](https://www.npmjs.com/package/better-sqlite3) - Library documentation, best practices
- [How to Use SQLite in Node.js Applications](https://oneuptime.com/blog/post/2026-02-02-sqlite-nodejs/view) - Current best practices for SQLite in Node.js (2026)

### Tertiary (LOW confidence)
- None — all critical information verified via primary sources

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries already in project, proven in production
- Architecture: HIGH - Patterns directly adapted from existing working code
- Pitfalls: HIGH - Derived from actual project patterns and FreeScout API structure

**Research date:** 2026-02-12
**Valid until:** 2026-03-12 (30 days - stable domain with established patterns)