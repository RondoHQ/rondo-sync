---
id: T01
parent: S13
milestone: M001
provides: []
requires: []
affects: []
key_files: []
key_decisions: []
patterns_established: []
observability_surfaces: []
drill_down_paths: []
duration: 
verification_result: passed
completed_at: 
blocker_discovered: false
---
# T01: 46-freescout-conversations-as-activities 01

**# Phase 46 Plan 01: FreeScout Conversations Download and Activity Preparation**

## What Happened

# Phase 46 Plan 01: FreeScout Conversations Download and Activity Preparation

**One-liner:** SQLite tracking for FreeScout conversations with pagination support, incremental sync, and transformation to Rondo Club activity payloads.

## What Was Built

### 1. FreeScout Conversations Database Module (`lib/freescout-conversations-db.js`)

SQLite tracking database for FreeScout conversations with deduplication and sync state management.

**Schema:**
- `freescout_conversations` table: conversation_id (UNIQUE), knvb_id, freescout_customer_id, subject, status, created_at, source_hash, rondo_club_activity_id, last_synced_at
- `sync_metadata` table: key-value store for last_download_at timestamp
- Indexes: knvb_id lookup, partial index on unsynced conversations (WHERE rondo_club_activity_id IS NULL)

**Functions:**
- `openDb(dbPath)` - Open database with WAL mode and busy_timeout
- `upsertConversations(db, conversations)` - Bulk insert/update with ON CONFLICT handling
- `getUnsyncedConversations(db)` - Query conversations needing activity creation
- `markConversationSynced(db, conversationId, rondoClubActivityId)` - Update sync state
- `getLastSyncTimestamp(db)` / `updateLastSyncTimestamp(db, timestamp)` - Metadata tracking
- `computeConversationHash(conversation)` - SHA-256 hash for change detection

**Pattern:** Follows exact structure from `lib/freescout-db.js` - WAL mode, transactions, hash-based change detection.

### 2. Conversations Download Step (`steps/download-freescout-conversations.js`)

Downloads FreeScout conversations for all tracked customers with pagination and incremental sync support.

**Core logic:**
1. Get all tracked customers with freescout_id from freescout-sync database
2. Get last sync timestamp (skip if `--force` flag used)
3. For each customer:
   - Fetch conversations: `GET /api/conversations?customerId={id}` (add `&createdSince={timestamp}` for incremental)
   - Handle pagination: check `response.body.page.totalPages`, loop through all pages
   - Transform conversations: compute hash, build records with conversation_id, knvb_id, freescout_customer_id, subject, status, created_at, source_hash
   - Add 100ms delay between customers (rate limiting)
4. Bulk upsert all conversations
5. Update last sync timestamp to current time

**Error handling:** Per-customer try/catch - errors logged but don't fail entire step. Step succeeds if at least some customers processed successfully.

**CLI:** `node steps/download-freescout-conversations.js [--verbose] [--force]`

### 3. Activity Preparation Step (`steps/prepare-freescout-activities.js`)

Transforms unsynced FreeScout conversations into Rondo Club activity payloads.

**Core logic:**
1. Get unsynced conversations from conversations database
2. For each conversation:
   - Look up rondo_club_id from rondo-sync database using knvb_id
   - Skip if no rondo_club_id found (member not synced to Rondo Club)
   - Extract date (YYYY-MM-DD) and time (HH:MM) from ISO 8601 created_at
   - Build activity payload with:
     - `personId`: rondo_club_id (for URL path)
     - `conversationId`: conversation_id (for tracking)
     - `body.content`: HTML with escaped subject + FreeScout link
     - `body.activity_type`: "email"
     - `body.activity_date`: YYYY-MM-DD
     - `body.activity_time`: HH:MM
3. Return array of activity payloads ready for submission

**HTML escaping:** Inline function escapes &, <, >, " characters to prevent XSS in activity content.

**CLI:** `node steps/prepare-freescout-activities.js [--verbose]`

## Deviations from Plan

None - plan executed exactly as written.

## Verification Results

All verification steps passed:

1. ✓ `lib/freescout-conversations-db.js` loads without error
2. ✓ `steps/download-freescout-conversations.js` loads without error
3. ✓ `steps/prepare-freescout-activities.js` loads without error
4. ✓ In-memory DB test: upsert → query unsynced (1) → mark synced → query unsynced (0)
5. ✓ All three files follow module/CLI hybrid pattern (export functions + CLI entry point)

## Key Technical Details

### Database Path
`data/freescout-conversations.sqlite` - **separate from** `data/freescout-sync.sqlite` (different concern: conversations vs customers)

### Pagination Handling
```javascript
const totalPages = firstResponse.body.page?.totalPages || 1;
for (let page = 2; page <= totalPages; page++) {
  const pageEndpoint = `${endpoint}&page=${page}`;
  // fetch and accumulate
}
```

### Incremental Sync
```javascript
const lastSyncTimestamp = force ? null : getLastSyncTimestamp(conversationsDb);
if (lastSyncTimestamp && !force) {
  endpoint += `&createdSince=${encodeURIComponent(lastSyncTimestamp)}`;
}
```

### Activity Payload Structure
```javascript
{
  personId: 12345,              // Rondo Club person ID (for URL path)
  conversationId: 67890,         // FreeScout conversation ID (for tracking)
  body: {
    content: "<p><strong>Subject</strong></p><p><a href=\"...\">Bekijk in FreeScout</a></p>",
    activity_type: "email",
    activity_date: "2026-02-12",
    activity_time: "14:30"
  }
}
```

## Next Steps

This plan provides the foundation for syncing FreeScout conversations to Rondo Club. Next steps:

1. Create upload step (`steps/upload-freescout-activities.js`) - POST activities to Rondo Club Activities API
2. Create pipeline orchestrator (`pipelines/sync-freescout-conversations.js`) - connects download → prepare → upload
3. Add to cron schedule for automated sync (likely daily)

## Self-Check: PASSED

**Files created:**
- ✓ FOUND: lib/freescout-conversations-db.js
- ✓ FOUND: steps/download-freescout-conversations.js
- ✓ FOUND: steps/prepare-freescout-activities.js

**Commits exist:**
- ✓ FOUND: 52ecdb4 (feat(46-01): create FreeScout conversations SQLite tracking module)
- ✓ FOUND: c201042 (feat(46-01): create download and prepare steps for FreeScout conversations)

All planned deliverables created and committed successfully.
