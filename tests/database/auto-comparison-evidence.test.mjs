// 합성 과천 갈현동 84D 픽스처와 PGlite로 자동 비교 근거(작업 E)의 DB 권한·캐시·원자 저장·재계산·삭제 연쇄를 검사한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const regionCode = '91290';
const identity = { houseManageNo: '9129000001', noticeNo: '9129000001', edition: '2026-09-25' };
const modelNo = '01';
const houseType = '084.7450D';
const basisDate = '2026-10-20';
const baseSources = [
  'applyhome_apt', 'applyhome_apt_model',
  'applyhome_remainder', 'applyhome_remainder_model',
  'mois_legal_region_codes', 'apt_trade', 'apt_rights', 'applyhome_notice_pdf',
];

const forbidden = { code: '42501' };
const missing = { code: 'PT404' };
const staleLease = { code: 'PT409', message: 'analysis_run_stale_lease' };
const invalidComparison = { code: '22023', message: 'invalid_notice_comparison_result' };
const json = value => JSON.stringify(value);

let db;

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', anonymous = false, mode = '') {
  await db.exec('reset role');
  await db.query(
    `select set_config('request.jwt.claim.sub', $1, false),
            set_config('request.jwt.claims', $2, false),
            set_config('storage.operation', $3, false)`,
    [userId, JSON.stringify({ sub: userId, is_anonymous: anonymous }), mode],
  );
  await db.exec(`set role ${role}`);
}

async function rpc(name, ...params) {
  const args = params.map((_, idx) => `$${idx + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as value`, params)).value;
}

async function seedSources({ kakaoStorage = 'unknown', kakaoReuse = 'unknown', kakaoDisplay = 'allowed' } = {}) {
  await db.exec('reset role');
  for (const id of baseSources) {
    await db.query(
      `insert into public.source_registry(id, display_name, storage_permission, reuse_permission, display_permission, export_permission)
       values ($1, $2, 'allowed', 'allowed', 'allowed', 'allowed')
       on conflict (id) do update set
         storage_permission = 'allowed', reuse_permission = 'allowed',
         display_permission = 'allowed', export_permission = 'allowed', retention_days = null`,
      [id, `합성 ${id}`],
    );
  }
  await db.query(
    `insert into public.source_registry(id, display_name, storage_permission, reuse_permission, display_permission, export_permission)
     values ('kakao_address', '합성 카카오 로컬 주소', $1, $2, $3, 'unknown')
     on conflict (id) do update set
       storage_permission = $1, reuse_permission = $2, display_permission = $3, retention_days = null`,
    [kakaoStorage, kakaoReuse, kakaoDisplay],
  );
}

async function createOwner() {
  const userId = randomUUID();
  await db.exec('reset role');
  await db.query('insert into auth.users(id, confirmed_at) values ($1, now())', [userId]);
  await as('authenticated', userId);
  const chat = await one('insert into public.chats(user_id) values ($1) returning id', [userId]);
  const analysis = await one(
    `insert into public.analyses(user_id, chat_id, conditions_snapshot) values ($1, $2, '{}'::jsonb) returning id`,
    [userId, chat.id],
  );
  return { userId, chatId: chat.id, analysisId: analysis.id };
}

function buildAutoEvidenceArtifacts({ kakaoStorage = false, uploadDocId = null, customPeriod = null } = {}) {
  const python = `
import json, sys
from datetime import datetime, timezone
from pathlib import Path
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot
from complex_evidence import LegalRegionCatalog, build_comparison_evidence
from replay_ingestion import ingest
from store_ingestion import snapshot_input
from test_auto_evidence import make_synthetic_harness

live_now = lambda: datetime.now(timezone.utc)
kakao_storage, upload_doc_id, custom_period = json.loads(sys.stdin.read())
fixture = json.loads(Path('tests/fixtures/auto-evidence-gwacheon-synthetic.json').read_text(encoding='utf-8'))
catalog = LegalRegionCatalog.from_mois_tsv_text(fixture['regionTsv'])
api_fetch, kakao_fetch, default_review, _, _ = make_synthetic_harness(fixture)

request = dict(fixture['request'])
request.pop('start', None)
request.pop('end', None)
if custom_period:
    request['start'] = custom_period['start']
    request['end'] = custom_period['end']

def review_fn(target, current):
    if upload_doc_id is None:
        return default_review(target, current)
    spec = fixture['pdfReviewEvidence']
    doc_ver = 'b' * 64
    doc_meta = {
        'id': 'upload:' + upload_doc_id, 'version': doc_ver, 'source': 'upload', 'originCheck': 'confirmed',
        'status': 'accepted', 'houseManageNo': target['houseManageNo'], 'noticeNo': target['noticeNo'],
        'edition': target['edition'], 'role': 'original',
    }
    return {
        'documentVersions': [doc_meta],
        'issues': [],
        'evidence': [
            {'document': doc_meta, 'modelNo': spec['modelNo'],
             'houseType': spec['houseType'], 'item': 'supply_area', 'basis': 'supply',
             'unit': 'm2', 'm2': spec['supplyAreaM2'], 'check': 'confirmed', 'page': 4},
            {'document': doc_meta, 'modelNo': spec['modelNo'],
             'houseType': spec['houseType'], 'room': spec['room'], 'item': 'sale_price',
             'unit': 'won', 'won': spec['salePriceWon'], 'check': 'confirmed', 'page': 4},
            {'document': doc_meta, 'modelNo': spec['modelNo'],
             'houseType': spec['houseType'], 'room': spec['room'], 'item': 'required_options',
             'unit': 'won', 'won': spec['requiredOptionsWon'], 'check': 'confirmed', 'page': 5},
        ],
    }

capture = ingest(request, api_fetch, data_origin='collected', review_documents=review_fn)
built = build_comparison_evidence(
    capture, region_catalog=catalog, api_fetch=api_fetch, kakao_fetch=kakao_fetch,
    model_no='01',
    permissions={'applyhomeApt': True, 'applyhomeRemainder': True, 'moisRegions': True,
                 'kakaoRuntime': True, 'kakaoStorage': bool(kakao_storage)},
    now=live_now,
)
comparison = compare_snapshot(capture, {'modelNo': '01', 'room': '101동 101호'}, built['runtimeEvidence'])
region_record = catalog.to_cache_record('91290', live_now().isoformat())
print(json.dumps({
    'request': snapshot_input(request),
    'result': capture,
    'comparison': comparison,
    'persistedEvidence': built['persistedEvidence'],
    'persistedSources': built['persistedSourceIds'],
    'metadata': built['metadata'],
    'newCacheEntries': built['newCacheEntries'],
    'regionCacheRecord': region_record,
    'schedules': [],
}, ensure_ascii=False))
`;
  return JSON.parse(
    execFileSync('python3', ['-B', '-c', python], {
      cwd: root,
      encoding: 'utf8',
      input: JSON.stringify([kakaoStorage, uploadDocId, customPeriod]),
    }),
  );
}

async function publishAndClaimNoticeRun(owner) {
  const now = new Date();
  const todayKst = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(now);
  const index = {
    contractVersion: 'notice-search-index/v1',
    dataOrigin: 'collected',
    observedAt: now.toISOString(),
    publicationWindow: { start: identity.edition, end: todayKst },
    regionCodes: [regionCode],
    coverage: {
      status: 'complete',
      sources: [
        { source: 'applyhome_apt', status: 'empty' },
        { source: 'applyhome_remainder', status: 'complete' },
      ],
    },
    notices: [{
      ...identity,
      title: '합성과천 갈현타운 대상단지',
      kind: 'resupply',
      regionCode,
      moveIn: null,
      application: { start: identity.edition, end: identity.edition },
      inventoryComplete: false,
      models: [{ modelNo, houseType, supplyAreaM2: null, areaEvidence: [], rooms: [] }],
      sourceIds: ['applyhome_remainder', 'applyhome_remainder_model'],
      reasonCodes: [],
    }],
  };
  await as('service_role');
  await rpc('publish_notice_directory', json(index), json({ [regionCode]: '경기도 합성과천시' }));

  const noticeInput = { kind: 'notice', noticeSource: 'applyhome_remainder', ...identity, modelNo };
  await as('authenticated', owner.userId);
  const run = await rpc('enqueue_analysis_run', owner.analysisId, randomUUID(), json(noticeInput));

  await db.exec('reset role');
  await db.query(
    `update private.analysis_runs
        set basis_date = $2::date,
            notice_request = jsonb_set(notice_request, '{asOf}', to_jsonb($2::text))
      where id = $1`,
    [run.runId, basisDate],
  );
  await as('service_role');
  const job = await rpc('claim_analysis_run', 300, run.runId);
  return { run, job };
}

before(async () => {
  db = await createBe03Db();
  await db.exec(`
    alter table auth.users
      add column if not exists confirmed_at timestamptz,
      add column if not exists is_anonymous boolean not null default false,
      add column if not exists deleted_at timestamptz,
      add column if not exists banned_until timestamptz;
  `);
});

beforeEach(async () => {
  await db.exec('reset role');
  await db.exec(`truncate private.legal_region_locality_cache, private.complex_evidence_cache,
    private.analysis_funding_schedule_snapshots, private.comparison_results, private.comparison_evidence,
    private.analysis_runs, public.analysis_input_snapshots, public.analysis_uploads,
    public.analyses, public.chats, auth.users cascade`);
  await seedSources();
});

after(async () => {
  if (db) await db.close();
});

test('shared evidence cache tables enforce RLS, zero user identifiers, and narrow service_role RPC grants', async () => {
  await db.exec('reset role');
  for (const tbl of ['legal_region_locality_cache', 'complex_evidence_cache']) {
    const rls = await one(
      `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'private' and c.relname = $1`,
      [tbl],
    );
    assert.equal(rls.relrowsecurity, true, `${tbl} must have RLS enabled`);

    const cols = (await db.query(
      `select column_name from information_schema.columns
       where table_schema = 'private' and table_name = $1`,
      [tbl],
    )).rows.map(r => r.column_name);
    assert.ok(!cols.includes('user_id') && !cols.includes('analysis_id'),
      `${tbl} must not store user/analysis identifiers`);
  }

  const owner = await createOwner();
  const { job } = await publishAndClaimNoticeRun(owner);

  for (const role of ['anon', 'authenticated']) {
    await as(role, role === 'authenticated' ? owner.userId : '');
    await assert.rejects(db.query('select * from private.legal_region_locality_cache'), forbidden);
    await assert.rejects(db.query('select * from private.complex_evidence_cache'), forbidden);
    await assert.rejects(
      rpc('read_auto_evidence_permissions', job.runId, job.generation, job.leaseToken),
      forbidden,
    );
    await assert.rejects(
      rpc('read_auto_evidence_cache', job.runId, job.generation, job.leaseToken, regionCode, []),
      forbidden,
    );
    await assert.rejects(
      rpc('upsert_auto_evidence_cache', job.runId, job.generation, job.leaseToken, null, '[]'),
      forbidden,
    );
    await assert.rejects(
      rpc('finish_notice_with_evidence', job.runId, job.generation, job.leaseToken, '{}', '{}', '{}', '{}', [], null, null),
      forbidden,
    );
  }
});

test('read_auto_evidence_permissions and cache RPCs honor source_registry without mutating permissions', async () => {
  const owner = await createOwner();
  const { job } = await publishAndClaimNoticeRun(owner);
  const artifacts = buildAutoEvidenceArtifacts({ kakaoStorage: true });

  await as('service_role');
  const perms = await rpc('read_auto_evidence_permissions', job.runId, job.generation, job.leaseToken);
  assert.deepEqual(perms, {
    applyhomeApt: true,
    applyhomeRemainder: true,
    moisRegions: true,
    kakaoRuntime: true,
    kakaoStorage: false,
  });

  // source_registry의 kakao_address 권한은 그대로 유지되어야 한다.
  await db.exec('reset role');
  const regRow = await one(
    "select storage_permission, reuse_permission, display_permission from public.source_registry where id = 'kakao_address'",
  );
  assert.deepEqual(regRow, {
    storage_permission: 'unknown',
    reuse_permission: 'unknown',
    display_permission: 'allowed',
  });

  // kakaoStorage=false 상태에서 kakao_road_coordinate 캐시 저장 시도는 42501로 차단된다.
  await as('service_role');
  const kakaoOnly = artifacts.newCacheEntries.filter(e => e.cacheKind === 'kakao_road_coordinate');
  assert.ok(kakaoOnly.length > 0);
  await assert.rejects(
    rpc('upsert_auto_evidence_cache', job.runId, job.generation, job.leaseToken, null, json(kakaoOnly)),
    forbidden,
  );

  // 청약홈 구조화 캐시와 행안부 법정동 캐시는 저장·조회된다.
  const applyhomeOnly = artifacts.newCacheEntries.filter(e => e.cacheKind === 'applyhome_supply_area');
  const saved = await rpc(
    'upsert_auto_evidence_cache',
    job.runId, job.generation, job.leaseToken,
    json(artifacts.regionCacheRecord),
    json(applyhomeOnly),
  );
  assert.deepEqual(saved, { regionStored: true, entriesStored: applyhomeOnly.length });

  const keys = applyhomeOnly.map(e => e.complexKey);
  const fetched = await rpc('read_auto_evidence_cache', job.runId, job.generation, job.leaseToken, regionCode, keys);
  assert.equal(fetched.region.requestRegionCode, regionCode);
  assert.equal(Object.keys(fetched.applyhome).length, applyhomeOnly.length);
  assert.deepEqual(fetched.kakao, {});

  // raw payload 키가 포함된 캐시 항목과 90일 초과 TTL은 거부된다.
  await assert.rejects(
    rpc('upsert_auto_evidence_cache', job.runId, job.generation, job.leaseToken, null, json([{
      ...applyhomeOnly[0],
      entryData: { body: 'raw not allowed' },
    }])),
    { code: '22023' },
  );
  await assert.rejects(
    rpc('upsert_auto_evidence_cache', job.runId, job.generation, job.leaseToken, null, json([{
      ...applyhomeOnly[0],
      expiresAt: '2027-12-31T00:00:00+00:00',
    }])),
    { code: '22023' },
  );

  // 기한 만료 또는 출처 권한 회수 시 캐시 조회에서 제외된다.
  await db.exec('reset role');
  await db.query(
    `update private.complex_evidence_cache
        set observed_at = now() - interval '8 days', expires_at = now() - interval '1 minute'
      where complex_key = $1`,
    [keys[0]],
  );
  await as('service_role');
  const afterExpire = await rpc('read_auto_evidence_cache', job.runId, job.generation, job.leaseToken, regionCode, keys);
  assert.equal(afterExpire.applyhome[keys[0]], undefined);
  assert.ok(afterExpire.applyhome[keys[1]]);

  await db.exec('reset role');
  await db.query("update public.source_registry set reuse_permission = 'denied' where id = 'applyhome_apt_model'");
  await as('service_role');
  const afterRevoke = await rpc('read_auto_evidence_cache', job.runId, job.generation, job.leaseToken, regionCode, keys);
  assert.deepEqual(afterRevoke.applyhome, {});
});

test('finish_notice_with_evidence atomically stores evidence, unlocks condition recalculation without re-querying, and enforces ownership/rights', async () => {
  const owner = await createOwner();
  const outsider = await createOwner();
  const { run, job } = await publishAndClaimNoticeRun(owner);
  const artifacts = buildAutoEvidenceArtifacts({ kakaoStorage: false });

  // 근거 고정 없이 finish_analysis_comparison으로 appliedScope != null 저장 시도는 계속 차단된다.
  await as('service_role');
  await assert.rejects(
    rpc('finish_analysis_comparison', job.runId, job.generation, job.leaseToken,
      json(artifacts.request), json(artifacts.result), json(artifacts.comparison)),
    invalidComparison,
  );

  // 잘못된 대상 공고 근거 또는 raw payload 메타데이터는 원자 롤백된다.
  const badEvidence = structuredClone(artifacts.persistedEvidence);
  badEvidence.target.noticeNo = '0000000000';
  await assert.rejects(
    rpc('finish_notice_with_evidence', job.runId, job.generation, job.leaseToken,
      json(artifacts.request), json(artifacts.result), json(artifacts.comparison),
      json(badEvidence), artifacts.persistedSources, json(artifacts.metadata), json(artifacts.schedules)),
    { code: '22023', message: 'comparison_evidence_target_mismatch' },
  );
  await db.exec('reset role');
  assert.equal((await one('select count(*)::int as n from public.analysis_input_snapshots')).n, 0);
  assert.equal((await one('select count(*)::int as n from private.comparison_evidence')).n, 0);

  // 정상 원자 저장 (kakaoStorage=false -> 좌표 제거된 persistedEvidence + 거리 포함된 comparison/v1)
  await as('service_role');
  const done = await rpc(
    'finish_notice_with_evidence',
    job.runId, job.generation, job.leaseToken,
    json(artifacts.request), json(artifacts.result), json(artifacts.comparison),
    json(artifacts.persistedEvidence), artifacts.persistedSources,
    json(artifacts.metadata), json(artifacts.schedules),
  );
  assert.equal(done.status, 'finished');
  assert.ok(done.snapshotId);

  // DB에 comparison_evidence_pinned=true, metadata, comparison_results가 함께 저장됐다.
  await db.exec('reset role');
  const evRow = await one('select evidence, source_ids, metadata from private.comparison_evidence where snapshot_id = $1',
    [done.snapshotId]);
  assert.ok(evRow);
  assert.ok(!evRow.source_ids.includes('kakao_address'));
  assert.equal(evRow.metadata.contractVersion, 'comparison-evidence-meta/v1');
  const runRow = await one('select comparison_evidence_pinned from private.analysis_runs where id = $1', [run.runId]);
  assert.equal(runRow.comparison_evidence_pinned, true);

  // 소유자는 비교 통계를 읽고, 타 계정은 PT404를 받는다.
  await as('authenticated', owner.userId);
  const readRes = await rpc('get_analysis_comparison', owner.analysisId, run.runId);
  assert.equal(readRes.result.appliedScope, 'priority');
  assert.equal(readRes.result.comparables.length, 2);
  assert.equal(readRes.result.comparables[0].rank, 1);

  await as('authenticated', outsider.userId);
  await assert.rejects(rpc('get_analysis_comparison', owner.analysisId, run.runId), missing);

  // 저장된 수집본으로 조건 변경(기간 축소) 승인 -> 새 snapshot 실행의 read_comparison_work가 저장된 comparison_evidence를 그대로 내려준다.
  await as('authenticated', owner.userId);
  const conv = await rpc('read_analysis_conversation', owner.analysisId, run.runId);
  assert.ok(conv.conditionBounds.period);
  const submitted = await rpc(
    'submit_analysis_condition_turn',
    owner.analysisId, run.runId, randomUUID(), '10월 거래만 다시 비교해줘',
    json({ period: { start: '2026-10-01', end: '2026-10-20' } }),
  );
  const turnId = submitted.turns.at(-1).id;
  const decided = await rpc('decide_analysis_chat_turn', owner.analysisId, run.runId, turnId, 'approve');
  const recalcRunId = decided.turns.find(t => t.id === turnId).proposal.resultRunId;
  assert.ok(recalcRunId);

  await as('service_role');
  const recalcJob = await rpc('claim_analysis_run', 300, recalcRunId);
  const recalcWork = await rpc('read_comparison_work', recalcJob.runId, recalcJob.generation, recalcJob.leaseToken);
  assert.deepEqual(recalcWork.evidence, artifacts.persistedEvidence);
  assert.deepEqual(recalcWork.comparisonPeriod, { start: '2026-10-01', end: '2026-10-20' });

  // 출처 표시 권한 회수 시 소유자 결과 조회가 PT403으로 차단된다.
  await db.exec('reset role');
  await db.query("update public.source_registry set display_permission = 'denied' where id = 'applyhome_apt_model'");
  await as('authenticated', owner.userId);
  await assert.rejects(rpc('get_analysis_comparison', owner.analysisId, run.runId), { code: 'PT403' });
});

test('upload_supplement run with finish_notice_with_evidence cascades snapshot evidence on A-56 upload deletion without touching shared cache', async () => {
  const owner = await createOwner();
  const { run: baseRun, job: baseJob } = await publishAndClaimNoticeRun(owner);
  const baseArtifacts = buildAutoEvidenceArtifacts({ kakaoStorage: false });

  // 기준 실행은 PDF 없음 상태(근거 없음)로 먼저 마친다.
  const pythonHeld = `
import json, sys
from pathlib import Path
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot
from replay_ingestion import ingest
from store_ingestion import snapshot_input
from test_auto_evidence import make_synthetic_harness

fixture = json.loads(Path('tests/fixtures/auto-evidence-gwacheon-synthetic.json').read_text(encoding='utf-8'))
api_fetch, _, _, _, _ = make_synthetic_harness(fixture)
req = dict(fixture['request'])
req.pop('start', None); req.pop('end', None)
cap = ingest(req, api_fetch, data_origin='collected')
comp = compare_snapshot(cap, {'modelNo': '01', 'room': '101동 101호'}, None)
print(json.dumps({'request': snapshot_input(req), 'result': cap, 'comparison': comp}, ensure_ascii=False))
`;
  const heldBase = JSON.parse(execFileSync('python3', ['-B', '-c', pythonHeld], { cwd: root, encoding: 'utf8' }));
  await as('service_role');
  await rpc('finish_analysis_comparison', baseJob.runId, baseJob.generation, baseJob.leaseToken,
    json(heldBase.request), json(heldBase.result), json(heldBase.comparison));

  // 소유자가 업로드 PDF 등록 + 스토리지 적재 후 upload_supplement 실행 접수
  const uploadId = randomUUID();
  await as('authenticated', owner.userId, false, 'storage.object.upload');
  const uploadRow = await one('select * from public.register_analysis_upload($1, $2)', [owner.analysisId, uploadId]);
  await db.exec('reset role');
  await db.query(
    'insert into storage.objects(bucket_id, name, owner_id, metadata) values ($1, $2, $3, $4)',
    ['analysis-uploads', uploadRow.object_path, owner.userId,
      JSON.stringify({ mimetype: 'application/pdf', cacheControl: 'max-age=0', size: 1024 })],
  );

  await as('authenticated', owner.userId);
  const supRun = await rpc('enqueue_upload_supplement_run', owner.analysisId, baseRun.runId, uploadId, randomUUID());
  await db.exec('reset role');
  await db.query(
    `update private.analysis_runs
        set basis_date = $2::date,
            notice_request = jsonb_set(notice_request, '{asOf}', to_jsonb($2::text))
      where id = $1`,
    [supRun.runId, basisDate],
  );

  await as('service_role');
  const supJob = await rpc('claim_analysis_run', 300, supRun.runId);
  const supArtifacts = buildAutoEvidenceArtifacts({ kakaoStorage: false, uploadDocId: uploadId });

  // 공유 캐시 저장 + upload_supplement에 자동 근거 원자 저장
  const applyhomeOnly = supArtifacts.newCacheEntries.filter(e => e.cacheKind === 'applyhome_supply_area');
  await rpc('upsert_auto_evidence_cache', supJob.runId, supJob.generation, supJob.leaseToken,
    json(supArtifacts.regionCacheRecord), json(applyhomeOnly));
  const supDone = await rpc(
    'finish_notice_with_evidence',
    supJob.runId, supJob.generation, supJob.leaseToken,
    json(supArtifacts.request), json(supArtifacts.result), json(supArtifacts.comparison),
    json(supArtifacts.persistedEvidence), supArtifacts.persistedSources,
    json(supArtifacts.metadata), json(supArtifacts.schedules),
  );
  assert.equal(supDone.status, 'finished');

  // 소유자가 업로드 1건 삭제(A-56)하면 파생 스냅샷·비교 근거·비교 결과는 연쇄 삭제되지만,
  // 사용자 식별자 없는 공유 캐시는 그대로 유지된다.
  await as('authenticated', owner.userId);
  const receipt = randomUUID();
  await rpc('delete_personal_data', 'upload', receipt, uploadId);

  await db.exec('reset role');
  assert.equal(await one('select snapshot_id from private.comparison_evidence where snapshot_id = $1', [supDone.snapshotId]), undefined);
  assert.equal(await one('select run_id from private.comparison_results where run_id = $1', [supRun.runId]), undefined);
  assert.equal((await one('select count(*)::int as n from private.complex_evidence_cache')).n, applyhomeOnly.length);
  assert.equal((await one('select count(*)::int as n from private.legal_region_locality_cache')).n, 1);

  // 만료된 임대에서는 finish_notice_with_evidence가 PT409로 거부된다.
  const owner2 = await createOwner();
  const { job: staleJob } = await publishAndClaimNoticeRun(owner2);
  await db.exec('reset role');
  await db.query("update private.analysis_runs set next_claim_at = now() - interval '1 second' where id = $1", [staleJob.runId]);
  await as('service_role');
  await assert.rejects(
    rpc('finish_notice_with_evidence', staleJob.runId, staleJob.generation, staleJob.leaseToken,
      json(baseArtifacts.request), json(baseArtifacts.result), json(baseArtifacts.comparison),
      json(baseArtifacts.persistedEvidence), baseArtifacts.persistedSources, json(baseArtifacts.metadata), json([])),
    staleLease,
  );
});
