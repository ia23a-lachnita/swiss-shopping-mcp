---
applyTo: "**/*.ts"
---

Use strict TypeScript with explicit interfaces and discriminated unions.

Prefer extending existing domain contracts in `src/adapters/types.ts` over creating parallel shapes.

For MCP tools:
- define explicit input schemas
- keep response payloads deterministic
- return clear typed errors

Do not introduce `any` unless no alternative exists.
