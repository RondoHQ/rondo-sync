# T01: 46-freescout-conversations-as-activities 01

**Slice:** S13 — **Milestone:** M001

## Description

Create the FreeScout conversations database tracking module, download step with pagination and incremental sync, and prepare step that transforms conversations into Rondo Club activity payloads.

Purpose: Foundation for syncing FreeScout email conversations to Rondo Club person timelines — handles data acquisition and transformation.
Output: Three files: SQLite DB module, download step, prepare step. All follow existing project patterns.

## Must-Haves

- [ ] "FreeScout conversations are downloaded per customer with pagination handling for 50+ conversations"
- [ ] "Incremental sync fetches only new conversations since last sync timestamp"
- [ ] "Conversations are tracked in SQLite with UNIQUE constraint on conversation_id to prevent duplicates"
- [ ] "Conversations are transformed into Rondo Club activity payloads with correct format"

## Files

- `lib/freescout-conversations-db.js`
- `steps/download-freescout-conversations.js`
- `steps/prepare-freescout-activities.js`
