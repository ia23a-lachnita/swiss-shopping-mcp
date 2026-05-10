# swiss-shopping-mcp - Implementation Tracker

**ALWAYS READ THIS FIRST before starting any work.**

This tracker documents the current phase, completed work, and next steps.

---

## Current Phase: V1 Foundation (Architecture & Bootstrap)

**Status**: ✅ COMPLETE  
**Completion Date**: 2026-05-10  
**Next Phase**: Phase 2 — Adapter Implementation

### What's Done (Phase 1)

- ✅ Project scaffold with TypeScript + pnpm
- ✅ Vitest testing framework with coverage config
- ✅ ESLint + Prettier configuration
- ✅ MCP server bootstrap (`src/index.ts`)
- ✅ Logger utility with log levels
- ✅ Adapter type system (`src/adapters/types.ts`)
- ✅ Git initialized locally
- ✅ Documentation (README.md, SETUP.md, claude.md, PLAN.md)

### Test Coverage (Phase 1)
- ✅ Logger utility tests (100%)
- Currently: ~10 tests passing
- Target: 80%+ coverage once adapters added

### Known Limitations (Phase 1)
- No actual chain adapters yet
- HTTP client not yet implemented
- No geocoding service yet
- Mock MCP tools (placeholders only)

---

## Next: Phase 2 — Adapter Implementation

**Estimated Duration**: 3-5 sessions  
**Goal**: Implement 8 chain adapters (Migros, Coop, Aldi, Denner, Lidl, Farmy, Volg, Otto's)

### Phase 2 Tasks

#### 2.1 Core Infrastructure
- [ ] HTTP client with caching & retry logic
- [ ] Adapter base class & registry
- [ ] Geocoding service (ZIP → lat/lng)
- [ ] Haversine distance calculation

#### 2.2 Adapter Implementations
- [ ] Migros adapter (reference: swissgroceries-mcp)
- [ ] Coop adapter (reference: swissgroceries-mcp)
- [ ] Aldi adapter (reference: swissgroceries-mcp)
- [ ] Denner adapter (reference: swissgroceries-mcp)
- [ ] Lidl adapter (reference: swissgroceries-mcp)
- [ ] Farmy adapter (reference: swissgroceries-mcp)
- [ ] Volg adapter (reference: swissgroceries-mcp)
- [ ] Otto's adapter (reference: swissgroceries-mcp)

#### 2.3 Services (Business Logic)
- [ ] Product matcher (canonical product matching)
- [ ] Shopping planner (multi-chain search & filtering)
- [ ] Strategy solver (single-store, split-cart, absolute-cheapest)

#### 2.4 MCP Tools
- [ ] `search_products` - Cross-chain product search
- [ ] `get_product` - Detailed product info
- [ ] `find_stores` - Store locator
- [ ] `get_promotions` - Current deals
- [ ] `find_stock` - Stock availability
- [ ] `plan_shopping` - Multi-chain optimization
- [ ] `health_check` - Adapter status

#### 2.5 Enhancements
- [ ] Nutrition normalization (protein, calories, macros)
- [ ] Allergen standardization
- [ ] Better unit price comparison

#### 2.6 Testing (Phase 2)
- [ ] Unit tests for each adapter (mock API responses)
- [ ] Integration tests for services
- [ ] Snapshot tests for normalization
- [ ] Target: 80%+ coverage

### Phase 2 Success Criteria
- ✅ All 8 chain adapters working
- ✅ Services (matcher, planner, strategy) tested
- ✅ All MCP tools callable
- ✅ 80%+ test coverage
- ✅ README with examples
- ✅ NPM package publishable

---

## Phase 3: V2 — Account Integration (Planned)

**Estimated Duration**: 3-5 sessions  
**Goal**: Add authenticated cart/order management for Migros, Coop, Denner, Lidl

### Phase 3 Tasks

#### 3.1 Authentication Framework
- [ ] Abstract auth interface
- [ ] OAuth2 for Migros (reference: migros-mcp)
- [ ] OAuth2 for Coop (if available)
- [ ] OAuth2 for Denner (if available)
- [ ] OAuth2 for Lidl (if available)
- [ ] Keychain storage (secure credential cache)
- [ ] Token refresh logic

#### 3.2 Authenticated Tools
- [ ] `get_basket` / `add_to_basket` / `update_basket_quantity` / `remove_from_basket`
- [ ] `get_orders` / `get_order_details`
- [ ] `get_checkout_link`
- [ ] `get_loyalty_status` / `get_cumulus_points`

#### 3.3 Loyalty Programs
- [ ] Migros Cumulus (reference: migros-mcp)
- [ ] Coop loyalty (if available)
- [ ] Denner loyalty (if available)

#### 3.4 Testing (Phase 3)
- [ ] Auth flow tests (mock OAuth)
- [ ] Keychain integration tests
- [ ] Basket CRUD tests
- [ ] Token refresh logic tests

### Phase 3 Success Criteria
- ✅ ≥3 chains with auth working
- ✅ Basket operations tested
- ✅ Loyalty logic working
- ✅ Session persistence working
- ✅ Graceful degradation to anonymous

---

## Phase 4: V3+ — Expansion (Roadmap)

### Planned Features
- [ ] Non-grocery adapters (pharma, hardware, drugstores)
- [ ] Price history database
- [ ] Seasonal trends & recommendations
- [ ] Meal planning integration
- [ ] Budget alerts
- [ ] Sustainability tracking

---

## Session Notes

### Session 1: 2026-05-10 (15:08 UTC+2)
- ✅ Created full project scaffold
- ✅ TypeScript + pnpm setup
- ✅ Testing framework (Vitest)
- ✅ Documentation (claude.md, PLAN.md, SETUP.md)
- ✅ Git initialized
- ⏳ Next: Create GitHub repo, start Phase 2 adapters

---

## Common Issues & Fixes

### Issue: Tests not running
```bash
pnpm install
pnpm build
pnpm test
```

### Issue: TypeScript errors
Make sure strict mode is enforced in tsconfig.json. All code must pass TypeScript strict checks.

### Issue: Format issues
```bash
pnpm format  # Auto-fix
pnpm lint --fix  # Auto-fix linting
```

---

## How to Update This Tracker

1. **After completing a task**: Update the checkbox (`[ ]` → `[✅]`)
2. **After completing a phase**: Update "Status" and add session notes
3. **Before starting new work**: Read the "Next" section and check what's blocked/ready
4. **On decisions**: Add a note with the decision rationale

Example:
```markdown
### Session 2: 2026-05-11
- ✅ Implemented Migros adapter
- 🐛 Found issue with unit price normalization (fix: test case added)
- 📝 Decision: Use 100g/1L as standard (not per-piece) for consistency
- ⏳ Next: Implement Coop adapter
```

---

**Last Updated**: 2026-05-10 14:06 UTC  
**Next Review**: When Phase 2 starts
