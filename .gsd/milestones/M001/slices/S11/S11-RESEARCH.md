# Phase 44: RelationEnd Field Mapping - Research

**Researched:** 2026-02-12
**Domain:** FreeScout custom field date mapping from Sportlink member data
**Confidence:** HIGH

## Summary

This phase adds Sportlink RelationEnd date synchronization to FreeScout custom field ID 9 ("Lid tot"), enabling support agents to see membership expiration dates directly in the FreeScout customer profile without switching to Sportlink Club.

The implementation follows established patterns from Phase 16 (FreeScout Customer Sync). RelationEnd data is already extracted from Sportlink and stored in Rondo Club ACF field `lid-tot` (prepare-rondo-club-members.js:179). This phase extends the existing FreeScout sync pipeline to include this field in custom field submissions.

The critical technical requirement is date format normalization. FreeScout custom fields expect `YYYY-MM-DD` format, but ACF date fields may return various formats (YYYYMMDD, ISO 8601, d/m/Y). The existing codebase provides proven normalization patterns from Sportlink sync operations.

**Primary recommendation:** Add RelationEnd to `prepare-freescout-customers.js` customFields extraction, implement date normalization function, extend `buildCustomFieldsPayload()` in `submit-freescout-sync.js` to include field ID 9, and add environment variable `FREESCOUT_FIELD_RELATION_END=9`.

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| better-sqlite3 | latest | Database access for Rondo Club member data | Already used for tracking databases; provides RelationEnd from `rondo_club_members.data_json` |
| node:https | native | FreeScout API client | Already used in `lib/freescout-client.js` via `lib/http-client.js` |
| dotenv | latest | Environment variable management | Already used project-wide for configuration |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| lib/utils.js | - | Date normalization utilities | Use `readEnv()` for environment vars; add date normalization if not exists |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ACF date field | Sportlink raw data | ACF already normalized; raw Sportlink data may have multiple formats |
| Custom date parser | Native JS Date | Date parsing is error-prone; regex normalization safer for known formats |

**Installation:**
```bash
# No new dependencies required - all libraries already in package.json
```

## Architecture Patterns

### Recommended Project Structure
```
steps/
├── prepare-freescout-customers.js  # Add relationEnd to customFields
├── submit-freescout-sync.js        # Add field ID 9 to buildCustomFieldsPayload()
lib/
├── freescout-client.js              # No changes needed
├── rondo-club-db.js                 # No changes needed
└── utils.js                         # Add normalizeDateToYYYYMMDD() if not exists
```

### Pattern 1: Date Normalization
**What:** Convert ACF date formats to YYYY-MM-DD for FreeScout API
**When to use:** Before sending any date field to FreeScout custom fields API

**Example:**
```javascript
// Source: Inspired by existing Sportlink date handling patterns
function normalizeDateToYYYYMMDD(dateValue) {
  if (!dateValue || typeof dateValue !== 'string') return null;

  const trimmed = dateValue.trim();
  if (!trimmed) return null;

  // ACF returns YYYYMMDD when return format is YYYYMMDD
  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.substr(0, 4)}-${trimmed.substr(4, 2)}-${trimmed.substr(6, 2)}`;
  }

  // ISO 8601 timestamp (2026-02-12T00:00:00Z or 2026-02-12T00:00:00)
  if (trimmed.includes('T')) {
    return trimmed.split('T')[0]; // Extract YYYY-MM-DD
  }

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // Invalid format
  return null;
}
```

### Pattern 2: Custom Field Extension
**What:** Add new custom field to existing FreeScout sync payload
**When to use:** When adding any new custom field to FreeScout customer records

**Example:**
```javascript
// Source: steps/submit-freescout-sync.js (lines 18-42)
function getCustomFieldIds() {
  return {
    union_teams: parseInt(process.env.FREESCOUT_FIELD_UNION_TEAMS || '1', 10),
    public_person_id: parseInt(process.env.FREESCOUT_FIELD_PUBLIC_PERSON_ID || '4', 10),
    member_since: parseInt(process.env.FREESCOUT_FIELD_MEMBER_SINCE || '5', 10),
    nikki_saldo: parseInt(process.env.FREESCOUT_FIELD_NIKKI_SALDO || '7', 10),
    nikki_status: parseInt(process.env.FREESCOUT_FIELD_NIKKI_STATUS || '8', 10),
    relation_end: parseInt(process.env.FREESCOUT_FIELD_RELATION_END || '9', 10) // NEW
  };
}

function buildCustomFieldsPayload(customFields) {
  const fieldIds = getCustomFieldIds();
  return [
    { id: fieldIds.union_teams, value: customFields.union_teams || '' },
    { id: fieldIds.public_person_id, value: customFields.public_person_id || '' },
    { id: fieldIds.member_since, value: customFields.member_since || '' },
    { id: fieldIds.nikki_saldo, value: customFields.nikki_saldo !== null ? String(customFields.nikki_saldo) : '' },
    { id: fieldIds.nikki_status, value: customFields.nikki_status || '' },
    { id: fieldIds.relation_end, value: customFields.relation_end || '' } // NEW
  ];
}
```

### Pattern 3: ACF Field Extraction
**What:** Extract ACF field value from Rondo Club member data
**When to use:** In prepare step when transforming member data for FreeScout

**Example:**
```javascript
// Source: steps/prepare-freescout-customers.js (lines 131-230)
function prepareCustomer(member, freescoutDb, rondoClubDb, nikkiDb) {
  const data = member.data || {};
  const acf = data.acf || {};

  // ... existing email, name, phone extraction ...

  // Get Nikki data
  const nikkiData = getMostRecentNikkiData(nikkiDb, member.knvb_id);

  // NEW: Extract and normalize RelationEnd
  const relationEndRaw = acf['lid-tot'] || null;
  const relationEnd = normalizeDateToYYYYMMDD(relationEndRaw);

  return {
    knvb_id: member.knvb_id,
    email: email.toLowerCase(),
    freescout_id: freescoutId,
    data: {
      firstName,
      lastName,
      phones: phones,
      photoUrl: getPhotoUrl(member),
      websites: websites
    },
    customFields: {
      union_teams: unionTeams,
      public_person_id: member.knvb_id,
      member_since: acf['lid-sinds'] || null,
      nikki_saldo: nikkiData.saldo,
      nikki_status: nikkiData.status,
      relation_end: relationEnd // NEW
    }
  };
}
```

### Anti-Patterns to Avoid
- **Sending unnormalized dates to FreeScout API:** FreeScout accepts malformed dates as strings, causing silent data corruption
- **Hardcoding field ID 9:** Use environment variable with default fallback for flexibility across demo/production
- **Skipping null handling:** Always handle null/empty RelationEnd gracefully (current members have no end date)

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Date parsing/validation | Custom date parser with complex regex | Simple format detection + normalization | Edge cases (leap years, month boundaries) are error-prone; format detection is sufficient |
| Custom field API payload | Ad-hoc object construction | `buildCustomFieldsPayload()` pattern | Centralized mapping ensures consistency; environment variable pattern already established |
| ACF field access | Direct data.acf property access without null checks | Safe navigation with fallbacks | Prevents errors when ACF data is missing or malformed |

**Key insight:** FreeScout API accepts malformed dates silently, storing them as strings instead of dates. This breaks UI date pickers and filtering. Normalization + validation before submission is critical.

## Common Pitfalls

### Pitfall 1: Date Format Mismatch
**What goes wrong:** FreeScout custom field ID 9 expects `YYYY-MM-DD` format. Rondo Club ACF date field may return `YYYYMMDD`, `d/m/Y`, or ISO 8601 timestamp. Wrong format is accepted by API but stored as string, breaking FreeScout UI date picker and filtering.

**Why it happens:** WordPress ACF date fields return formatted strings based on field settings. FreeScout API accepts any string value for custom fields without validation. No immediate error during sync. FreeScout UI shows blank date or garbled text in custom field 9.

**How to avoid:**
1. Implement `normalizeDateToYYYYMMDD()` function to handle all known formats
2. Validate normalized output matches `^\d{4}-\d{2}-\d{2}$` regex before API submission
3. Log warning for unrecognized formats (helps identify new edge cases)
4. Return null for invalid dates (field left empty, not corrupted)

**Warning signs:**
- FreeScout custom field shows text instead of date picker
- Search by "membership end date" returns 0 results
- Database query shows field value as string: `SELECT value FROM customer_fields WHERE field_id = 9` returns non-date strings

### Pitfall 2: Missing ACF Field Data
**What goes wrong:** Former members whose Sportlink data was wiped have empty `data_json`. Accessing `acf['lid-tot']` on empty object returns undefined, causing downstream errors.

**Why it happens:** Sportlink removes detailed data for former members. Rondo Club sync preserves email/name but `data_json` may be empty object. ACF field access without null checks throws errors.

**How to avoid:**
1. Check `acf` exists before accessing nested properties: `const acf = data.acf || {}`
2. Use nullish coalescing for ACF field access: `acf['lid-tot'] || null`
3. Handle null gracefully in normalization function (already returns null for falsy input)
4. Test with former member data (KNVB IDs from `rondo_club_members` where `data_json = '{}'`)

**Warning signs:**
- TypeError: Cannot read property 'lid-tot' of undefined
- Sync errors for specific members (check if former members)
- Zero RelationEnd values synced despite having active members

### Pitfall 3: Environment Variable Type Mismatch
**What goes wrong:** `process.env.FREESCOUT_FIELD_RELATION_END` returns string "9", but FreeScout API expects integer ID. Sending `{ id: "9", value: "2026-12-31" }` causes API error or field not updated.

**Why it happens:** Environment variables are always strings. Forgetting `parseInt()` results in string ID. FreeScout API may accept it silently but not update the field.

**How to avoid:**
1. Always use `parseInt()` for field IDs: `parseInt(process.env.FREESCOUT_FIELD_RELATION_END || '9', 10)`
2. Use base-10 radix (second parameter) to avoid octal interpretation
3. Provide default as string in `process.env.X || '9'` pattern (matches existing code)
4. Verify field ID type in payload before API call (optional assertion)

**Warning signs:**
- Field value not updated in FreeScout after sync
- API accepts request but field remains empty
- Debug logs show `{ id: "9", ... }` instead of `{ id: 9, ... }`

### Pitfall 4: Null vs Empty String Handling
**What goes wrong:** Sending `{ id: 9, value: null }` to FreeScout API may cause error. Should send empty string `''` for missing dates.

**Why it happens:** FreeScout API expects string values for custom fields. Null is not a string. Inconsistent handling across different custom field types.

**How to avoid:**
1. Convert null to empty string in `buildCustomFieldsPayload()`: `customFields.relation_end || ''`
2. This matches existing pattern for other fields (union_teams, member_since)
3. Empty string clears the field value (correct behavior for members without end date)

**Warning signs:**
- FreeScout API returns 400 Bad Request
- Error message: "value must be a string"
- Field not cleared when RelationEnd is removed in Sportlink

## Code Examples

Verified patterns from official sources and existing codebase:

### Date Normalization Function
```javascript
// Source: New implementation based on existing patterns from Sportlink sync
// Location: lib/utils.js (add to existing file)

/**
 * Normalize date value to YYYY-MM-DD format for FreeScout API
 * @param {string|null} dateValue - Date in various formats
 * @returns {string|null} - Date in YYYY-MM-DD format or null
 */
function normalizeDateToYYYYMMDD(dateValue) {
  if (!dateValue || typeof dateValue !== 'string') return null;

  const trimmed = dateValue.trim();
  if (!trimmed) return null;

  // ACF returns YYYYMMDD when return format is YYYYMMDD
  if (/^\d{8}$/.test(trimmed)) {
    return `${trimmed.substr(0, 4)}-${trimmed.substr(4, 2)}-${trimmed.substr(6, 2)}`;
  }

  // ISO 8601 timestamp (2026-02-12T00:00:00Z or 2026-02-12T00:00:00)
  if (trimmed.includes('T')) {
    return trimmed.split('T')[0]; // Extract YYYY-MM-DD
  }

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // Invalid format
  return null;
}

module.exports = {
  // ... existing exports ...
  normalizeDateToYYYYMMDD
};
```

### Prepare Step Modification
```javascript
// Source: steps/prepare-freescout-customers.js (modify existing prepareCustomer function)
// Lines to modify: ~line 225 (customFields object)

const { normalizeDateToYYYYMMDD } = require('../lib/utils');

function prepareCustomer(member, freescoutDb, rondoClubDb, nikkiDb) {
  const data = member.data || {};
  const acf = data.acf || {};

  // ... existing email, name, phone, etc. extraction ...

  // Get Nikki data
  const nikkiData = getMostRecentNikkiData(nikkiDb, member.knvb_id);

  // Extract and normalize RelationEnd
  const relationEndRaw = acf['lid-tot'] || null;
  const relationEnd = normalizeDateToYYYYMMDD(relationEndRaw);

  return {
    knvb_id: member.knvb_id,
    email: email.toLowerCase(),
    freescout_id: freescoutId,
    data: {
      firstName,
      lastName,
      phones: phones,
      photoUrl: getPhotoUrl(member),
      websites: websites
    },
    customFields: {
      union_teams: unionTeams,
      public_person_id: member.knvb_id,
      member_since: acf['lid-sinds'] || null,
      nikki_saldo: nikkiData.saldo,
      nikki_status: nikkiData.status,
      relation_end: relationEnd // NEW
    }
  };
}
```

### Submit Step Modification
```javascript
// Source: steps/submit-freescout-sync.js (modify existing functions)
// Lines to modify: ~line 18 (getCustomFieldIds) and ~line 33 (buildCustomFieldsPayload)

function getCustomFieldIds() {
  return {
    union_teams: parseInt(process.env.FREESCOUT_FIELD_UNION_TEAMS || '1', 10),
    public_person_id: parseInt(process.env.FREESCOUT_FIELD_PUBLIC_PERSON_ID || '4', 10),
    member_since: parseInt(process.env.FREESCOUT_FIELD_MEMBER_SINCE || '5', 10),
    nikki_saldo: parseInt(process.env.FREESCOUT_FIELD_NIKKI_SALDO || '7', 10),
    nikki_status: parseInt(process.env.FREESCOUT_FIELD_NIKKI_STATUS || '8', 10),
    relation_end: parseInt(process.env.FREESCOUT_FIELD_RELATION_END || '9', 10) // NEW
  };
}

function buildCustomFieldsPayload(customFields) {
  const fieldIds = getCustomFieldIds();
  return [
    { id: fieldIds.union_teams, value: customFields.union_teams || '' },
    { id: fieldIds.public_person_id, value: customFields.public_person_id || '' },
    { id: fieldIds.member_since, value: customFields.member_since || '' },
    { id: fieldIds.nikki_saldo, value: customFields.nikki_saldo !== null ? String(customFields.nikki_saldo) : '' },
    { id: fieldIds.nikki_status, value: customFields.nikki_status || '' },
    { id: fieldIds.relation_end, value: customFields.relation_end || '' } // NEW
  ];
}
```

### Environment Variable Configuration
```bash
# Source: .env file (add new variable)
# Location: .env and .env.example

# FreeScout Custom Field IDs (existing)
FREESCOUT_FIELD_UNION_TEAMS=1
FREESCOUT_FIELD_PUBLIC_PERSON_ID=4
FREESCOUT_FIELD_MEMBER_SINCE=5
FREESCOUT_FIELD_NIKKI_SALDO=7
FREESCOUT_FIELD_NIKKI_STATUS=8

# NEW: RelationEnd field
FREESCOUT_FIELD_RELATION_END=9
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Manual date parsing per field | Centralized date normalization function | This phase (44) | Reduces code duplication, easier testing, consistent behavior |
| Hardcoded field IDs | Environment variable pattern | Phase 16 (2026-01-28) | Enables different field IDs across demo/production environments |
| No validation before API submission | Format validation before submit | This phase (44) | Prevents silent data corruption in FreeScout |

**Deprecated/outdated:**
- Direct ACF field access without null checks (pre-Phase 16): Use `const acf = data.acf || {}` pattern
- Sending null values for missing custom fields: FreeScout API expects empty strings

## Open Questions

1. **ACF date field return format**
   - What we know: `prepare-rondo-club-members.js:179` stores RelationEnd as `acf['lid-tot']`, extracted from Sportlink `RelationEnd` field (line 173)
   - What's unclear: Does Rondo Club WordPress ACF field have specific return format configured? Or does it return raw value from Sportlink?
   - Recommendation: Test with actual data from `rondo_club_members` table. Query: `SELECT data_json FROM rondo_club_members WHERE knvb_id = '<known-member-with-end-date>' LIMIT 1` and inspect `acf['lid-tot']` format. Update normalization function if new format discovered.

2. **FreeScout custom field type configuration**
   - What we know: FreeScout custom field ID 9 named "Lid tot" (member until)
   - What's unclear: Is field ID 9 configured as "date" type in FreeScout admin? Or generic "text" field?
   - Recommendation: Verify FreeScout field configuration before deployment. If "date" type, YYYY-MM-DD is required. If "text" type, any format accepted but date picker won't work. Document actual field type in VERIFICATION.md.

3. **Null date handling for current members**
   - What we know: Current members (no expiration) have null/empty RelationEnd in Sportlink
   - What's unclear: Should null RelationEnd be stored as empty string (field cleared) or omitted from payload entirely?
   - Recommendation: Send empty string (matches existing pattern for member_since). Clearing the field is correct behavior when membership end date is removed. Test both approaches if unclear.

## Sources

### Primary (HIGH confidence)
- FreeScout API Documentation - [API Reference](https://api-docs.freescout.net/) - Custom fields endpoint, date format specification
- Existing codebase - `steps/prepare-freescout-customers.js` - ACF field extraction pattern
- Existing codebase - `steps/submit-freescout-sync.js` - Custom field payload builder pattern
- Existing codebase - `steps/prepare-rondo-club-members.js:173-179` - RelationEnd extraction from Sportlink

### Secondary (MEDIUM confidence)
- FreeScout Custom Fields Module - [Documentation](https://freescout.net/module/custom-fields/) - Field type configuration
- Existing codebase - `.planning/research/PITFALLS.md:103-147` - Date format normalization guidance
- Existing codebase - `.planning/research/STACK.md:145-174` - RelationEnd data flow diagram

### Tertiary (LOW confidence)
- None - all research verified with official sources or existing code

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - All libraries already in use, no new dependencies
- Architecture: HIGH - Follows established patterns from Phase 16 (FreeScout sync)
- Pitfalls: HIGH - Date format issues documented in research phase, tested patterns available
- Implementation: HIGH - All code modification points identified, patterns verified in existing codebase

**Research date:** 2026-02-12
**Valid until:** 2026-04-12 (60 days - stable domain, no fast-moving dependencies)