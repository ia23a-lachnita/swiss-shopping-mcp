---
applyTo: "**/*.{test,spec}.ts"
---

Tests must cover:
- expected success behavior
- edge input behavior
- explicit error behavior

Prefer small, deterministic unit tests over broad integration snapshots when possible.

When adding a new tool or adapter behavior, add at least one failing-path test alongside happy-path tests.
