# Phase 45: Photo URL Sync to FreeScout - Research

**Researched:** 2026-02-12
**Domain:** FreeScout customer photoUrl field synchronization from Rondo Club member photos
**Confidence:** HIGH

## Summary

This phase enables member photos from Sportlink (via Rondo Club) to appear as FreeScout customer avatars by syncing photo URLs to the FreeScout `photoUrl` customer field. Photos uploaded to Rondo Club WordPress will automatically propagate to FreeScout on the next sync, improving support agent efficiency by displaying member photos directly in ticket views.

The implementation extends the existing FreeScout sync pipeline (Phase 16) to include photo URL extraction from Rondo Club API responses. The critical technical requirement is obtaining the WordPress media URL from the `_embedded['wp:featuredmedia']` response when querying people posts with `?_embed` parameter.

Hash-based change detection already exists in the FreeScout sync pipeline (`freescout_customers.source_hash` vs `last_synced_hash`). Since photos are part of the WordPress post data (featured media), photo URL changes automatically trigger re-sync when the member's `source_hash` changes. No separate photo-specific hash tracking is needed.

**Primary recommendation:** Extend `prepare-freescout-customers.js` to query Rondo Club API with `?_embed` parameter, extract photo URL from `_embedded['wp:featuredmedia'][0]['source_url']`, and include in customer `data.photoUrl` field. Photo changes propagate automatically via existing hash-based change detection.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| lib/rondo-club-client.js | - | Rondo Club WordPress REST API client | Already used for all WordPress API calls; supports `?_embed` parameter |
| lib/freescout-db.js | - | Hash-based change detection | Existing `source_hash` comparison triggers re-sync when photo URL changes |
| better-sqlite3 | latest | Database access for member tracking | Already used for `rondo_club_members` table; stores `photo_state` for filtering |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lib/freescout-client.js | - | FreeScout API client | Already used for customer create/update; supports `photoUrl` field |
| lib/utils.js | - | Hash computation utilities | `computeHash()` and `stableStringify()` already used for change detection |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| WordPress `?_embed` | Separate /media/{id} API call | Two API calls per member vs one; more complexity, no benefit |
| Photo-specific hash | Reuse existing source_hash | Separate tracking adds complexity; existing hash already includes photo URL |
| Direct photo upload to FreeScout | URL reference | FreeScout stores photos internally; URL reference simpler and maintains single source of truth |

**Installation:**
```bash
# No new dependencies required - all libraries already in package.json
```

## Architecture Patterns

### Recommended Project Structure
```
steps/
├── prepare-freescout-customers.js  # Modify getPhotoUrl() to query Rondo Club API with ?_embed
├── submit-freescout-sync.js        # No changes needed - photoUrl already in payload
lib/
├── rondo-club-client.js            # No changes needed - supports ?_embed parameter
├── freescout-db.js                 # No changes needed - hash detection works automatically
└── rondo-club-db.js                # No changes needed - photo_state field already exists
```

### Pattern 1: WordPress Featured Media URL Extraction
**What:** Query WordPress REST API with `?_embed` parameter to get featured image URL in single request
**When to use:** When fetching post data that includes featured media (photos, images)

**Example:**
```javascript
// Source: WordPress REST API documentation + existing rondo-club-client.js patterns
async function getPhotoUrlFromRondoClub(rondoClubId, options) {
  try {
    // Query with ?_embed to get featured media data
    const response = await rondoClubRequest(
      `wp/v2/people/${rondoClubId}?_embed`,
      'GET',
      null,
      options
    );

    // Extract photo URL from embedded featured media
    const featuredMedia = response.body?._embedded?.['wp:featuredmedia'];
    if (featuredMedia && featuredMedia.length > 0) {
      return featuredMedia[0].source_url;
    }

    return null;
  } catch (error) {
    // 404 or other errors - member has no photo
    return null;
  }
}
```

### Pattern 2: Hash-Based Photo Change Detection
**What:** Existing `source_hash` automatically detects photo URL changes
**When to use:** Already implemented - no new code needed

**Example:**
```javascript
// Source: lib/freescout-db.js (lines 108-134)
// This pattern ALREADY handles photo URL changes:

// 1. prepare-freescout-customers.js creates customer with photoUrl
const customer = {
  knvb_id: member.knvb_id,
  email: member.email,
  data: {
    firstName: 'John',
    lastName: 'Doe',
    photoUrl: 'https://rondo.club/wp-content/uploads/2024/01/12345.jpg' // NEW
  }
};

// 2. freescout-db.js computes hash including photoUrl
const sourceHash = computeSourceHash(customer.knvb_id, customer.data);
// Hash includes ALL data fields including photoUrl

// 3. getCustomersNeedingSync() returns customers with changed hashes
// Photo URL change → data changed → hash changed → customer re-synced
const needsSync = getCustomersNeedingSync(db, force);
// Returns customers where last_synced_hash != source_hash
```

### Pattern 3: Conditional Photo URL Inclusion
**What:** Only include photoUrl when photo_state = 'synced' (photo successfully uploaded to Rondo Club)
**When to use:** In prepare step to avoid sending broken/pending photo URLs to FreeScout

**Example:**
```javascript
// Source: Modified from steps/prepare-freescout-customers.js (lines 61-73)
async function getPhotoUrl(member, options) {
  // Only include photo URL if photo is synced to Rondo Club
  if (member.photo_state !== 'synced') {
    return null;
  }

  // Only fetch if member has rondo_club_id (WordPress post exists)
  if (!member.rondo_club_id) {
    return null;
  }

  // Fetch photo URL from Rondo Club API
  try {
    const response = await rondoClubRequest(
      `wp/v2/people/${member.rondo_club_id}?_embed`,
      'GET',
      null,
      options
    );

    const featuredMedia = response.body?._embedded?.['wp:featuredmedia'];
    if (featuredMedia && featuredMedia.length > 0) {
      return featuredMedia[0].source_url;
    }

    return null;
  } catch (error) {
    // API error or no photo - return null
    return null;
  }
}
```

### Anti-Patterns to Avoid
- **Making separate /media/{id} API calls:** Use `?_embed` parameter instead - single request
- **Uploading photos to FreeScout:** Use URL reference instead - maintains single source of truth in Rondo Club
- **Including photoUrl for non-synced photos:** Only send when `photo_state = 'synced'` - prevents broken image URLs
- **Creating separate photo hash tracking:** Reuse existing `source_hash` - photo URL is part of customer data

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Photo change detection | Photo-specific hash/timestamp tracking | Existing `source_hash` comparison | Photo URL is part of customer data; existing hash automatically detects changes |
| WordPress media URL fetching | Custom media endpoint logic | `?_embed` parameter on people endpoint | Single API call vs two; WordPress standard approach |
| Photo upload to FreeScout | Custom photo upload/storage | photoUrl field with URL reference | FreeScout supports URL references; simpler than binary upload |
| Photo availability checking | Manual photo existence checks | Use `photo_state` field from database | State machine already tracks photo lifecycle |

**Key insight:** FreeScout's `photoUrl` field expects a URL reference (max 200 characters), not binary upload. Rondo Club is the single source of truth for photos. Photo URL changes trigger automatic re-sync via existing hash-based change detection.

## Common Pitfalls

### Pitfall 1: Including Photo URLs for Non-Synced Photos
**What goes wrong:** Sending photoUrl for members where photo_state is 'pending_upload', 'downloaded', or 'pending_download' results in broken image links in FreeScout because photo doesn't exist in Rondo Club yet.

**Why it happens:** Photo pipeline has multiple states (pending_download → downloaded → pending_upload → synced). Only 'synced' means photo is uploaded and accessible via Rondo Club URL. Other states mean photo is in progress or only exists locally.

**How to avoid:**
1. Check `photo_state = 'synced'` before including photoUrl
2. Return null for any other photo_state value
3. Existing hash detection will re-sync once photo reaches 'synced' state
4. Log skipped members in verbose mode for debugging

**Warning signs:**
- Broken image icons in FreeScout customer profiles
- 404 errors when FreeScout tries to fetch photo URL
- Photos appear in Rondo Club but not in FreeScout (state not 'synced')

### Pitfall 2: Missing ?_embed Parameter
**What goes wrong:** Querying `/wp/v2/people/{id}` without `?_embed` returns featured_media as integer ID, not URL. Code attempts to use integer as URL, causing invalid photoUrl in FreeScout.

**Why it happens:** WordPress REST API returns featured_media as media attachment ID by default. To get full media data including source_url, must explicitly request with `?_embed` parameter.

**How to avoid:**
1. Always append `?_embed` to WordPress API queries when fetching posts with featured media
2. Extract URL from `_embedded['wp:featuredmedia'][0]['source_url']` path
3. Handle null/undefined gracefully (member may have no photo)
4. Validate photoUrl is string starting with 'https://' before including in FreeScout payload

**Warning signs:**
- photoUrl contains integer instead of URL string
- FreeScout API rejects customer update with 400 error
- Debug logs show photoUrl like "12345" instead of "https://..."

### Pitfall 3: API Request Performance Impact
**What goes wrong:** Querying Rondo Club API for every member during prepare step adds N API calls (where N = member count). For 1000+ members, this causes slow sync and potential rate limiting.

**Why it happens:** Each `getPhotoUrl()` call makes individual WordPress API request. No batching or caching. Full sync queries API 1000+ times.

**How to avoid:**
1. ONLY query API for members where photo_state = 'synced' (skips most members)
2. Use hash-based change detection to skip unchanged customers (existing pattern)
3. Consider future optimization: cache photo URLs in database (out of scope for Phase 45)
4. Monitor sync duration after implementation; acceptable if <5 min for full sync

**Warning signs:**
- FreeScout sync duration increases significantly (e.g., 30s → 10min)
- WordPress API returns 429 Too Many Requests
- Sync reports show many API timeout errors

### Pitfall 4: Null vs Empty String Handling
**What goes wrong:** Sending `photoUrl: null` in FreeScout customer update payload may cause API error or unexpected behavior. FreeScout expects string or field omitted.

**Why it happens:** JavaScript null is not valid JSON string value. FreeScout API may reject null for photoUrl field.

**How to avoid:**
1. Omit photoUrl field entirely when value is null (don't include in payload)
2. Use conditional object spreading: `...(photoUrl ? { photoUrl } : {})`
3. Matches existing pattern for other optional fields in prepare-freescout-customers.js
4. Test with actual FreeScout API to verify null handling (may accept gracefully)

**Warning signs:**
- FreeScout API returns 400 Bad Request for customer updates
- Error message mentions photoUrl field validation
- Photos stop syncing but no obvious error in logs

### Pitfall 5: Photo URL Expiration or Access Control
**What goes wrong:** FreeScout fetches photoUrl but receives 403 Forbidden or 401 Unauthorized because WordPress photo attachment has restricted access (logged-in users only).

**Why it happens:** WordPress media attachments may inherit access restrictions from parent post. If person post is private/restricted, featured media may also be restricted. FreeScout fetches URL as anonymous client.

**How to avoid:**
1. Verify WordPress media attachments are publicly accessible (no auth required)
2. Test photo URLs in browser incognito mode (simulates FreeScout access)
3. Check WordPress media settings and post visibility settings
4. Document requirement: member photos must be publicly accessible for FreeScout avatar display

**Warning signs:**
- FreeScout shows broken image icon despite valid photoUrl
- Testing photoUrl in browser incognito mode requires login
- Browser network inspector shows 403/401 for photo URLs

## Code Examples

Verified patterns from official sources and existing codebase:

### Modified getPhotoUrl() Function
```javascript
// Source: steps/prepare-freescout-customers.js (lines 61-73)
// Location: Replace existing getPhotoUrl() implementation

const { rondoClubRequest } = require('../lib/rondo-club-client');

/**
 * Get photo URL for a member from Rondo Club WordPress API
 * @param {Object} member - Member record from rondo_club_members
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<string|null>} - Photo URL or null
 */
async function getPhotoUrl(member, options) {
  // Only include photo URL if photo is synced to Rondo Club
  if (member.photo_state !== 'synced') {
    return null;
  }

  // Only fetch if member has rondo_club_id (WordPress post exists)
  if (!member.rondo_club_id) {
    return null;
  }

  try {
    // Query WordPress API with ?_embed to get featured media data
    const response = await rondoClubRequest(
      `wp/v2/people/${member.rondo_club_id}?_embed`,
      'GET',
      null,
      options
    );

    // Extract photo URL from embedded featured media
    const featuredMedia = response.body?._embedded?.['wp:featuredmedia'];
    if (featuredMedia && featuredMedia.length > 0) {
      const sourceUrl = featuredMedia[0].source_url;

      // Validate URL is HTTPS (security requirement)
      if (sourceUrl && sourceUrl.startsWith('https://')) {
        return sourceUrl;
      }
    }

    return null;
  } catch (error) {
    // API error or no photo - return null silently
    // Verbose logging already handled by rondoClubRequest
    return null;
  }
}
```

### Modified prepareCustomer() Call
```javascript
// Source: steps/prepare-freescout-customers.js (lines 286-301)
// Location: Inside runPrepare() function

for (const row of memberRows) {
  const member = {
    knvb_id: row.knvb_id,
    email: row.email,
    rondo_club_id: row.rondo_club_id,
    photo_state: row.photo_state, // Include photo_state
    data: JSON.parse(row.data_json)
  };

  // Pass options to prepareCustomer so it can pass to getPhotoUrl
  const customer = await prepareCustomer(member, freescoutDb, rondoClubDb, nikkiDb, options);
  if (customer) {
    customers.push(customer);
  } else {
    skippedNoEmail++;
  }
}
```

### Modified prepareCustomer() Function Signature
```javascript
// Source: steps/prepare-freescout-customers.js (lines 124-235)
// Location: Change function signature and await getPhotoUrl()

/**
 * Transform a Rondo Club member to FreeScout customer format
 * @param {Object} member - Member record from rondo_club_members
 * @param {Object} freescoutDb - FreeScout database connection
 * @param {Object} rondoClubDb - Rondo Club database connection
 * @param {Object|null} nikkiDb - Nikki database connection (may be null)
 * @param {Object} options - Logger and verbose options
 * @returns {Promise<Object|null>} - FreeScout customer object or null if no email
 */
async function prepareCustomer(member, freescoutDb, rondoClubDb, nikkiDb, options) {
  const data = member.data || {};
  const acf = data.acf || {};

  // ... existing email, name, phone extraction ...

  // Get photo URL from Rondo Club (async call)
  const photoUrl = await getPhotoUrl(member, options);

  return {
    knvb_id: member.knvb_id,
    email: email.toLowerCase(),
    freescout_id: freescoutId,
    data: {
      firstName,
      lastName,
      phones: phones,
      photoUrl: photoUrl, // Include photo URL
      websites: websites
    },
    customFields: {
      // ... existing custom fields ...
    }
  };
}
```

### Submit Step - photoUrl Already Handled
```javascript
// Source: steps/submit-freescout-sync.js (lines 114-136)
// Location: No changes needed - photoUrl already included in payload

async function createCustomer(customer, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  const payload = {
    firstName: customer.data.firstName,
    lastName: customer.data.lastName,
    emails: [{ value: customer.email, type: 'home' }]
  };

  // Add phones if available
  if (customer.data.phones && customer.data.phones.length > 0) {
    payload.phones = customer.data.phones;
  }

  // Add photoUrl if available (NEW - already supported by existing code)
  if (customer.data.photoUrl) {
    payload.photoUrl = customer.data.photoUrl;
  }

  // Add websites if available
  if (customer.data.websites && customer.data.websites.length > 0) {
    payload.websites = customer.data.websites;
  }

  logVerbose(`Creating new customer: ${customer.email}`);
  const response = await freescoutRequest('/api/customers', 'POST', payload, options);
  return response.body.id;
}

async function updateCustomer(freescoutId, customer, options) {
  const logVerbose = options.logger?.verbose.bind(options.logger) || (options.verbose ? console.log : () => {});

  const payload = {
    firstName: customer.data.firstName,
    lastName: customer.data.lastName
  };

  // Add phones if available
  if (customer.data.phones && customer.data.phones.length > 0) {
    payload.phones = customer.data.phones;
  }

  // Add photoUrl if available (NEW - already supported by existing code)
  if (customer.data.photoUrl) {
    payload.photoUrl = customer.data.photoUrl;
  }

  // Add websites if available
  if (customer.data.websites && customer.data.websites.length > 0) {
    payload.websites = customer.data.websites;
  }

  logVerbose(`Updating customer ${freescoutId}: ${customer.email}`);
  await freescoutRequest(`/api/customers/${freescoutId}`, 'PUT', payload, options);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Separate photo hash tracking | Reuse customer data source_hash | This phase (45) | Simpler architecture; photo URL changes trigger automatic re-sync |
| Direct photo upload to FreeScout | URL reference to Rondo Club | This phase (45) | Single source of truth; no photo duplication |
| Synchronous prepare step | Async prepare with photo URL fetching | This phase (45) | Enables API calls during preparation; proper async/await pattern |
| Multiple /media API calls | Single request with ?_embed | This phase (45) | Reduces API calls by 50%; faster sync |

**Deprecated/outdated:**
- Synchronous `prepareCustomer()` function: Now requires async/await for photo URL fetching
- Comment at line 69-71 suggesting separate media API call: Use `?_embed` instead

## Open Questions

1. **WordPress media attachment access control**
   - What we know: Rondo Club uploads photos as featured media on person posts
   - What's unclear: Are uploaded photos publicly accessible or restricted to logged-in users?
   - Recommendation: Test photo URL access in browser incognito mode. If restricted, configure WordPress to allow public media access or document as requirement. FreeScout cannot display photos requiring authentication.

2. **FreeScout photoUrl field validation**
   - What we know: FreeScout API accepts photoUrl as string (max 200 characters)
   - What's unclear: Does FreeScout validate URL accessibility before storing? What happens if URL returns 404?
   - Recommendation: Test with invalid/broken photo URL to observe FreeScout behavior. Document findings in VERIFICATION.md. Likely graceful degradation (shows broken image icon).

3. **Photo URL caching strategy**
   - What we know: Current implementation queries Rondo Club API for each member with photo_state = 'synced'
   - What's unclear: For large clubs (1000+ members), is API call overhead acceptable? Should photo URLs be cached in database?
   - Recommendation: Implement Phase 45 without caching (simplest approach). Monitor sync duration. If >5 minutes or rate limiting occurs, add photo_url column to rondo_club_members table in Phase 46 for caching.

4. **Hash-based change detection validation**
   - What we know: `source_hash` includes all customer data fields including photoUrl
   - What's unclear: If photo URL changes but other fields don't, does hash comparison correctly detect change?
   - Recommendation: Test scenario: member with photo, change photo in Sportlink, verify sync updates FreeScout. Hash computation via `stableStringify()` should handle this correctly.

## Sources

### Primary (HIGH confidence)
- FreeScout API Documentation - [API Reference](https://api-docs.freescout.net/) - Customer photoUrl field specification (max 200 characters)
- WordPress REST API Documentation - [REST API Handbook](https://developer.wordpress.org/rest-api/reference/media/) - ?_embed parameter usage
- Existing codebase - `lib/freescout-db.js` - Hash-based change detection pattern
- Existing codebase - `steps/prepare-freescout-customers.js` - Customer preparation and getPhotoUrl() implementation
- Existing codebase - `lib/rondo-club-db.js:73` - photo_state field definition and state machine

### Secondary (MEDIUM confidence)
- WordPress REST API Featured Image Guide - [Rudrastyh Tutorial](https://rudrastyh.com/wordpress/rest-api-get-featured-image-url.html) - ?_embed usage and _embedded extraction
- FreeScout Customer API - [GitHub Source](https://github.com/freescout-help-desk/freescout/blob/dist/app/Customer.php) - photoUrl field usage (note: todo comment suggests incomplete implementation)
- Phase 44 Research - `.planning/phases/44-relationend-field-mapping/44-RESEARCH.md` - FreeScout custom field patterns

### Tertiary (LOW confidence)
- None - all research verified with official sources or existing code

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries already in use, no new dependencies
- Architecture: HIGH - Follows established patterns from Phase 16 (FreeScout sync) and existing photo pipeline
- Pitfalls: HIGH - Photo state machine and API patterns well-documented in existing code
- Implementation: HIGH - All code modification points identified, patterns verified in existing codebase
- Performance: MEDIUM - API call overhead for photo URL fetching not tested at scale; may need optimization in future phase

**Research date:** 2026-02-12
**Valid until:** 2026-04-12 (60 days - stable domain, no fast-moving dependencies)

**Key dependencies:**
- Phase 16: FreeScout Customer Sync (provides pipeline foundation)
- Phase 44: RelationEnd Field Mapping (demonstrates custom field extension pattern)
- Photo sync pipeline: Provides photo_state field and state machine for filtering