---
created: 2026-03-11T13:00:43.968Z
title: Expand reverse sync to include home addresses
area: general
files: []
---

## Problem

The reverse sync (from Rondo Club back to Sportlink) currently syncs certain data but does not include addresses. The feature request is to expand the reverse sync to also push address changes back to Sportlink, limited to "Home" addresses only (not postal/other address types).

## Solution

Before implementing, need to understand the Sportlink API interface:

1. **Sportlink address API endpoints** — What endpoints exist for reading/writing member addresses? Is there a specific endpoint for updating addresses vs. creating them?
2. **Address types in Sportlink** — How does Sportlink distinguish address types (Home/Postal/etc.)? What field names and enum values are used?
3. **Required fields** — What fields are required when updating an address in Sportlink (street, house number, postal code, city, country)?
4. **Validation rules** — Does Sportlink validate addresses (e.g., Dutch postal code format)? What error responses can we expect?
5. **Rate limits / batch support** — Can addresses be updated in batch or only one at a time? Are there rate limits?
6. **Existing reverse sync pattern** — How does the current reverse sync work? What data does it already push back? This determines the integration pattern to follow.

Once these questions are answered, the implementation would extend the existing reverse sync flow to detect Home address changes in Rondo Club and push them to Sportlink via the appropriate API.
