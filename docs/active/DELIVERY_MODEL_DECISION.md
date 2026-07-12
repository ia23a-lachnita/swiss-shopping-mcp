# Delivery Model Decision — how users consume swiss-shopping-mcp in real life

Date: 2026-07-11
Status: recommended (Phase 1 not yet started)
Inputs: Antigravity (Gemini) brainstorming session, current codebase constraints

## Goal

A user **on the go** must answer these questions **in seconds**:

1. "Is product X available at a store near me / on my route **right now** so I can grab it?"
2. "Does vendor Y carry product X at all — and if yes, at which location?"
3. "Show me that store on a map."

Speed-to-answer is the #1 requirement.

## Hard constraints

- **Server-side Playwright/Chromium is mandatory** (Migros Cloudflare bypass, Lidl
  client-side rendering). This rules out static hosting, edge functions, and
  most serverless platforms. The backend needs a **long-running Node process**.
- Per-vendor capabilities differ: only **Migros and Coop** have real per-store
  availability; the source registry tracks this and the UI must keep degrading
  gracefully (it already does).
- Single developer, low budget, unofficial vendor APIs (fragile — the server
  must be easy to redeploy/patch).

## Options considered

### (a) Native / hybrid mobile app
- ✅ Best device integration (GPS, push).
- ❌ App-store friction, signing, review cycles; a second codebase (or
  Capacitor wrapper) to maintain; zero speed advantage over a PWA for this
  use case (all heavy work is server-side anyway).
- **Verdict: rejected for now.** If needed later, wrap the PWA with Capacitor —
  the investment is not lost.

### (b) Mobile-first website / PWA ⭐ RECOMMENDED
- ✅ The SPA already exists — this is an upgrade, not a rewrite.
- ✅ Installable (Add to Home Screen), full-screen, geolocation API for
  "stores near me", Google Maps deep links already implemented.
- ✅ Fastest possible answer path: warm Node server with persistent Playwright
  session + file TTL cache → warm responses in ~1–3 s.
- ✅ No store review; deploy fixes in minutes when a vendor API breaks.
- **Verdict: primary delivery model.**

### (c) Agent-mediated access (LLM chat client → MCP server)
- ✅ Zero UI work; natural language; the MCP server already exists.
- ❌ Too slow for the core use case: cloud agents (e.g. GitHub Copilot cloud
  agents) cold-start environments; every answer costs tokens; latency is
  10–60 s vs. 1–3 s for a direct call. Nondeterministic answers hurt trust for
  "is it in stock" questions.
- **Verdict: secondary interface, not the primary.** Keep the MCP server; a
  remote MCP endpoint (HTTP/SSE) on the same host lets Claude or other
  assistants handle *complex* multi-step queries ("plan my shopping across two
  stores under CHF 50") where an agent genuinely adds value.

### (d) Messaging bot (Telegram) — from the brainstorming session
- ✅ No frontend work at all; Telegram Live Location → nearest stores; results
  as list with inline Google Maps buttons; push-capable.
- ✅ Runs in the same Node process (`telegraf`), reuses SearchService directly.
- **Verdict: optional Phase 3 addition** — cheap to add and excellent on-the-go
  ergonomics, but the PWA must come first (richer UI: images, filters, price
  comparison).

## Decision

**PWA-first, VPS-hosted, MCP as secondary agent interface.**

```
┌───────────────┐   ┌────────────────┐   ┌─────────────────┐
│  PWA (phone)  │   │ Telegram bot    │   │ LLM client      │
│  primary      │   │ optional Ph. 3  │   │ via remote MCP  │
└───────┬───────┘   └───────┬────────┘   └────────┬────────┘
        └────────────┬──────┴─────────────────────┘
                     ▼
        ┌─────────────────────────────┐
        │ Node backend (Docker, VPS)  │
        │ SearchService + adapters    │
        │ Playwright (Migros/Lidl)    │
        │ Web-augmented search        │
        │ File TTL cache              │
        └─────────────────────────────┘
```

## Phased path

### Phase 1 — Mobile-first PWA (highest value, ~1 short iteration)
1. Responsive layout pass on `src/web/public/index.html` (mobile-first CSS).
2. Web app manifest + service worker shell (installable; cache static assets
   only — data must stay live).
3. "Use my location" button → `navigator.geolocation` → pass lat/lon to the
   existing store/availability endpoints (they already accept coordinates).
4. Availability tab as the landing view (it answers the core question).

### Phase 2 — Deploy (makes it real)
1. Dockerfile: Node 20 + Playwright Chromium deps; persist
   `SWISS_SHOPPING_CACHE_DIR` as a volume.
2. Small VPS (e.g. Hetzner CX ~€4–5/mo) + Caddy for HTTPS.
3. Set `GOOGLE_CSE_API_KEY`/`GOOGLE_CSE_CX` (reliable semantic search; the
   keyless DuckDuckGo fallback rate-limits bursts).
4. Private by default: basic auth or a long random path — the vendor APIs are
   unofficial; do not run a public service on top of them.
5. Keep the server warm: Playwright session and guest token are already
   process-lifetime; add a 15-min self-ping if the host idles.

### Phase 3 — Optional interfaces
1. Telegram bot (live location → nearest in-stock stores with Maps buttons).
2. Remote MCP endpoint (streamable HTTP) for agent access on the same host.

## Speed budget (target, warm server)

| Step | Target |
| --- | --- |
| Geolocate + store lookup (cached geocode) | < 500 ms |
| Product search (cache hit) | < 300 ms |
| Product search (cache miss, web-augmented) | 2–4 s |
| Availability fan-out Migros+Coop (10 stores) | 1–3 s |

## Rejected alternatives (recorded for posterity)

- **Serverless/edge hosting** — Playwright requirement and per-request cold
  starts kill both feasibility and the speed budget.
- **Native app first** — no benefit before the PWA exists; app-store friction.
- **Agent-only delivery** — latency and token cost are incompatible with the
  "grab it now" use case.
