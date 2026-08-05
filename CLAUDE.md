# swiss-shopping-mcp - Agent Instructions

## FIRST THING: Read the tracker

Before coding anything, read:
- `docs/active/IMPLEMENTATION_TRACKER.md`

Update the tracker after each meaningful change.

## Project scope

Build a TypeScript MCP server for Swiss retail/grocery discovery and comparison.

### In scope (current)
- Product search across supported Swiss chains
- Normalized product/store/promotion models
- Price comparison and filtering logic
- Strong automated tests for adapters and core services

### Not in scope (unless explicitly requested)
- Mobile automation MCP tooling
- Firebase tooling
- Account/cart checkout integrations in this phase

## Tool / MCP usage policy

Only use development MCPs relevant to this codebase:
- `context7` for library docs
- `context-mode` for large-output command execution
- `antigravity-mcp` for AI-powered code review, brainstorming, and second opinion (uses Gemini via Google subscription)

Do not add runtime/business MCPs (e.g., external shopping/account MCPs) to this repository config.

## antigravity-mcp model priority

When using `antigravity-mcp` for code review or brainstorming, prefer models in this order (fall back to next if usage exhausted):
1. `gemini-3.6-flash`
2. `gemini-3.1-pro`
3. `gemini-3.5-flash`
4. `gemini-3`
5. `gemini-2.5-pro`
6. `gemini-2.5-flash`

Always pass `model` explicitly starting from the top of this list — antigravity-mcp's own default (currently `gemini-3.5-flash` via its `sdk` backend) does not follow this order on its own. Only drop to the next model on an actual failure/exhaustion signal, not preemptively.

### When to consult antigravity (SECOND-OPINION CONTRACT)

**Consult antigravity-mcp before committing to any idea, plan, or design
decision — not only for code review.** It is the project's designated second
opinion, and the agent is expected to reach for it whenever a choice has real
alternatives, not just when asked to.

Mandatory before implementing:
- Any **plan** or multi-step approach (`brainstorm` for open-ended options,
  `ask-ai` when a concrete implementation-ready recommendation is wanted).
- Any **technique with real trade-offs** — animation/easing, layout, algorithm
  choice, data-flow or state design, protocol/error-handling strategy.
- Any **architecture or dependency decision**, including "should this live in
  the adapter, the service, or the UI".
- Any time a first attempt did not look right and the fix is not obvious.

Expected afterwards: say what antigravity recommended, and where the
implementation departed from it and why. A consult that produced a correction
worth keeping belongs in the code comment or the plan doc — this is how
`.button-loading-border`'s alpha-compositing and linecap rules got recorded.

Skip it only for mechanical work with one obvious form (a rename, a typo, a
test that mirrors an existing one). If unsure whether a decision qualifies,
consult — it is cheap, and the model priority above keeps it free.

## Live-model testing contract (DETERMINISTIC FIRST)

Anything that spends OpenRouter quota — `npm run test:eval`, `test:live`,
driving the real chat in a browser — runs **only after the deterministic
suite is fully green**. Order, every time:

1. `npm run build` — types must compile.
2. `npm test -- --run` — the whole suite passes, not "passes except".
3. `npm run lint` — 0 errors.
4. **Only then** run the live-model tests.

**Why:** a red live run has two possible causes — our code is wrong, or the
model behaved badly — and they are indistinguishable in the output. Clearing
the deterministic layer first collapses that ambiguity: once the code is known
correct, a live failure is a statement about model behaviour, which is the
only thing those runs are for. It also stops us paying real quota to discover
a type error.

**Rate limits are ours to respect, not the vendor's to enforce.** Free-tier
model calls go through `src/agent/openRouterRateLimit.ts`, which paces below
the published cap and honors `Retry-After`. Never bypass it with a bare
provider client, and never "fix" a 429 by retrying harder. See
`docs/active/PWA_UX_FIX_PLAN_2026-08-04.md` §5 for what that cost once.

**Budget awareness:** the account is credit-verified, so the daily free-model
allowance is 1000 requests/day (the 50/day figure applies only to accounts
that never purchased credits). The binding constraint in practice is the
per-minute cap, which the limiter already handles — so a live eval run is
cheap and there is no reason to avoid one when the deterministic gate is
green.

## Execution workflow (MANDATORY MANUAL TESTING CONTRACT)

**Automated tests are self-written and do not guarantee correctness. Manual SPA testing is required.**

### CRITICAL: Browser MCP requirement

**Before doing ANY implementation work, verify a browser MCP is available.** If no browser MCP is configured, the agent MUST:
1. Inform the user: "No browser MCP available — cannot perform mandatory manual testing. Please configure a browser MCP (e.g., `@anthropic-ai/claude-code-mcp-browser` or similar) and retry."
2. **STOP. Do not proceed with implementation.**

Proceeding without browser verification is a contract violation.

### Before implementation
1. Read tracker
2. Verify browser MCP is available (if not, STOP — see above)
3. Start the SPA server (`createBackgroundProcess` with tags=["spa","server"])
4. **Manually test the issue in the browser** to confirm it exists and understand exact behavior
5. Stop the server (`killTasks` with tags=["spa","server"])

### Implementation
6. Implement minimal complete slice
7. Build (`npm run build`)

### After implementation (MANDATORY VERIFICATION LOOP)
8. Restart the SPA server (clear cache first if needed)
9. **Manually test the fix in the browser** to verify it works
10. If **not working**: go back to step 6 (implement again), then repeat steps 8-9
11. If **working**: proceed to step 12

### Cleanup
12. Add/adjust automated tests (if coverage is lacking)
13. Run full test suite (`npm test -- --run`)
14. Lint (`npm run lint`)
14a. If the change touches the chat agent, its tools, prompts, or model
    configuration: run `npm run test:eval` — but only once 13 and 14 are green
    (see the live-model testing contract above)
15. Update tracker
16. **Commit AND push** (`git push origin main`) — committing without pushing is a contract violation. Verify with `git status` that the branch is not ahead of origin before ending the task.

### Key rule
**Never mark a fix as done without browser verification. Build/test passing is NOT sufficient.**

## Architecture

### Core modules
- `src/index.ts` - MCP server bootstrap and tool registration
- `src/adapters/` - Per-chain adapter implementations
- `src/services/` - Matching, comparison, planning logic
- `src/util/` - Shared infra utilities

### Normalized model contract
Use `src/adapters/types.ts` as the canonical domain schema:
- `NormalizedProduct`
- `NormalizedStore`
- `NormalizedPromotion`
- `Result<T>`

Adapters translate source data into this contract only.

## Coding standards

- TypeScript strict mode only
- No broad catches or silent failures
- No fake fallbacks that hide integration failures
- Tests required for new behavior
- Keep code and docs aligned

## Definition of done

- Feature works end-to-end in the **browser** (manually verified)
- Tests cover normal path + edge/error path
- Lint/build/test pass
- Tracker updated
- Changes **committed and pushed** to origin (never leave local-only commits)

## References

- `README.md` - product and development requirements
- `docs/active/IMPLEMENTATION_TRACKER.md` - phase/state tracking
