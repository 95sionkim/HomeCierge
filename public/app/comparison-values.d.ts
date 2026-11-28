export function reasonText(code: unknown): string | null;
export function won(value: unknown): string;
export function halfWon(value: unknown): bigint | null;
export function noticeRange(price: unknown): { min: string; max: string } | null;
export function tradeRange(stat: unknown): { min: string; mid: string; max: string } | null;
export function priceLabel(range: ReturnType<typeof noticeRange>): string;
export function exclusiveAreaClass(value: unknown): number | null;
export function areaClassLabel(areaClass: unknown): string;
export function groupModelsByAreaClass<T extends { houseType?: string | null }>(
  models: readonly T[] | null | undefined,
): Array<{ key: string; areaClass: number | null; label: string; models: Array<{ model: T; index: number }> }>;
export function comparisonAreaCriterion(data: unknown): {
  basis: 'exclusive_area_class' | 'supply' | 'unknown';
  areaClass: number | null;
  tolerancePercent?: string | null;
  minM2?: string | null;
  maxM2?: string | null;
  short: string;
  full: string;
  banner: string;
};
