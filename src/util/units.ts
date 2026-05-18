/**
 * Normalizes a unit price to a common base unit (kg, l, or piece) for comparison.
 * Returns the price per base unit and the base unit name.
 */
export function getBaseUnitPrice(
  currentPrice: number,
  unitValue: number,
  per: string,
): { price: number; unit: string } | undefined {
  if (unitValue <= 0) {
    return undefined;
  }

  const p = per.toLowerCase().trim().replace(/\s+/g, '');

  // Weight normalization to CHF/kg
  if (p === 'kg' || p === 'kilogram' || p === 'kilograms') {
    return { price: currentPrice / unitValue, unit: 'kg' };
  }
  if (p === 'g' || p === 'gram' || p === 'grams') {
    return { price: currentPrice / (unitValue * 0.001), unit: 'kg' };
  }
  const weightMatch = p.match(/^(\d+(?:\.\d+)?)(g|kg)$/);
  if (weightMatch) {
    const amount = Number(weightMatch[1]);
    const unit = weightMatch[2];
    const multiplier = unit === 'kg' ? amount : amount * 0.001;
    return { price: currentPrice / (unitValue * multiplier), unit: 'kg' };
  }

  // Volume normalization to CHF/l
  if (p === 'l' || p === 'liter' || p === 'litre' || p === 'liters' || p === 'litres') {
    return { price: currentPrice / unitValue, unit: 'l' };
  }
  if (p === 'ml') {
    return { price: currentPrice / (unitValue * 0.001), unit: 'l' };
  }
  const volumeMatch = p.match(/^(\d+(?:\.\d+)?)(ml|l)$/);
  if (volumeMatch) {
    const amount = Number(volumeMatch[1]);
    const unit = volumeMatch[2];
    const multiplier = unit === 'l' ? amount : amount * 0.001;
    return { price: currentPrice / (unitValue * multiplier), unit: 'l' };
  }

  // Count normalization to CHF/piece
  if (p === 'piece' || p === 'pieces' || p === 'stk' || p === 'count' || p === 'pc' || p === 'pcs') {
    return { price: currentPrice / unitValue, unit: 'piece' };
  }

  return undefined;
}
