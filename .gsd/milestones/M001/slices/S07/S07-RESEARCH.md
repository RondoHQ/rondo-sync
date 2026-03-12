# Phase 40: Former Member Import Tool - Research

**Researched:** 2026-02-09
**Domain:** Sportlink UI automation, member status filtering, one-time import tooling
**Confidence:** HIGH

## Summary

This phase creates a one-time import tool to download all former members (inactive status) from Sportlink and sync them to Rondo Club with the `former_member` flag. The tool extends existing member sync infrastructure (Phase 38) but adds status filter toggling in Sportlink's search UI and sets the `former_member` flag on synced records.

Sportlink's member search interface has status filter chips that toggle between ACTIVE and INACTIVE members. The requirement is to download INACTIVE members specifically. The existing `download-data-from-sportlink.js` downloads active members by clicking search without toggling status. For former members, the tool needs to locate and click the status filter UI elements (likely chip buttons or checkboxes) before triggering the search.

The implementation follows established patterns: Playwright-based download step, prepare step for data transformation, sync step to Rondo Club with `acf.former_member = true`, and photo download/upload using existing infrastructure. The tool runs as a standalone script in `tools/`, not a scheduled pipeline, with dry-run support and progress reporting.

**Primary recommendation:** Create `tools/import-former-members.js` that orchestrates three steps: (1) download inactive members via modified Playwright script that toggles status filters, (2) prepare and sync to Rondo Club with `former_member = true` flag, (3) download and upload photos using existing photo infrastructure. Implement dry-run mode, skip existing active members by checking `stadion_members` table, and provide detailed progress output.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| playwright | latest (installed) | Browser automation for Sportlink | Already used for all Sportlink interactions, handles UI element clicks |
| better-sqlite3 | latest (installed) | Member tracking database | Already tracks all members with stadion_id mapping |
| Node.js fs/promises | Native | Photo file operations | Standard for file operations in existing photo sync |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| varlock | latest (installed) | Environment variable loading | Used across all scripts for .env loading |
| form-data | 4.x (installed) | Photo upload multipart requests | Already used in photo upload step |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| New pipeline | Standalone tool | Tool is one-time, pipeline implies recurring schedule |
| API endpoint for status | UI automation | Sportlink API doesn't expose inactive member filtering, must use UI |
| Separate database table | Extend stadion_members | Same tracking structure works, just set former_member flag |

**Installation:**
No new packages needed - all dependencies already installed.

## Architecture Patterns

### Recommended Project Structure
```
tools/
├── import-former-members.js        # NEW: Main orchestrator script
steps/
├── download-inactive-members.js    # NEW: Modified download with status filter
├── prepare-rondo-club-members.js   # REUSE: Same preparation logic
├── submit-rondo-club-sync.js       # EXTEND: Add former_member flag support
├── download-photos-from-api.js     # REUSE: Photo download from MemberHeader
└── upload-photos-to-rondo-club.js  # REUSE: Photo upload to WordPress
```

### Pattern 1: One-Time Import Tool (tools/ pattern)
**What:** Standalone script with dry-run support and progress output
**When to use:** One-time operations, not recurring pipelines
**Example:**
```javascript
// Source: tools/merge-duplicate-parents.js pattern
async function runImport(options = {}) {
  const { dryRun = true, verbose = false } = options;

  console.log(dryRun ? '=== DRY RUN ===' : '=== IMPORTING FORMER MEMBERS ===');
  console.log('');

  const stats = {
    downloaded: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    errors: []
  };

  // Step 1: Download inactive members
  console.log('Step 1: Downloading inactive members from Sportlink...');
  const downloadResult = await downloadInactiveMembers({ verbose });
  stats.downloaded = downloadResult.memberCount;

  if (dryRun) {
    console.log(`Would sync ${stats.downloaded} former members`);
    return stats;
  }

  // Step 2: Sync to Rondo Club
  console.log('Step 2: Syncing to Rondo Club...');
  // ... sync logic

  return stats;
}

// CLI entry point
if (require.main === module) {
  const dryRun = !process.argv.includes('--import');
  const verbose = process.argv.includes('--verbose');

  runImport({ dryRun, verbose })
    .then(stats => {
      console.log('');
      console.log('=== SUMMARY ===');
      console.log(`Downloaded: ${stats.downloaded}`);
      console.log(`Synced: ${stats.synced}`);
      console.log(`Skipped: ${stats.skipped}`);
      console.log(`Failed: ${stats.failed}`);
      if (dryRun) {
        console.log('');
        console.log('Run with --import to actually sync these members.');
      }
    });
}
```

### Pattern 2: Sportlink Status Filter Toggling
**What:** Locate and click status filter UI elements before search
**When to use:** When downloading inactive/former members from Sportlink
**Example:**
```javascript
// Source: Inferred from download-data-from-sportlink.js + Sportlink UI patterns
async function downloadInactiveMembers(options = {}) {
  const page = await context.newPage();
  await loginToSportlink(page, { logger });

  await page.goto('https://club.sportlink.com/member/search', {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForLoadState('networkidle');

  // Click show more to reveal filter options
  await page.waitForSelector('#btnShowMore', { timeout: 20000 });
  await page.click('#btnShowMore');

  // Toggle status filter to INACTIVE
  // NOTE: Actual selectors need to be discovered via browser inspection
  // Likely pattern: status chip buttons or radio buttons
  // Examples: .status-chip[data-status="inactive"], #scStatusInactive, etc.
  await page.waitForSelector('.status-filter-inactive', { timeout: 20000 });
  await page.click('.status-filter-inactive');

  // Set up response listener before clicking search
  const responsePromise = page.waitForResponse(
    resp => resp.url().includes('/navajo/entity/common/clubweb/member/search/SearchMembers'),
    { timeout: 60000 }
  );

  await page.click('#btnSearch');
  const response = await responsePromise;
  const jsonData = await response.json();

  return { memberCount: jsonData.Members.length };
}
```

### Pattern 3: Skip Existing Active Members
**What:** Check local database before syncing to avoid duplicates
**When to use:** Importing historical data that may overlap with active members
**Example:**
```javascript
// Source: steps/submit-rondo-club-sync.js syncPerson() pattern
async function syncFormerMember(member, db, options) {
  const { knvb_id } = member;

  // Check if member already exists as active member
  const existing = db.prepare(
    'SELECT stadion_id, former_member FROM stadion_members WHERE knvb_id = ?'
  ).get(knvb_id);

  if (existing && existing.stadion_id) {
    // Member exists and is already synced
    if (!existing.former_member) {
      // Active member - skip import
      logger.verbose(`Skipping ${knvb_id}: already active member`);
      return { action: 'skipped', reason: 'active_member' };
    } else {
      // Already a former member - skip
      logger.verbose(`Skipping ${knvb_id}: already marked as former`);
      return { action: 'skipped', reason: 'already_former' };
    }
  }

  // New former member - sync to Rondo Club
  const data = {
    ...member.data,
    acf: {
      ...member.data.acf,
      former_member: true
    }
  };

  await rondoClubRequest('wp/v2/people', 'POST', data, options);
  return { action: 'created' };
}
```

### Anti-Patterns to Avoid
- **Creating pipeline script instead of tool:** Phase requires one-time import, not recurring sync
- **Assuming status API parameter exists:** Sportlink SearchMembers API requires UI interaction for status filtering
- **Creating duplicate person records:** Must check stadion_members table before syncing
- **Syncing former members to Laposta:** Former members don't need marketing emails (out of scope)

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Status filter UI discovery | Manual trial/error clicking | Playwright page.locator() with verbose selectors | Playwright provides reliable element selection with multiple strategies (CSS, text, role) |
| Duplicate detection | Custom email matching | Existing stadion_members table with knvb_id lookup | Database already tracks all members with reliable stadion_id mapping |
| Photo download/upload | New photo sync logic | Existing photo infrastructure (download-photos-from-api.js, upload-photos-to-rondo-club.js) | Photo sync already handles MemberHeader API, signed URLs, and multipart uploads |
| Member data transformation | New prepare logic | Existing prepare-rondo-club-members.js | Member preparation already handles all field mappings and validation |

**Key insight:** Former member import is 90% code reuse. Only new logic needed is status filter toggling and former_member flag setting. Avoid rebuilding existing sync infrastructure.

## Common Pitfalls

### Pitfall 1: Status Filter Element Discovery
**What goes wrong:** Status filter UI elements may not have stable IDs/classes, causing script failures
**Why it happens:** Sportlink UI may use generic class names or dynamic IDs for status chips
**How to avoid:**
- Inspect Sportlink member search page in browser DevTools to identify status filter elements
- Use multiple selector strategies (ID, class, data attributes, text content)
- Add wait conditions and error handling for missing elements
**Warning signs:**
- Script hangs at status filter step
- "Element not found" errors
- Search returns active members instead of inactive

### Pitfall 2: Creating Duplicate Person Records
**What goes wrong:** Former member already exists as active member, tool creates second record
**Why it happens:** Not checking stadion_members table before syncing
**How to avoid:**
- Query stadion_members by knvb_id before creating new person
- Skip sync if stadion_id exists and member is not marked former
- Log skipped members for operator visibility
**Warning signs:**
- Duplicate person records in Rondo Club with same KNVB ID
- Errors about duplicate KNVB ID constraints
- Unexpected high sync counts

### Pitfall 3: Photo Download Timeouts
**What goes wrong:** Photo downloads fail for large batches of former members
**Why it happens:** Sportlink rate limits or timeouts during photo MemberHeader API calls
**How to avoid:**
- Reuse existing photo download infrastructure with built-in rate limiting
- Process photos in batches with delays (existing pattern: 500-1500ms between members)
- Mark photo_state appropriately for retry logic
**Warning signs:**
- Multiple "No MemberHeader response" errors
- "Photo download failed" with timeout messages
- Large numbers in "pending download" count

## Code Examples

Verified patterns from existing codebase:

### Existing Member Download (Active Members)
```javascript
// Source: steps/download-data-from-sportlink.js (lines 38-63)
await page.goto('https://club.sportlink.com/member/search', {
  waitUntil: 'domcontentloaded'
});
await page.waitForLoadState('networkidle');

// Click show more to reveal filters
await page.waitForSelector('#btnShowMore', { timeout: 20000 });
await page.click('#btnShowMore');

// Check union teams
await page.waitForSelector('#scFetchUnionTeams_input', { timeout: 20000 });
await page.check('#scFetchUnionTeams_input');

// Set up response listener before search
const responsePromise = page.waitForResponse(
  resp => resp.url().includes('/navajo/entity/common/clubweb/member/search/SearchMembers'),
  { timeout: 60000 }
);

await page.click('#btnSearch');
const response = await responsePromise;
const jsonData = await response.json();
```

### Setting former_member Flag
```javascript
// Source: steps/submit-rondo-club-sync.js (lines 650-687)
async function markFormerMembers(db, currentKnvbIds, options) {
  const toMark = getMembersNotInList(db, currentKnvbIds);

  for (const member of toMark) {
    if (!member.stadion_id) {
      deleteMember(db, member.knvb_id);
      continue;
    }

    await rondoClubRequest(
      `wp/v2/people/${member.stadion_id}`,
      'PUT',
      { acf: { former_member: true } },
      options
    );
  }
}
```

### Tool Pattern with Dry-Run
```javascript
// Source: tools/merge-duplicate-parents.js (lines 46-88)
async function runMerge(options = {}) {
  const { dryRun = true, verbose = false } = options;

  console.log(dryRun ? '=== DRY RUN ===' : '=== MERGING DUPLICATE PARENTS ===');

  const stats = { merged: 0, errors: 0 };

  for (const item of items) {
    if (verbose) {
      console.log(`Processing: ${item.email}`);
    }

    if (dryRun) {
      stats.merged++;
      continue;
    }

    // Actual work happens here
    await performWork(item);
    stats.merged++;
  }

  return stats;
}

if (require.main === module) {
  const dryRun = !process.argv.includes('--merge');
  const verbose = process.argv.includes('--verbose');

  runMerge({ dryRun, verbose })
    .then(stats => {
      console.log(`Merged: ${stats.merged}`);
      if (dryRun) {
        console.log('Run with --merge to actually merge.');
      }
    });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Delete removed members | Mark as former_member | Phase 38 (v3.0) | Preserves historical member records for payment tracking |
| Manual status discovery | UI automation with Playwright | Phase 1 (v1.0) | Enables automated downloads from web-only Sportlink interface |
| Single photo endpoint | MemberHeader API with signed URLs | Phase 17 (v1.7) | Provides reliable photo access without direct scraping |

**Deprecated/outdated:**
- Direct member deletion: Now marks members as former instead (preserves records)
- CSV export for former members: No bulk export available, must use SearchMembers API with UI filter

## Open Questions

1. **Status Filter Selector Discovery**
   - What we know: Sportlink member search has status filter UI (requirement DL-01)
   - What's unclear: Exact CSS selectors for inactive status filter chip/button
   - Recommendation: Inspect Sportlink UI in browser DevTools to identify selector patterns. Test selector stability across sessions.

2. **Former Member Data Completeness**
   - What we know: SearchMembers API returns inactive members with same data structure as active
   - What's unclear: Whether inactive members have all fields populated (photos, addresses, etc.)
   - Recommendation: Test with sample inactive members to verify data completeness. Handle missing data gracefully.

3. **Import Frequency**
   - What we know: Phase 40 is one-time import tool
   - What's unclear: Whether periodic re-checks for newly inactive members needed (marked FUTURE-01 in requirements)
   - Recommendation: Implement as one-time tool. If recurring needed, convert to pipeline in future phase.

## Sources

### Primary (HIGH confidence)
- `/Users/joostdevalk/Code/rondo/rondo-sync/steps/download-data-from-sportlink.js` - Active member download implementation
- `/Users/joostdevalk/Code/rondo/rondo-sync/steps/submit-rondo-club-sync.js` - Member sync and markFormerMembers() function
- `/Users/joostdevalk/Code/rondo/rondo-sync/tools/merge-duplicate-parents.js` - Tool pattern with dry-run support
- `/Users/joostdevalk/Code/rondo/rondo-sync/steps/download-photos-from-api.js` - Photo download from MemberHeader API
- `/Users/joostdevalk/Code/rondo/rondo-sync/lib/sportlink-login.js` - Sportlink authentication pattern

### Secondary (MEDIUM confidence)
- `.planning/REQUIREMENTS.md` - Phase 40 requirements (DL-01, DL-02, DL-03, etc.)
- `.planning/ROADMAP.md` - Phase 40 description and dependencies
- `.planning/phases/11-photo-upload-deletion/11-RESEARCH.md` - Photo upload patterns

### Tertiary (LOW confidence)
- Status filter UI selectors: Need browser inspection to verify exact element IDs/classes

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All dependencies already installed and used
- Architecture: HIGH - Clear extension of existing patterns, minimal new code
- Pitfalls: MEDIUM - Status filter discovery requires UI inspection, duplicate prevention critical

**Research date:** 2026-02-09
**Valid until:** 60 days (stable domain, well-established patterns)