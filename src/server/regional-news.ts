// 선택 공고에서 확인한 행정구역으로 네이버 뉴스 검색 결과를 즉시 조회한다.
import { isIP } from 'node:net';
import { isTimestamp } from './public-fields.js';

const endpoint = 'https://naverapihub.apigw.ntruss.com/search/v1/news';
const source = Object.freeze({ provider: 'naver_api_hub', name: '네이버 검색결과',
  url: 'https://www.ncloud.com/product/applicationService/NAVERAPIHUB' } as const);
const display = 3;
const timeoutMs = 5_000;
const maxResponseBytes = 64 * 1024;

const metropolitanCities = new Set([
  '서울특별시', '부산광역시', '대구광역시', '인천광역시', '대전광역시', '울산광역시',
]);
const provinces = new Set([
  '경기도', '강원특별자치도', '충청북도', '충청남도', '전북특별자치도',
  '경상북도', '경상남도', '제주특별자치도',
]);
const integratedCity = '전남광주통합특별시';

export type RegionalNewsOptions = {
  clientId?: string;
  clientSecret?: string;
  signal: AbortSignal;
  fetch?: typeof fetch;
  now?: () => Date;
};

type RegionalNewsItem = {
  title: string;
  snippet: string;
  originalUrl: string;
  originalHost: string;
  publishedAt: string;
};

export type RegionalNewsResult = {
  status: 'available' | 'empty' | 'partial' | 'provider_unavailable' | 'rate_limited' | 'not_configured';
  queriedAt: string | null;
  conditions: { region: string; query: string; sort: 'date'; display: 3; format: 'json' };
  source: typeof source;
  textFormat: 'plain_text';
  geographicRelevance: 'unverified';
  factVerification: 'unverified';
  items: RegionalNewsItem[];
  // 응답에서 누락되었거나 사용할 수 없는 항목의 수다. 부분 응답의 목록은 통째로 보류한다.
  omittedCount: number;
};

// 실제 소속 검증은 서버의 공고 자료에서 끝낸 상태로 호출한다.
export function isRegionalNewsRegion(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 40) return false;
  if (value === '세종특별자치시') return true;
  const [province, municipality, district, extra] = value.split(' ');
  if (!municipality || extra !== undefined) return false;
  if (metropolitanCities.has(province)) return district === undefined && /^[가-힣]+[군구]$/u.test(municipality);
  if (!provinces.has(province) && province !== integratedCity) return false;
  if (district !== undefined) return /^[가-힣]+시$/u.test(municipality) && /^[가-힣]+구$/u.test(district);
  return province === integratedCity ? /^[가-힣]+[시군구]$/u.test(municipality) : /^[가-힣]+[시군]$/u.test(municipality);
}

const entities = new Map(Object.entries({
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', AMP: '&', QUOT: '"', LT: '<', GT: '>',
  nbsp: '\u00a0', middot: '·', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—',
}));

function plainText(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  // 검색어 강조 태그와 엔티티는 표시 형식만 벗겨 낸다.
  const decoded = value.replace(/<\/?b>/gi, '').replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (_match, entity: string) => {
    if (!entity.startsWith('#')) return entities.get(entity) ?? '\u0000';
    const hex = entity[1].toLowerCase() === 'x';
    const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return codePoint > 0x10ffff ? '\u0000' : String.fromCodePoint(codePoint);
  }).trim();
  if (decoded && !/<(?:\/?[a-z]|[!?])|[\p{Cc}\p{Cs}]/iu.test(decoded)) return decoded;
}

function originalHost(value: string): string | undefined {
  // URL 문자열은 제공자가 준 형태로 보존하고 표시할 호스트만 추출한다.
  if (/[\s\p{Cc}\p{Cs}\\]/u.test(value) || !/^https?:\/\/[^/?#@]+(?:[/?#]|$)/iu.test(value)) return;
  try {
    const hostname = new URL(value).hostname;
    const domain = hostname.replace(/\.$/u, '');
    const labels = domain.split('.');
    if (labels.length < 2 || domain.length > 253 || isIP(domain)
      || /\.(?:localhost|local|localdomain|internal|lan|home|corp|arpa|onion)$/iu.test(domain)
      || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))) return;
    return hostname;
  } catch {
    return undefined;
  }
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const providerDate = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) ([+-][0-9]{2})([0-9]{2})$/u;

function providerTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  const match = providerDate.exec(value);
  if (!match) return;
  const [, weekday, day, monthName, year, clock, offsetHour, offsetMinute] = match;
  const month = String(months.indexOf(monthName) + 1).padStart(2, '0');
  const date = `${year}-${month}-${day.padStart(2, '0')}`;
  const time = `${date}T${clock}${offsetHour}:${offsetMinute}`;
  if (!isTimestamp(time) || weekdays[new Date(`${date}T00:00:00Z`).getUTCDay()] !== weekday) return;
  // pubDate는 네이버에 공급된 시각이며 미제휴 기사는 원문이 제공된 시각이다.
  const timestamp = new Date(time).toISOString();
  if (isTimestamp(timestamp)) return timestamp;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readItem(value: unknown, credentials: string[]): RegionalNewsItem | undefined {
  if (!isObject(value) || typeof value.originallink !== 'string') return;
  const title = plainText(value.title);
  const snippet = plainText(value.description);
  const host = originalHost(value.originallink);
  const publishedAt = providerTimestamp(value.pubDate);
  if (!title || !snippet || !host || !publishedAt) return;
  const item = { title, snippet, originalUrl: value.originallink, originalHost: host, publishedAt };
  if (Object.values(item).some(field => credentials.some(credential => field.includes(credential)))) return;
  return item;
}

function readPage(value: unknown, credentials: string[]): Pick<RegionalNewsResult, 'status' | 'items' | 'omittedCount'> {
  if (!isObject(value) || 'error' in value || 'errorCode' in value || 'errorMessage' in value
    || typeof value.total !== 'number' || !Number.isSafeInteger(value.total) || value.total < 0
    || !Array.isArray(value.items) || value.items.length > Math.min(value.total, display)) {
    throw new Error('invalid_news_response');
  }
  const firstPage = value.start === undefined || value.start === 1 || (value.total === 0 && value.start === 0);
  // 응답 display가 생략되거나 실제 항목 수와 요청 크기 중 하나를 표시할 수 있다.
  const validDisplay = value.display === undefined || value.display === value.items.length || value.display === display;
  if (!firstPage || !validDisplay) throw new Error('invalid_news_response');

  const validItems: RegionalNewsItem[] = [];
  for (const row of value.items) {
    const item = readItem(row, credentials);
    if (item) validItems.push(item);
  }
  const omittedCount = Math.min(value.total, display) - validItems.length;
  if (omittedCount > 0) return { status: 'partial', items: [], omittedCount };
  return { status: value.total === 0 ? 'empty' : 'available', items: validItems, omittedCount };
}

async function readLimitedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_news_response');
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  const bytes = new Uint8Array(maxResponseBytes);
  let length = 0;
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (length + value.byteLength > bytes.length) throw new Error('invalid_news_response');
      bytes.set(value, length);
      length += value.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}

export async function fetchRegionalNews(region: string, options: RegionalNewsOptions): Promise<RegionalNewsResult> {
  if (!isRegionalNewsRegion(region)) throw new TypeError('invalid_news_region');
  const base: RegionalNewsResult = {
    status: 'provider_unavailable', queriedAt: null,
    conditions: { region, query: `${region} 분양`, sort: 'date', display, format: 'json' },
    source, textFormat: 'plain_text', geographicRelevance: 'unverified', factVerification: 'unverified',
    items: [], omittedCount: 0,
  };
  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret?.trim();
  if (!clientId || !clientSecret) return { ...base, status: 'not_configured' };
  if (options.signal.aborted) return base;

  const { query, sort, format } = base.conditions;
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ query, display: String(display), sort, format }).toString();
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
  const queriedAt = (options.now?.() ?? new Date()).toISOString();
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: 'GET', signal, redirect: 'error', cache: 'no-store', credentials: 'omit',
      headers: { Accept: 'application/json', 'X-NCP-APIGW-API-KEY-ID': clientId, 'X-NCP-APIGW-API-KEY': clientSecret },
    });
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (signal.aborted || response.redirected || response.status !== 200 || contentType !== 'application/json'
      || Number(response.headers.get('content-length')) > maxResponseBytes) {
      void response.body?.cancel().catch(() => {});
      const status = !signal.aborted && !response.redirected && response.status === 429 ? 'rate_limited' : 'provider_unavailable';
      return { ...base, status, queriedAt };
    }
    const page = await readLimitedJson(response, signal);
    return { ...base, queriedAt, ...readPage(page, [clientId, clientSecret]) };
  } catch {
    return { ...base, queriedAt };
  }
}
