---
status: resolved
trigger: "Family relations in Rondo Club are broken. Person 103 (father) has relations to children 583 and 789, but wrong type, no back-relations, no sibling relations."
created: 2026-02-22T00:00:00Z
updated: 2026-02-22T00:02:00Z
---

## Current Focus

hypothesis: RESOLVED
test: N/A
expecting: N/A
next_action: archived

## Symptoms

expected: Parent (103) should have "Child" type relations to 583 and 789. Children should have "Parent" type relations back to 103. Children should have "Sibling" relations to each other.
actual: Person 103 has relations to 583 and 789 but with wrong type (9 instead of 3). Children 583 and 789 have no relations back to father. No sibling relations exist between children.
errors: No error messages — the system just doesn't create the right relations
reproduction: Look at any parent-child family in the system — relations are incomplete/wrong
started: Never worked correctly — first detailed inspection reveals the issue

## Eliminated

- hypothesis: updateChildrenParentLinks not being called
  evidence: The function IS called (lines 501, 528 in submit-rondo-club-sync.js). But it uses wrong type ID 8, and Rondo Club's class-inverse-relationships.php bails out when get_term(8, 'relationship_type') returns null.
  timestamp: 2026-02-22

- hypothesis: WordPress REST API requires first_name/last_name for PUT
  evidence: The auto-title reads from DB with get_field(), so PUT without names just reuses existing names. Not the primary cause.
  timestamp: 2026-02-22

## Evidence

- timestamp: 2026-02-22
  checked: WordPress relationship_type taxonomy terms via wp-cli
  found: term_id 2=Parent, 3=Child, 4=Sibling
  implication: The actual term IDs are 2/3/4, NOT 8/9/10

- timestamp: 2026-02-22
  checked: Post meta for person 103 (parent)
  found: relationships_0_relationship_type = a:1:{i:0;i:9;} (type 9, nonexistent)
         relationships_1_relationship_type = a:1:{i:0;i:9;} (type 9, nonexistent)
         relationships point to posts 583 and 789
  implication: Relations exist but with type 9 (which doesn't exist in WordPress taxonomy)

- timestamp: 2026-02-22
  checked: Post meta for persons 583 and 789 (children)
  found: Zero relationship meta entries on either child
  implication: updateChildrenParentLinks completely failed - no parent links on children

- timestamp: 2026-02-22
  checked: submit-rondo-club-sync.js hardcoded type IDs
  found: Line 327: relationship_type: [8] // Parent
         Line 400: relationship_type: [9] // Child
         Comment on line 285: 8=parent, 9=child, 10=sibling
  implication: Code was written assuming different term IDs than what WordPress actually has

- timestamp: 2026-02-22
  checked: class-inverse-relationships.php (Rondo Club theme)
  found: Also uses hardcoded 8/9/10 in sibling/parent-child logic (lines 248,253,432,435,440,650,778)
         BUT sync_single_inverse_relationship correctly uses get_term() lookup and get_field('inverse_relationship_type') for inverse mapping
  implication: The inverse sync in WordPress WOULD work if it received valid term IDs. Since it gets type 9 (nonexistent), get_term(9) returns null → function bails at line 327 → no inverse created.

- timestamp: 2026-02-22
  checked: WordPress term meta for inverse_relationship_type mappings
  found: term 2 (Parent) → inverse_relationship_type = 3 (Child)
         term 3 (Child) → inverse_relationship_type = 2 (Parent)
         term 4 (Sibling) → inverse_relationship_type = 4 (Sibling)
  implication: WordPress knows correct inverse mappings. Just needs correct type IDs.

- timestamp: 2026-02-22
  checked: class-inverse-relationships.php hooks
  found: Hooks into rest_after_insert_person and rest_after_update_person
  implication: If rondo-sync sends correct type IDs (3 for child), Rondo Club will automatically:
               1. Create inverse Parent (type 2) relation on children
               2. Create Sibling (type 4) relations between children
               So updateChildrenParentLinks in rondo-sync is redundant (but harmless if fixed)

## Resolution

root_cause: Hardcoded relationship type IDs in submit-rondo-club-sync.js used wrong values (8=parent, 9=child) that don't match the actual WordPress taxonomy term IDs (2=parent, 3=child, 4=sibling). When these wrong IDs are stored in WordPress and class-inverse-relationships.php fires, it calls get_term(9) which returns null (term doesn't exist), causing the entire inverse/sibling sync to be skipped. The same wrong IDs were present in class-inverse-relationships.php itself (for the sibling cleanup logic) and in two tools.

fix: |
  1. Added RELATIONSHIP_TYPE constant object in submit-rondo-club-sync.js with correct IDs (PARENT=2, CHILD=3, SIBLING=4)
  2. Updated all uses: [9] → [RELATIONSHIP_TYPE.CHILD], [8] → [RELATIONSHIP_TYPE.PARENT]
  3. Fixed merge logic to replace old wrong-typed child relations (type 9) during next sync to avoid duplicates
  4. Fixed class-inverse-relationships.php with class constants TYPE_PARENT=2, TYPE_CHILD=3, TYPE_SIBLING=4
  5. Fixed same wrong IDs in tools/merge-duplicate-person.js and tools/merge-duplicate-parents.js
  6. Documented correct type IDs in CLAUDE.md

  After next sync run, existing bad data (type 9 relations on person 103) will be automatically replaced with correct type 3 relations. Rondo Club's class-inverse-relationships.php will then fire and create: (a) inverse Parent type 2 relations on children 583 and 789, and (b) Sibling type 4 relations between children 583 and 789.

verification: Fix confirmed by checking WordPress taxonomy terms (2=Parent, 3=Child, 4=Sibling) and tracing the exact failure path. No existing tests broken. Data cleanup will happen automatically on next sync.

files_changed:
  - steps/submit-rondo-club-sync.js (wrong type IDs 8/9 → RELATIONSHIP_TYPE constants)
  - tools/merge-duplicate-person.js (same fix)
  - tools/merge-duplicate-parents.js (same fix)
  - includes/class-inverse-relationships.php in rondo-club (added TYPE_PARENT/CHILD/SIBLING class constants, replaced hardcoded IDs)
  - CLAUDE.md (documented correct relationship type IDs)
