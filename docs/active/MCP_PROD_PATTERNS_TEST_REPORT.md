# swiss-shopping-mcp — Production Patterns MCP Test Report

Date: 2026-06-16
Test file: `src/mcp.prodpatterns.test.ts`
Target: MCP server via loopback transport with fake fetch (Aldi + Denner fixtures)
Total tests: **113** (all pass)
Pre-existing tests: 131 (all pass)
Combined: **244 tests pass**, 2 skipped (live opt-in), 0 fail

## Method

Tests exercise all 7 MCP tools end-to-end through the MCP protocol using a
loopback transport pair (client ↔ server in-process). Fake fetch serves fixture
HTML/XML for Aldi product pages and Denner promotions pages. Tests validate
tool registration, schema correctness, data contracts, error handling, filtering,
cross-tool integration, edge cases, metadata propagation, and performance.

---

## 1. Tool Registration & Schema Validation (6 tests)

| # | Test | Outcome |
|---|---|---|
| 1.1 | Registers all 7 V1 MCP tools | PASS — exact 7 tool names |
| 1.2 | Each tool has non-empty description | PASS |
| 1.3 | search_products schema: query is only required field | PASS — all optional params present |
| 1.4 | compare_prices schema: query is only required field | PASS |
| 1.5 | find_stores schema: location is only required field | PASS |
| 1.6 | lookup_store_product_availability requires chain, storeId, query | PASS |

**Finding**: All tool schemas use strict mode (no additionalProperties). Optional
parameters include chains, maxPrice, category, tags, limit, matchMode, etc.

---

## 2. Error Handling (11 tests)

| # | Test | Outcome |
|---|---|---|
| 2.1 | Unknown tool name → UNKNOWN_TOOL | PASS |
| 2.2 | Empty query → INVALID_ARGUMENTS | PASS |
| 2.3 | Missing query → INVALID_ARGUMENTS | PASS |
| 2.4 | Empty location → INVALID_ARGUMENTS | PASS |
| 2.5 | Invalid chain enum → INVALID_ARGUMENTS | PASS |
| 2.6 | Quantity 0 → INVALID_ARGUMENTS | PASS |
| 2.7 | Negative quantity → INVALID_ARGUMENTS | PASS |
| 2.8 | Invalid matchMode → INVALID_ARGUMENTS | PASS |
| 2.9 | Limit > 100 → INVALID_ARGUMENTS | PASS |
| 2.10 | Missing chain for availability → INVALID_ARGUMENTS | PASS |
| 2.11 | Unknown properties rejected (strict) | PASS |

**Finding**: Zod validation catches all malformed input before reaching adapter
code. Error messages include field path and specific constraint violation.

---

## 3. search_products (11 tests)

| # | Test | Outcome |
|---|---|---|
| 3.1 | Basic query returns Aldi Toskanabrot | PASS — 1 product, price 2.19 |
| 3.2 | Chains filter restricts to aldi only | PASS |
| 3.3 | Non-matching query returns empty | PASS |
| 3.4 | maxPrice=1.0 excludes Toskanabrot (2.19) | PASS |
| 3.5 | limit=1 returns ≤1 product | PASS |
| 3.6 | Balanced mode: "Brot" matches "Toskanabrot" | PASS |
| 3.7 | Literal mode: "Brot" still matches via substring | PASS |
| 3.8 | Sources array present in response | PASS |
| 3.9 | Provenance has confidence and sourceType | PASS — medium, retailer-web |
| 3.10 | Unsupported chains produce source warnings | PASS — coop warning with REAL_SOURCE_NOT_IMPLEMENTED |
| 3.11 | All unsupported chains → ALL_SOURCES_FAILED | PASS |

**Finding**: Literal mode only controls taxonomy alias expansion, not substring
matching. "Brot" is a substring of "Toskanabrot" so it matches in both modes.

---

## 4. search_promotions (6 tests)

| # | Test | Outcome |
|---|---|---|
| 4.1 | Denner adapter operational | PASS — returns empty (fixture promotions expired) |
| 4.2 | Unsupported chains produce warnings | PASS — migros warning |
| 4.3 | All unsupported → ALL_SOURCES_FAILED | PASS |
| 4.4 | Non-matching query → empty | PASS |
| 4.5 | Source metadata includes Denner provider | PASS |
| 4.6 | Chain filter works | PASS |

**Finding**: Denner fixture HTML contains promotions valid "Bis 20.05.2026".
Since today is 2026-06-16, all promotions are expired and filtered out by the
adapter's `validUntil >= now` check. This is correct behavior — the adapter
properly rejects stale promotions.

---

## 5. find_stores (6 tests)

| # | Test | Outcome |
|---|---|---|
| 5.1 | Aldi store search → ALL_SOURCES_FAILED | PASS |
| 5.2 | Coop store search → ALL_SOURCES_FAILED | PASS |
| 5.3 | All unsupported → ALL_SOURCES_FAILED | PASS |
| 5.4 | Empty location → INVALID_ARGUMENTS | PASS |
| 5.5 | Migros store search → ALL_SOURCES_FAILED | PASS |
| 5.6 | Mixed supported/unsupported → ALL_SOURCES_FAILED | PASS |

**Finding**: No chain currently has a live store search adapter. Aldi live-beta
covers product search only. All store searches return ALL_SOURCES_FAILED with
descriptive messages.

---

## 6. compare_prices (11 tests)

| # | Test | Outcome |
|---|---|---|
| 6.1 | Basic comparison returns Toskanabrot offer | PASS — aldi, 2.19, packPrice |
| 6.2 | Default quantity is 1 | PASS |
| 6.3 | Quantity=3 multiplies totalPrice to 6.57 | PASS |
| 6.4 | Chain filter restricts offers | PASS |
| 6.5 | cheapestOffer and mostExpensiveOffer present | PASS |
| 6.6 | savingsVsMostExpensive undefined for single chain | PASS |
| 6.7 | maxPrice excludes expensive offers | PASS |
| 6.8 | All unsupported → ALL_SOURCES_FAILED | PASS |
| 6.9 | includePromotions does not crash (empty promos) | PASS |
| 6.10 | unitPrice comparisonBasis works | PASS |
| 6.11 | Invalid comparisonBasis → INVALID_ARGUMENTS | PASS |

**Finding**: With only Aldi having live product search, cross-chain comparison
is limited. When includePromotions=true with Denner, no promotion offers are
added because fixture promotions are expired.

---

## 7. get_source_status (7 tests)

| # | Test | Outcome |
|---|---|---|
| 7.1 | All 8 chains returned without filters | PASS |
| 7.2 | Each chain has all 5 capabilities | PASS |
| 7.3 | Aldi productSearch is live-beta | PASS |
| 7.4 | Denner promotions is live-beta | PASS |
| 7.5 | Farmy all capabilities are blocked | PASS |
| 7.6 | Capability filter works | PASS |
| 7.7 | No static-v1 status in runtime | PASS |

**Finding**: Source registry accurately reflects current adapter support.
8 chains × 5 capabilities = 40 entries returned.

---

## 8. get_store_availability_support (4 tests)

| # | Test | Outcome |
|---|---|---|
| 8.1 | Returns all chains | PASS — includes aldi, denner, coop |
| 8.2 | All chains report supported=false | PASS |
| 8.3 | Chain filter restricts results | PASS |
| 8.4 | Unsupported chains provide reason | PASS |

---

## 9. lookup_store_product_availability (5 tests)

| # | Test | Outcome |
|---|---|---|
| 9.1 | Coop returns supported=false, isAvailable=false | PASS |
| 9.2 | Aldi returns supported=false | PASS |
| 9.3 | Farmy returns supported=false | PASS |
| 9.4 | Denner returns supported=false via delegate | PASS |
| 9.5 | Volg returns non-error with supported=false | PASS |

**Finding**: All chains currently return supported=false for store availability.
The response is always ok:true (not isError) — graceful degradation.

---

## 10. Cross-Tool Integration (6 tests)

| # | Test | Outcome |
|---|---|---|
| 10.1 | Source status matches search capability | PASS |
| 10.2 | Unsupported chain status matches search error | PASS |
| 10.3 | Search and compare prices are consistent | PASS — same price 2.19 |
| 10.4 | find_stores unsupported matches availability | PASS |
| 10.5 | Denner status and search are consistent | PASS |
| 10.6 | Availability for unsupported chain is non-error | PASS |

**Finding**: Cross-tool consistency is maintained. Price from search_products
matches effectivePrice from compare_prices for the same product.

---

## 11. Data Integrity & Model Contracts (6 tests)

| # | Test | Outcome |
|---|---|---|
| 11.1 | NormalizedProduct has required fields | PASS — id, chain, name, price |
| 11.2 | Product chain is valid Chain enum | PASS |
| 11.3 | Comparison offers have all required fields | PASS |
| 11.4 | Source warnings have code, message, chain | PASS |
| 11.5 | CapabilitySourceStatus has chain, capability, status | PASS |
| 11.6 | Availability result has all required fields | PASS |

---

## 12. Edge Cases & Boundary Conditions (10 tests)

| # | Test | Outcome |
|---|---|---|
| 12.1 | Whitespace-only query rejected | PASS |
| 12.2 | HTML injection in query does not crash | PASS |
| 12.3 | Unicode query returns empty gracefully | PASS |
| 12.4 | 500-char query does not crash | PASS |
| 12.5 | limit=1 respected | PASS |
| 12.6 | limit=100 accepted | PASS |
| 12.7 | quantity=0.01 accepted | PASS |
| 12.8 | Empty chains array rejected | PASS |
| 12.9 | Valid dietaryPreferences accepted | PASS |
| 12.10 | Invalid dietaryPreference rejected | PASS |

---

## 13. Metadata & Provenance Propagation (4 tests)

| # | Test | Outcome |
|---|---|---|
| 13.1 | search_products sources array with provider | PASS — ALDI SUISSE |
| 13.2 | search_products includes summary | PASS |
| 13.3 | search_promotions source metadata | PASS — Denner provider |
| 13.4 | compare_prices propagates warnings | PASS |

---

## 14. MatchMode & Taxonomy Behavior (5 tests)

| # | Test | Outcome |
|---|---|---|
| 14.1 | Balanced: "Brot" matches "Toskanabrot" | PASS |
| 14.2 | Literal: "Brot" matches via substring | PASS |
| 14.3 | Multi-token all must match | PASS |
| 14.4 | Multi-token fails if any token unmatched | PASS |
| 14.5 | Query by brand field works | PASS — BACKBOX matches |

**Finding**: Literal mode only affects taxonomy alias expansion (e.g., "pasta"
→ "penne"). Substring matching within product fields works in both modes.

---

## 15. Source Warning Codes & Error Patterns (5 tests)

| # | Test | Outcome |
|---|---|---|
| 15.1 | Unsupported chain search → ALL_SOURCES_FAILED | PASS |
| 15.2 | Unsupported chain find_stores → ALL_SOURCES_FAILED | PASS |
| 15.3 | Unsupported chain promotions → ALL_SOURCES_FAILED | PASS |
| 15.4 | Partial failure: aldi succeeds, coop fails with warning | PASS |
| 15.5 | Partial failure: denner succeeds, farmy fails with warning | PASS |

**Finding**: When a mix of supported and unsupported chains are requested, the
tool returns ok:true with data from successful chains and sourceWarnings from
failed chains. Only when ALL chains fail does the tool return isError.

---

## 16. Production Readiness Patterns (7 tests)

| # | Test | Outcome |
|---|---|---|
| 16.1 | Concurrent tool calls do not interfere | PASS |
| 16.2 | Rapid sequential calls (5x) work | PASS |
| 16.3 | structuredContent matches text content | PASS |
| 16.4 | get_source_status < 2s | PASS |
| 16.5 | search_products < 5s | PASS |
| 16.6 | compare_prices < 5s | PASS |
| 16.7 | lookup_store_product_availability < 3s | PASS |

---

## Results Summary

| Category | Tests | Pass | Fail |
|---|---|---|---|
| 1. Tool Registration | 6 | 6 | 0 |
| 2. Error Handling | 11 | 11 | 0 |
| 3. search_products | 11 | 11 | 0 |
| 4. search_promotions | 6 | 6 | 0 |
| 5. find_stores | 6 | 6 | 0 |
| 6. compare_prices | 11 | 11 | 0 |
| 7. get_source_status | 7 | 7 | 0 |
| 8. get_store_availability_support | 4 | 4 | 0 |
| 9. lookup_store_product_availability | 5 | 5 | 0 |
| 10. Cross-Tool Integration | 6 | 6 | 0 |
| 11. Data Integrity | 6 | 6 | 0 |
| 12. Edge Cases | 10 | 10 | 0 |
| 13. Metadata Propagation | 4 | 4 | 0 |
| 14. MatchMode & Taxonomy | 5 | 5 | 0 |
| 15. Warning Codes & Errors | 5 | 5 | 0 |
| 16. Production Readiness | 7 | 7 | 0 |
| **Total** | **113** | **113** | **0** |

## Key Findings

1. **Live adapter coverage is limited**: Only Aldi (product search) and Denner
   (promotions) have live adapters. All other chains return ALL_SOURCES_FAILED
   or source warnings.

2. **Denner fixture promotions are expired**: The sample HTML fixture contains
   promotions valid until 2026-05-20. The adapter correctly filters these out.
   To test promotion data flow, the fixture would need future-dated promotions.

3. **Literal vs balanced mode**: Literal mode only controls taxonomy alias
   expansion. Substring matching within product fields works identically in
   both modes. "Brot" matches "Toskanabrot" in both modes.

4. **No matchExplanation in Aldi adapter**: The Aldi live adapter does not set
   `matchExplanation` on returned products. This field is optional in the schema.

5. **Graceful degradation**: All unsupported operations return structured
   responses (not crashes) with supported=false and descriptive reasons.

6. **Performance**: All tools respond within acceptable latency bounds through
   the loopback transport.

## Verification

| Command | Result |
|---|---|
| `npm run lint` | PASS |
| `npx vitest run` | PASS: 244 tests, 2 skipped |
| `npm run build` | PASS |
