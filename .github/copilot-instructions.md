# Repository-wide Copilot Instructions

Follow `CLAUDE.md` first, then `docs/active/IMPLEMENTATION_TRACKER.md`.

## Scope rules

- Build swiss-shopping-mcp as a TypeScript MCP server for Swiss shopping discovery/comparison.
- Keep implementation focused on adapters, normalization, search/comparison tools, and tests.
- Do not introduce unrelated infrastructure (mobile automation, firebase ops, unrelated account MCPs) unless explicitly requested.

## Implementation rules

- Preserve strict typing and explicit domain contracts.
- Reuse `src/adapters/types.ts` shared models.
- Keep tool schemas explicit and version-safe.
- Propagate meaningful errors; do not swallow them.
- Add tests with any behavior change.

## Validation rules

Before closing a task, run:

```bash
pnpm lint
pnpm test
pnpm build
```
