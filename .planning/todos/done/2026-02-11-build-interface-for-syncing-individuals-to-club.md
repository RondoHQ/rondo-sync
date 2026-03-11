---
created: 2026-02-11T09:31:13.953Z
title: Build interface for syncing individuals to Club
area: sync
files: []
---

## Problem

Currently, the sync system operates in bulk — syncing all members, parents, teams, etc. in pipeline runs. There is no way to trigger a sync for a single individual person to Rondo Club. This would be useful for on-demand updates (e.g., after manually fixing data for one person) without running a full pipeline.

## Solution

Build an interface (CLI tool or web dashboard endpoint) that allows syncing a single individual to Rondo Club by member number or name. Should reuse existing steps (prepare, submit) but scoped to one person. TBD on whether this is a CLI tool (`tools/sync-individual.js`), a dashboard action, or both.
