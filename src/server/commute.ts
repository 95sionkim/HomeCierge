// 공고 주소와 일치하는 지점에서 사용자가 지정한 주소까지 두 제공자를 독립 조회한다.
import { isPublicLabel } from './public-fields.js';
import { readLimitedJson } from './provider-json.js';

type Options = { kakaoKey?: string; odsayKey?: string; signal: AbortSignal; fetch?: typeof fetch; now?: () => Date };
type Point = { x: string; y: string };
type State = 'ready' | 'synthetic_input' | 'origin_unverified' | 'selection_unverified' | 'source_restricted';
type RouteStatus = 'available' | 'not_queried' | 'source_restricted' | 'not_configured' | 'provider_unavailable'
  | 'provider_denied' | 'rate_limited' | 'no_route' | 'points_too_close' | 'connections_unverified';
type Route = { source: 'odsay_route' | 'kakao_directions'; status: RouteStatus; queriedAt: string | null;
  durationSeconds: number | null; distanceMeters: number | null; walkMinutes: number | null;
  walkMeters: number | null; kind: 'subway' | 'bus' | 'mixed' | 'car' | null };
type ResponseStatus = State | 'destination_unverified' | 'geocoder_unavailable' | 'geocoder_denied' | 'geocoder_rate_limited' | 'not_configured';
const holds = ['synthetic_input','origin_unverified','selection_unverified','source_restricted'];
const local = 'https://dapi.kakao.com/v2/local/search/address.json';
const odsay = 'https://api.odsay.com/v1/api/searchPubTransPathT';
const mobility = 'https://apis-navi.kakaomobility.com/v1/directions';

function record(value: unknown): value is Record<string,unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
export function commuteDestination(input: unknown): string | null {
  return record(input) && Object.keys(input).length === 1 && isPublicLabel(input.destination, 200)
    ? input.destination : null;
}

async function provider(url: URL, options: Options, maxBytes: number, init: RequestInit) {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(5000)]);
  try {
    signal.throwIfAborted();
    const res = await (options.fetch ?? fetch)(url, { ...init, signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    if (res.status !== 200 || res.redirected || !/^application\/json\b/i.test(res.headers.get('content-type') ?? '')
      || Number(res.headers.get('content-length')) > maxBytes) {
      void res.body?.cancel().catch(() => {});
      if (res.status === 429) return { error: 'rate_limited' } as const;
      if ([401,403].includes(res.status)) return { error: 'provider_denied' } as const;
      return { error: 'provider_unavailable' } as const;
    }
    return { payload: await readLimitedJson(res, signal, maxBytes) };
  } catch {
    return { error: 'provider_unavailable' } as const;
  }
}

const provinceNames: Record<string,string> = {
  서울특별시:'서울', 서울시:'서울', 부산광역시:'부산', 대구광역시:'대구', 인천광역시:'인천',
  대전광역시:'대전', 울산광역시:'울산', 광주광역시:'광주', 세종특별자치시:'세종', 경기도:'경기',
  충청북도:'충북', 충청남도:'충남', 경상북도:'경북', 경상남도:'경남', 강원특별자치도:'강원',
  전북특별자치도:'전북', 전라남도:'전남', 제주특별자치도:'제주',
};
function addressKey(value: unknown) {
  if (typeof value !== 'string') return '';
  const words = value.normalize('NFC').trim().split(/\s+/u);
  words[0] = provinceNames[words[0]!] ?? words[0]!;
  return words.join(' ').replace(/(\d)번지$/u, '$1');
}
function numberedAddress(text: string) {
  return /[가-힣0-9]+(?:로|길|리|동|가|읍|면) (?:산 ?)?\d+(?:-\d+)?$/u.test(addressKey(text));
}
function point(item: Record<string,unknown>): Point | null {
  const {x,y} = item;
  // 카카오 로컬은 WGS84 십진 문자열을 반환한다. 축을 바꾸거나 다른 좌표계를 추정하지 않는다.
  if (typeof x !== 'string' || typeof y !== 'string' || !/^\d{2,3}(?:\.\d{1,16})?$/.test(x)
    || !/^\d{2}(?:\.\d{1,16})?$/.test(y) || +x < 124 || +x > 132 || +y < 33 || +y > 39.5) return null;
  return {x,y};
}
async function locate(address: string, options: Options) {
  const url = new URL(local);
  url.search = new URLSearchParams({ query: address, analyze_type: 'exact', size: '2' }).toString();
  const result = await provider(url, options, 32 * 1024, { headers: { Authorization: 'KakaoAK ' + options.kakaoKey } });
  if (result.error) return { error: result.error };
  const data = result.payload;
  if (!record(data) || !record(data.meta) || !Array.isArray(data.documents) || !nonnegative(data.meta.total_count)
    || typeof data.meta.is_end !== 'boolean') return { error: 'provider_unavailable' as const };
  if (data.meta.total_count !== 1 || !data.meta.is_end || data.documents.length !== 1) return { point: null };
  const doc = data.documents[0];
  if (!record(doc) || !['REGION_ADDR','ROAD_ADDR'].includes(String(doc.address_type))) return { point: null };
  for (const item of [doc.road_address, doc.address, doc]) {
    if (record(item) && addressKey(item.address_name) === addressKey(address)) return { point: point(item) };
  }
  return { point: null };
}
function emptyRoute(source: Route['source'], status: RouteStatus): Route {
  return { source, status, queriedAt: null, durationSeconds: null, distanceMeters: null, walkMinutes: null, walkMeters: null, kind: null };
}

async function transitRoute(route: Route, from: Point, to: Point, options: Options): Promise<Route> {
  let key: string;
  try { key = decodeURIComponent(options.odsayKey!); } catch { return { ...route, status: 'not_configured' }; }
  const body = new URLSearchParams({ SX: from.x, SY: from.y, EX: to.x, EY: to.y, OPT: '0', output: 'json', apiKey: key });
  const queriedAt = (options.now?.() ?? new Date()).toISOString();
  const base = { ...route, queriedAt };
  const result = await provider(new URL(odsay), options, 1024 * 1024, { method: 'POST', body });
  if (result.error) return { ...base, status: result.error };
  const data = result.payload;
  if (record(data) && data.error !== undefined) {
    const item = Array.isArray(data.error) && data.error.length === 1 ? data.error[0] : data.error;
    const code = record(item) ? String(item.code) : '';
    if (record(item) && code === '500' && typeof item.message === 'string' && /auth|인증/i.test(item.message))
      return { ...base, status: 'provider_denied' };
    return { ...base, status: code === '-98' ? 'points_too_close' : code === '-99' ? 'no_route' : 'provider_unavailable' };
  }
  const response = record(data) && record(data.result) ? data.result : null;
  if (response?.searchType === 1 || response?.searchType === 2) return { ...base, status: 'connections_unverified' };
  const first = response?.searchType === 0 && Array.isArray(response.path) ? response.path[0] : null;
  const info = record(first) && record(first.info) ? first.info : null;
  if (!info || ![1,2,3].includes(first.pathType) || !nonnegative(info.totalTime) || info.totalTime < 1
    || !Number.isSafeInteger(info.totalTime * 60)) return { ...base, status: 'provider_unavailable' };
  return { ...base, status: 'available', kind: first.pathType === 1 ? 'subway' : first.pathType === 2 ? 'bus' : 'mixed',
    durationSeconds: info.totalTime * 60, walkMeters: nonnegative(info.totalWalk) ? info.totalWalk : null,
    walkMinutes: nonnegative(info.totalWalkTime) && info.totalWalkTime <= info.totalTime ? info.totalWalkTime : null };
}

async function drivingRoute(route: Route, from: Point, to: Point, options: Options): Promise<Route> {
  const url = new URL(mobility);
  url.search = new URLSearchParams({ origin: from.x + ',' + from.y, destination: to.x + ',' + to.y,
    summary: 'true', priority: 'RECOMMEND', alternatives: 'false' }).toString();
  const base = { ...route, queriedAt: (options.now?.() ?? new Date()).toISOString() };
  const result = await provider(url, options, 64 * 1024, { headers: { Authorization: 'KakaoAK ' + options.kakaoKey } });
  if (result.error) return { ...base, status: result.error };
  const data = result.payload;
  const item = record(data) && Array.isArray(data.routes) && data.routes.length === 1 ? data.routes[0] : null;
  if (item?.result_code === 1) return { ...base, status: 'no_route' };
  if (item?.result_code === 104) return { ...base, status: 'points_too_close' };
  const info = item?.summary;
  if (item?.result_code !== 0 || !record(info) || !nonnegative(info.duration) || info.duration === 0
    || !nonnegative(info.distance) || info.distance === 0) return { ...base, status: 'provider_unavailable' };
  return { ...base, status: 'available', kind: 'car', durationSeconds: info.duration, distanceMeters: info.distance };
}

export async function readCommute(context: unknown, analysisId: string, snapshotId: string, destination: string, options: Options) {
  if (!record(context) || context.analysisId !== analysisId || context.snapshotId !== snapshotId
    || typeof context.status !== 'string' || typeof context.geocode !== 'boolean'
    || typeof context.transit !== 'boolean' || typeof context.driving !== 'boolean'
    || (context.status === 'ready' ? !isPublicLabel(context.originAddress, 240)
      : !holds.includes(context.status) || context.originAddress !== null || context.geocode || context.transit || context.driving))
    throw new Error('invalid_commute_context');
  const shape = { contractVersion: 'commute/v1', analysisId, snapshotId, originAddress: context.originAddress as string | null,
    status: context.status as ResponseStatus, transit: emptyRoute('odsay_route', 'not_queried'), driving: emptyRoute('kakao_directions', 'not_queried') };
  if (shape.status !== 'ready') return shape;
  const transit = shape.transit, driving = shape.driving;
  if (!context.transit) transit.status = 'source_restricted';
  else if (!options.odsayKey?.trim()) transit.status = 'not_configured';
  if (!context.driving) driving.status = 'source_restricted';
  else if (!options.kakaoKey?.trim()) driving.status = 'not_configured';
  if (!context.geocode) return { ...shape, status: 'source_restricted' };
  if (!options.kakaoKey?.trim()) return { ...shape, status: 'not_configured' };
  if (transit.status !== 'not_queried' && driving.status !== 'not_queried') return shape;
  if (!numberedAddress(shape.originAddress!)) return { ...shape, status: 'origin_unverified' };
  if (!numberedAddress(destination)) return { ...shape, status: 'destination_unverified' };
  // 출발지가 정해져야 개인 목적지 주소를 제공자에게 전송한다.
  const geocoderError = (error: string) => error === 'rate_limited' ? 'geocoder_rate_limited'
    : error === 'provider_denied' ? 'geocoder_denied' : 'geocoder_unavailable';
  const origin = await locate(shape.originAddress!, options);
  if (origin.error) return { ...shape, status: geocoderError(origin.error) };
  if (!origin.point) return { ...shape, status: 'origin_unverified' };
  const end = await locate(destination, options);
  if (end.error) return { ...shape, status: geocoderError(end.error) };
  if (!end.point) return { ...shape, status: 'destination_unverified' };
  [shape.transit, shape.driving] = await Promise.all([
    transit.status === 'not_queried' ? transitRoute(transit, origin.point, end.point, options) : transit,
    driving.status === 'not_queried' ? drivingRoute(driving, origin.point, end.point, options) : driving,
  ]);
  return shape;
}
