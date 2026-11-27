// 공고 공급위치에서 추출하거나 사용자가 입력한 단일 출발지 주소와 목적지 주소를 구조 비교로 확인해 경로를 조회한다.
import { isPublicLabel } from './public-fields.js';
import { readLimitedJson } from './provider-json.js';

type Options = { kakaoKey?: string; odsayKey?: string; signal: AbortSignal; fetch?: typeof fetch; now?: () => Date };
type Point = { x: string; y: string };
type ContextState = 'ready' | 'synthetic_input' | 'selection_unverified' | 'source_restricted';
type RouteStatus = 'available' | 'not_queried' | 'source_restricted' | 'not_configured' | 'provider_unavailable'
  | 'provider_denied' | 'rate_limited' | 'no_route' | 'points_too_close' | 'connections_unverified';
type Route = {
  source: 'odsay_route' | 'kakao_directions';
  status: RouteStatus;
  queriedAt: string | null;
  durationSeconds: number | null;
  distanceMeters: number | null;
  walkMinutes: number | null;
  walkMeters: number | null;
  kind: 'subway' | 'bus' | 'mixed' | 'car' | null;
};
type ResponseStatus = ContextState | 'origin_unverified' | 'destination_unverified'
  | 'geocoder_unavailable' | 'geocoder_denied' | 'geocoder_rate_limited' | 'not_configured';
export type OriginBasis = 'notice_address' | 'user_input' | null;
export type OriginReason = 'ambiguous_area' | 'unnumbered' | 'multiple_points' | 'notice_address_unverified' | null;
export type CommuteOrigin = {
  noticeAddress: string | null;
  address: string | null;
  basis: OriginBasis;
  reason: OriginReason;
  suggestion: string | null;
};
export type RoadSpec = { roadName: string; mainNo: number; subNo: number };
export type ParcelSpec = { localityToken: string; isMountain: boolean; mainNo: number; subNo: number };
type AdminPrefix = {
  province: string | null;
  sgg: string | null;
  eupMyeon: string | null;
  conflictingRegion: boolean;
};
type AddressSpec = (
  | ({ kind: 'road' } & RoadSpec)
  | ({ kind: 'parcel' } & ParcelSpec)
) & {
  province: string | null;
  sgg: string | null;
  eupMyeon: string | null;
  formatted: string;
};
type CommuteContext = {
  analysisId: string;
  snapshotId: string;
  status: ContextState;
  noticeAddress: string | null;
  geocode: boolean;
  transit: boolean;
  driving: boolean;
};

const holds: ContextState[] = ['synthetic_input', 'selection_unverified', 'source_restricted'];
const local = 'https://dapi.kakao.com/v2/local/search/address.json';
const odsay = 'https://api.odsay.com/v1/api/searchPubTransPathT';
const mobility = 'https://apis-navi.kakaomobility.com/v1/directions';

// scripts/complex_coordinates.py(Q-39)와 동일한 시·도 약칭·모호 표기·도로명/지번 패턴을 유지한다.
const PROVINCE_ALIASES: Record<string, string> = {
  서울: '서울특별시', 서울시: '서울특별시',
  부산: '부산광역시', 부산시: '부산광역시',
  대구: '대구광역시', 대구시: '대구광역시',
  인천: '인천광역시', 인천시: '인천광역시',
  광주: '광주광역시', 광주시: '광주광역시',
  대전: '대전광역시', 대전시: '대전광역시',
  울산: '울산광역시', 울산시: '울산광역시',
  세종: '세종특별자치시', 세종시: '세종특별자치시',
  경기: '경기도',
  강원: '강원특별자치도', 강원도: '강원특별자치도',
  충북: '충청북도', 충남: '충청남도',
  전북: '전북특별자치도', 전라북도: '전북특별자치도',
  전남: '전라남도',
  경북: '경상북도', 경남: '경상남도',
  제주: '제주특별자치도', 제주도: '제주특별자치도',
};
const CANONICAL_PROVINCES = new Set([
  ...Object.values(PROVINCE_ALIASES),
  '전남광주통합특별시',
]);
const METROPOLITAN_SINGLE_SGG = new Set([
  '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시', '전남광주통합특별시',
]);
const NO_SGG_PROVINCES = new Set(['세종특별자치시']);

const AMBIGUOUS_ADDRESS_PATTERN = /(?:일원|일대|주변|부근|외\s*[0-9]+\s*필지|외\s*필지|등\s*[0-9]+\s*필지|번지\s*외|[0-9A-Za-z가-힣]+\s*(?:블록|블럭|BL|블록내|구역|공구)(?=[\s,()·]|$))/iu;
const ROAD_ADDRESS_PATTERN = /(?:^|[\s,])((?=[가-힣A-Za-z0-9·.]*[가-힣])[가-힣A-Za-z0-9·.]+(?:대로|로|길))\s+0*([1-9][0-9]*)(?:-0*([0-9]+))?(?=[\s,(]|$)/gu;
const PARCEL_ADDRESS_PATTERN = /(?:^|[\s,])([가-힣0-9]+(?:동|가|읍|면|리))\s+(산\s*)?0*([1-9][0-9]*)(?:-0*([0-9]+))?(?:번지)?(?=[\s,(]|$)/gu;
const ROAD_NAME_FULL = /^(?=[가-힣A-Za-z0-9·.]*[가-힣])[가-힣A-Za-z0-9·.]+(?:대로|로|길)$/u;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function normalizeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.normalize('NFC').trim().split(/\s+/u).filter(Boolean).join(' ');
}
function normalizeRoadName(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  const compact = text.replace(/\s+/gu, '');
  return ROAD_NAME_FULL.test(compact) ? compact : null;
}
function parsePositiveInt(value: unknown): number | null {
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^[0-9]{1,10}$/.test(text)) {
      const n = Number(text);
      return Number.isSafeInteger(n) && n > 0 ? n : null;
    }
  }
  return null;
}
function parseNonnegativeInt(value: unknown): number | null {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return 0;
  if (typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^[0-9]{1,10}$/.test(text)) {
      const n = Number(text);
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    }
  }
  return null;
}

export function stripParentheticalNotes(address: string): string {
  const text = normalizeText(address);
  return text.replace(/\([^()]*\)/gu, ' ').trim().split(/\s+/u).filter(Boolean).join(' ');
}

export function isAmbiguousAreaAddress(address: string): boolean {
  const text = stripParentheticalNotes(address);
  if (!text) return true;
  return AMBIGUOUS_ADDRESS_PATTERN.test(text);
}

type RoadMatch = RoadSpec & { kind: 'road'; index: number };
type ParcelMatch = ParcelSpec & { kind: 'parcel'; index: number };

function matchRoadSpecs(core: string): RoadMatch[] {
  const results: RoadMatch[] = [];
  for (const match of core.matchAll(ROAD_ADDRESS_PATTERN)) {
    const roadName = normalizeRoadName(match[1]);
    const mainNo = parsePositiveInt(match[2]);
    const subNo = parseNonnegativeInt(match[3]);
    if (roadName !== null && mainNo !== null && subNo !== null) {
      results.push({ kind: 'road', roadName, mainNo, subNo, index: match.index ?? 0 });
    }
  }
  return results;
}

function matchParcelSpecs(core: string): ParcelMatch[] {
  const results: ParcelMatch[] = [];
  for (const match of core.matchAll(PARCEL_ADDRESS_PATTERN)) {
    const localityToken = match[1];
    const isMountain = Boolean(match[2]);
    const mainNo = parsePositiveInt(match[3]);
    const subNo = parseNonnegativeInt(match[4]);
    if (localityToken && mainNo !== null && subNo !== null) {
      results.push({ kind: 'parcel', localityToken, isMountain, mainNo, subNo, index: match.index ?? 0 });
    }
  }
  return results;
}

export function extractRoadSpec(address: string): RoadSpec | null {
  if (isAmbiguousAreaAddress(address)) return null;
  const matches = matchRoadSpecs(stripParentheticalNotes(address));
  if (matches.length !== 1) return null;
  const { roadName, mainNo, subNo } = matches[0]!;
  return { roadName, mainNo, subNo };
}

export function extractParcelSpec(address: string): ParcelSpec | null {
  if (isAmbiguousAreaAddress(address)) return null;
  const matches = matchParcelSpecs(stripParentheticalNotes(address));
  if (matches.length !== 1) return null;
  const { localityToken, isMountain, mainNo, subNo } = matches[0]!;
  return { localityToken, isMountain, mainNo, subNo };
}

function isProvinceToken(token: string): boolean {
  const mapped = PROVINCE_ALIASES[token] ?? token;
  return CANONICAL_PROVINCES.has(mapped) || /^[가-힣]+(?:특별시|광역시|특별자치시|특별자치도|도)$/u.test(token);
}
function isSggToken(token: string, kind: 'gu' | 'any'): boolean {
  if (!/^[가-힣]{1,6}(?:시|군|구)$/u.test(token)) return false;
  if (/(?:신도시|지구|공구|특구|입구|출구)$/u.test(token)) return false;
  return kind === 'gu' ? token.endsWith('구') : true;
}
function isEupMyeonToken(token: string): boolean {
  return /^[가-힣0-9]+(?:읍|면)$/u.test(token);
}

function parseAdminPrefix(prefixText: string): AdminPrefix {
  const tokens = prefixText.split(/[\s,]+/u).filter(Boolean);
  let i = 0;
  let province: string | null = null;
  if (tokens.length > 0) {
    const first = tokens[0]!;
    const mapped = PROVINCE_ALIASES[first] ?? first;
    if (CANONICAL_PROVINCES.has(mapped)) {
      province = mapped;
      i = 1;
    } else if (/^[가-힣]+(?:특별시|광역시|특별자치시|특별자치도|도)$/u.test(first)) {
      province = first;
      i = 1;
    }
  }
  const sggParts: string[] = [];
  if (province !== null && NO_SGG_PROVINCES.has(province)) {
    // 세종특별자치시는 하위 시·군·구가 없다.
  } else if (province !== null && METROPOLITAN_SINGLE_SGG.has(province)) {
    if (i < tokens.length && isSggToken(tokens[i]!, 'any')) {
      sggParts.push(tokens[i++]!);
    }
  } else if (i < tokens.length && isSggToken(tokens[i]!, 'any')) {
    const first = tokens[i++]!;
    sggParts.push(first);
    if (first.endsWith('시') && i < tokens.length && isSggToken(tokens[i]!, 'gu')) {
      sggParts.push(tokens[i++]!);
    }
  }
  const sgg = province !== null && NO_SGG_PROVINCES.has(province)
    ? ''
    : (sggParts.length > 0 ? sggParts.join(' ') : null);
  const leftover = tokens.slice(i);
  let eupMyeon: string | null = null;
  if (leftover.length > 0 && isEupMyeonToken(leftover[0]!)) {
    eupMyeon = leftover.shift()!;
  } else if (leftover.length > 0 && isEupMyeonToken(leftover[leftover.length - 1]!)) {
    eupMyeon = leftover.pop()!;
  }
  const conflictingRegion = leftover.some(token => isProvinceToken(token) || isSggToken(token, 'any'));
  return { province, sgg, eupMyeon, conflictingRegion };
}

function buildAddressSpec(core: string, match: RoadMatch | ParcelMatch): AddressSpec | null {
  const prefix = parseAdminPrefix(core.slice(0, match.index));
  if (prefix.conflictingRegion) return null;
  const parts: string[] = [];
  if (prefix.province) parts.push(prefix.province);
  if (prefix.sgg) parts.push(prefix.sgg);
  if (prefix.eupMyeon && (match.kind === 'road' || match.localityToken !== prefix.eupMyeon)) {
    parts.push(prefix.eupMyeon);
  }
  const num = match.subNo > 0 ? `${match.mainNo}-${match.subNo}` : String(match.mainNo);
  if (match.kind === 'road') {
    parts.push(match.roadName, num);
    return {
      kind: 'road',
      roadName: match.roadName,
      mainNo: match.mainNo,
      subNo: match.subNo,
      province: prefix.province,
      sgg: prefix.sgg,
      eupMyeon: prefix.eupMyeon,
      formatted: parts.join(' '),
    };
  }
  parts.push(match.localityToken, match.isMountain ? `산 ${num}` : num);
  return {
    kind: 'parcel',
    localityToken: match.localityToken,
    isMountain: match.isMountain,
    mainNo: match.mainNo,
    subNo: match.subNo,
    province: prefix.province,
    sgg: prefix.sgg,
    eupMyeon: prefix.eupMyeon,
    formatted: parts.join(' '),
  };
}

function parseAddressQuery(address: string): { spec: AddressSpec | null; reason: Exclude<OriginReason, 'notice_address_unverified'> } {
  const core = stripParentheticalNotes(address);
  if (!core) return { spec: null, reason: 'unnumbered' };
  const roads = matchRoadSpecs(core);
  const parcels = matchParcelSpecs(core);
  if (AMBIGUOUS_ADDRESS_PATTERN.test(core)) return { spec: null, reason: 'ambiguous_area' };
  const total = roads.length + parcels.length;
  if (total === 0) return { spec: null, reason: 'unnumbered' };
  if (total > 1) return { spec: null, reason: 'multiple_points' };
  const single = roads[0] ?? parcels[0]!;
  const spec = buildAddressSpec(core, single);
  if (!spec) return { spec: null, reason: 'multiple_points' };
  return { spec, reason: null };
}

export function analyzeNoticeOrigin(noticeAddress: string | null): CommuteOrigin {
  if (noticeAddress === null || !normalizeText(noticeAddress)) {
    return { noticeAddress: null, address: null, basis: null, reason: 'notice_address_unverified', suggestion: null };
  }
  const raw = noticeAddress.normalize('NFC').trim();
  const core = stripParentheticalNotes(raw);
  if (!core) {
    return { noticeAddress: raw, address: null, basis: null, reason: 'unnumbered', suggestion: null };
  }
  const roads = matchRoadSpecs(core);
  const parcels = matchParcelSpecs(core);
  const total = roads.length + parcels.length;
  if (AMBIGUOUS_ADDRESS_PATTERN.test(core)) {
    let suggestion: string | null = null;
    if (total === 1) {
      const candidate = buildAddressSpec(core, roads[0] ?? parcels[0]!);
      if (candidate) suggestion = candidate.formatted;
    }
    return { noticeAddress: raw, address: null, basis: null, reason: 'ambiguous_area', suggestion };
  }
  if (total === 0) {
    return { noticeAddress: raw, address: null, basis: null, reason: 'unnumbered', suggestion: null };
  }
  if (total > 1) {
    return { noticeAddress: raw, address: null, basis: null, reason: 'multiple_points', suggestion: null };
  }
  const spec = buildAddressSpec(core, roads[0] ?? parcels[0]!);
  if (!spec) {
    return { noticeAddress: raw, address: null, basis: null, reason: 'multiple_points', suggestion: null };
  }
  return { noticeAddress: raw, address: spec.formatted, basis: 'notice_address', reason: null, suggestion: null };
}

export function commuteRequest(input: unknown): { destination: string; origin: string | null } | null {
  if (!record(input)) return null;
  const keys = Object.keys(input);
  if (keys.length === 0 || keys.length > 2 || !keys.every(k => k === 'destination' || k === 'origin')) return null;
  if (!isPublicLabel(input.destination, 200)) return null;
  if (Object.hasOwn(input, 'origin') && input.origin !== undefined) {
    if (!isPublicLabel(input.origin, 200)) return null;
    return { destination: input.destination, origin: input.origin };
  }
  return { destination: input.destination, origin: null };
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
      if ([401, 403].includes(res.status)) return { error: 'provider_denied' } as const;
      return { error: 'provider_unavailable' } as const;
    }
    return { payload: await readLimitedJson(res, signal, maxBytes) };
  } catch {
    return { error: 'provider_unavailable' } as const;
  }
}

function point(item: Record<string, unknown>): Point | null {
  const { x, y } = item;
  // 카카오 로컬은 WGS84 십진 문자열을 반환한다. 축을 바꾸거나 다른 좌표계를 추정하지 않는다.
  if (typeof x !== 'string' || typeof y !== 'string' || !/^\d{2,3}(?:\.\d{1,16})?$/.test(x)
    || !/^\d{2}(?:\.\d{1,16})?$/.test(y) || +x < 124 || +x > 132 || +y < 33 || +y > 39.5) return null;
  return { x, y };
}

function regionMatches(target: Record<string, unknown>, spec: AddressSpec): boolean {
  const rawProvince = normalizeText(target.region_1depth_name);
  if (!rawProvince) return false;
  const obsProvince = PROVINCE_ALIASES[rawProvince] ?? rawProvince;
  if (spec.province !== null && obsProvince !== spec.province) return false;
  const obsSgg = normalizeText(target.region_2depth_name);
  if (spec.province !== null && NO_SGG_PROVINCES.has(spec.province)) {
    if (obsSgg !== '') return false;
  } else if (spec.sgg !== null) {
    const exact = obsSgg === spec.sgg;
    const cityParentOfGu = !spec.sgg.includes(' ') && spec.sgg.endsWith('시') && obsSgg.startsWith(spec.sgg + ' ');
    if (!exact && !cityParentOfGu) return false;
  }
  return true;
}

async function locate(spec: AddressSpec, options: Options) {
  const url = new URL(local);
  url.search = new URLSearchParams({ query: spec.formatted, analyze_type: 'exact', size: '2' }).toString();
  const result = await provider(url, options, 32 * 1024, { headers: { Authorization: 'KakaoAK ' + options.kakaoKey } });
  if (result.error) return { error: result.error };
  const data = result.payload;
  if (!record(data) || !record(data.meta) || !Array.isArray(data.documents) || !nonnegative(data.meta.total_count)
    || typeof data.meta.is_end !== 'boolean') return { error: 'provider_unavailable' as const };
  if (data.meta.total_count !== 1 || !data.meta.is_end || data.documents.length !== 1) return { point: null };
  const doc = data.documents[0];
  if (!record(doc) || !['REGION_ADDR', 'ROAD_ADDR'].includes(String(doc.address_type))) return { point: null };

  if (spec.kind === 'road') {
    const road = record(doc.road_address) ? doc.road_address : null;
    if (!road) return { point: null };
    if (road.underground_yn === 'Y'
      || (typeof road.underground_yn === 'string' && road.underground_yn !== '' && road.underground_yn !== 'N')) {
      return { point: null };
    }
    if (!regionMatches(road, spec)) return { point: null };
    const obsRoad = normalizeRoadName(road.road_name);
    const obsMain = parsePositiveInt(road.main_building_no);
    const obsSub = parseNonnegativeInt(road.sub_building_no);
    if (obsRoad !== spec.roadName || obsMain !== spec.mainNo || obsSub !== spec.subNo) return { point: null };
    if (spec.eupMyeon !== null) {
      const obsRoad3 = normalizeText(road.region_3depth_name);
      if (obsRoad3 && obsRoad3.split(' ')[0] !== spec.eupMyeon) return { point: null };
      if (!obsRoad3 && record(doc.address)) {
        const obsAddr3 = normalizeText(doc.address.region_3depth_name);
        if (obsAddr3 && obsAddr3.split(' ')[0] !== spec.eupMyeon) return { point: null };
      }
    }
    return { point: point(road) ?? point(doc) };
  }

  const addr = record(doc.address) ? doc.address : null;
  if (!addr) return { point: null };
  if (!regionMatches(addr, spec)) return { point: null };
  const obsDong = normalizeText(addr.region_3depth_name);
  if (!obsDong) return { point: null };
  if (spec.eupMyeon !== null) {
    if (obsDong !== `${spec.eupMyeon} ${spec.localityToken}`) return { point: null };
  } else if (spec.localityToken.endsWith('리')) {
    if (obsDong !== spec.localityToken && !obsDong.endsWith(' ' + spec.localityToken)) return { point: null };
  } else if (obsDong !== spec.localityToken) {
    return { point: null };
  }
  const obsMountain = addr.mountain_yn;
  const obsMain = parsePositiveInt(addr.main_address_no);
  const obsSub = parseNonnegativeInt(addr.sub_address_no);
  if ((obsMountain !== 'Y' && obsMountain !== 'N')
    || (obsMountain === 'Y') !== spec.isMountain
    || obsMain !== spec.mainNo
    || obsSub !== spec.subNo) {
    return { point: null };
  }
  return { point: point(addr) ?? point(doc) };
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
  if (!info || ![1, 2, 3].includes(first.pathType) || !nonnegative(info.totalTime) || info.totalTime < 1
    || !Number.isSafeInteger(info.totalTime * 60)) return { ...base, status: 'provider_unavailable' };
  return {
    ...base,
    status: 'available',
    kind: first.pathType === 1 ? 'subway' : first.pathType === 2 ? 'bus' : 'mixed',
    durationSeconds: info.totalTime * 60,
    walkMeters: nonnegative(info.totalWalk) ? info.totalWalk : null,
    walkMinutes: nonnegative(info.totalWalkTime) && info.totalWalkTime <= info.totalTime ? info.totalWalkTime : null,
  };
}

async function drivingRoute(route: Route, from: Point, to: Point, options: Options): Promise<Route> {
  const url = new URL(mobility);
  url.search = new URLSearchParams({
    origin: from.x + ',' + from.y,
    destination: to.x + ',' + to.y,
    summary: 'true',
    priority: 'RECOMMEND',
    alternatives: 'false',
  }).toString();
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

function parseContext(context: unknown, analysisId: string, snapshotId: string): CommuteContext {
  if (!record(context) || context.analysisId !== analysisId || context.snapshotId !== snapshotId
    || typeof context.status !== 'string' || typeof context.geocode !== 'boolean'
    || typeof context.transit !== 'boolean' || typeof context.driving !== 'boolean') {
    throw new Error('invalid_commute_context');
  }
  if (context.status === 'ready') {
    if (context.noticeAddress !== null && !isPublicLabel(context.noticeAddress, 240)) {
      throw new Error('invalid_commute_context');
    }
    return {
      analysisId,
      snapshotId,
      status: 'ready',
      noticeAddress: context.noticeAddress as string | null,
      geocode: context.geocode,
      transit: context.transit,
      driving: context.driving,
    };
  }
  if (!holds.includes(context.status as ContextState) || context.noticeAddress !== null
    || context.geocode || context.transit || context.driving) {
    throw new Error('invalid_commute_context');
  }
  return {
    analysisId,
    snapshotId,
    status: context.status as ContextState,
    noticeAddress: null,
    geocode: false,
    transit: false,
    driving: false,
  };
}

export function readCommuteOrigin(context: unknown, analysisId: string, snapshotId: string) {
  const parsed = parseContext(context, analysisId, snapshotId);
  const origin = analyzeNoticeOrigin(parsed.noticeAddress);
  const status: ContextState = parsed.status !== 'ready'
    ? parsed.status
    : !parsed.geocode ? 'source_restricted' : 'ready';
  return {
    contractVersion: 'commute/v1' as const,
    analysisId,
    snapshotId,
    status,
    origin,
  };
}

export async function readCommute(
  context: unknown,
  analysisId: string,
  snapshotId: string,
  input: { destination: string; origin?: string | null },
  options: Options,
) {
  const parsed = parseContext(context, analysisId, snapshotId);
  const noticeOrigin = analyzeNoticeOrigin(parsed.noticeAddress);
  const base = {
    contractVersion: 'commute/v1' as const,
    analysisId,
    snapshotId,
    originAddress: null as string | null,
    origin: noticeOrigin,
    status: parsed.status as ResponseStatus,
    transit: emptyRoute('odsay_route', 'not_queried'),
    driving: emptyRoute('kakao_directions', 'not_queried'),
  };
  // 합성 입력·선택 미확인·출처 제한은 사용자 출발지로 우회하지 않는다.
  if (parsed.status !== 'ready') return base;

  const userOrigin = input.origin ?? null;
  let originSpec: AddressSpec | null = null;
  let effectiveOrigin: CommuteOrigin;
  if (userOrigin !== null) {
    const parsedUser = parseAddressQuery(userOrigin);
    if (parsedUser.spec) {
      originSpec = parsedUser.spec;
      effectiveOrigin = {
        noticeAddress: noticeOrigin.noticeAddress,
        address: parsedUser.spec.formatted,
        basis: 'user_input',
        reason: null,
        suggestion: null,
      };
    } else {
      effectiveOrigin = {
        noticeAddress: noticeOrigin.noticeAddress,
        address: null,
        basis: null,
        reason: parsedUser.reason,
        suggestion: noticeOrigin.suggestion,
      };
    }
  } else {
    effectiveOrigin = noticeOrigin;
    if (noticeOrigin.address !== null) {
      originSpec = parseAddressQuery(noticeOrigin.address).spec;
    }
  }

  const shape = {
    ...base,
    originAddress: effectiveOrigin.address,
    origin: effectiveOrigin,
  };
  const transit = shape.transit;
  const driving = shape.driving;
  if (!parsed.transit) transit.status = 'source_restricted';
  else if (!options.odsayKey?.trim()) transit.status = 'not_configured';
  if (!parsed.driving) driving.status = 'source_restricted';
  else if (!options.kakaoKey?.trim()) driving.status = 'not_configured';
  if (!parsed.geocode) return { ...shape, status: 'source_restricted' as ResponseStatus };
  if (!options.kakaoKey?.trim()) return { ...shape, status: 'not_configured' as ResponseStatus };
  if (transit.status !== 'not_queried' && driving.status !== 'not_queried') return shape;
  if (!originSpec) return { ...shape, status: 'origin_unverified' as ResponseStatus };
  const destSpec = parseAddressQuery(input.destination).spec;
  if (!destSpec) return { ...shape, status: 'destination_unverified' as ResponseStatus };

  // 출발지가 정해져야 개인 목적지 주소를 제공자에게 전송한다.
  const geocoderError = (error: string): ResponseStatus => error === 'rate_limited' ? 'geocoder_rate_limited'
    : error === 'provider_denied' ? 'geocoder_denied' : 'geocoder_unavailable';
  const originPoint = await locate(originSpec, options);
  if (originPoint.error) return { ...shape, status: geocoderError(originPoint.error) };
  if (!originPoint.point) return { ...shape, status: 'origin_unverified' as ResponseStatus };
  const destPoint = await locate(destSpec, options);
  if (destPoint.error) return { ...shape, status: geocoderError(destPoint.error) };
  if (!destPoint.point) return { ...shape, status: 'destination_unverified' as ResponseStatus };

  [shape.transit, shape.driving] = await Promise.all([
    transit.status === 'not_queried' ? transitRoute(transit, originPoint.point, destPoint.point, options) : transit,
    driving.status === 'not_queried' ? drivingRoute(driving, originPoint.point, destPoint.point, options) : driving,
  ]);
  return shape;
}
