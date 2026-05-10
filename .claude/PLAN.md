# swiss-shopping-mcp Development Plan

## Phase 1: Foundation (V1 - Enhanced swissgroceries-mcp)

### Core Infrastructure
- [x] Project scaffold with TypeScript + pnpm
- [x] Testing setup with Vitest
- [x] ESLint + Prettier configuration
- [x] MCP server bootstrap
- [x] Logger utility
- [ ] HTTP client with caching & retry logic
- [ ] Adapter base class & registry

### Adapter Implementation (V1)
- [ ] Migros adapter (copy & improve from swissgroceries-mcp)
- [ ] Coop adapter (copy & improve from swissgroceries-mcp)
- [ ] Aldi adapter (copy & improve from swissgroceries-mcp)
- [ ] Denner adapter (copy & improve from swissgroceries-mcp)
- [ ] Lidl adapter (copy & improve from swissgroceries-mcp)
- [ ] Farmy adapter (copy & improve from swissgroceries-mcp)
- [ ] Volg adapter (copy & improve from swissgroceries-mcp)
- [ ] Otto's adapter (copy & improve from swissgroceries-mcp)

### Services (V1)
- [ ] Product matcher (canonical matching, unit price normalization)
- [ ] Shopping planner (multi-chain optimization)
- [ ] Strategy solver (single-store, split-cart, cheapest)
- [ ] Geocoding service (ZIP → GPS, distance calculation)

### MCP Tools (V1)
- [ ] `search_products` - Cross-chain product search
- [ ] `get_product` - Detailed product info
- [ ] `find_stores` - Store locator with distance
- [ ] `get_promotions` - Current deals
- [ ] `find_stock` - Stock availability
- [ ] `plan_shopping` - Multi-chain planning
- [ ] `health_check` - Adapter status

### Enhancements over swissgroceries-mcp (V1)
- [ ] Nutrition data normalization (protein, calories, macros)
- [ ] Allergen standardization (milk, gluten, nuts, etc.)
- [ ] Better price unit comparison (per 100g vs per liter)
- [ ] Improved error handling & fallbacks
- [ ] Cache strategy optimization
- [ ] Test coverage 80%+

---

## Phase 2: Account Integration (V2)

### Authentication Framework
- [ ] Abstract auth interface
- [ ] OAuth2 flow for Migros, Coop, Denner, Lidl
- [ ] Credential encryption & OS keychain storage
- [ ] Automatic token refresh
- [ ] Session persistence

### Authenticated Tools (V2)
- [ ] `get_basket` - Current basket contents
- [ ] `add_to_basket` - Add items
- [ ] `update_basket_quantity` - Modify quantities
- [ ] `remove_from_basket` - Remove items
- [ ] `get_orders` - Order history
- [ ] `get_checkout_link` - Hand off to browser for payment
- [ ] `get_loyalty_status` - Points balance & tier

### Loyalty Integration (V2)
- [ ] Migros Cumulus (copy from migros-mcp)
- [ ] Coop loyalty (if available)
- [ ] Denner loyalty (if available)
- [ ] Plan optimization considering loyalty points

### Account-Aware Planning (V2)
- [ ] Loyalty-points-optimized strategy
- [ ] Personalized deal recommendations
- [ ] Saved shopping lists
- [ ] Recurring shopping patterns

---

## Phase 3: Expansion (V3)

### Beyond Groceries
- [ ] Pharmacy adapters (Amavita, Apotheke am Markt, etc.)
- [ ] Hardware stores (Baumarkt, Hornbach, etc.)
- [ ] Drugstores (Müller, DM, Kruidvat, etc.)

### Price History & Trends (V3)
- [ ] Price tracking database
- [ ] Historical comparison
- [ ] Best time to buy recommendations
- [ ] Seasonal trends

### Smart Features (V3+)
- [ ] Meal planning integration
- [ ] Recipe suggestions based on deals
- [ ] Bulk buying optimization
- [ ] Sustainability tracking (carbon footprint)
- [ ] Shopping list templates
- [ ] Budget alerts

---

## Testing Roadmap

- [ ] Unit tests for adapters (mock API responses)
- [ ] Integration tests for planner & strategy
- [ ] Snapshot tests for normalization
- [ ] E2E tests for full workflows
- [ ] Load testing for multi-chain queries
- [ ] Coverage target: 80%+

---

## Known Limitations & TODOs

- [ ] Error handling could be more granular
- [ ] Rate limiting strategy (respect per-chain limits)
- [ ] Caching TTL optimization
- [ ] Pagination for large result sets
- [ ] Async operation batching
- [ ] Circuit breaker pattern for failing adapters

---

## Success Criteria (V1)

- ✅ All 8 chains working
- ✅ Tests passing with 80%+ coverage
- ✅ README complete with examples
- ✅ NPM package publishable
- ✅ MCP integration tested

## Success Criteria (V2)

- ✅ Account login working for ≥3 chains
- ✅ Cart operations tested end-to-end
- ✅ Loyalty program logic working
- ✅ Session persistence working across restarts
- ✅ Graceful degradation without auth

## Success Criteria (V3)

- ✅ Non-grocery adapters (≥1 pharmacy, ≥1 hardware)
- ✅ Price history tracking
- ✅ Meal plan integration (if applicable)
