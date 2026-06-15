# Production Release Checklist

Run these checks before tagging a production release.

## Static Runtime Gate

- [ ] `rg -n "StaticChainAdapter|STATIC_CHAIN_CATALOG|legacy-static" src` returns no matches.

## Quality Gates

- [ ] `npm run lint` passes.
- [ ] `npm test -- --run` passes.
- [ ] `npm run build` passes.

## Source Status Honesty

- [ ] `get_source_status` (called without filters) reports every chain and capability.
- [ ] README support matrix matches `get_source_status` output.
- [ ] No source marked `live-stable` without repeated successful live checks.

## Live Source Coverage

- [ ] Every enabled live source has fixture tests.
- [ ] Every enabled live source has an opt-in live smoke test (`LIVE_SOURCE_TESTS=1 npm run test:live`).

## Architecture Decisions

- [ ] Product search provider decision is recorded in `docs/active/SOURCE_PROVIDER_DECISION_RECORD.md`.
- [ ] All blocked chains have documented reasons in the source registry.

## CI

- [ ] `.github/workflows/ci.yml` passes on the main branch.
