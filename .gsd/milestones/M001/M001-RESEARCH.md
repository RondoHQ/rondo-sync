# Project Research Summary

**Project:** Rondo Sync v3.3 - FreeScout Enhanced Integration
**Domain:** Helpdesk/CRM bi-directional data synchronization
**Researched:** 2026-02-12
**Confidence:** HIGH

## Executive Summary

This research evaluates three enhancements to the existing FreeScout integration: (1) syncing FreeScout email conversations as activities in Rondo Club, (2) pushing member photos to FreeScout customer avatars, and (3) mapping Sportlink RelationEnd date to FreeScout custom field ID 9. All three features fit cleanly into the existing rondo-sync architecture with minimal new infrastructure.

The recommended approach leverages existing patterns: hash-based change detection for photos and conversations, the established pipeline step model (download/prepare/submit), and the proven FreeScout API client with retry logic. No new npm dependencies are required. The most complex feature (conversations → activities) requires approximately 380 new lines of code across 2 new step files and database layer enhancements. The simpler features (photos and RelationEnd) are pure modifications to existing steps totaling ~40 lines.

Critical risks center on cross-repository dependencies. The activities API endpoint already exists in Rondo Club (confirmed via developer docs), removing the primary blocker identified during research. However, photo URL extraction requires coordination on whether to use WordPress media API calls or ACF field storage. Implementation should follow a phased approach: start with low-risk RelationEnd field mapping and photo sync, then tackle conversation sync once the Rondo Club integration pattern is validated.

## Key Findings

### Recommended Stack

No new technology stack required. All three features use existing infrastructure: Node.js 22, Playwright, better-sqlite3, the FreeScout API client (`lib/freescout-client.js`), the Rondo Club API client (`lib/rondo-club-client.js`), and the hash-based change detection pattern established in `lib/freescout-db.js`.

**Core technologies (existing):**
- **better-sqlite3**: Conversation tracking table, photo hash storage — proven reliable for member sync tracking
- **FreeScout API client**: Conversations endpoint (`/api/conversations`), photoUrl field, custom fields API — already handles authenticated requests with exponential backoff retry logic
- **Rondo Club API client**: Activities POST endpoint (verified to exist), WordPress media API for photo URLs — existing infrastructure handles authentication
- **Hash-based change detection**: Prevents duplicate uploads/creates, enables incremental sync — established pattern from customer sync

**Critical environment variable:**
- `FREESCOUT_FIELD_RELATION_END=9` (optional, defaults to 9) — enables different field IDs across demo/production environments

**Database migrations (in-code via initDb()):**
- `freescout_customers` table: Add `photo_hash`, `photo_synced_hash` columns
- New `freescout_conversations` table: Track conversation sync state with hash-based change detection

### Expected Features

Research identified standard CRM/helpdesk integration patterns that users expect, competitive differentiators for Rondo Sync's unique use case, and anti-features to explicitly avoid.

**Must have (table stakes):**
- Email conversation visibility in CRM — Industry standard. CRMs display support ticket history on customer records. Rondo Club users work in WordPress, not FreeScout, so conversation visibility is essential for context.
- Customer photos/avatars in helpdesk — Visual identification speeds up support. Expected in modern helpdesk systems (HelpScout, Zendesk, Intercom).
- Custom field sync for membership data — Helpdesk agents need context like membership end date. Custom fields are standard for CRM/helpdesk integrations.

**Should have (competitive differentiators):**
- Real-time activity feed in WordPress — Agents work in Rondo Club, not FreeScout. Inline conversation display eliminates tab switching. Creates single source of truth.
- Bi-directional photo sync — Sportlink → Rondo Club → FreeScout creates single pipeline. Manual photo management across systems is error-prone.
- Automated membership status indicators — "Lid tot" (RelationEnd) date in FreeScout enables proactive support (renewal reminders, post-membership inquiries).

**Defer (v2+):**
- Real-time webhooks — Polling inefficiency doesn't justify webhook complexity for sports club volumes. Cached conversation display (nightly sync) is sufficient.
- Two-way custom field sync — FreeScout is not authoritative for membership data. One-way sync maintains Sportlink as canonical source.
- Inline photo editing in FreeScout — Photos originate from Sportlink. Editing in FreeScout bypasses source of truth and complicates sync logic.

### Architecture Approach

All three features follow the established rondo-sync pipeline pattern: download → prepare → submit. The architecture extends existing components rather than introducing new patterns.

**Major components:**

1. **Photo sync (Feature 2)** — Modify `prepare-freescout-customers.js` to extract photo URL from Rondo Club (via WordPress media API or ACF field). Modify `submit-freescout-sync.js` to include `photoUrl` in customer payload. Add photo hash columns to `freescout_customers` table for change detection. Pure enhancement to existing steps, no new files.

2. **RelationEnd sync (Feature 3)** — Modify `prepare-freescout-customers.js` to extract RelationEnd from member data (verify source: ACF field vs raw Sportlink data in `data_json`). Modify `submit-freescout-sync.js` to add field ID 9 to custom fields payload. Add one environment variable. Simplest feature, approximately 10 lines of code changes.

3. **Conversation sync (Feature 1)** — New step `download-conversations-from-freescout.js` fetches conversations by customer from FreeScout API with pagination handling. New `freescout_conversations` tracking table with hash-based change detection. New step `sync-conversations-to-rondo-club.js` posts activities to Rondo Club `/rondo/v1/people/{id}/activities` endpoint. Wire into `pipelines/sync-freescout.js`. Approximately 380 new lines across 2 files plus database enhancements.

**Data flow:**
```
FreeScout conversations API → download step → SQLite tracking → submit step → Rondo Club activities API
Rondo Club photo URL → prepare step → submit step → FreeScout customer photoUrl field
Sportlink RelationEnd → prepare step → submit step → FreeScout custom field ID 9
```

**File impact:** 2 new step files, 5 modified files, approximately 610 total lines of new code.

### Critical Pitfalls

Research identified 15 pitfalls across critical/moderate/minor severity. Top 5 critical pitfalls that could cause data corruption or require full rewrites:

1. **Photo upload without hash-based change detection** — Re-uploading unchanged photos daily wastes bandwidth and risks API limits. Sync time increases linearly with member count. **Prevention:** Extend `freescout_customers` with `photo_hash` and `photo_synced_hash` columns. Skip upload if hash unchanged. Use existing `computeHash()` from `lib/utils.js`.

2. **FreeScout conversation pagination without total count verification** — Fetching page 1 only syncs 50 most recent emails per customer. Older conversations never appear. Silent data loss. **Prevention:** Check `page.totalPages` metadata, iterate all pages with rate limiting (200ms between pages), log total vs fetched counts for verification.

3. **RelationEnd custom field date format mismatch** — FreeScout expects `YYYY-MM-DD`, but ACF may return `d/m/Y` or ISO 8601 timestamp. Wrong format stored as string "Invalid date", breaking FreeScout UI. **Prevention:** Normalize dates using regex patterns (handle YYYYMMDD, ISO 8601, and YYYY-MM-DD formats). Validate before API submission.

4. **WordPress activity relationship without orphan cleanup** — FreeScout conversations deleted (GDPR, customer left) but activity posts remain in WordPress, pointing to non-existent conversation IDs. ACF relationship breaks. **Prevention:** Track conversation → activity mapping in `freescout_conversations` table. Cascade delete activities when customer deleted. Add weekly orphan cleanup cron.

5. **FreeScout photoUrl vs photo blob upload API ambiguity** — `photoUrl` parameter works on hosted FreeScout but self-hosted instances may not fetch remote URLs (security, firewall, missing module). Photos don't appear despite sync success. **Prevention:** Test both URL-based and multipart upload methods during implementation. Verify photos appear in FreeScout UI after test sync. Implement fallback if URL method fails verification.

## Implications for Roadmap

Based on research, the recommended phase structure follows a risk-based ordering: start with low-complexity, high-value features to validate the integration pattern, then tackle the more complex conversation sync.

### Phase 1: RelationEnd Field Mapping
**Rationale:** Lowest complexity (10 lines of code), immediate value (membership expiration visibility for support agents), zero cross-repo dependencies. Validates FreeScout custom fields API pattern before more complex features.

**Delivers:** Sportlink RelationEnd date visible in FreeScout custom field ID 9, enabling support agents to see membership expiration dates without switching to Sportlink.

**Addresses:**
- Table stakes: Custom field sync for membership data
- Differentiator: Automated membership status indicators

**Avoids:**
- Pitfall 3: Date format mismatch via normalization to YYYY-MM-DD
- Pitfall 10: Custom field ID hardcoding via environment variable

**Implementation:**
- Modify `prepare-freescout-customers.js`: Extract RelationEnd from member data (verify source in `rondo_club_members.data_json`)
- Modify `submit-freescout-sync.js`: Add field ID 9 to `getCustomFieldIds()` and `buildCustomFieldsPayload()`
- Add `FREESCOUT_FIELD_RELATION_END=9` to `.env` and `.env.example`

**Research needed:** None — standard pattern.

### Phase 2: Photo URL Sync to FreeScout
**Rationale:** Low complexity (40 lines), high visual recognition benefit. Requires coordination with Rondo Club team on photo URL approach (ACF field vs WordPress media API), but no new step files. Validates photoUrl API pattern before conversation sync.

**Delivers:** Member photos from Sportlink automatically appear as FreeScout customer avatars, enabling visual identification in support tickets.

**Addresses:**
- Table stakes: Customer photos/avatars in helpdesk
- Differentiator: Bi-directional photo sync (Sportlink → Rondo Club → FreeScout pipeline)

**Avoids:**
- Pitfall 1: Hash-based change detection prevents re-uploading unchanged photos
- Pitfall 5: Test both photoUrl and multipart upload methods
- Pitfall 11: Hash file content, not filename/extension

**Implementation:**
- Coordinate with Rondo Club: Decide approach (ACF `photo_url` field vs WordPress media API GET)
- Extend `freescout_customers` table: Add `photo_hash`, `photo_synced_hash`, `photo_synced_at` columns
- Modify `prepare-freescout-customers.js`: Implement `getPhotoUrl()` based on chosen approach
- Modify `submit-freescout-sync.js`: Add `photoUrl` to customer payload if available

**Research needed:** Coordinate photo URL extraction approach with Rondo Club team.

### Phase 3: FreeScout Conversations as Rondo Club Activities
**Rationale:** Highest complexity (380 new lines, 2 new files), but highest impact for users who work primarily in Rondo Club. Depends on Rondo Club activities API endpoint (confirmed to exist via developer docs). Builds on patterns validated in Phases 1 and 2.

**Delivers:** FreeScout email conversations visible as activities in Rondo Club person timeline, eliminating tab switching for support agents working in WordPress.

**Addresses:**
- Table stakes: Email conversation visibility in CRM
- Differentiator: Real-time activity feed in WordPress (cached approach)

**Avoids:**
- Pitfall 2: Pagination handling for customers with 50+ conversations
- Pitfall 4: Orphan cleanup via conversation tracking table
- Pitfall 8: Timezone conversion (UTC → Europe/Amsterdam)
- Pitfall 9: Duplicate prevention via tracking table

**Implementation:**
- Extend `lib/freescout-db.js`: Add `freescout_conversations` table with hash-based change detection
- New step: `download-conversations-from-freescout.js` (fetch via `/api/conversations?customerId={id}&embed=threads`, handle pagination)
- New step: `sync-conversations-to-rondo-club.js` (POST to `/rondo/v1/people/{id}/activities`)
- Modify `pipelines/sync-freescout.js`: Wire conversation steps after customer sync
- Add cleanup: Cascade delete activities when customer deleted, weekly orphan scan

**Research needed:** Validate Rondo Club activities API contract (payload structure, deduplication handling).

### Phase Ordering Rationale

- **Dependencies:** Phase 1 and 2 have no cross-phase dependencies and can be built in parallel. Phase 3 depends on validating the FreeScout API patterns (pagination, custom fields) established in Phases 1-2.
- **Risk reduction:** Starting with simple features (RelationEnd, photos) validates the integration approach before committing to the complex conversation sync. If FreeScout API quirks surface, they're discovered early.
- **Value delivery:** Phase 1 ships immediately (10 lines of code), providing value to support agents within days. Phase 2 follows within a week. Phase 3 delivers the flagship feature after patterns are proven.
- **Pitfall avoidance:** Hash-based change detection tested in Phase 2 (photos) before applying to Phase 3 (conversations). Date normalization tested in Phase 1 before handling conversation timestamps in Phase 3.

### Research Flags

**Phases with standard patterns (skip research-phase):**
- **Phase 1 (RelationEnd):** Well-documented FreeScout custom fields API. Existing pattern from `submit-freescout-sync.js` lines 18-42. Date normalization pattern established in Sportlink sync.
- **Phase 2 (Photos):** FreeScout photoUrl parameter verified in official docs. Hash-based change detection pattern exists in `freescout-db.js`. WordPress media API standard.

**Phases likely needing coordination during planning:**
- **Phase 2 (Photos):** Coordinate with Rondo Club team on photo URL extraction approach (ACF field vs media API). Decision impacts implementation complexity (0 API calls vs N+1 query risk).
- **Phase 3 (Conversations):** Validate Rondo Club activities API deduplication handling. Test with real FreeScout data to verify pagination behavior and `updatedAt` reliability for incremental sync.

**Recommended validation tests:**
- **Phase 1:** Test RelationEnd with null, empty string, "0000-00-00", future dates, past dates. Verify FreeScout UI date picker works.
- **Phase 2:** Test both photoUrl and multipart upload methods on actual FreeScout instance. Verify photos appear in UI. Test with customers lacking photos (null handling).
- **Phase 3:** Test with customer having 100+ conversations (pagination). Test with deleted conversations (orphan cleanup). Test timezone conversion during DST transition.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Zero new dependencies. All features use existing infrastructure (better-sqlite3, FreeScout/Rondo Club API clients, hash-based change detection). Verified in codebase. |
| Features | HIGH | FreeScout API endpoints verified in official docs. CRM/helpdesk integration patterns validated via industry research (HelpScout, Zendesk, Intercom). Activities API confirmed in Rondo Club developer docs. |
| Architecture | HIGH | All features follow established rondo-sync patterns (download/prepare/submit steps, hash-based change detection, pipeline orchestration). Existing code inspection confirms compatibility. |
| Pitfalls | MEDIUM | Critical pitfalls verified (pagination, hash detection, date formats) via official docs and codebase analysis. FreeScout self-hosted quirks (photoUrl method, custom field IDs) flagged for testing. Conversation `updatedAt` reliability needs validation. |

**Overall confidence:** HIGH

### Gaps to Address

Research identified 5 gaps requiring validation during implementation:

1. **Photo URL extraction approach:** Does Rondo Club expose photo URL in ACF field, or must rondo-sync query WordPress media API? ACF field approach is simpler (0 API calls), but requires Rondo Club code change. Media API approach works today but risks N+1 queries. **Resolution:** Coordinate with Rondo Club team in Phase 2 planning. Recommend ACF field if feasible.

2. **RelationEnd data location:** Is RelationEnd synced to Rondo Club ACF field `relation-end`, or only available in raw Sportlink data (`rondo_club_members.data_json`)? Code inspection of `prepare-rondo-club-members.js` suggests it's in Sportlink data, but needs verification. **Resolution:** Query `rondo_club_members` table during Phase 1 implementation. Implement fallback to check both ACF and raw Sportlink data.

3. **FreeScout conversation `updatedAt` reliability:** Does `updatedAt` timestamp change when new threads added to conversation? Critical for incremental sync optimization. **Resolution:** Test with real FreeScout data in Phase 3. If unreliable, fall back to full conversation fetch (slower but safe).

4. **FreeScout photoUrl vs multipart upload:** Self-hosted FreeScout instances may not fetch remote URLs (security, firewall, missing module). `photoUrl` parameter accepted but photos don't appear. **Resolution:** Test both methods during Phase 2 implementation. Implement verification check (fetch photo URL after upload, verify 200 OK with image MIME type). Add fallback to multipart if URL method fails.

5. **Rondo Club activities deduplication:** How does `/rondo/v1/people/{id}/activities` POST endpoint handle duplicate submissions? Does it check for existing activity by conversation ID? Critical for preventing duplicate timeline entries on re-sync. **Resolution:** Review Rondo Club activities API implementation during Phase 3 planning. Implement client-side duplicate check via `freescout_conversations` tracking table if server-side deduplication unavailable.

## Sources

### Primary (HIGH confidence)
- [FreeScout API Reference](https://api-docs.freescout.net/) — Conversations endpoint, pagination metadata, custom fields API, photoUrl parameter
- [Rondo Club Activities API](~/Code/rondo/developer/src/content/docs/api/activities.md) — POST endpoint contract, activity types, required parameters
- Existing codebase patterns: `lib/freescout-client.js`, `lib/freescout-db.js`, `steps/prepare-freescout-customers.js`, `steps/submit-freescout-sync.js`

### Secondary (MEDIUM confidence)
- [CRM Integration Guide 2026 - Shopify](https://www.shopify.com/blog/crm-integration) — Industry patterns for CRM/helpdesk sync
- [Helpdesk Integration Best Practices - Deskpro](https://www.deskpro.com/product/crm) — Custom field sync standards
- [Laravel Timezone Handling](https://ggomez.dev/blog/best-practices-for-storing-timestamps-in-laravel) — UTC storage, timezone conversion patterns
- [ACF WP REST API Integration](https://www.advancedcustomfields.com/resources/wp-rest-api-integration/) — WordPress media API patterns

### Tertiary (LOW confidence)
- [FreeScout API Issues (GitHub)](https://github.com/freescout-help-desk/freescout/issues/2103) — Known API quirks (rate limits not documented, self-hosted variations)
- Project memory: Parent/member duplicate bug (hash-based change detection critical), SQLite migration corruption (avoid concurrent access), WordPress PUT requirements (first_name/last_name always required)

---
*Research completed: 2026-02-12*
*Ready for roadmap: yes*

# Architecture Patterns: FreeScout Integration Enhancements

**Domain:** FreeScout ↔ Rondo Club Integration
**Researched:** 2026-02-12

## Executive Summary

This architecture document defines how three new features integrate into the existing rondo-sync architecture: (1) FreeScout email conversations as Rondo Club activities, (2) photo sync from Rondo Club to FreeScout customer avatars, and (3) RelationEnd field mapping to FreeScout custom field. All features follow established patterns while adding minimal new components.

**Key finding:** All three features fit cleanly into existing pipeline steps with minimal new infrastructure. The conversation sync requires the most new code (new step + Rondo Club API endpoint), while photo and RelationEnd are minor enhancements to existing steps.

## Feature 1: FreeScout Conversations → Rondo Club Activities

### Data Flow

```
FreeScout conversations API → download step → SQLite tracking → submit step → Rondo Club REST API → Activities display
```

### New Components

| Component | Type | Purpose |
|-----------|------|---------|
| `steps/download-conversations-from-freescout.js` | Download step | Fetch conversations by customer from FreeScout API |
| `lib/freescout-db.js` (enhancement) | DB layer | Add conversation tracking table + functions |
| `steps/sync-conversations-to-rondo-club.js` | Submit step | POST conversations as activities to Rondo Club |
| Rondo Club API: `/rondo/v1/people/{id}/activities` | WordPress endpoint | Accept activity submissions (NOT in rondo-sync, but required) |

### Modified Components

| Component | Modification | Rationale |
|-----------|--------------|-----------|
| `pipelines/sync-freescout.js` | Add conversation sync step after ID sync | Logical ordering: customers first, then conversations |
| `lib/freescout-db.js` | New table: `freescout_conversations` | Track sync state with hash-based change detection |

### Architecture Pattern: Activity Submission

**Data structure for Rondo Club activities:**
```json
{
  "activity_type": "freescout_email",
  "activity_date": "2026-02-12T14:30:00Z",
  "activity_title": "Email: Subject from FreeScout",
  "activity_content": "Email thread content (last N messages)",
  "activity_meta": {
    "freescout_conversation_id": 123,
    "freescout_conversation_number": 456,
    "freescout_customer_id": 789,
    "freescout_url": "https://support.example.org/conversation/456"
  }
}
```

**Endpoint contract (Rondo Club side, not in rondo-sync):**
```
POST /wp-json/rondo/v1/people/{rondo_club_id}/activities
Authorization: Basic {credentials}
Content-Type: application/json

Body: {activity_type, activity_date, activity_title, activity_content, activity_meta}
Response: {success: true, activity_id: 123}
```

### Hash-Based Change Detection

Following existing pattern in `freescout-db.js`:

```javascript
function computeConversationHash(conversationId, data) {
  const payload = stableStringify({
    conversation_id: conversationId,
    data: {
      subject: data.subject,
      status: data.status,
      threads: data.threads.map(t => ({
        id: t.id,
        body: t.body,
        created_at: t.createdAt
      }))
    }
  });
  return computeHash(payload);
}
```

### Conversations Table Schema

```sql
CREATE TABLE IF NOT EXISTS freescout_conversations (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL UNIQUE,
  customer_id INTEGER NOT NULL,
  knvb_id TEXT NOT NULL,
  rondo_club_id INTEGER,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  last_synced_at TEXT,
  last_synced_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_freescout_conversations_customer
  ON freescout_conversations (customer_id);

CREATE INDEX IF NOT EXISTS idx_freescout_conversations_sync
  ON freescout_conversations (source_hash, last_synced_hash);
```

### API Integration Points

**FreeScout API (download):**
```javascript
// Get all conversations for a customer
const response = await freescoutRequest(
  `/api/conversations?customerId=${customerId}&embed=threads`,
  'GET',
  null,
  { logger, verbose }
);

const conversations = response.body._embedded?.conversations || [];
```

**Rondo Club API (submit):**
```javascript
// Submit activity to person record
await rondoClubRequest(
  `/rondo/v1/people/${rondoClubId}/activities`,
  'POST',
  {
    activity_type: 'freescout_email',
    activity_date: conversation.updatedAt,
    activity_title: `Email: ${conversation.subject}`,
    activity_content: formatThreadsAsContent(conversation.threads),
    activity_meta: {
      freescout_conversation_id: conversation.id,
      freescout_conversation_number: conversation.number,
      freescout_customer_id: conversation.customer.id,
      freescout_url: `${FREESCOUT_URL}/conversation/${conversation.number}`
    }
  },
  { logger, verbose }
);
```

### Build Order

1. **Phase 1: Database layer** — Add conversation tracking table and functions to `lib/freescout-db.js`
2. **Phase 2: Download step** — Implement `steps/download-conversations-from-freescout.js`
3. **Phase 3: Submit step** — Implement `steps/sync-conversations-to-rondo-club.js`
4. **Phase 4: Pipeline integration** — Wire steps into `pipelines/sync-freescout.js`
5. **Phase 5: Testing** — Verify with real FreeScout data (requires Rondo Club API endpoint first)

**Critical dependency:** Rondo Club must implement `/rondo/v1/people/{id}/activities` endpoint BEFORE Phase 5.

---

## Feature 2: Rondo Club Photos → FreeScout Customer Avatars

### Data Flow

```
Rondo Club featured image → prepare step → submit step → FreeScout customer photoUrl field
```

### Modified Components Only (No New Components)

| Component | Modification | Rationale |
|-----------|--------------|-----------|
| `steps/prepare-freescout-customers.js` | Fetch photo URL from Rondo Club WordPress media API | Already has `getPhotoUrl()` stub returning null |
| `steps/submit-freescout-sync.js` | Include `photoUrl` in customer payload | FreeScout API already supports this field |

### Architecture Pattern: Photo URL Fetch

**Current code (lines 61-73 in prepare-freescout-customers.js):**
```javascript
function getPhotoUrl(member) {
  // Only include photo URL if photo_state is 'synced'
  if (member.photo_state !== 'synced') {
    return null;
  }

  // TODO: Construct Rondo Club photo URL
  // The photo is attached to the person post in WordPress
  return null; // Currently returns null
}
```

**Enhanced implementation:**
```javascript
async function getPhotoUrl(member, options) {
  if (member.photo_state !== 'synced') {
    return null;
  }

  if (!member.rondo_club_id) {
    return null;
  }

  try {
    // Fetch person post to get featured_media ID
    const personResponse = await rondoClubRequest(
      `wp/v2/people/${member.rondo_club_id}`,
      'GET',
      null,
      options
    );

    const featuredMediaId = personResponse.body.featured_media;
    if (!featuredMediaId) {
      return null;
    }

    // Fetch media object to get source_url
    const mediaResponse = await rondoClubRequest(
      `wp/v2/media/${featuredMediaId}`,
      'GET',
      null,
      options
    );

    return mediaResponse.body.source_url || null;
  } catch (error) {
    // Log error but don't fail preparation
    options.logger?.verbose(`Photo URL fetch failed for ${member.knvb_id}: ${error.message}`);
    return null;
  }
}
```

**Optimization:** Batch fetch all featured media IDs in single pass, then fetch media objects for those that exist. This reduces N+1 queries.

**Alternative approach (simpler, no API calls):**
If Rondo Club exposes photo URL in person ACF field, read directly from `rondo_club_members.data_json`:

```javascript
function getPhotoUrl(member) {
  if (member.photo_state !== 'synced') {
    return null;
  }

  const data = member.data || {};
  const acf = data.acf || {};

  // Assuming Rondo Club stores photo URL in ACF field 'photo_url'
  return acf.photo_url || null;
}
```

**Recommended:** Use ACF field approach if Rondo Club can provide this. Otherwise, use WordPress media API.

### Submit Step Enhancement

**Current payload (submit-freescout-sync.js lines 116-119):**
```javascript
const payload = {
  firstName: customer.data.firstName,
  lastName: customer.data.lastName,
  emails: [{ value: customer.email, type: 'home' }]
};
```

**Enhanced payload:**
```javascript
const payload = {
  firstName: customer.data.firstName,
  lastName: customer.data.lastName,
  emails: [{ value: customer.email, type: 'home' }]
};

// Add photo URL if available
if (customer.data.photoUrl) {
  payload.photoUrl = customer.data.photoUrl;
}
```

### Build Order

1. **Phase 1: Decide approach** — ACF field vs WordPress media API (coordinate with Rondo Club)
2. **Phase 2: Modify prepare step** — Implement `getPhotoUrl()` based on chosen approach
3. **Phase 3: Modify submit step** — Add `photoUrl` to customer payload
4. **Phase 4: Testing** — Verify photos appear in FreeScout customer profiles

**No new files required.** Pure enhancement to existing steps.

---

## Feature 3: Sportlink RelationEnd → FreeScout Custom Field

### Data Flow

```
Sportlink RelationEnd field → prepare step → submit step → FreeScout custom field ID 9
```

### Modified Components Only (No New Components)

| Component | Modification | Rationale |
|-----------|--------------|-----------|
| `steps/prepare-freescout-customers.js` | Extract RelationEnd from member data | Already extracts other Sportlink fields |
| `steps/submit-freescout-sync.js` | Add field ID 9 to custom fields payload | Already sends custom fields array |

### Architecture Pattern: Custom Field Mapping

**Current custom field IDs (submit-freescout-sync.js lines 18-26):**
```javascript
function getCustomFieldIds() {
  return {
    union_teams: parseInt(process.env.FREESCOUT_FIELD_UNION_TEAMS || '1', 10),
    public_person_id: parseInt(process.env.FREESCOUT_FIELD_PUBLIC_PERSON_ID || '4', 10),
    member_since: parseInt(process.env.FREESCOUT_FIELD_MEMBER_SINCE || '5', 10),
    nikki_saldo: parseInt(process.env.FREESCOUT_FIELD_NIKKI_SALDO || '7', 10),
    nikki_status: parseInt(process.env.FREESCOUT_FIELD_NIKKI_STATUS || '8', 10)
  };
}
```

**Enhanced with RelationEnd:**
```javascript
function getCustomFieldIds() {
  return {
    union_teams: parseInt(process.env.FREESCOUT_FIELD_UNION_TEAMS || '1', 10),
    public_person_id: parseInt(process.env.FREESCOUT_FIELD_PUBLIC_PERSON_ID || '4', 10),
    member_since: parseInt(process.env.FREESCOUT_FIELD_MEMBER_SINCE || '5', 10),
    nikki_saldo: parseInt(process.env.FREESCOUT_FIELD_NIKKI_SALDO || '7', 10),
    nikki_status: parseInt(process.env.FREESCOUT_FIELD_NIKKI_STATUS || '8', 10),
    relation_end: parseInt(process.env.FREESCOUT_FIELD_RELATION_END || '9', 10)
  };
}
```

**Current custom fields payload (submit-freescout-sync.js lines 33-42):**
```javascript
function buildCustomFieldsPayload(customFields) {
  const fieldIds = getCustomFieldIds();
  return [
    { id: fieldIds.union_teams, value: customFields.union_teams || '' },
    { id: fieldIds.public_person_id, value: customFields.public_person_id || '' },
    { id: fieldIds.member_since, value: customFields.member_since || '' },
    { id: fieldIds.nikki_saldo, value: customFields.nikki_saldo !== null ? String(customFields.nikki_saldo) : '' },
    { id: fieldIds.nikki_status, value: customFields.nikki_status || '' }
  ];
}
```

**Enhanced with RelationEnd:**
```javascript
function buildCustomFieldsPayload(customFields) {
  const fieldIds = getCustomFieldIds();
  return [
    { id: fieldIds.union_teams, value: customFields.union_teams || '' },
    { id: fieldIds.public_person_id, value: customFields.public_person_id || '' },
    { id: fieldIds.member_since, value: customFields.member_since || '' },
    { id: fieldIds.nikki_saldo, value: customFields.nikki_saldo !== null ? String(customFields.nikki_saldo) : '' },
    { id: fieldIds.nikki_status, value: customFields.nikki_status || '' },
    { id: fieldIds.relation_end, value: customFields.relation_end || '' }
  ];
}
```

### Data Extraction

**Location:** `steps/prepare-freescout-customers.js`, function `prepareCustomer()`

**Current member_since extraction (line 225):**
```javascript
customFields: {
  union_teams: unionTeams,
  public_person_id: member.knvb_id,
  member_since: acf['lid-sinds'] || null,
  nikki_saldo: nikkiData.saldo,
  nikki_status: nikkiData.status
}
```

**Enhanced with RelationEnd:**
```javascript
customFields: {
  union_teams: unionTeams,
  public_person_id: member.knvb_id,
  member_since: acf['lid-sinds'] || null,
  nikki_saldo: nikkiData.saldo,
  nikki_status: nikkiData.status,
  relation_end: acf['relation-end'] || null  // Assuming Rondo Club stores this in ACF
}
```

**Data source verification needed:** Where does RelationEnd live in the sync flow?

From code inspection (steps/prepare-rondo-club-members.js line 173):
```javascript
const relationEnd = (sportlinkMember.RelationEnd || '').trim() || null;
```

This suggests RelationEnd is available in Sportlink download data. Verify if it's synced to Rondo Club ACF fields.

**If NOT in Rondo Club ACF:** Read from `rondo_club_members.data_json` directly (it contains full Sportlink data).

**Implementation:**
```javascript
function prepareCustomer(member, freescoutDb, rondoClubDb, nikkiDb) {
  const data = member.data || {};
  const acf = data.acf || {};

  // Extract RelationEnd from ACF if available, otherwise from raw Sportlink data
  let relationEnd = acf['relation-end'] || null;

  // Fallback: Check raw Sportlink data if not in ACF
  if (!relationEnd && data.sportlink && data.sportlink.RelationEnd) {
    relationEnd = data.sportlink.RelationEnd;
  }

  // ... rest of function

  return {
    // ... existing fields
    customFields: {
      union_teams: unionTeams,
      public_person_id: member.knvb_id,
      member_since: acf['lid-sinds'] || null,
      nikki_saldo: nikkiData.saldo,
      nikki_status: nikkiData.status,
      relation_end: relationEnd
    }
  };
}
```

### Environment Variable

Add to `.env.example` and documentation:
```bash
FREESCOUT_FIELD_RELATION_END=9  # FreeScout custom field ID for "Lid tot"
```

### Build Order

1. **Phase 1: Verify data source** — Confirm where RelationEnd lives in `rondo_club_members.data_json`
2. **Phase 2: Modify prepare step** — Extract RelationEnd and add to customFields
3. **Phase 3: Modify submit step** — Add field ID 9 to custom fields payload
4. **Phase 4: Environment config** — Add `FREESCOUT_FIELD_RELATION_END=9` to `.env`
5. **Phase 5: Testing** — Verify RelationEnd appears in FreeScout customer profiles

**No new files required.** Pure enhancement to existing steps.

---

## Integration Summary

### Component Dependency Graph

```
┌─────────────────────────────────────────────────────────────┐
│ pipelines/sync-freescout.js                                 │
│                                                              │
│  1. prepare-freescout-customers.js (MODIFIED)               │
│     - Extract photo URL (Feature 2)                         │
│     - Extract RelationEnd (Feature 3)                       │
│                                                              │
│  2. submit-freescout-sync.js (MODIFIED)                     │
│     - Send photoUrl field (Feature 2)                       │
│     - Send relation_end custom field (Feature 3)            │
│                                                              │
│  3. sync-freescout-ids-to-rondo-club.js (EXISTING)          │
│                                                              │
│  4. download-conversations-from-freescout.js (NEW)          │
│     - Fetch conversations by customer from FreeScout        │
│     - Track in freescout_conversations table                │
│                                                              │
│  5. sync-conversations-to-rondo-club.js (NEW)               │
│     - POST activities to Rondo Club                         │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ lib/freescout-db.js (MODIFIED)                              │
│                                                              │
│  - ADD: freescout_conversations table                       │
│  - ADD: computeConversationHash()                           │
│  - ADD: upsertConversations()                               │
│  - ADD: getConversationsNeedingSync()                       │
│  - ADD: updateConversationSyncState()                       │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ External Dependencies (Rondo Club WordPress)                │
│                                                              │
│  - POST /wp-json/rondo/v1/people/{id}/activities            │
│    (Required for Feature 1)                                 │
│                                                              │
│  - GET /wp-json/wp/v2/people/{id}                           │
│    (Existing, used for photo URL in Feature 2)              │
│                                                              │
│  - GET /wp-json/wp/v2/media/{id}                            │
│    (Existing, used for photo URL in Feature 2)              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### File Impact Analysis

| File | Change Type | Feature | Lines Changed (est.) |
|------|-------------|---------|---------------------|
| `steps/prepare-freescout-customers.js` | Modified | 2, 3 | +30 |
| `steps/submit-freescout-sync.js` | Modified | 2, 3 | +10 |
| `lib/freescout-db.js` | Modified | 1 | +150 |
| `steps/download-conversations-from-freescout.js` | New | 1 | +200 |
| `steps/sync-conversations-to-rondo-club.js` | New | 1 | +180 |
| `pipelines/sync-freescout.js` | Modified | 1 | +40 |
| `.env.example` | Modified | 3 | +1 |

**Total:** 2 new files, 5 modified files, ~610 lines of new code.

### Risk Assessment

| Feature | Complexity | Risk | Mitigation |
|---------|-----------|------|------------|
| Conversations → Activities | Medium | Rondo Club API endpoint doesn't exist yet | Build steps 1-4 first, test with mock; coordinate with Rondo Club team |
| Photos → FreeScout | Low | WordPress media API N+1 queries | Use ACF field approach if available; otherwise batch fetch |
| RelationEnd → Custom Field | Low | Data location unclear | Verify in rondo_club_members.data_json first; fallback to multiple sources |

---

## Recommended Build Order (Cross-Feature)

**Phase 1: Low-hanging fruit (Features 2 & 3)**
1. Verify RelationEnd data location in `rondo_club_members.data_json`
2. Implement Feature 3 (RelationEnd field mapping)
3. Test Feature 3 with real data
4. Coordinate with Rondo Club team on photo URL approach (ACF vs media API)
5. Implement Feature 2 (photo sync)
6. Test Feature 2 with real data

**Phase 2: Activities integration (Feature 1)**
1. Coordinate with Rondo Club team on activities endpoint design
2. Add conversation tracking table to `lib/freescout-db.js`
3. Implement download step (`download-conversations-from-freescout.js`)
4. Implement submit step (`sync-conversations-to-rondo-club.js`)
5. Wire into pipeline (`sync-freescout.js`)
6. Test with mock Rondo Club endpoint
7. Test with real Rondo Club endpoint once available

**Rationale:** Features 2 and 3 are independent, low-risk enhancements that can ship immediately. Feature 1 requires cross-repo coordination and new infrastructure.

---

## Pipeline Execution Flow (After Integration)

```
sync-freescout.js execution:

1. prepare-freescout-customers.js
   ├─ Extract member data from rondo_club_members
   ├─ Fetch photo URLs (NEW - Feature 2)
   ├─ Extract RelationEnd (NEW - Feature 3)
   └─ Build customer objects with customFields

2. submit-freescout-sync.js
   ├─ Upsert customers to freescout_customers table
   ├─ Sync to FreeScout API (with photoUrl - NEW)
   ├─ Update custom fields (with relation_end - NEW)
   └─ Handle conflicts/errors

3. sync-freescout-ids-to-rondo-club.js
   └─ Write freescout_id back to Rondo Club ACF

4. download-conversations-from-freescout.js (NEW - Feature 1)
   ├─ For each tracked customer with freescout_id:
   │  └─ GET /api/conversations?customerId={id}&embed=threads
   ├─ Upsert to freescout_conversations table
   └─ Mark conversations needing sync (hash changed)

5. sync-conversations-to-rondo-club.js (NEW - Feature 1)
   ├─ For each conversation needing sync:
   │  ├─ Format as activity payload
   │  ├─ POST /rondo/v1/people/{id}/activities
   │  └─ Update sync state in freescout_conversations
   └─ Track errors
```

**Execution time impact:** +30-60 seconds (conversation download/sync for ~300 customers with ~10 conversations each).

---

## Data Storage Impact

### freescout-sync.sqlite Size Estimate

**Current:**
- `freescout_customers`: ~300 rows × ~2KB = 600KB

**After Feature 1:**
- `freescout_conversations`: ~300 customers × ~10 conversations × ~5KB = 15MB

**Total estimated:** ~16MB (manageable for SQLite).

**Retention policy recommendation:** Keep conversations for last 90 days only. Implement cleanup in download step:

```javascript
function cleanupOldConversations(db) {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 90);

  const stmt = db.prepare(`
    DELETE FROM freescout_conversations
    WHERE created_at < ?
  `);

  stmt.run(cutoffDate.toISOString());
}
```

---

## Testing Strategy

### Feature 1: Conversations → Activities

**Unit tests:**
- `computeConversationHash()` produces stable hashes
- `upsertConversations()` handles duplicates correctly
- `getConversationsNeedingSync()` returns only changed conversations
- Activity payload formatting includes all required fields

**Integration tests:**
- Download step fetches conversations from real FreeScout
- Submit step posts to mock Rondo Club endpoint
- Full pipeline with dry-run flag
- Full pipeline with real endpoints

### Feature 2: Photos → FreeScout

**Unit tests:**
- `getPhotoUrl()` returns null for non-synced photos
- `getPhotoUrl()` fetches URL from WordPress media API
- Customer payload includes photoUrl when available

**Integration tests:**
- Prepare step with real Rondo Club data
- Submit step with real FreeScout API
- Verify photos appear in FreeScout customer profiles

### Feature 3: RelationEnd → Custom Field

**Unit tests:**
- RelationEnd extracted from correct data source
- Custom field payload includes field ID 9
- Empty RelationEnd sends empty string (not null)

**Integration tests:**
- Prepare step with real member data
- Submit step with real FreeScout API
- Verify RelationEnd appears in FreeScout custom field

---

## Open Questions

1. **Rondo Club activities endpoint:** What is the exact API contract? What ACF fields store activities?
2. **Photo URL source:** Does Rondo Club expose photo URL in ACF field, or must we use WordPress media API?
3. **RelationEnd in Rondo Club:** Is this field synced to ACF, or only in raw Sportlink data?
4. **Conversation retention:** Should we keep all conversations, or implement 90-day retention?
5. **Activity deduplication:** How does Rondo Club handle duplicate activity submissions?
6. **Photo dimensions:** Does FreeScout have size requirements for photoUrl images?

---

## Sources

- [FreeScout REST API Documentation](https://api-docs.freescout.net/)
- [FreeScout API & Webhooks Module](https://freescout.net/module/api-webhooks/)
- [FreeScout Customer Avatars](https://freescout.shop/downloads/freescout-module-avatars/)
- Existing codebase: `lib/freescout-client.js`, `lib/freescout-db.js`, `steps/prepare-freescout-customers.js`, `steps/submit-freescout-sync.js`

# Technology Stack

**Project:** Rondo Sync v3.3 - FreeScout Enhanced Integration
**Researched:** 2026-02-12

## Overview

This document covers stack additions/changes needed for three NEW FreeScout integration features. The existing Node.js 22, Playwright, SQLite, Fastify, and FreeScout API client stack remains unchanged — this research focuses ONLY on what's needed for:

1. Fetching FreeScout conversations and creating activities in Rondo Club
2. Pushing member photos to FreeScout customers
3. Syncing Sportlink RelationEnd to FreeScout custom field ID 9

**Confidence:** HIGH (verified with official FreeScout API docs, existing codebase patterns)

---

## NEW Capabilities Required

### 1. FreeScout Conversations → Rondo Club Activities

| Component | Technology | Version | Why |
|-----------|-----------|---------|-----|
| **API Client** | Existing `lib/freescout-client.js` | N/A | Already handles authenticated FreeScout API requests with retry logic |
| **HTTP Client** | Node.js `https` module (built-in) | Node.js 22 | No additional library needed — `freescoutRequest()` uses existing `lib/http-client.js` |
| **Rondo Club API** | Existing `lib/rondo-club-client.js` | N/A | Already handles WordPress REST API requests — will need activity creation endpoint |
| **Database** | Existing `lib/freescout-db.js` (better-sqlite3) | Current | Track last synced conversation ID per customer to avoid duplicate activities |

**What NOT to add:**
- ❌ No GraphQL client needed (FreeScout REST API is sufficient)
- ❌ No polling/webhook server (batch sync via cron fits existing patterns)
- ❌ No message queue (volumes don't justify complexity)

**New FreeScout API Endpoint Usage:**

```javascript
// GET /api/conversations?customerId={id}&page=1&pageSize=50
// Returns: { _embedded: { conversations: [...] } }
//
// Each conversation object includes:
// - id, number, subject, status, state, type
// - createdAt (ISO 8601 UTC)
// - customer { id, firstName, lastName, email }
// - threads (if embed=threads parameter used)
```

**Integration Pattern:**

1. Iterate `freescout_customers` table (existing)
2. For each customer with `freescout_id`, fetch conversations via GET `/api/conversations?customerId={id}`
3. Track last synced conversation ID in new `last_conversation_id` column in `freescout_customers`
4. For new conversations, POST to Rondo Club activity endpoint (TBD in Rondo Club research)
5. Store activity relationship in new `freescout_activities` tracking table

**Database Extension:**

```sql
-- Add to lib/freescout-db.js initDb()
ALTER TABLE freescout_customers ADD COLUMN last_conversation_id INTEGER;

CREATE TABLE IF NOT EXISTS freescout_activities (
  id INTEGER PRIMARY KEY,
  knvb_id TEXT NOT NULL,
  freescout_conversation_id INTEGER NOT NULL,
  rondo_club_activity_id INTEGER,
  conversation_subject TEXT,
  conversation_created_at TEXT NOT NULL,
  synced_at TEXT,
  UNIQUE(knvb_id, freescout_conversation_id)
);
```

---

### 2. Member Photos → FreeScout Customers

| Component | Technology | Version | Why |
|-----------|-----------|---------|-----|
| **Photo Storage** | Existing `photos/` directory | N/A | Photos already downloaded from Sportlink via `download-photos-from-api.js` |
| **FreeScout API** | `photoUrl` field on customer PUT | N/A | FreeScout accepts external photo URLs (max 200 chars) — does NOT support file upload |
| **Photo Hosting** | Rondo Club WordPress `/wp-content/uploads/` | N/A | Photos uploaded to WordPress are publicly accessible via permalink |
| **URL Extraction** | Rondo Club API response | N/A | After photo upload, WordPress returns attachment URL |

**What NOT to add:**
- ❌ No image CDN needed (WordPress handles photo serving)
- ❌ No image processing library (Sportlink photos already optimized, WordPress handles resizing)
- ❌ No separate file upload to FreeScout (API uses URL reference, not multipart upload)

**FreeScout API Pattern:**

```javascript
// PUT /api/customers/{freescoutId}
{
  "photoUrl": "https://rondo.svawc.nl/wp-content/uploads/2026/02/12345678.jpg"
}
```

**Integration Points:**

1. **Existing:** Photo downloaded from Sportlink → saved to `photos/{knvb_id}.jpg` (done by `download-photos-from-api.js`)
2. **Existing:** Photo uploaded to Rondo Club → WordPress attachment ID returned (done by `upload-photos-to-rondo-club.js`)
3. **NEW:** After upload, GET person record from Rondo Club API to retrieve photo URL (or extract from upload response)
4. **NEW:** Store photo URL in `freescout_customers.photo_url` column
5. **NEW:** During customer sync, include `photoUrl` in FreeScout PUT request

**Database Extension:**

```sql
-- Add to lib/freescout-db.js initDb()
ALTER TABLE freescout_customers ADD COLUMN photo_url TEXT;
```

**Dependency on Rondo Club:** Requires Rondo Club WordPress to return photo permalink after upload. Verify `/wp-json/rondo/v1/people/{id}/photo` POST response includes attachment URL, or fetch via GET `/wp-json/wp/v2/media/{attachment_id}`.

---

### 3. Sportlink RelationEnd → FreeScout Custom Field ID 9

| Component | Technology | Version | Why |
|-----------|-----------|---------|-----|
| **Data Source** | Existing Sportlink scraper | N/A | `RelationEnd` already captured in `download-functions-from-sportlink.js` |
| **Database** | Existing `rondo_club_members` table | N/A | `relation_end` column already exists (stores Sportlink RelationEnd date) |
| **FreeScout API** | Custom Fields PUT endpoint | N/A | Existing `updateCustomerFields()` in `submit-freescout-sync.js` handles array of `{id, value}` |

**What NOT to add:**
- ❌ No date parsing library (Node.js `Date` handles ISO 8601 from Sportlink)
- ❌ No field mapping config (field ID 9 is hardcoded requirement per spec)
- ❌ No validation library (FreeScout API returns errors for invalid values)

**FreeScout API Pattern (existing code):**

```javascript
// PUT /api/customers/{freescoutId}/customer_fields
{
  "customerFields": [
    { "id": 1, "value": "Team1, Team2" },       // existing: union_teams
    { "id": 4, "value": "123456" },             // existing: public_person_id
    { "id": 5, "value": "2020-01-15" },         // existing: member_since
    { "id": 7, "value": "€45.50" },             // existing: nikki_saldo
    { "id": 8, "value": "Active" },             // existing: nikki_status
    { "id": 9, "value": "2025-12-31" }          // NEW: relation_end
  ]
}
```

**Integration Points:**

1. **Existing:** `RelationEnd` downloaded from Sportlink in `download-functions-from-sportlink.js` → stored in `member_functions.relation_end`
2. **Existing:** Field mapping in `getCustomFieldIds()` in `submit-freescout-sync.js` (currently maps IDs 1, 4, 5, 7, 8)
3. **NEW:** Add `relation_end: parseInt(process.env.FREESCOUT_FIELD_RELATION_END || '9', 10)` to field mapping
4. **NEW:** Add RelationEnd to `prepare-freescout-customers.js` customer data preparation
5. **NEW:** Add `{ id: fieldIds.relation_end, value: customFields.relation_end || '' }` to `buildCustomFieldsPayload()`

**Environment Variable:**

```bash
# Add to .env (with default fallback to 9 in code)
FREESCOUT_FIELD_RELATION_END=9
```

**Data Flow:**

```
Sportlink MemberFunctions API (RelationEnd)
  ↓ download-functions-from-sportlink.js
member_functions table (relation_end column)
  ↓ prepare-freescout-customers.js
customFields.relation_end
  ↓ buildCustomFieldsPayload()
FreeScout API PUT /api/customers/{id}/customer_fields
```

**Date Format:** Sportlink provides dates in various formats. The existing code in `download-functions-from-sportlink.js` line 48 stores `RelationEnd` as-is. FreeScout custom fields accept string values. If FreeScout field is configured as date type, it may require YYYY-MM-DD format — test with actual field configuration.

---

## Installation

**No new dependencies required.** All capabilities use existing libraries:

```bash
# Current dependencies (no changes)
npm install better-sqlite3 playwright form-data
```

**Environment variables to ADD:**

```bash
# .env additions
FREESCOUT_FIELD_RELATION_END=9  # Optional - defaults to 9 if not set
```

**Database migrations:**

All migrations handled in-code via `initDb()` pattern (existing approach):

```javascript
// lib/freescout-db.js initDb() additions
const cols = db.prepare('PRAGMA table_info(freescout_customers)').all();

if (!cols.some(c => c.name === 'last_conversation_id')) {
  db.exec('ALTER TABLE freescout_customers ADD COLUMN last_conversation_id INTEGER');
}

if (!cols.some(c => c.name === 'photo_url')) {
  db.exec('ALTER TABLE freescout_customers ADD COLUMN photo_url TEXT');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS freescout_activities (
    id INTEGER PRIMARY KEY,
    knvb_id TEXT NOT NULL,
    freescout_conversation_id INTEGER NOT NULL,
    rondo_club_activity_id INTEGER,
    conversation_subject TEXT,
    conversation_created_at TEXT NOT NULL,
    synced_at TEXT,
    UNIQUE(knvb_id, freescout_conversation_id)
  )
`);
```

---

## Code Patterns

### Pattern 1: Conversation Fetching (NEW)

**File:** `steps/fetch-freescout-conversations.js` (new file)

```javascript
const { freescoutRequest } = require('../lib/freescout-client');
const { openDb, getCustomersNeedingConversationSync } = require('../lib/freescout-db');

async function fetchConversations(freescoutId, lastConversationId, options) {
  const endpoint = `/api/conversations?customerId=${freescoutId}&sortField=createdAt&sortOrder=desc&pageSize=50`;
  const response = await freescoutRequest(endpoint, 'GET', null, options);

  const conversations = response.body?._embedded?.conversations || [];

  // Filter to only new conversations (ID > lastConversationId)
  if (lastConversationId) {
    return conversations.filter(c => c.id > lastConversationId);
  }

  return conversations;
}
```

**Integration:** Similar to existing `submit-freescout-sync.js` pattern — iterate customers, fetch data, update tracking DB, POST to Rondo Club.

### Pattern 2: Photo URL Sync (extension of existing)

**File:** `steps/sync-freescout-photos.js` (new file) OR extend `steps/sync-freescout-ids-to-rondo-club.js`

```javascript
// After photo upload to Rondo Club, extract URL
const photoUrl = await getRondoClubPhotoUrl(rondoClubId);

// Update FreeScout customer
await freescoutRequest(`/api/customers/${freescoutId}`, 'PUT', {
  photoUrl: photoUrl
}, options);

// Track in database
updatePhotoUrl(db, knvbId, photoUrl);
```

**Integration:** Extend existing photo sync pipeline (`pipelines/sync-people.js`) with new step after `upload-photos-to-rondo-club.js`.

### Pattern 3: RelationEnd Field (modification of existing)

**File:** `steps/submit-freescout-sync.js` (modify existing function)

**Change 1 - Field mapping:**
```javascript
function getCustomFieldIds() {
  return {
    union_teams: parseInt(process.env.FREESCOUT_FIELD_UNION_TEAMS || '1', 10),
    public_person_id: parseInt(process.env.FREESCOUT_FIELD_PUBLIC_PERSON_ID || '4', 10),
    member_since: parseInt(process.env.FREESCOUT_FIELD_MEMBER_SINCE || '5', 10),
    nikki_saldo: parseInt(process.env.FREESCOUT_FIELD_NIKKI_SALDO || '7', 10),
    nikki_status: parseInt(process.env.FREESCOUT_FIELD_NIKKI_STATUS || '8', 10),
    relation_end: parseInt(process.env.FREESCOUT_FIELD_RELATION_END || '9', 10)  // NEW
  };
}
```

**Change 2 - Payload builder:**
```javascript
function buildCustomFieldsPayload(customFields) {
  const fieldIds = getCustomFieldIds();
  return [
    { id: fieldIds.union_teams, value: customFields.union_teams || '' },
    { id: fieldIds.public_person_id, value: customFields.public_person_id || '' },
    { id: fieldIds.member_since, value: customFields.member_since || '' },
    { id: fieldIds.nikki_saldo, value: customFields.nikki_saldo !== null ? String(customFields.nikki_saldo) : '' },
    { id: fieldIds.nikki_status, value: customFields.nikki_status || '' },
    { id: fieldIds.relation_end, value: customFields.relation_end || '' }  // NEW
  ];
}
```

**Change 3 - Data preparation in `prepare-freescout-customers.js`:**
```javascript
// Fetch relation_end from member_functions table (most recent RelationEnd for member)
const relationEndStmt = db.prepare(`
  SELECT relation_end
  FROM member_functions
  WHERE knvb_id = ?
  ORDER BY relation_end DESC
  LIMIT 1
`);
const relationEndRow = relationEndStmt.get(member.knvb_id);

customFields.relation_end = relationEndRow?.relation_end || null;
```

---

## Sources

### Official Documentation

- [FreeScout API Reference](https://api-docs.freescout.net/) - Official API documentation (HIGH confidence)
- [FreeScout API & Webhooks Module](https://freescout.net/module/api-webhooks/) - Module overview

### Verified Capabilities

1. **Conversations API:** GET `/api/conversations` supports `customerId`, `customerEmail`, pagination, sorting, and optional `embed=threads` parameter (verified via official docs)
2. **Custom Fields API:** PUT `/api/customers/{id}/customer_fields` accepts array of `{id, value}` objects (existing code in `submit-freescout-sync.js` line 176)
3. **Photo URL Field:** `photoUrl` field on customer PUT accepts external URLs (max 200 chars) — verified via official docs, does NOT support file upload
4. **RelationEnd Data:** Already captured in `download-functions-from-sportlink.js` line 48, stored in `member_functions.relation_end` column

### Existing Codebase Patterns

- FreeScout API client: `/Users/joostdevalk/Code/rondo/rondo-sync/lib/freescout-client.js`
- FreeScout DB layer: `/Users/joostdevalk/Code/rondo/rondo-sync/lib/freescout-db.js`
- Photo download: `/Users/joostdevalk/Code/rondo/rondo-sync/steps/download-photos-from-api.js`
- Photo upload: `/Users/joostdevalk/Code/rondo/rondo-sync/steps/upload-photos-to-rondo-club.js`
- Custom field sync: `/Users/joostdevalk/Code/rondo/rondo-sync/steps/submit-freescout-sync.js` lines 18-42, 172-181

---

## Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Rondo Club activity endpoint doesn't exist yet** | High | Requires parallel Rondo Club development — coordinate with WordPress theme research |
| **Photo URL extraction unclear** | Medium | Test Rondo Club photo upload response format — may need GET `/wp-json/wp/v2/media/{id}` |
| **FreeScout custom field 9 date format** | Low | Test with actual FreeScout configuration — may need date normalization |
| **Conversation pagination limits** | Low | Handle pagination if customer has >50 conversations (rare for sports club) |
| **Photo URL 200 char limit** | Very Low | WordPress URLs typically <100 chars for uploads |

---

## Dependencies on Rondo Club (WordPress)

**CRITICAL:** Feature 1 (conversations → activities) requires NEW Rondo Club WordPress API endpoint:

```
POST /wp-json/rondo/v1/people/{id}/activities
{
  "title": "FreeScout: {conversation subject}",
  "source": "freescout",
  "source_id": "{conversation_id}",
  "activity_date": "{conversation createdAt}",
  "activity_type": "email",
  "meta": {
    "conversation_number": "{number}",
    "conversation_status": "{status}",
    "conversation_url": "https://freescout.example.com/conversation/{id}"
  }
}
```

This endpoint does NOT exist yet — must be implemented in Rondo Club theme research/development phase.

**Photo URL:** Existing `/wp-json/rondo/v1/people/{id}/photo` POST endpoint must return photo URL in response (verify or add GET endpoint to retrieve URL after upload).

---

## Summary

**Zero new npm packages required.** All three features use existing infrastructure:

1. **Conversations → Activities:** FreeScout API client + Rondo Club API client + SQLite tracking (all existing). Requires NEW Rondo Club WordPress activity endpoint.
2. **Photos → FreeScout:** Existing photo download/upload pipeline + FreeScout `photoUrl` field. Requires photo URL extraction from Rondo Club.
3. **RelationEnd → Field 9:** Existing Sportlink scraper + existing FreeScout custom fields sync. Add one field to mapping.

**Codebase changes:**
- Extend `lib/freescout-db.js` with 2 new columns + 1 new table (SQLite migrations)
- New step: `steps/fetch-freescout-conversations.js`
- New step: `steps/sync-freescout-photos.js` OR extend `steps/sync-freescout-ids-to-rondo-club.js`
- Modify: `steps/submit-freescout-sync.js` (add RelationEnd field mapping)
- Modify: `steps/prepare-freescout-customers.js` (add RelationEnd data extraction)

**Environment:**
- Add `FREESCOUT_FIELD_RELATION_END=9` (optional, defaults to 9)

**Blockers:**
- Rondo Club WordPress must provide activity creation endpoint (Feature 1)
- Rondo Club WordPress must return photo URL after upload (Feature 2)

# Feature Landscape

**Domain:** Helpdesk/CRM integration with WordPress (FreeScout + Rondo Club)
**Researched:** 2026-02-12

## Table Stakes

Features users expect. Missing = product feels incomplete.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| **Email conversation visibility in CRM** | Industry standard — CRMs display support ticket history on customer records. Users expect complete interaction history. | Medium | FreeScout API provides `/api/conversations?customerEmail=` endpoint. Modern CRMs thread all conversations by customer. |
| **Customer photos/avatars in helpdesk** | Visual identification speeds up support. Expected in modern helpdesk systems (HelpScout, Zendesk, Intercom all support it). | Low | FreeScout API accepts `photoUrl` parameter on customer create/update. Photo must be web-accessible URL (not file upload). |
| **Custom field sync for membership data** | Helpdesk agents need context (membership status, end date, etc.). Custom fields are standard for CRM/helpdesk integrations. | Low | FreeScout API supports custom fields via `/api/customers/{id}/customer_fields` endpoint. Date fields use `YYYY-MM-DD` format. |

## Differentiators

Features that set product apart. Not expected, but valued.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| **Real-time activity feed in WordPress** | Agents work in WordPress (Rondo Club), not FreeScout. Showing conversations inline = faster context, no tab switching. | Medium-High | Requires storing/caching FreeScout data in WordPress (ACF repeater or REST endpoint). Alternative: client-side fetch on page load (slower, API rate limits). |
| **Bi-directional photo sync** | Photos from Sportlink → Rondo Club → FreeScout creates single source of truth. Manual photo management across systems is error-prone. | Medium | Existing: Sportlink → Rondo Club (via MemberHeader API). New: Rondo Club → FreeScout (needs WordPress media URL extraction). |
| **Automated membership status indicators** | "Lid tot" (member until) date in FreeScout shows agents when membership expires. Proactive support (renewal reminders, post-membership inquiries). | Low | Leverages existing `RelationEnd` field from Sportlink CSV export. Maps to FreeScout custom field ID 9. |
| **Deep-link navigation** | FreeScout customer records link to Sportlink + Rondo Club person pages. Agents jump directly to source systems for full member context. | Low | Already implemented in `prepare-freescout-customers.js` (websites array). Table stakes for multi-system workflows. |

## Anti-Features

Features to explicitly NOT build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| **Create FreeScout conversations from Rondo Club** | FreeScout is the source of truth for support tickets. Creating conversations from WordPress violates single-responsibility principle and risks data conflicts. | Read-only display of FreeScout conversations in Rondo Club. Support agents create tickets in FreeScout. |
| **Real-time webhooks for conversation updates** | Polling FreeScout API for every person page load is inefficient. Webhooks add complexity (server endpoints, security, state management) for marginal benefit. | Cache FreeScout conversations in WordPress database (nightly sync or on-demand refresh). Display cached data with timestamp. |
| **Two-way custom field sync** | FreeScout is not authoritative for membership data. Syncing FreeScout changes back to Sportlink creates data conflicts and overwrites canonical source. | One-way sync: Sportlink → Rondo Club → FreeScout. FreeScout custom fields are read-only displays of upstream data. |
| **Inline photo editing in FreeScout** | Photos originate from Sportlink. FreeScout editing bypasses source of truth, creates orphaned files, and complicates sync logic. | Display photos from Rondo Club. Updates happen in Sportlink → flow downstream. |

## Feature Dependencies

```
FreeScout Customer Sync (EXISTING)
  ├─> Photo URL Sync (NEW)
  │     └─> Requires: WordPress media URL extraction from person post
  │
  ├─> RelationEnd Custom Field (NEW)
  │     └─> Requires: Sportlink CSV field mapping + FreeScout custom field API
  │
  └─> Email Conversation Display (NEW)
        ├─> Requires: FreeScout conversation fetch by email
        └─> Decision: Store in WordPress DB vs client-side fetch
              ├─> WordPress DB: Requires cache table, nightly sync step
              └─> Client-side: Requires JavaScript widget, CORS/auth handling
```

## MVP Recommendation

Prioritize:
1. **RelationEnd custom field sync** (Low complexity, high value — immediate agent context)
2. **Photo URL sync** (Low complexity, visual recognition benefit)
3. **Email conversation display (cached approach)** (Medium complexity, high impact — agents work in WordPress)

Defer:
- **Real-time activity feed**: Requires caching infrastructure decision first (Phase 1 research question: WordPress REST endpoint vs ACF repeater vs custom table)
- **Advanced conversation threading**: FreeScout handles threading. Rondo Club shows read-only timeline.

## Implementation Patterns

### Pattern 1: Photo URL Sync
**What:** Extract WordPress media URL from person post, send to FreeScout `photoUrl` field
**When:** After photo upload to Rondo Club (`photo_state = 'synced'`)
**Existing Code:**
- Photo download: `steps/download-photos-from-api.js` (Sportlink → local disk)
- Photo state tracking: `lib/rondo-club-db.js` (`photo_state` field)
- FreeScout customer update: `steps/submit-freescout-sync.js`

**New Requirements:**
- Query WordPress REST API for media attachments where `parent = {person_post_id}`
- Extract `source_url` from media response
- Include `photoUrl: media.source_url` in FreeScout customer data
- Handle edge case: Multiple attachments (select featured image or most recent)

### Pattern 2: RelationEnd Custom Field
**What:** Map Sportlink `RelationEnd` date to FreeScout custom field ID 9
**When:** During FreeScout customer sync (daily)
**Existing Code:**
- RelationEnd extraction: `steps/prepare-rondo-club-members.js:173` (stored in ACF `lid-tot` field)
- Custom field support: `steps/prepare-freescout-customers.js` (customFields object)
- FreeScout API client: `lib/freescout-client.js`

**New Requirements:**
- Add `lid_tot: acf['lid-tot']` to customFields object in `prepareCustomer()` function
- Map to FreeScout custom field ID 9 in submit step
- Use FreeScout API endpoint: `PUT /api/customers/{id}/customer_fields`
- Format: `{ customerFields: [{ id: 9, value: "YYYY-MM-DD" }] }`
- Handle null values (members without end date)

### Pattern 3: Conversation Display (Cached Approach)
**What:** Fetch FreeScout conversations by email, store in WordPress, display on person page
**When:** Nightly sync (or on-demand refresh button)
**Architecture Options:**

#### Option A: ACF Repeater Field
- **Pros:** Familiar WordPress pattern, no custom tables, REST API support built-in
- **Cons:** ACF repeaters slow with 100+ conversations, field bloat on person posts
- **Best For:** Low conversation volume (< 50 per person)

#### Option B: Custom WordPress Table
- **Pros:** Fast queries, independent of person posts, supports pagination
- **Cons:** Custom schema migration, manual REST endpoint, backup complexity
- **Best For:** High conversation volume, complex filtering

#### Option C: REST Endpoint (No Storage)
- **Pros:** No caching logic, always fresh data, minimal code
- **Cons:** FreeScout API latency on every page load, rate limit risk, no offline access
- **Best For:** Low traffic, small member base (< 500 people)

**Recommendation:** Start with Option C (REST endpoint, no storage) for MVP. Migrate to Option B if FreeScout API becomes bottleneck.

**API Flow:**
1. WordPress REST endpoint: `GET /wp-json/rondo/v1/person/{id}/freescout-conversations`
2. Extract email from person ACF fields
3. Call FreeScout API: `GET /api/conversations?customerEmail={email}&embed=threads`
4. Parse response: Extract `id`, `subject`, `status`, `created_at`, thread preview
5. Return JSON to frontend
6. Display in React/Vue widget on person edit page

## Conversation Display UX Patterns

Based on industry research, effective activity timeline displays follow these principles:

### Progressive Disclosure
- **Initial View:** Show 5 most recent conversations (subject, status, date)
- **Expand:** Click conversation to show thread preview
- **Deep Link:** "View in FreeScout" button to full conversation

### Visual Hierarchy
- **Status Indicators:** Color-coded badges (Active = green, Closed = gray, Pending = yellow)
- **Timestamps:** Relative time ("2 days ago") for recent, absolute dates for old
- **Avatars:** FreeScout agent photo + customer photo (if available)

### Whitespace & Spacing
- **Card-based Layout:** Each conversation in separate card with subtle border
- **Spacing:** 16px vertical gap between conversations
- **No Clutter:** Hide metadata (mailbox, folder, tags) unless relevant

### Micro-interactions
- **Hover States:** Card elevates on hover (box-shadow)
- **Loading States:** Skeleton loader while fetching from FreeScout API
- **Error States:** "Could not load conversations" with retry button

**Reference Implementations:**
- [Figma Activity Feed Components](https://www.untitledui.com/components/activity-feeds) (design patterns)
- [UX Flows for Activity Feeds](https://pageflows.com/web/screens/activity-feed/) (interaction patterns)

## Data Freshness Considerations

| Approach | Freshness | API Load | Complexity |
|----------|-----------|----------|------------|
| **Real-time fetch** | Always current | High (every page load) | Low (single API call) |
| **Cached (nightly)** | 0-24 hours stale | Low (daily batch) | Medium (cache invalidation logic) |
| **Hybrid (cache + refresh button)** | User-controlled | Low (on-demand spikes) | High (state management) |

**For this project:** Start with real-time fetch (MVP). The Rondo Club member base is small (< 1000 people), and WordPress person pages are low-traffic admin views, not public pages. FreeScout API rate limits are unlikely to be hit.

**Migration Path:** If FreeScout API becomes bottleneck, add caching layer:
1. Create `freescout_conversations` table in `rondo-sync.sqlite`
2. Add nightly sync step: `scripts/sync.sh freescout-conversations`
3. Update WordPress REST endpoint to query local cache
4. Add `Last synced: 2 hours ago` timestamp to UI

## Sources

**FreeScout API Documentation:**
- [FreeScout API Reference](https://api-docs.freescout.net/) — Conversations endpoint, customer fields, photoUrl parameter (HIGH confidence)

**Helpdesk/CRM Integration Best Practices:**
- [CRM Integration Guide 2026 - Shopify](https://www.shopify.com/blog/crm-integration) (MEDIUM confidence)
- [Email Integration Best Practices - Smartlead](https://www.smartlead.ai/blog/email-integration) (MEDIUM confidence)
- [CRM Help Desk Integration - Deskpro](https://www.deskpro.com/product/crm) (MEDIUM confidence)

**WordPress/ACF Patterns:**
- [ACF WP REST API Integration](https://www.advancedcustomfields.com/resources/wp-rest-api-integration/) (HIGH confidence)
- [How to Fetch API Data in WordPress - ACF](https://www.advancedcustomfields.com/blog/wordpress-fetch-data-from-api/) (HIGH confidence)
- [ACF Repeater Field Guide - WPLake](https://wplake.org/blog/how-to-use-and-display-the-acf-repeater-field/) (MEDIUM confidence)

**UI/UX Design Patterns:**
- [CRM UX Design Best Practices - Design Studio](https://www.designstudiouiux.com/blog/crm-ux-design-best-practices/) (MEDIUM confidence)
- [Activity Feed Components - Untitled UI](https://www.untitledui.com/components/activity-feeds) (HIGH confidence)
- [UX Flows for Activity Feeds - Pageflows](https://pageflows.com/web/screens/activity-feed/) (HIGH confidence)

**Sportlink API:**
- [Sportlink Club.Dataservice PHP Wrapper - GitHub](https://github.com/PendoNL/php-club-dataservice) (MEDIUM confidence — no official RelationEnd docs found, field confirmed in project config/sportlink-fields.json)

# Domain Pitfalls: FreeScout Email Activities, Photo Sync, and Custom Field Mapping

**Domain:** FreeScout integration enhancement for Rondo Sync
**Researched:** 2026-02-12
**Confidence:** MEDIUM (FreeScout API docs verified, Laravel timezone patterns established, existing codebase patterns analyzed)

## Critical Pitfalls

These mistakes cause data corruption, duplicate entries, or require full rewrites.

### Pitfall 1: Photo Upload Without Hash-Based Change Detection

**What goes wrong:** Re-uploading unchanged photos on every sync creates unnecessary API calls, wastes bandwidth, and risks hitting WordPress media library limits. Without hash comparison, photo sync becomes exponentially slower over time.

**Why it happens:** Existing FreeScout customer sync uses hash-based change detection (`source_hash` vs `last_synced_hash` in `freescout-db.js`). Photo sync in `upload-photos-to-rondo-club.js` uses state tracking but lacks content hashing. Developers assume FreeScout photo sync should follow the same pattern, forgetting to add hash storage for photos.

**Consequences:**
- 1000+ member sync re-uploads all photos daily (4x daily on people sync schedule)
- WordPress media library bloats with duplicate attachments
- Sync time increases from minutes to hours
- API rate limits may trigger failures mid-sync
- Photo state becomes unreliable (uploaded but hash not stored = re-upload next run)

**Prevention:**
1. **Extend `freescout_customers` table** with photo hash columns:
   ```sql
   ALTER TABLE freescout_customers ADD COLUMN photo_hash TEXT;
   ALTER TABLE freescout_customers ADD COLUMN photo_synced_at TEXT;
   ALTER TABLE freescout_customers ADD COLUMN photo_synced_hash TEXT;
   ```
2. **Hash photo files** using existing `computeHash()` from `lib/utils.js`:
   ```javascript
   const photoBuffer = await fs.readFile(photoPath);
   const photoHash = computeHash(photoBuffer);
   ```
3. **Skip upload if `photo_synced_hash === photo_hash`** (unchanged photo)
4. **Update `photo_synced_hash` only after successful FreeScout API confirmation**
5. **Use retry logic** from existing `freescoutRequestWithRetry` for 5xx errors

**Detection:**
- Photo sync time increases linearly with member count
- FreeScout storage grows continuously despite no photo changes
- API error logs show timeouts during photo upload phase
- Database query: `SELECT COUNT(*) FROM freescout_customers WHERE photo_hash IS NOT NULL AND photo_synced_hash IS NULL` (should be 0 after successful sync)

---

### Pitfall 2: FreeScout Conversation Pagination Without Total Count Verification

**What goes wrong:** FreeScout API paginates conversations (default 50/page, max unknown). Fetching page 1 only syncs recent 50 emails per customer. Older conversations never appear in Rondo Club. Customers with 100+ emails lose 50+ activities.

**Why it happens:** Developers copy single-page patterns from customer sync (`/api/customers` likely returns all via `_embedded.customers`). FreeScout docs show `page` and `pageSize` params exist but don't emphasize multi-page iteration requirement. First test with low-email-volume customer succeeds (< 50 conversations), hiding the bug.

**Consequences:**
- Partial conversation history synced (only most recent 50 per customer)
- Activity timeline shows gaps for high-volume support users
- No error thrown (API returns success with partial data)
- Silent data loss discovered weeks later when user reports "missing emails"
- Re-syncing requires tracking which conversations already synced (complex state management)

**Prevention:**
1. **Always check pagination metadata** in API response:
   ```javascript
   const response = await freescoutRequest(`/api/conversations?customerEmail=${email}`, 'GET');
   const page = response.body.page; // { size: 50, totalElements: 237, totalPages: 5, number: 1 }
   if (page.totalPages > 1) {
     // Fetch remaining pages
   }
   ```
2. **Implement page iteration loop** similar to existing pagination patterns:
   ```javascript
   let allConversations = [];
   for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
     const resp = await freescoutRequest(
       `/api/conversations?customerEmail=${email}&page=${pageNum}`,
       'GET'
     );
     allConversations.push(...resp.body._embedded.conversations);
     await sleep(200); // Rate limiting between pages
   }
   ```
3. **Log total vs fetched counts** for verification:
   ```javascript
   logger.verbose(`Fetched ${allConversations.length} of ${page.totalElements} conversations`);
   if (allConversations.length !== page.totalElements) {
     logger.error(`Conversation count mismatch for ${email}`);
   }
   ```
4. **Store last sync cursor** in `freescout_customers` to enable incremental sync:
   ```sql
   ALTER TABLE freescout_customers ADD COLUMN last_conversation_sync_at TEXT;
   ```
5. **Use `updatedAt` filter** to fetch only new/updated conversations after initial full sync

**Detection:**
- Customers with high email volume show fewer activities than expected
- `SELECT freescout_id, COUNT(*) FROM rondo_club_activities GROUP BY freescout_id HAVING COUNT(*) = 50` (suspicious exact-50 counts)
- Compare conversation count in FreeScout UI vs Rondo Club activity count
- Warning sign: first test customer has < 50 emails and sync "works perfectly"

---

### Pitfall 3: RelationEnd Custom Field Date Format Mismatch

**What goes wrong:** FreeScout custom field ID 9 expects `YYYY-mm-dd` format (per API docs). Rondo Club ACF date field may return `d/m/Y` or ISO 8601 timestamp. Wrong format rejected silently or stored as string "Invalid date", breaking FreeScout UI date picker and filtering.

**Why it happens:** WordPress ACF date fields return formatted strings (format depends on field settings). FreeScout API silently accepts malformed dates as strings. No immediate error during sync. FreeScout UI shows blank date or garbled text in custom field 9.

**Consequences:**
- RelationEnd dates invisible in FreeScout customer view
- FreeScout searches by "membership end date" return 0 results (malformed dates don't match)
- Silent data corruption (stored as string, not date type)
- Requires manual FreeScout database fix: `UPDATE customer_fields SET value = DATE_FORMAT(STR_TO_DATE(value, '%d/%m/%Y'), '%Y-%m-%d') WHERE field_id = 9`
- Customer support can't filter by upcoming expirations

**Prevention:**
1. **Normalize date format before API submission** using existing patterns from Sportlink sync:
   ```javascript
   function normalizeRelationEndDate(acfDateValue) {
     if (!acfDateValue) return null;

     // ACF returns YYYYMMDD when return format is YYYYMMDD
     if (/^\d{8}$/.test(acfDateValue)) {
       return `${acfDateValue.substr(0,4)}-${acfDateValue.substr(4,2)}-${acfDateValue.substr(6,2)}`;
     }

     // ISO 8601 timestamp (2026-02-12T00:00:00Z)
     if (acfDateValue.includes('T')) {
       return acfDateValue.split('T')[0]; // Extract YYYY-MM-DD
     }

     // Already YYYY-MM-DD
     if (/^\d{4}-\d{2}-\d{2}$/.test(acfDateValue)) {
       return acfDateValue;
     }

     logger.error(`Unknown RelationEnd date format: ${acfDateValue}`);
     return null;
   }
   ```
2. **Validate before sending** to FreeScout:
   ```javascript
   const relationEnd = normalizeRelationEndDate(rondoClubData.relation_end);
   if (relationEnd && !/^\d{4}-\d{2}-\d{2}$/.test(relationEnd)) {
     throw new Error(`Invalid date format for field 9: ${relationEnd}`);
   }
   ```
3. **Add field ID 9 to custom fields payload** in `buildCustomFieldsPayload()`:
   ```javascript
   { id: fieldIds.relation_end, value: customFields.relation_end || '' }
   ```
4. **Add env var** for configurability:
   ```bash
   FREESCOUT_FIELD_RELATION_END=9  # Default
   ```
5. **Test with edge cases:** null, empty string, "0000-00-00", future dates, past dates

**Detection:**
- FreeScout UI shows blank or "Invalid date" in custom field 9
- Database query: `SELECT value FROM customer_fields WHERE field_id = 9 AND value NOT REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`
- Rondo Club has populated `relation_end` but FreeScout shows empty
- Manual FreeScout customer inspection after first test sync

---

### Pitfall 4: WordPress Activity Timeline Relationship Without Orphan Cleanup

**What goes wrong:** FreeScout conversations deleted (customer left club, GDPR request) but activity posts remain in WordPress, pointing to non-existent FreeScout conversation IDs. ACF relationship field breaks, showing "Post not found" errors. Activity timeline shows orphaned entries.

**Why it happens:** Bidirectional sync assumption—developers sync FreeScout → Rondo Club but forget delete propagation. WordPress has no foreign key constraints. ACF relationship fields store post IDs as strings in post meta, no referential integrity. Existing `deleteOrphanCustomers()` in `submit-freescout-sync.js` handles customer deletion but doesn't cascade to activities.

**Consequences:**
- Orphaned activity posts accumulate (never cleaned up)
- ACF relationship queries include deleted FreeScout refs (performance degrades)
- User clicks activity → 404 or "Access denied"
- WordPress database bloats with dead post meta rows
- Manual cleanup required: `wp post delete $(wp post list --post_type=activity --format=ids --meta_key=freescout_conversation_id --meta_value=DELETED_ID)`

**Prevention:**
1. **Track conversation → activity post mapping** in `freescout-db.js`:
   ```sql
   CREATE TABLE IF NOT EXISTS freescout_conversations (
     id INTEGER PRIMARY KEY,
     conversation_id INTEGER NOT NULL UNIQUE,
     customer_knvb_id TEXT NOT NULL,
     rondo_club_activity_id INTEGER,
     last_synced_at TEXT,
     FOREIGN KEY (customer_knvb_id) REFERENCES freescout_customers(knvb_id) ON DELETE CASCADE
   );
   ```
2. **Delete activity posts when customer deleted**:
   ```javascript
   async function deleteCustomerActivities(knvbId, db, options) {
     const conversations = db.prepare(
       'SELECT rondo_club_activity_id FROM freescout_conversations WHERE customer_knvb_id = ?'
     ).all(knvbId);

     for (const conv of conversations) {
       if (conv.rondo_club_activity_id) {
         await rondoClubRequest(`/wp-json/wp/v2/activity/${conv.rondo_club_activity_id}`, 'DELETE');
       }
     }

     db.prepare('DELETE FROM freescout_conversations WHERE customer_knvb_id = ?').run(knvbId);
   }
   ```
3. **Add cleanup step** to `deleteOrphanCustomers()` in `submit-freescout-sync.js`
4. **Weekly orphan scan** (cron job):
   ```javascript
   // tools/cleanup-orphan-activities.js
   // Check for activity posts with freescout_conversation_id not in freescout_conversations table
   ```
5. **Log orphan counts** in dashboard for monitoring

**Detection:**
- `SELECT COUNT(*) FROM freescout_conversations WHERE rondo_club_activity_id IS NOT NULL` > actual activity post count
- WordPress: `SELECT COUNT(*) FROM wp_postmeta WHERE meta_key = 'freescout_conversation_id' AND post_id NOT IN (SELECT ID FROM wp_posts WHERE post_status != 'trash')`
- User reports "missing conversation" errors
- ACF relationship field shows "(no title)" entries

---

### Pitfall 5: FreeScout photoUrl vs Photo Blob Upload API Ambiguity

**What goes wrong:** FreeScout API docs show `photoUrl` parameter for customer create/update, suggesting URL-based photo sync. But self-hosted FreeScout instances may not fetch remote URLs (security, firewall, or module not installed). Photos don't appear despite sync reporting success.

**Why it happens:** FreeScout is open-source Laravel app with varying module installations. `photoUrl` works on SaaS/hosted instances with background job processors. Self-hosted installs may lack this or have `allow_url_fopen` disabled in PHP. API accepts `photoUrl` (200 OK) but doesn't actually fetch it. No error returned.

**Consequences:**
- Photos uploaded successfully to Rondo Club but never appear in FreeScout
- Silent failure (API returns 200, stores URL string, never downloads)
- Debugging requires FreeScout server logs (unavailable to sync script)
- Assumption that sync "works" because no errors logged
- Alternative: Requires multipart/form-data upload (blob), not URL string

**Prevention:**
1. **Test both methods** during initial implementation:
   - Method A: `photoUrl` string (simple, may not work on self-hosted)
   - Method B: Multipart form-data upload (complex, reliable)
2. **Check FreeScout version and modules** via `/api/users/me` response metadata
3. **Verify photo appears** after test sync (automated check):
   ```javascript
   const customer = await freescoutRequest(`/api/customers/${freescoutId}`, 'GET');
   if (customer.body.photoUrl !== expectedPhotoUrl) {
     logger.error(`Photo URL not set for customer ${freescoutId}`);
   }
   // Better: Check if photoUrl returns 200 OK with image MIME type
   const photoResp = await fetch(customer.body.photoUrl);
   if (!photoResp.ok || !photoResp.headers.get('content-type').startsWith('image/')) {
     logger.error(`Photo not accessible for customer ${freescoutId}`);
   }
   ```
4. **Implement multipart upload fallback** if `photoUrl` method fails verification:
   ```javascript
   async function uploadPhotoToFreeScout(freescoutId, photoPath, options) {
     // Try Method A: photoUrl
     const photoUrl = await uploadPhotoToPublicUrl(photoPath); // S3, CDN, etc.
     const urlResult = await freescoutRequest(`/api/customers/${freescoutId}`, 'PUT', { photoUrl });

     // Verify photo accessible
     await sleep(2000); // Wait for FreeScout to fetch
     const customer = await freescoutRequest(`/api/customers/${freescoutId}`, 'GET');
     if (customer.body.photoUrl && await verifyPhotoAccessible(customer.body.photoUrl)) {
       return { success: true, method: 'photoUrl' };
     }

     // Fallback to Method B: multipart
     logger.verbose('photoUrl method failed, using multipart upload');
     return await uploadPhotoMultipart(freescoutId, photoPath, options);
   }
   ```
5. **Document which method used** in `.env` configuration:
   ```bash
   FREESCOUT_PHOTO_METHOD=photoUrl  # or "multipart"
   ```

**Detection:**
- Sync logs show photo uploads successful but FreeScout UI shows default avatar
- `customer.body.photoType === null` after sync
- Manual FreeScout customer check shows no photo
- FreeScout server logs (if accessible): "Failed to fetch photoUrl: [error]"

**Mitigation if discovered late:**
- Re-sync all photos using multipart method
- Mark all `photo_synced_hash` as NULL to force re-upload

---

## Moderate Pitfalls

### Pitfall 6: FreeScout Conversation Threads Embedded vs Separate Requests

**What goes wrong:** Fetching conversations without `?embed=threads` returns conversation metadata only. Requires second API call per conversation to get thread content (email body, timestamps, etc.). 1000 conversations = 1001 API calls (1 list + 1000 individual).

**Why it happens:** FreeScout API docs mention `embed` parameter but don't emphasize performance impact. Developers test with 1-2 conversations (fast), miss N+1 query problem at scale.

**Prevention:**
- Use `?embed=threads` on `/api/conversations/{id}` requests
- Or fetch all threads in batch after getting conversation list
- Log "Fetching threads for 237 conversations" (transparency)
- Rate limit: 200ms sleep between thread requests if not using embed

### Pitfall 7: WordPress Activity Custom Post Type Slug Collision

**What goes wrong:** Creating custom post type `activity` conflicts with WordPress core or popular plugins (BuddyPress, WooCommerce Activity Log, etc.). Post type registration fails silently, sync writes to wrong CPT or throws 404.

**Why it happens:** `activity` is generic term, high collision risk. WordPress doesn't enforce namespacing.

**Prevention:**
- Use prefixed slug: `rondo_activity` or `freescout_activity`
- Check `post_type_exists('activity')` before registering
- Document in Rondo Club's `functions.php` or CPT registration code
- Test on fresh WordPress install + common plugin suite (WooCommerce, BuddyPress)

### Pitfall 8: Conversation Timestamps in Wrong Timezone

**What goes wrong:** FreeScout returns timestamps in UTC (ISO 8601: `2026-02-12T14:30:00Z`). WordPress stores in local timezone (Europe/Amsterdam). Activity timeline shows wrong times (off by +1 or +2 hours depending on DST).

**Why it happens:** Laravel apps (FreeScout) default to UTC storage. WordPress uses `get_option('timezone_string')` or GMT offset. Developers forget timezone conversion.

**Prevention:**
- Convert FreeScout timestamps to WordPress timezone before saving:
  ```javascript
  const moment = require('moment-timezone');
  const wpTimezone = 'Europe/Amsterdam'; // From Rondo Club settings
  const wpTime = moment.utc(freescoutTimestamp).tz(wpTimezone).format('YYYY-MM-DD HH:mm:ss');
  ```
- Or store in UTC and convert on display (WordPress `get_post_time()` handles this if stored correctly)
- Test during DST transition dates (March, October)

### Pitfall 9: Activity Post Creation Without Duplicate Prevention

**What goes wrong:** Re-syncing conversations creates duplicate activity posts. Same FreeScout conversation ID → 2+ WordPress posts. Timeline shows duplicates.

**Why it happens:** No unique constraint. Sync script creates post, stores `freescout_conversation_id` in ACF, but next run doesn't check if post already exists.

**Prevention:**
- Check before create:
  ```javascript
  const existing = await rondoClubRequest(
    `/wp-json/wp/v2/activity?meta_key=freescout_conversation_id&meta_value=${conversationId}`,
    'GET'
  );
  if (existing.body.length > 0) {
    // Update existing post
  } else {
    // Create new post
  }
  ```
- Or use `freescout_conversations` tracking table (Pitfall 4 solution)
- Add unique index in WordPress: `ALTER TABLE wp_postmeta ADD UNIQUE KEY unique_freescout_conversation (meta_key, meta_value) WHERE meta_key = 'freescout_conversation_id'` (requires plugin or custom SQL)

### Pitfall 10: FreeScout Custom Field ID Hardcoding Across Environments

**What goes wrong:** Custom field IDs differ between production and demo FreeScout instances (field 9 = RelationEnd in prod, but field 12 in demo). Hardcoded ID 9 writes to wrong field in demo, corrupting data.

**Why it happens:** FreeScout assigns IDs sequentially on field creation. Demo instance created fields in different order (testing, module installs). Custom field IDs not portable.

**Prevention:**
- Use environment variables (already implemented in `getCustomFieldIds()`):
  ```bash
  # .env.production
  FREESCOUT_FIELD_RELATION_END=9

  # .env.demo
  FREESCOUT_FIELD_RELATION_END=12
  ```
- Verify field IDs on deploy: `node tools/verify-freescout-fields.js --env=demo`
- Document field mapping in `CLAUDE.md` or deploy checklist
- Log field IDs on first sync: "Using RelationEnd field ID: 9"

---

## Minor Pitfalls

### Pitfall 11: Photo File Extension Ambiguity After FreeScout Upload

**What goes wrong:** Upload photo as `12345.jpg` but FreeScout returns `photoUrl` pointing to `.png` (re-encoded). Next sync detects hash change (file extension differs), re-uploads unnecessarily.

**Why it happens:** FreeScout may re-encode photos for optimization. Hash comparison includes file extension in path.

**Prevention:**
- Hash file content, not filename
- Store `photo_hash` as content hash, not path hash
- Extension-agnostic comparison

### Pitfall 12: Activity Post Title Truncation for Long Email Subjects

**What goes wrong:** FreeScout conversation subject = 300 chars. WordPress post title field = 255 chars max (MySQL TEXT). Title truncated mid-word, activity timeline shows "Re: Important update about member..." (incomplete).

**Why it happens:** No validation before `wp_insert_post()`. WordPress silently truncates.

**Prevention:**
- Truncate with ellipsis:
  ```javascript
  const title = conversation.subject.length > 252
    ? conversation.subject.substr(0, 252) + '...'
    : conversation.subject;
  ```
- Store full subject in ACF field if needed for search

### Pitfall 13: FreeScout API 5xx Retry Logic Missing

**What goes wrong:** Transient FreeScout server errors (502, 503, 504) fail sync permanently. Activities not synced. Next run re-attempts but some conversations missed due to timestamp cursor.

**Why it happens:** Existing `freescoutRequestWithRetry()` has retry logic but may not be used for conversation sync. One 503 error = entire batch fails.

**Prevention:**
- Use `freescoutRequestWithRetry()` for all FreeScout API calls
- Already implemented in `lib/freescout-client.js` (exponential backoff: 1s, 2s, 4s)
- Ensure conversation sync uses this wrapper

### Pitfall 14: WordPress API Rate Limiting on Bulk Activity Creation

**What goes wrong:** Creating 500 activity posts in rapid succession triggers WordPress rate limiting (if configured) or overloads server. Some posts return 429 or 500. Sync fails halfway.

**Why it happens:** Existing photo upload has `sleep(100)` between requests. Activity creation may not have rate limiting.

**Prevention:**
- Add `await sleep(50)` between activity post creations
- Batch creates: 50 posts per request (if WordPress supports batch endpoint)
- Monitor WordPress error logs during high-volume sync

### Pitfall 15: Empty Conversation Thread Content Breaks Activity Post

**What goes wrong:** FreeScout conversation exists but all threads deleted (admin cleanup). `threads` array empty. Activity post created with blank content. WordPress requires non-empty post_content for some use cases.

**Why it happens:** No validation of thread array length.

**Prevention:**
- Check `conversation.threads.length > 0` before creating activity post
- Log skip: "Skipping conversation {id}: no threads"
- Or create post with placeholder: "Conversation deleted by administrator"

---

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
|-------------|---------------|------------|
| **Photo sync to FreeScout** | Pitfall 1 (no hash detection), Pitfall 5 (photoUrl vs multipart), Pitfall 11 (extension change) | Test both upload methods, implement content hashing, verify photos in FreeScout UI after test sync |
| **Conversation sync to activities** | Pitfall 2 (pagination), Pitfall 4 (orphans), Pitfall 8 (timezones), Pitfall 9 (duplicates) | Implement page iteration, tracking table, timezone conversion, duplicate check before create |
| **RelationEnd field mapping** | Pitfall 3 (date format), Pitfall 10 (field ID mismatch) | Normalize to YYYY-MM-DD, use env vars, verify on deploy |
| **Incremental sync optimization** | Pagination, rate limiting, 5xx retries | Use `updatedAt` filters, `freescoutRequestWithRetry`, log total vs fetched counts |
| **Production deployment** | Multi-DB pitfall (from memory: `rondo-sync.sqlite` vs `stadion-sync.sqlite`), concurrent access | Never run locally, verify DB path in code before deploy, check systemd service conflicts |

---

## Sources

### HIGH Confidence (Official Documentation)
- [FreeScout API Reference](https://api-docs.freescout.net/) — Endpoints, pagination, custom fields, photoUrl parameter
- [FreeScout Customer Avatars Module](https://freescout.shop/downloads/freescout-module-avatars/) — Photo handling methods
- [WordPress REST API Handbook](https://developer.wordpress.org/rest-api/) — Custom post types, relationship fields
- [ACF Performance Best Practices](https://www.advancedcustomfields.com/resources/improving-acf-performance/) — Local JSON, query optimization

### MEDIUM Confidence (Community Patterns)
- [Laravel Timezone Handling](https://ggomez.dev/blog/best-practices-for-storing-timestamps-in-laravel) — UTC storage, timezone conversion patterns
- [FreeScout API Issues (GitHub)](https://github.com/freescout-help-desk/freescout/issues/2103) — Known API quirks and limitations
- [Duplicate Image Detection with Hashing](https://benhoyt.com/writings/duplicate-image-detection/) — Perceptual hashing for change detection
- [ACF Relationship Field Guide](https://www.advancedcustomfields.com/blog/wordpress-custom-post-type-relationships/) — Relationship patterns, performance

### LOW Confidence (Existing Codebase Patterns)
- `lib/freescout-db.js` — Hash-based sync pattern (lines 8-14, 109-134)
- `lib/freescout-client.js` — Retry logic implementation (lines 109-134)
- `steps/submit-freescout-sync.js` — Duplicate prevention, orphan cleanup (lines 216-273, 276-319)
- `lib/photo-utils.js` — Photo download, MIME type handling (lines 44-88)
- Project memory: Parent/member duplicate bug, SQLite migration corruption, WordPress PUT requirements

---

## Research Gaps

**Could not verify:**
1. **FreeScout exact rate limits** — No official documentation found. Self-hosted may have no limits or vary by hosting. Assume conservative 200ms between requests.
2. **FreeScout multipart photo upload endpoint** — API docs only show `photoUrl` string method. May require reverse-engineering or support ticket.
3. **WordPress activity CPT already exists** — Need to inspect Rondo Club codebase to confirm post type slug and ACF field schema.
4. **FreeScout conversation `updatedAt` reliability** — Does it update when threads added? Need testing.
5. **Production FreeScout version and modules** — Self-hosted quirks depend on version and installed modules (API & Webhooks module confirmed required, but version unknown).

**Flagged for phase-specific research:**
- Phase: Conversation sync implementation → Verify FreeScout conversation `updatedAt` behavior with test data
- Phase: Photo upload → Test both `photoUrl` and multipart methods on actual FreeScout instance
- Phase: Production deploy → Verify custom field IDs match between demo and production