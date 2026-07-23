/**
 * Extracts a trailing pack-size token (e.g. "800 g", "5x28g", "1l") from a
 * product name for sources that embed size in the free-text name instead of
 * exposing it as a separate field (verified live: Volg's WooCommerce API and
 * Otto's OCC API both do this; Migros/Coop expose size separately already).
 */

const TRAILING_SIZE_PATTERN =
  /\s+((?:\d+\s*x\s*)?\d+(?:[.,]\d+)?\s*(?:kg|g|ml|cl|dl|l))\.?\s*$/i;

export function extractTrailingSize(rawName: string): { name: string; size?: string } {
  const trimmed = rawName.trim();
  const match = trimmed.match(TRAILING_SIZE_PATTERN);
  if (!match || match.index === undefined) {
    return { name: trimmed };
  }

  const size = match[1].replace(/\s+/g, ' ').trim();
  const name = trimmed.slice(0, match.index).trim();
  return { name: name || trimmed, size };
}
