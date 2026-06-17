# Replace Static ZIP Database with GeoAdmin API

## Problem

`src/util/geo.ts` contains a hardcoded `SWISS_ZIP_DATABASE` of ~270 entries. Switzerland has ~4,000 ZIP codes. The database is incomplete, has inconsistent coordinate precision, and will go stale. ZIP "8303" (Bassersdorf) was missing entirely.

## Solution

Replace the synchronous `resolveLocation()` lookup with an async call to the **Swiss GeoAdmin SearchServer API** (free, no API key, official swisstopo service).

**API endpoint:**
```
GET https://api3.geo.admin.ch/rest/services/api/SearchServer
  ?searchText={query}
  &type=locations
  &origins=zipcode,gg25
  &sr=4326
  &limit=1
```

**Response:**
```json
{
  "results": [{
    "attrs": {
      "lat": 47.44012451171875,
      "lon": 8.62593936920166,
      "label": "<b>8303 - Bassersdorf</b>",
      "origin": "zipcode"
    }
  }]
}
```

Covers all Swiss ZIP codes, city names, and addresses. Already used by `mcp-swiss` and `swisstopo-mcp` projects.

## Changes

### 1. `src/util/geo.ts` — Make `resolveLocation` async with API fallback

- Add `resolveLocationAsync(location: string): Promise<GeoPoint | undefined>` that:
  1. Tries the GeoAdmin SearchServer API first
  2. Falls back to the static database on network error
  3. Has a 3-second timeout per request
- Keep `resolveLocation` (sync) as a deprecated wrapper that only checks the static DB
- Remove the static ZIP database entries for cities already covered by the API (keep the database small as offline fallback only)
- Add a simple in-memory cache (`Map<string, GeoPoint>`) to avoid repeated API calls for the same location

### 2. `src/adapters/live/coopLiveAdapter.ts` — Use async resolver

- Change `resolveLocation(location)` call to `await resolveLocationAsync(location)` (line 233)
- Already in an async function, so this is safe

### 3. `src/adapters/live/migrosLiveAdapter.ts` — Already async

- Change `await resolveLocation(location)` to `await resolveLocationAsync(location)` (line 336)
- Already awaits, just rename the import

### 4. `src/util/geo.test.ts` — Update tests

- Change `resolveLocation` tests to `resolveLocationAsync` (now returns promises)
- Mock `fetch` for API tests
- Keep one test that verifies static DB fallback works

### 5. `src/util/geo.ts` — Keep `findNearbyLocations` unchanged

- `findNearbyLocations` uses the static DB for local proximity search — this is fine as-is
- It's a different use case (find nearby stores, not resolve a location)

## Verification

1. `pnpm lint && pnpm test && pnpm build`
2. Manual: search "8303" in SPA store finder — should find Bassersdorf stores
3. Manual: search "Winterthur" — should resolve to Winterthur coordinates
4. Manual: search "Zürich" — should resolve correctly
5. Test offline fallback: disconnect network, verify `resolveLocation` still works via static DB
