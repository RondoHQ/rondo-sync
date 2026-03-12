# T02: 46-freescout-conversations-as-activities 02

**Slice:** S13 — **Milestone:** M001

## Description

Create the submit step, pipeline orchestrator, and integrate FreeScout conversations sync into sync.sh and sync-all.js.

Purpose: Complete the end-to-end flow — activities get created in Rondo Club and the pipeline is operational via CLI.
Output: Submit step, pipeline orchestrator, updated sync.sh and sync-all.js.

## Must-Haves

- [ ] "FreeScout email conversations appear in Rondo Club person activity timeline"
- [ ] "Each conversation syncs only once (no duplicate timeline entries on re-sync)"
- [ ] "Pipeline is accessible via sync.sh conversations command"
- [ ] "Pipeline is included in sync-all.js full sync run"
- [ ] "Support agents working in Rondo Club can see conversation history without tab switching"

## Files

- `steps/submit-freescout-activities.js`
- `pipelines/sync-freescout-conversations.js`
- `scripts/sync.sh`
- `pipelines/sync-all.js`
