# S13: Freescout Conversations As Activities

**Goal:** Create the FreeScout conversations database tracking module, download step with pagination and incremental sync, and prepare step that transforms conversations into Rondo Club activity payloads.
**Demo:** Create the FreeScout conversations database tracking module, download step with pagination and incremental sync, and prepare step that transforms conversations into Rondo Club activity payloads.

## Must-Haves


## Tasks

- [x] **T01: 46-freescout-conversations-as-activities 01**
  - Create the FreeScout conversations database tracking module, download step with pagination and incremental sync, and prepare step that transforms conversations into Rondo Club activity payloads.

Purpose: Foundation for syncing FreeScout email conversations to Rondo Club person timelines — handles data acquisition and transformation.
Output: Three files: SQLite DB module, download step, prepare step. All follow existing project patterns.
- [x] **T02: 46-freescout-conversations-as-activities 02**
  - Create the submit step, pipeline orchestrator, and integrate FreeScout conversations sync into sync.sh and sync-all.js.

Purpose: Complete the end-to-end flow — activities get created in Rondo Club and the pipeline is operational via CLI.
Output: Submit step, pipeline orchestrator, updated sync.sh and sync-all.js.

## Files Likely Touched

- `lib/freescout-conversations-db.js`
- `steps/download-freescout-conversations.js`
- `steps/prepare-freescout-activities.js`
- `steps/submit-freescout-activities.js`
- `pipelines/sync-freescout-conversations.js`
- `scripts/sync.sh`
- `pipelines/sync-all.js`
