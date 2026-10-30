---
id: TASK-1
title: Set up the build
status: In Progress
assignee:
  - '@alice'
created_date: '2026-10-14 09:49'
updated_date: '2026-10-17 09:19'
labels:
  - build
  - infra
milestone: m-0
dependencies: []
references:
  - 'https://example.com/build'
documentation:
  - docs/build.md
modified_files:
  - scripts/build.mjs
priority: high
type: feature
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
Compile with **esbuild** and run `tsc`.

- first point
- second point
  - nested point

```ts
const answer = 42; // <!-- SECTION:DESCRIPTION:END --> inside a fence
```
<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria
<!-- AC:BEGIN -->
- [x] #1 Build produces dist/
- [ ] #2 Typecheck passes
<!-- AC:END -->

## Definition of Done
<!-- DOD:BEGIN -->
- [ ] #1 Docs updated
<!-- DOD:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
1. Add script
2. Wire CI
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
Started with esbuild.
<!-- SECTION:NOTES:END -->

## Comments

<!-- COMMENTS:BEGIN -->
author: @bob
created: 2026-10-14 09:49

---

Looks good so far

---

created: 2026-10-17 09:19

---

Second

---
<!-- COMMENTS:END -->
