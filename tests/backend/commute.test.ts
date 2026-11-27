// 합성 응답으로 출발지 추출·미리보기·사용자 입력·카카오 구조 비교·브라우저 ODsay 위임(Q-47)·수단별 실패·사용자 JWT 경계를 검사한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  analyzeNoticeOrigin,
  commuteRequest,
  extractParcelSpec,
  extractRoadSpec,
  isAmbiguousAreaAddress,
  readCommute,
  readCommuteOrigin,
  stripParentheticalNotes,
} from '../../src/server/commute.js';
import { createHandler } from '../../src/server/handler.js';
import { createBackend } from '../../src/server/supabase.js';

const analysisId = 'b5000000-0000-4000-8000-000000000001';
const snapshotId = 'b5000000-0000-4000-8000-000000000002';
const ready = {
  analysisId,
  snapshotId,
  status: 'ready',
  noticeAddress: '서울특별시 가람구 예시로 10 (예시동, 합성아파트)',
  transit: true,
  driving: true,
  geocode: true,
};
const destination = '서울특별시 가람구 합성길 20';
const car = { routes: [{ result_code: 0, summary: { distance: 3100, duration: 601 } }] };
const options = {
  kakaoKey: 'synthetic-kakao',
  odsayWebKey: 'synthetic-odsay-web',
  now: () => new Date('2026-10-27T08:00:00Z'),
  signal: new AbortController().signal,
};

function roadDoc(fields: {
  province?: string;
  sgg?: string;
  dong?: string;
  roadName: string;
  mainNo: string;
  subNo?: string;
  underground?: string;
  x?: string;
  y?: string;
  addressType?: string;
}) {
  const x = fields.x ?? '127.10';
  const y = fields.y ?? '37.4';
  return {
    meta: { total_count: 1, is_end: true },
    documents: [{
      address_type: fields.addressType ?? 'ROAD_ADDR',
      address_name: `${fields.province ?? '서울'} ${fields.sgg ?? '가람구'} ${fields.roadName} ${fields.mainNo}${fields.subNo ? '-' + fields.subNo : ''}`,
      x,
      y,
      road_address: {
        region_1depth_name: fields.province ?? '서울',
        region_2depth_name: fields.sgg ?? '가람구',
        region_3depth_name: fields.dong ?? '예시동',
        road_name: fields.roadName,
        underground_yn: fields.underground ?? 'N',
        main_building_no: fields.mainNo,
        sub_building_no: fields.subNo ?? '',
        x,
        y,
      },
    }],
  };
}

function parcelDoc(fields: {
  province?: string;
  sgg?: string;
  dong: string;
  mountain?: string;
  mainNo: string;
  subNo?: string;
  x?: string;
  y?: string;
  addressType?: string;
}) {
  const x = fields.x ?? '127.10';
  const y = fields.y ?? '37.4';
  return {
    meta: { total_count: 1, is_end: true },
    documents: [{
      address_type: fields.addressType ?? 'REGION_ADDR',
      address_name: `${fields.province ?? '서울'} ${fields.sgg ?? '종로구'} ${fields.dong} ${fields.mountain === 'Y' ? '산 ' : ''}${fields.mainNo}${fields.subNo ? '-' + fields.subNo : ''}`,
      x,
      y,
      address: {
        region_1depth_name: fields.province ?? '서울',
        region_2depth_name: fields.sgg ?? '종로구',
        region_3depth_name: fields.dong,
        mountain_yn: fields.mountain ?? 'N',
        main_address_no: fields.mainNo,
        sub_address_no: fields.subNo ?? '',
        x,
        y,
      },
    }],
  };
}

function located(address: string) {
  const x = address === destination ? '127.11' : '127.10';
  const roadMatch = address.match(/^(?:(서울특별시|경기도|세종특별자치시|강원특별자치도)\s+)?(?:([가-힣]+(?:시\s+[가-힣]+구|[시군구]))\s+)?([가-힣A-Za-z0-9·.]+(?:대로|로|길))\s+(\d+)(?:-(\d+))?$/u);
  if (roadMatch) {
    const provinceShort = roadMatch[1] === '서울특별시' ? '서울' : roadMatch[1] === '경기도' ? '경기' : (roadMatch[1] ?? '서울');
    return roadDoc({
      province: provinceShort,
      sgg: roadMatch[2] ?? '',
      roadName: roadMatch[3]!,
      mainNo: roadMatch[4]!,
      subNo: roadMatch[5] ?? '',
      x,
    });
  }
  const parcelMatch = address.match(/^(?:(서울특별시|경기도|강원특별자치도|세종특별자치시)\s+)?(?:([가-힣]+(?:시\s+[가-힣]+구|[시군구]))\s+)?(?:([가-힣0-9]+[읍면])\s+)?([가-힣0-9]+(?:동|가|읍|면|리))\s+(산\s*)?(\d+)(?:-(\d+))?$/u);
  if (parcelMatch) {
    const provinceShort = parcelMatch[1] === '서울특별시' ? '서울' : parcelMatch[1] === '경기도' ? '경기' : (parcelMatch[1] ?? '서울');
    const dong = parcelMatch[3] ? `${parcelMatch[3]} ${parcelMatch[4]}` : parcelMatch[4]!;
    return parcelDoc({
      province: provinceShort,
      sgg: parcelMatch[2] ?? '',
      dong,
      mountain: parcelMatch[5] ? 'Y' : 'N',
      mainNo: parcelMatch[6]!,
      subNo: parcelMatch[7] ?? '',
      x,
    });
  }
  return { meta: { total_count: 0, is_end: true }, documents: [] };
}

function upstream(change: { geocode?: (address: string) => unknown; car?: unknown } = {}) {
  const calls: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    calls.push(req);
    assert.notEqual(url.hostname, 'api.odsay.com', 'server must never call ODsay directly (Q-47)');
    const address = url.searchParams.get('query')!;
    if (url.hostname === 'dapi.kakao.com') return Response.json(change.geocode ? change.geocode(address) : located(address));
    const value = change.car ?? car;
    return value instanceof Response ? value : Response.json(value);
  };
  return { fetcher, calls };
}

test('address extraction table matches the shared synthetic Q-39 fixture across all cases', () => {
  const fixture = JSON.parse(readFileSync(new URL('../fixtures/commute-origin-cases.json', import.meta.url), 'utf8'));
  assert.equal(fixture.dataOrigin, 'synthetic');
  assert.ok(fixture.cases.length >= 15);
  for (const item of fixture.cases) {
    assert.equal(stripParentheticalNotes(item.noticeAddress), item.stripped, item.id);
    assert.equal(isAmbiguousAreaAddress(item.noticeAddress), item.ambiguous, item.id);
    assert.deepEqual(extractRoadSpec(item.noticeAddress), item.road, item.id);
    assert.deepEqual(extractParcelSpec(item.noticeAddress), item.parcel, item.id);
    assert.deepEqual(analyzeNoticeOrigin(item.noticeAddress), item.origin, item.id);
  }
  assert.deepEqual(analyzeNoticeOrigin(null), {
    noticeAddress: null,
    address: null,
    basis: null,
    reason: 'notice_address_unverified',
    suggestion: null,
  });
  assert.deepEqual(analyzeNoticeOrigin('서울특별시 광진구 성동구 가람동 10'), {
    noticeAddress: '서울특별시 광진구 성동구 가람동 10',
    address: null,
    basis: null,
    reason: 'multiple_points',
    suggestion: null,
  });
});

test('origin preview resolves notice address or suggestion without calling any external provider', () => {
  assert.deepEqual(readCommuteOrigin(ready, analysisId, snapshotId), {
    contractVersion: 'commute/v1',
    analysisId,
    snapshotId,
    status: 'ready',
    origin: {
      noticeAddress: '서울특별시 가람구 예시로 10 (예시동, 합성아파트)',
      address: '서울특별시 가람구 예시로 10',
      basis: 'notice_address',
      reason: null,
      suggestion: null,
    },
  });
  assert.deepEqual(
    readCommuteOrigin({ ...ready, noticeAddress: '서울특별시 종로구 합성동 28번지 일원' }, analysisId, snapshotId),
    {
      contractVersion: 'commute/v1',
      analysisId,
      snapshotId,
      status: 'ready',
      origin: {
        noticeAddress: '서울특별시 종로구 합성동 28번지 일원',
        address: null,
        basis: null,
        reason: 'ambiguous_area',
        suggestion: '서울특별시 종로구 합성동 28',
      },
    },
  );
  assert.deepEqual(
    readCommuteOrigin({ ...ready, noticeAddress: '인천광역시 서해구 합성역세권 공공주택지구 내 B-1BL' }, analysisId, snapshotId),
    {
      contractVersion: 'commute/v1',
      analysisId,
      snapshotId,
      status: 'ready',
      origin: {
        noticeAddress: '인천광역시 서해구 합성역세권 공공주택지구 내 B-1BL',
        address: null,
        basis: null,
        reason: 'ambiguous_area',
        suggestion: null,
      },
    },
  );
  assert.deepEqual(readCommuteOrigin({ ...ready, noticeAddress: null }, analysisId, snapshotId), {
    contractVersion: 'commute/v1',
    analysisId,
    snapshotId,
    status: 'ready',
    origin: {
      noticeAddress: null,
      address: null,
      basis: null,
      reason: 'notice_address_unverified',
      suggestion: null,
    },
  });
  for (const status of ['synthetic_input', 'selection_unverified', 'source_restricted'] as const) {
    assert.equal(
      readCommuteOrigin({ ...ready, status, noticeAddress: null, geocode: false, transit: false, driving: false }, analysisId, snapshotId).status,
      status,
    );
  }
  assert.equal(readCommuteOrigin({ ...ready, geocode: false }, analysisId, snapshotId).status, 'source_restricted');
});

test('server never calls ODsay, delegates transit via client_query + transitQuery and queries driving via KakaoMobility (Q-47)', async () => {
  const { fetcher, calls } = upstream();
  const result = await readCommute(ready, analysisId, snapshotId, { destination }, { ...options, fetch: fetcher });
  assert.equal(result.status, 'ready');
  assert.equal(result.originAddress, '서울특별시 가람구 예시로 10');
  assert.deepEqual(result.origin, {
    noticeAddress: '서울특별시 가람구 예시로 10 (예시동, 합성아파트)',
    address: '서울특별시 가람구 예시로 10',
    basis: 'notice_address',
    reason: null,
    suggestion: null,
  });
  // 카카오 로컬 2회 + 카카오모빌리티 1회 = 3회. ODsay 서버 호출은 0회.
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(r => r.url.includes('odsay.com')).length, 0);
  assert.equal(new URL(calls[0]!.url).searchParams.get('query'), '서울특별시 가람구 예시로 10');
  assert.deepEqual(result.transit, {
    source: 'odsay_route',
    status: 'client_query',
    queriedAt: null,
    durationSeconds: null,
    distanceMeters: null,
    walkMinutes: null,
    walkMeters: null,
    kind: null,
  });
  assert.deepEqual(result.transitQuery, {
    provider: 'odsay_route',
    origin: { x: '127.10', y: '37.4' },
    destination: { x: '127.11', y: '37.4' },
    apiKey: 'synthetic-odsay-web',
  });
  assert.equal(result.driving.status, 'available');
  assert.equal(result.driving.durationSeconds, 601);
  assert.equal(result.driving.distanceMeters, 3100);
  assert.equal(result.driving.queriedAt, options.now().toISOString());
  const drive = calls.find(r => r.url.startsWith('https://apis-navi.'))!;
  assert.equal(new URL(drive.url).searchParams.get('summary'), 'true');
  assert.equal(drive.headers.get('authorization'), 'KakaoAK synthetic-kakao');
  assert.ok(calls.every(r => r.redirect === 'error' && r.cache === 'no-store'));
  assert.ok(!JSON.stringify(result).includes(destination) && !JSON.stringify(result).includes('synthetic-kakao'));

  // URL 인코딩된 ODsay 웹 키는 중복 인코딩되지 않도록 원문 키로 정규화해 전달한다.
  const encodedKeyResult = await readCommute(
    ready,
    analysisId,
    snapshotId,
    { destination },
    { ...options, odsayWebKey: 'abc%2Bdef%2Fghi%3D', fetch: fetcher },
  );
  assert.equal(encodedKeyResult.transit.status, 'client_query');
  assert.equal(encodedKeyResult.transitQuery?.apiKey, 'abc+def/ghi=');

  // 모호한 공고 공급위치나 주소 미보고 공고에서도 사용자가 입력한 단지 주소로 조회할 수 있다.
  const ambiguousCtx = { ...ready, noticeAddress: '서울특별시 종로구 합성동 28번지 일원' };
  const autoBlocked = await readCommute(ambiguousCtx, analysisId, snapshotId, { destination }, { ...options, fetch: fetcher });
  assert.equal(autoBlocked.status, 'origin_unverified');
  assert.equal(autoBlocked.transitQuery, null);
  assert.equal(autoBlocked.origin.reason, 'ambiguous_area');
  assert.equal(autoBlocked.origin.suggestion, '서울특별시 종로구 합성동 28');

  const userOriginResult = await readCommute(
    ambiguousCtx,
    analysisId,
    snapshotId,
    { destination, origin: '서울시 종로구 합성동 28번지' },
    { ...options, fetch: fetcher },
  );
  assert.equal(userOriginResult.status, 'ready');
  assert.equal(userOriginResult.originAddress, '서울특별시 종로구 합성동 28');
  assert.equal(userOriginResult.transit.status, 'client_query');
  assert.deepEqual(userOriginResult.transitQuery?.origin, { x: '127.10', y: '37.4' });
  assert.deepEqual(userOriginResult.origin, {
    noticeAddress: '서울특별시 종로구 합성동 28번지 일원',
    address: '서울특별시 종로구 합성동 28',
    basis: 'user_input',
    reason: null,
    suggestion: null,
  });

  const missingNoticeCtx = { ...ready, noticeAddress: null };
  const userForMissing = await readCommute(
    missingNoticeCtx,
    analysisId,
    snapshotId,
    { destination, origin: '서울특별시 종로구 합성동 28' },
    { ...options, fetch: fetcher },
  );
  assert.equal(userForMissing.status, 'ready');
  assert.equal(userForMissing.origin.basis, 'user_input');
  assert.equal(userForMissing.origin.noticeAddress, null);
  assert.equal(userForMissing.transit.status, 'client_query');
});

test('transitQuery presence respects odsay_route permission, ODSAY_WEB_API_KEY and stays independent from driving failures', async () => {
  // 1) 자동차 오류여도 대중교통 권한·웹 키가 있으면 client_query + transitQuery를 그대로 반환한다.
  for (const [payload, status] of [
    [{ routes: [{ result_code: 104 }] }, 'points_too_close'],
    [{ routes: [{ result_code: 1 }] }, 'no_route'],
    [{ routes: [] }, 'provider_unavailable'],
    [new Response(null, { status: 403 }), 'provider_denied'],
    [new Response(null, { status: 429 }), 'rate_limited'],
  ] as const) {
    const { fetcher, calls } = upstream({ car: payload });
    const r = await readCommute(ready, analysisId, snapshotId, { destination }, { ...options, fetch: fetcher });
    assert.equal(r.driving.status, status);
    assert.equal(r.driving.durationSeconds, null);
    assert.equal(r.transit.status, 'client_query');
    assert.equal(r.transitQuery?.provider, 'odsay_route');
    assert.equal(calls.length, 3);
  }

  // 2) 자동차 권한만 꺼져도 대중교통 좌표 확인과 client_query는 동작하며 카카오모빌리티는 호출하지 않는다.
  {
    const { fetcher, calls } = upstream();
    const r = await readCommute({ ...ready, driving: false }, analysisId, snapshotId, { destination }, { ...options, fetch: fetcher });
    assert.equal(r.status, 'ready');
    assert.equal(r.driving.status, 'source_restricted');
    assert.equal(r.transit.status, 'client_query');
    assert.deepEqual(r.transitQuery, {
      provider: 'odsay_route',
      origin: { x: '127.10', y: '37.4' },
      destination: { x: '127.11', y: '37.4' },
      apiKey: 'synthetic-odsay-web',
    });
    assert.equal(calls.length, 2);
  }

  // 3) ODSAY_WEB_API_KEY가 없거나 잘못된 인코딩이면 not_configured + transitQuery: null, 자동차는 정상 조회.
  for (const badKey of [undefined, '', '   ', '%E0%A4%A']) {
    const { fetcher, calls } = upstream();
    const r = await readCommute(ready, analysisId, snapshotId, { destination }, { ...options, odsayWebKey: badKey, fetch: fetcher });
    assert.equal(r.status, 'ready');
    assert.equal(r.transit.status, 'not_configured');
    assert.equal(r.transitQuery, null);
    assert.equal(r.driving.status, 'available');
    assert.equal(calls.length, 3);
  }

  // 4) odsay_route 표시 권한이 없으면 source_restricted + transitQuery: null, 자동차는 정상 조회.
  {
    const { fetcher, calls } = upstream();
    const r = await readCommute({ ...ready, transit: false }, analysisId, snapshotId, { destination }, { ...options, fetch: fetcher });
    assert.equal(r.status, 'ready');
    assert.equal(r.transit.status, 'source_restricted');
    assert.equal(r.transitQuery, null);
    assert.equal(r.driving.status, 'available');
    assert.equal(calls.length, 3);
  }
});

test('holds, denied sources, unnumbered user origin, missing keys and aborted requests stop without bypassing or leaking transitQuery', async () => {
  const { fetcher, calls } = upstream();
  for (const [ctx, input] of [
    [{ ...ready, status: 'synthetic_input', noticeAddress: null, transit: false, driving: false, geocode: false }, { destination, origin: '서울특별시 가람구 예시로 10' }],
    [{ ...ready, status: 'selection_unverified', noticeAddress: null, transit: false, driving: false, geocode: false }, { destination, origin: '서울특별시 가람구 예시로 10' }],
    [{ ...ready, status: 'source_restricted', noticeAddress: null, transit: false, driving: false, geocode: false }, { destination, origin: '서울특별시 가람구 예시로 10' }],
    [{ ...ready, geocode: false }, { destination, origin: '서울특별시 가람구 예시로 10' }],
    [{ ...ready, transit: false, driving: false }, { destination }],
    [{ ...ready, noticeAddress: '서울특별시 가람구 일원' }, { destination }],
    [ready, { destination, origin: '서울특별시 가람구 일원' }],
    [ready, { destination, origin: '서울특별시 가람구 합성동' }],
    [ready, { destination, origin: '서울특별시 가람구 합성동 10, 가람동 20' }],
  ] as const) {
    const r = await readCommute(ctx, analysisId, snapshotId, input, { ...options, fetch: fetcher });
    if (ctx.status !== 'ready') assert.equal(r.status, ctx.status);
    assert.equal(r.transitQuery, null);
    assert.equal(calls.length, 0);
  }
  await assert.rejects(readCommute({ ...ready, analysisId: snapshotId }, analysisId, snapshotId, { destination }, { ...options, fetch: fetcher }));
  const missing = await readCommute(ready, analysisId, snapshotId, { destination }, { ...options, kakaoKey: undefined, fetch: fetcher });
  assert.equal(missing.status, 'not_configured');
  assert.equal(missing.transitQuery, null);
  assert.equal(calls.length, 0);
  const aborted = new AbortController();
  aborted.abort();
  const abortedResult = await readCommute(ready, analysisId, snapshotId, { destination }, { ...options, signal: aborted.signal, fetch: fetcher });
  assert.equal(abortedResult.transitQuery, null);
  assert.equal(calls.length, 0);
});

test('structural Kakao verification matches road, parcel, mountain and province aliases and rejects mismatches on origin and destination', async () => {
  for (const invalid of [
    { meta: { total_count: 2, is_end: false }, documents: located(destination).documents },
    roadDoc({ roadName: '예시로', mainNo: '11' }),
    roadDoc({ roadName: '예시로', mainNo: '10', subNo: '1' }),
    roadDoc({ roadName: '예시로', mainNo: '10', underground: 'Y' }),
    roadDoc({ roadName: '다른로', mainNo: '10' }),
    roadDoc({ sgg: '다른구', roadName: '예시로', mainNo: '10' }),
    roadDoc({ province: '경기', roadName: '예시로', mainNo: '10' }),
    roadDoc({ roadName: '예시로', mainNo: '10', addressType: 'REGION' }),
    roadDoc({ roadName: '예시로', mainNo: '10', x: '37.5', y: '127.2' }),
    { meta: { total_count: 1, is_end: true }, documents: [{ address_type: 'ROAD_ADDR', x: '127.10', y: '37.4' }] },
  ]) {
    const { fetcher, calls } = upstream({ geocode: () => invalid });
    const res = await readCommute(ready, analysisId, snapshotId, { destination }, { ...options, fetch: fetcher });
    assert.equal(res.status, 'origin_unverified');
    assert.equal(res.transitQuery, null);
    assert.equal(calls.length, 1);
  }

  const mountainCtx = { ...ready, noticeAddress: '강원도 고성군 가람읍 가람리 산999-3' };
  const mountainOk = await readCommute(mountainCtx, analysisId, snapshotId, { destination: '서울특별시 종로구 합성동 28번지' }, {
    ...options,
    fetch: upstream({
      geocode: query => query.includes('가람리')
        ? parcelDoc({ province: '강원', sgg: '고성군', dong: '가람읍 가람리', mountain: 'Y', mainNo: '999', subNo: '3', x: '128.46', y: '38.38' })
        : parcelDoc({ province: '서울', sgg: '종로구', dong: '합성동', mountain: 'N', mainNo: '28', x: '126.96', y: '37.57' }),
    }).fetcher,
  });
  assert.equal(mountainOk.status, 'ready');
  assert.equal(mountainOk.originAddress, '강원특별자치도 고성군 가람읍 가람리 산 999-3');
  assert.deepEqual(mountainOk.transitQuery, {
    provider: 'odsay_route',
    origin: { x: '128.46', y: '38.38' },
    destination: { x: '126.96', y: '37.57' },
    apiKey: 'synthetic-odsay-web',
  });

  for (const badParcel of [
    parcelDoc({ province: '서울', sgg: '종로구', dong: '다른동', mountain: 'N', mainNo: '28' }),
    parcelDoc({ province: '서울', sgg: '종로구', dong: '합성동', mountain: 'Y', mainNo: '28' }),
    parcelDoc({ province: '서울', sgg: '종로구', dong: '합성동', mountain: 'N', mainNo: '29' }),
    parcelDoc({ province: '서울', sgg: '종로구', dong: '합성동', mountain: 'N', mainNo: '28', subNo: '1' }),
    parcelDoc({ province: '서울', sgg: '중구', dong: '합성동', mountain: 'N', mainNo: '28' }),
  ]) {
    const { fetcher, calls } = upstream({ geocode: () => badParcel });
    const r = await readCommute(
      { ...ready, noticeAddress: '서울특별시 종로구 합성동 28번지' },
      analysisId,
      snapshotId,
      { destination },
      { ...options, fetch: fetcher },
    );
    assert.equal(r.status, 'origin_unverified');
    assert.equal(r.transitQuery, null);
    assert.equal(calls.length, 1);
  }

  {
    const { fetcher, calls } = upstream({
      geocode: query => query === destination
        ? roadDoc({ sgg: '가람구', roadName: '합성길', mainNo: '21', x: '127.11' })
        : located(query),
    });
    const r = await readCommute(ready, analysisId, snapshotId, { destination }, { ...options, fetch: fetcher });
    assert.equal(r.status, 'destination_unverified');
    assert.equal(r.transitQuery, null);
    assert.equal(calls.length, 2);
  }
  {
    const { fetcher, calls } = upstream({
      geocode: query => query.includes('합성동')
        ? parcelDoc({ province: '서울', sgg: '종로구', dong: '다른동', mainNo: '28', x: '126.96' })
        : located(query),
    });
    const r = await readCommute(ready, analysisId, snapshotId, { destination: '서울특별시 종로구 합성동 28' }, { ...options, fetch: fetcher });
    assert.equal(r.status, 'destination_unverified');
    assert.equal(r.transitQuery, null);
    assert.equal(calls.length, 2);
  }
  {
    const { fetcher } = upstream({
      geocode: query => query.includes('오산동')
        ? parcelDoc({ province: '경기', sgg: '화성시 동탄구', dong: '오산동', mainNo: '10', x: '127.10' })
        : located(query),
    });
    assert.equal(
      (await readCommute({ ...ready, noticeAddress: '경기도 화성시 오산동 10' }, analysisId, snapshotId, { destination }, { ...options, fetch: fetcher })).status,
      'ready',
    );
    assert.equal(
      (await readCommute({ ...ready, noticeAddress: '경기도 화성시 만세구 오산동 10' }, analysisId, snapshotId, { destination }, { ...options, fetch: fetcher })).status,
      'origin_unverified',
    );
  }
});

test('GET preview uses read_analysis_commute_origin without providers, POST uses ODSAY_WEB_API_KEY only and enforces auth and validation', async t => {
  const path = `https://app.invalid/api/v1/analyses/${analysisId}/snapshots/${snapshotId}/commute`;
  const headers = { Authorization: 'Bearer SYNTHETIC_USER', 'Content-Type': 'application/json' };
  let rpc = Response.json(ready);
  const rpcCalls: Array<{ path: string; body: unknown }> = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    assert.equal(req.headers.get('authorization'), headers.Authorization);
    if (req.url.endsWith('/auth/v1/user')) return Response.json({ id: analysisId, is_anonymous: false });
    const pathname = new URL(req.url).pathname;
    rpcCalls.push({ path: pathname, body: await req.json() });
    return rpc.clone();
  });
  const { fetcher, calls } = upstream();
  const baseEnv = {
    APP_ENV: 'development',
    SUPABASE_URL: 'https://db.invalid',
    SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_SYNTHETIC',
    KAKAO_REST_API_KEY: options.kakaoKey,
  };
  const handler = createHandler({
    env: { ...baseEnv, ODSAY_WEB_API_KEY: options.odsayWebKey },
    createBackend,
    commuteFetch: fetcher,
    log() {},
  });
  const post = (body: unknown, url = path) => new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });

  assert.equal((await handler(new Request(path, { method: 'GET' }))).status, 401);
  assert.equal((await handler(new Request(path, { method: 'POST' }))).status, 401);
  const badMethod = await handler(new Request(path, { method: 'DELETE', headers }));
  assert.equal(badMethod.status, 405);
  assert.equal(badMethod.headers.get('allow'), 'GET, POST, OPTIONS');

  for (const body of [
    {},
    { destination: ' ' },
    { destination: 'https://foo.test' },
    { destination, origin: '' },
    { destination, origin: ' ' },
    { destination, origin: null },
    { destination, origin: 123 },
    { destination, origin: 'https://evil.test' },
    { destination, origin: '가'.repeat(201) },
    { destination, origin: '서울특별시 가람구 예시로 10', extra: true },
  ]) {
    assert.equal(commuteRequest(body), null);
    assert.equal((await handler(post(body))).status, 400);
  }
  assert.equal((await handler(post({ destination }, path + '?address=test'))).status, 400);
  assert.equal((await handler(new Request(path + '?address=test', { headers }))).status, 400);
  assert.equal(rpcCalls.length, 0);

  // GET 미리보기
  rpc = Response.json({ ...ready, noticeAddress: '서울특별시 종로구 합성동 28번지 일원' });
  const previewRes = await handler(new Request(path, { method: 'GET', headers: { Authorization: headers.Authorization } }));
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await previewRes.json(), {
    contractVersion: 'commute/v1',
    analysisId,
    snapshotId,
    status: 'ready',
    origin: {
      noticeAddress: '서울특별시 종로구 합성동 28번지 일원',
      address: null,
      basis: null,
      reason: 'ambiguous_area',
      suggestion: '서울특별시 종로구 합성동 28',
    },
  });
  assert.equal(calls.length, 0);
  assert.equal(rpcCalls.length, 1);
  assert.equal(rpcCalls[0]!.path, '/rest/v1/rpc/read_analysis_commute_origin');

  // 타인 스냅샷 404
  rpc = Response.json({ code: 'PT404' }, { status: 404 });
  assert.equal((await handler(new Request(path, { method: 'GET', headers: { Authorization: headers.Authorization } }))).status, 404);
  assert.equal((await handler(post({ destination }))).status, 404);
  assert.equal(calls.length, 0);

  // 한도 초과 429 + Retry-After
  rpc = Response.json({ code: 'PT429' }, { status: 429 });
  const limited = await handler(post({ destination }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');

  // 정상 POST (사용자 입력 출발지 + client_query + transitQuery)
  rpc = Response.json({ ...ready, noticeAddress: '서울특별시 종로구 합성동 28번지 일원' });
  const response = await handler(post({ destination, origin: '서울특별시 종로구 합성동 28' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const payload = await response.json();
  assert.equal(payload.driving.status, 'available');
  assert.equal(payload.transit.status, 'client_query');
  assert.equal(payload.transitQuery.provider, 'odsay_route');
  assert.equal(payload.transitQuery.apiKey, 'synthetic-odsay-web');
  assert.equal(payload.originAddress, '서울특별시 종로구 합성동 28');
  assert.equal(payload.origin.basis, 'user_input');
  assert.equal(rpcCalls.at(-1)!.path, '/rest/v1/rpc/prepare_analysis_commute');

  // 기존 서버 키(ODSAY_API_KEY)만 있고 ODSAY_WEB_API_KEY가 없으면 transitQuery를 내리지 않는다.
  const legacyOnlyHandler = createHandler({
    env: { ...baseEnv, ODSAY_API_KEY: 'synthetic-legacy-server-key' },
    createBackend,
    commuteFetch: fetcher,
    log() {},
  });
  const legacyRes = await legacyOnlyHandler(post({ destination, origin: '서울특별시 종로구 합성동 28' }));
  assert.equal(legacyRes.status, 200);
  const legacyPayload = await legacyRes.json();
  assert.equal(legacyPayload.transit.status, 'not_configured');
  assert.equal(legacyPayload.transitQuery, null);
  assert.equal(legacyPayload.driving.status, 'available');
});
