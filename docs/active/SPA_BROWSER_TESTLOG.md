# SPA Browser Test Log

## Loop 1 — Feature Verification via Browser MCP

| # | Test Case | Section | Steps | Expected | Actual | Status |
|---|-----------|---------|-------|----------|--------|--------|
| 1.1 | Page loads correctly | General | Navigate to localhost:3000 | Title visible, 5 tabs present | | |
| 1.2 | Tab navigation works | General | Click each tab | Correct section shows | | |
| 1.3 | Product search basic | Search | Enter "butter", click Search | Products appear with cards | | |
| 1.4 | Nutrition checkbox toggle | Search | After search, check "Show nutrition" | Nutrition info appears on cards | | |
| 1.5 | Ingredients checkbox toggle | Search | After search, check "Show ingredients" | Ingredients info appears on cards | | |
| 1.6 | Nutrition + Ingredients toggle OFF | Search | Uncheck both boxes | Nutrition/ingredients hidden | | |
| 1.7 | Chain filter - Migros only | Search | Uncheck all, check Migros, search "milk" | Only Migros products | | |
| 1.8 | Chain filter - Coop only | Search | Uncheck all, check Coop, search "butter" | Only Coop products | | |
| 1.9 | Store Finder - Migros | Stores | Enter "Bern", check Migros only, click Find | Migros stores appear | | |
| 1.10 | Store Finder - Coop | Stores | Enter "Zurich", check Coop only, click Find | Coop stores with hours | | |
| 1.11 | Store Finder - Multi-chain | Stores | Enter "Basel", both checked | Stores from both chains | | |
| 1.12 | Store opening hours display | Stores | After store search, check hours format | Weekday/weekend format shown | | |
| 1.13 | Price Comparison | Compare | Enter "butter", select Migros+Coop, compare | Offers from both chains | | |
| 1.14 | Availability - Products first | Avail | Enter "Milch", "Bern", search | Product card, then stores below | | |
| 1.15 | Source Status | Status | Click Source Status tab | Status table with all chains | | |
