export function reasonText(code: unknown): string | null;
export function won(value: unknown): string;
export function halfWon(value: unknown): bigint | null;
export function noticeRange(price: unknown): { min: string; max: string } | null;
export function tradeRange(stat: unknown): { min: string; mid: string; max: string } | null;
export function priceLabel(range: ReturnType<typeof noticeRange>): string;
