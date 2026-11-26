// 합성 Auth·공고·업로드·실거래 자료와 PGlite로 작업 B(업로드 보완 + A-56 파생 삭제)의 DB 계약을 검사한다.
// 실제 Supabase Auth·Storage·청약홈 API는 호출하지 않으며 모든 식별자와 PDF 기록은 합성 자료다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBe03Db } from './helpers/be03-db.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureRaw = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8'));
const fixtureEvidence = JSON.parse(readFileSync(new URL('../fixtures/comparison-evidence-v1.json', import.meta.url), 'utf8'));

const noticeFeeds = ['applyhome_apt', 'applyhome_remainder'];
const allSources = [
  ...noticeFeeds,
  ...noticeFeeds.map(feed => `${feed}_model`),
  'mois_legal_region_codes',
  'apt_trade',
  'apt_rights',
  'applyhome_notice_pdf',
  'law_eflaw',
  'synthetic-area-register',
  'synthetic-complex-register',
  'synthetic-coordinate-register',
  'synthetic-region-register',
];
const regionCode = '99999';
const modelNo = '01';
const houseType = '084.0000A';
const roomName = '101동 101호';
const basisDate = '2026-11-10';
const identity = { houseManageNo: '9900000001', noticeNo: '9900000042', edition: '2026-10-05' };
const storedPdfMetadata = JSON.stringify({ mimetype: 'application/pdf', cacheControl: 'max-age=0', size: 1024 });

const forbidden = { code: '42501' };
const missing = { code: 'PT404' };
const conflict = { code: 'PT409' };

let db;

const json = value => (value === null ? null : JSON.stringify(value));

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function as(role, userId = '', claims = { is_anonymous: false }, mode = '') {
  await db.exec('reset role');
  const jwt = { ...(userId ? { sub: userId } : {}), ...claims };
  await db.query(
    `select set_config('request.jwt.claim.sub', $1, false),
            set_config('request.jwt.claims', $2, false),
            set_config('storage.operation', $3, false)`,
    [userId, JSON.stringify(jwt), mode],
  );
  await db.exec(`set role ${role}`);
}

async function rpc(name, ...params) {
  const args = params.map((_, index) => `$${index + 1}`).join(', ');
  return (await one(`select public.${name}(${args}) as reply`, params)).reply;
}

async function createUser({ verified = true, anonymous = false, bannedUntil = null } = {}) {
  await db.exec('reset role');
  const userId = randomUUID();
  await db.query(
    `insert into auth.users(id, confirmed_at, is_anonymous, banned_until)
     values ($1, case when $2 then now() end, $3, $4)`,
    [userId, verified, anonymous, bannedUntil],
  );
  return userId;
}

async function createNoticeWorkspace(userId, { room = roomName } = {}) {
  const conditions = {
    ingestion_target: { noticeSource: 'applyhome_apt', ...identity },
    comparison: room ? { modelNo, room } : { modelNo },
  };
  await db.exec('reset role');
  const chat = await one("insert into public.chats(user_id, title) values ($1, '합성 업로드 보완 대화') returning id", [userId]);
  const analysis = await one(
    `insert into public.analyses(user_id, chat_id, title, conditions_snapshot)
     values ($1, $2, '합성 가람 아파트', $3) returning id`,
    [userId, chat.id, JSON.stringify(conditions)],
  );
  return { chatId: chat.id, analysisId: analysis.id, conditions };
}

async function registerUpload(userId, analysisId, uploadId = randomUUID(), { storeObject = true } = {}) {
  await as('authenticated', userId, { is_anonymous: false }, 'storage.object.upload');
  const row = await one('select * from public.register_analysis_upload($1, $2)', [analysisId, uploadId]);
  if (storeObject) {
    await db.exec('reset role');
    await db.query(
      'insert into storage.objects(bucket_id, name, owner_id, metadata) values ($1, $2, $3, $4)',
      ['analysis-uploads', row.object_path, userId, storedPdfMetadata],
    );
  }
  return row;
}

function buildCollectedCapture({
  docMode = 'missing', // 'missing' | 'official' | 'upload'
  uploadId = null,
  uploadHash = createHash('sha256').update('synthetic-notice-pdf-bytes').digest('hex'),
  room = roomName,
  withEvidence = false,
} = {}) {
  const python = `
import json, sys
from pathlib import Path
sys.path.insert(0, 'scripts')
from compare_trades import compare_snapshot
from replay_ingestion import ingest

doc_mode, upload_id, upload_hash, room, with_evidence = json.load(sys.stdin)
sample = json.loads(Path('tests/fixtures/ingestion-v0.json').read_text())
ev_fixture = json.loads(Path('tests/fixtures/comparison-evidence-v1.json').read_text())
target = {'houseManageNo': '9900000001', 'noticeNo': '9900000042', 'edition': '2026-10-05'}
request = {
    'noticeSource': 'applyhome_apt',
    'target': target,
    'asOf': '2026-11-10',
    'requestRegionCodes': ['99999'],
    'tradeKinds': ['sale', 'presale_right', 'occupancy_right'],
    'pageSize': 100,
}
notice = dict(sample['pages'][0]['body']['data'][0], HOUSE_MANAGE_NO=target['houseManageNo'],
              PBLANC_NO=target['noticeNo'], RCRIT_PBLANC_DE=target['edition'])
model = dict(sample['pages'][1]['body']['data'][0], HOUSE_MANAGE_NO=target['houseManageNo'],
             PBLANC_NO=target['noticeNo'], MODEL_NO='01')

def fetch(source, scope, page, page_size):
    entry = dict(source=source, scope=scope, page=page, pageSize=page_size,
                 observedAt='2026-11-10T01:00:00Z', httpStatus=200)
    if source == 'applyhome_apt':
        entry['body'] = dict(page=page, perPage=page_size, currentCount=1, matchCount=1, totalCount=1, data=[notice])
    elif source == 'applyhome_apt_model':
        entry['body'] = dict(page=page, perPage=page_size, currentCount=1, matchCount=1, totalCount=1, data=[model])
    elif source == 'apt_trade' and scope['DEAL_YMD'] == '202610':
        entry['body'] = sample['pages'][2]['body']
        inner = entry['body']['response']['body']
        inner['numOfRows'] = page_size
        inner['totalCount'] = len(inner['items']['item'])
    else:
        entry['body'] = {'response': {'header': {'resultCode': '000', 'resultMsg': 'OK'},
                         'body': {'pageNo': page, 'numOfRows': page_size, 'totalCount': 0, 'items': {}}}}
    return entry

if doc_mode == 'missing':
    result = ingest(request, fetch, data_origin='collected',
                    review_documents=lambda *_: {'evidence': [], 'issues': [{'code': 'attachment_not_found', 'stage': 'document_acquisition'}]})
    schedules = []
else:
    is_upload = (doc_mode == 'upload')
    doc_id = ('upload:' + upload_id) if is_upload else 'applyhome:9900000001:9900000042:11:1'
    version = 'sha256:' + upload_hash
    doc = {
        'id': doc_id, 'version': version,
        'source': 'upload' if is_upload else 'official',
        'originCheck': 'confirmed',
        **target,
    }
    ev_rows = [dict(item, document=dict(doc)) for item in sample['evidence']]
    result = ingest(request, fetch, data_origin='collected', evidence=ev_rows)
    schedules = [
        {
            'modelNo': '01', 'houseType': '084.0000A', 'room': '101동 101호', 'item': 'sale_price',
            'status': 'confirmed', 'totalWon': '700000000', 'reasons': [],
            'evidence': [{'document': doc_id, 'version': version, 'page': 7}],
            'installments': [{
                'stage': 'balance', 'won': '700000000',
                'timing': {'trigger': 'calendar_date', 'dateStatus': 'exact', 'date': '2026-11-30',
                           'evidence': [{'document': doc_id, 'version': version, 'page': 7}]}
            }],
        },
        {
            'modelNo': '01', 'houseType': '084.0000A', 'room': '101동 101호', 'item': 'required_options',
            'status': 'confirmed', 'totalWon': '10000000', 'reasons': [],
            'evidence': [{'document': doc_id, 'version': version, 'page': 8}],
            'installments': [{
                'stage': 'balance', 'won': '10000000',
                'timing': {'trigger': 'calendar_date', 'dateStatus': 'exact', 'date': '2026-11-30',
                           'evidence': [{'document': doc_id, 'version': version, 'page': 8}]}
            }],
        },
    ]

comp_evidence = None
if with_evidence:
    comp_evidence = dict(ev_fixture, dataOrigin='collected',
                         target=dict(ev_fixture['target'], **target))
selection = {'modelNo': '01', 'room': room} if room else {'modelNo': '01'}
comparison = compare_snapshot(result, selection, comp_evidence)
print(json.dumps({'request': request, 'result': result, 'comparison': comparison,
                  'schedules': schedules, 'compEvidence': comp_evidence}, ensure_ascii=False))
`;
  return JSON.parse(
    execFileSync('python3', ['-B', '-c', python], {
      cwd: root,
      encoding: 'utf8',
      input: JSON.stringify([docMode, uploadId, uploadHash, room, withEvidence]),
    }),
  );
}

async function finishBaseNoticeRun(userId, analysisId, { withEvidence = false, docMode = 'missing', uploadHash } = {}) {
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
        { source: 'applyhome_apt', status: 'complete' },
        { source: 'applyhome_remainder', status: 'empty' },
      ],
    },
    notices: [{
      ...identity,
      title: '합성 가람 아파트',
      kind: 'new_sale',
      regionCode,
      moveIn: null,
      application: { start: identity.edition, end: identity.edition },
      inventoryComplete: false,
      models: [{ modelNo, houseType, supplyAreaM2: null, areaEvidence: [], rooms: [] }],
      sourceIds: ['applyhome_apt', 'applyhome_apt_model'],
      reasonCodes: [],
    }],
  };
  await as('service_role');
  await rpc('publish_notice_directory', json(index), json({ [regionCode]: '합성 가람구' }));

  const noticeInput = { kind: 'notice', noticeSource: 'applyhome_apt', ...identity, modelNo };
  await as('authenticated', userId);
  const run = await rpc('enqueue_analysis_run', analysisId, randomUUID(), json(noticeInput));

  // 테스트 재현성을 위해 기준일을 고정한다.
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
  const basePayload = buildCollectedCapture({ docMode, uploadHash, withEvidence: false });
  const finished = await rpc(
    'finish_notice_with_funding',
    job.runId, job.generation, job.leaseToken,
    json(basePayload.request), json(basePayload.result), json(basePayload.comparison), json(basePayload.schedules),
  );
  if (withEvidence) {
    const withEv = buildCollectedCapture({ docMode, uploadHash, withEvidence: true });
    await rpc(
      'register_comparison_evidence',
      finished.snapshotId,
      json(withEv.compEvidence),
      [
        'applyhome_apt',
        'apt_trade',
        'apt_rights',
        'synthetic-area-register',
        'synthetic-complex-register',
        'synthetic-coordinate-register',
        'synthetic-region-register',
      ],
    );
  }
  return finished;
}

async function seedOfficialIndex(documentId, sha256, target = identity) {
  await db.exec('reset role');
  await db.query(
    `insert into private.official_notice_document_index(document_id, house_manage_no, notice_no, edition, sha256, role)
     values ($1, $2, $3, $4, $5, 'notice')`,
    [documentId, target.houseManageNo, target.noticeNo, target.edition, sha256],
  );
}

before(async () => {
  db = await createBe03Db();
  await db.exec(`alter table auth.users add column confirmed_at timestamptz,
    add column is_anonymous boolean not null default false,
    add column banned_until timestamptz, add column deleted_at timestamptz`);
});

beforeEach(async () => {
  await db.exec('reset role');
  await db.exec(`truncate
    private.official_notice_document_index,
    private.snapshot_upload_bindings,
    private.upload_supplement_runs,
    private.retired_deletion_keys,
    private.data_deletion_objects,
    private.account_deletion_fences,
    private.data_deletion_requests,
    private.saved_report_funding_refs,
    private.saved_analysis_reports,
    private.deleted_report_requests,
    private.analysis_report_versions,
    private.search_profile_proposals,
    private.analysis_chat_turns,
    private.comparison_results,
    private.comparison_evidence,
    private.analysis_funding_schedule_snapshots,
    private.analysis_runs,
    private.notice_directory_publication,
    private.notice_search_index,
    public.reports,
    public.funding_entries,
    public.analysis_uploads,
    public.analysis_input_snapshots,
    public.analyses,
    public.chat_messages,
    public.chats,
    public.profile_change_requests,
    public.user_profiles,
    public.source_registry,
    storage.objects,
    auth.users cascade`);
  await db.query(
    `insert into public.source_registry(
       id, display_name, storage_permission, reuse_permission, display_permission, export_permission
     )
     select id, '합성 출처', 'allowed', 'allowed', 'allowed', 'allowed'
     from unnest($1::text[]) as s(id)`,
    [allSources],
  );
});

after(async () => {
  await db?.close();
});

test('upload-supplement private tables keep RLS and zero direct grants while RPC privileges stay narrow', async () => {
  await db.exec('reset role');
  for (const tbl of [
    'private.official_notice_document_index',
    'private.snapshot_upload_bindings',
    'private.upload_supplement_runs',
  ]) {
    const rls = await one(
      `select c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'private' and c.relname = $1`,
      [tbl.split('.')[1]],
    );
    assert.equal(rls.relrowsecurity, true, `${tbl} RLS`);
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        assert.equal(
          (await one('select has_table_privilege($1, $2, $3) as ok', [role, tbl, priv])).ok,
          false,
          `${role} ${priv} ${tbl}`,
        );
      }
    }
  }

  for (const sig of [
    'public.read_upload_supplement_context(uuid,uuid)',
    'public.enqueue_upload_supplement_run(uuid,uuid,uuid,uuid)',
    'public.get_upload_supplement_run(uuid,uuid)',
  ]) {
    const def = await one('select prosecdef from pg_proc where oid = $1::regprocedure', [sig]);
    assert.equal(def.prosecdef, false, `${sig} invoker`);
    assert.equal((await one("select has_function_privilege('authenticated', $1, 'EXECUTE') as ok", [sig])).ok, true, sig);
    for (const role of ['public', 'anon', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }

  for (const sig of [
    'public.read_upload_supplement_work(uuid,integer,uuid)',
    'public.lookup_official_notice_document_index(uuid,integer,uuid,text)',
  ]) {
    assert.equal((await one("select has_function_privilege('service_role', $1, 'EXECUTE') as ok", [sig])).ok, true, sig);
    for (const role of ['public', 'anon', 'authenticated']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }

  // 공식 색인은 수집본 트리거만 쓴다. 사용자·작업자가 직접 부를 등록 RPC는 없다.
  assert.equal((await one("select to_regprocedure('public.register_official_notice_document_index(jsonb)') as fn")).fn, null);
  for (const sig of [
    'private.record_official_notice_documents()',
    'private.unambiguous_official_index(text,text)',
    'private.check_approved_condition_comparison(private.analysis_runs,public.analysis_input_snapshots,private.analysis_chat_turns,jsonb)',
  ]) {
    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      assert.equal((await one('select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).ok, false, `${role} ${sig}`);
    }
  }

  // service_role은 public.analysis_uploads 직접 권한이 계속 없다.
  assert.equal(
    (await one("select has_table_privilege('service_role', 'public.analysis_uploads', 'SELECT') as ok")).ok,
    false,
  );
});

test('enqueue, context and status enforce verified ownership, storage presence, idempotency and cross-account 404', async () => {
  const owner = await createUser();
  const peer = await createUser();
  const unverified = await createUser({ verified: false });
  const { analysisId } = await createNoticeWorkspace(owner);
  const baseRun = await finishBaseNoticeRun(owner, analysisId);

  // 미인증·익명·미확인·service_role 차단
  await as('anon');
  await assert.rejects(rpc('read_upload_supplement_context', analysisId, baseRun.runId), forbidden);
  await as('authenticated', unverified);
  await assert.rejects(rpc('read_upload_supplement_context', analysisId, baseRun.runId), forbidden);
  await as('authenticated', owner, { is_anonymous: true });
  await assert.rejects(rpc('read_upload_supplement_context', analysisId, baseRun.runId), forbidden);

  // 타 계정은 404
  await as('authenticated', peer);
  await assert.rejects(rpc('read_upload_supplement_context', analysisId, baseRun.runId), missing);
  await assert.rejects(rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, randomUUID(), randomUUID()), missing);

  // 소유자 컨텍스트 조회: 공식 PDF 누락으로 needsSupplement=true
  await as('authenticated', owner);
  const ctx = await rpc('read_upload_supplement_context', analysisId, baseRun.runId);
  assert.equal(ctx.contractVersion, 'upload-supplement-context/v1');
  assert.equal(ctx.eligible, true);
  assert.equal(ctx.needsSupplement, true);
  assert.equal(ctx.target.noticeNo, identity.noticeNo);
  assert.equal(ctx.target.edition, identity.edition);
  assert.equal(ctx.target.modelNo, modelNo);
  assert.ok(ctx.reasonCodes.includes('attachment_not_found'));
  assert.ok(ctx.reasonCodes.includes('official_document_missing'));

  // 파일 등록만 하고 Storage 업로드를 안 했으면 PT409(upload_file_missing)
  const noBytesUpload = await registerUpload(owner, analysisId, randomUUID(), { storeObject: false });
  await as('authenticated', owner);
  await assert.rejects(
    rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, noBytesUpload.id, randomUUID()),
    { code: 'PT409', message: 'upload_file_missing' },
  );

  // 등록 + Storage 적재 완료된 소유자 파일로 접수
  const upload = await registerUpload(owner, analysisId);
  const idem = randomUUID();
  await as('authenticated', owner);
  const queued = await rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, upload.id, idem);
  assert.equal(queued.contractVersion, 'upload-supplement-run/v1');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.baseRunId, baseRun.runId);
  assert.equal(queued.uploadId, upload.id);
  assert.equal(queued.input.kind, 'upload_supplement');
  assert.equal(queued.input.edition, identity.edition);

  // 같은 idempotency key 재전송은 같은 실행 반환, 다른 업로드로 재사용은 PT409
  const replayed = await rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, upload.id, idem);
  assert.deepEqual(replayed, queued);
  const otherUpload = await registerUpload(owner, analysisId);
  await as('authenticated', owner);
  await assert.rejects(
    rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, otherUpload.id, idem),
    { code: 'PT409', message: 'upload_supplement_conflict' },
  );

  // get_upload_supplement_run: 소유자 성공, 타 계정 404
  const fetched = await rpc('get_upload_supplement_run', analysisId, queued.runId);
  assert.equal(fetched.runId, queued.runId);
  await as('authenticated', peer);
  await assert.rejects(rpc('get_upload_supplement_run', analysisId, queued.runId), missing);
});

test('bound owner upload persists snapshot, funding schedules, recomputed comparison and saved report without official PDF feed', async () => {
  const owner = await createUser();
  const { analysisId } = await createNoticeWorkspace(owner);
  const baseRun = await finishBaseNoticeRun(owner, analysisId, { withEvidence: true });
  const upload = await registerUpload(owner, analysisId);
  const uploadHash = createHash('sha256').update('synthetic-official-matched-pdf').digest('hex');

  // 이전 실수집에서 확인된 공식 첨부 해시(합성)를 서버 색인에 둔다.
  await seedOfficialIndex('applyhome:9900000001:9900000042:11:1', uploadHash);

  // 공식 PDF 권한을 끈 상태에서도 소유자 업로드 보완 수집·자금표·보고서가 동작해야 한다.
  await db.exec('reset role');
  await db.query("update public.source_registry set storage_permission='denied', display_permission='denied' where id='applyhome_notice_pdf'");

  await as('authenticated', owner);
  const queued = await rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, upload.id, randomUUID());

  await as('service_role');
  const job = await rpc('claim_analysis_run', 300, queued.runId);
  const work = await rpc('read_upload_supplement_work', job.runId, job.generation, job.leaseToken);
  assert.equal(work.upload.uploadId, upload.id);
  assert.equal(work.upload.objectPath, upload.object_path);
  assert.equal(work.officialIndex.length, 1);
  assert.equal(work.officialIndex[0].sha256, uploadHash);
  assert.ok(work.evidence !== null);
  assert.equal(work.noticeCapture.allowOfficialPdf, false);

  // 같은 공고의 기록은 작업 입력으로 이미 받았으므로 해시 조회는 다른 공고 일치만 돌려준다.
  const byHash = await rpc('lookup_official_notice_document_index', job.runId, job.generation, job.leaseToken, uploadHash);
  assert.deepEqual(byHash, []);

  // 미바인딩(다른 업로드 ID) 문서는 저장 거부된다.
  const wrongUploadCapture = buildCollectedCapture({ docMode: 'upload', uploadId: randomUUID(), uploadHash, withEvidence: true });
  await assert.rejects(
    rpc(
      'finish_notice_with_funding',
      job.runId, job.generation, job.leaseToken,
      json(wrongUploadCapture.request), json(wrongUploadCapture.result),
      json(wrongUploadCapture.comparison), json(wrongUploadCapture.schedules),
    ),
    { code: '22023' },
  );

  // 핀닝된 소유자 업로드로 원자 완료: 스냅샷 + 납부 일정 + 비교 재계산 + 근거 승계
  const validCapture = buildCollectedCapture({ docMode: 'upload', uploadId: upload.id, uploadHash, withEvidence: true });
  const finished = await rpc(
    'finish_notice_with_funding',
    job.runId, job.generation, job.leaseToken,
    json(validCapture.request), json(validCapture.result),
    json(validCapture.comparison), json(validCapture.schedules),
  );
  assert.equal(finished.status, 'finished');
  assert.ok(finished.snapshotId);

  // 소유자는 비교 결과·자금표·저장 보고서를 모두 읽을 수 있다.
  await as('authenticated', owner);
  const comp = await rpc('get_analysis_comparison', analysisId, finished.runId);
  assert.equal(comp.result.target.supplyArea.status, 'confirmed');
  assert.equal(comp.result.target.supplyArea.evidence[0].document, `upload:${upload.id}`);
  assert.equal(comp.result.noticePrice.status, 'confirmed');
  assert.equal(comp.result.noticePrice.won, '710000000');

  const funding = await rpc('read_analysis_funding_inputs', analysisId, finished.snapshotId, modelNo, roomName);
  assert.equal(funding.scheduleStatus, 'available');
  assert.equal(funding.schedules.length, 2);
  assert.equal(funding.schedules[0].evidence[0].document, `upload:${upload.id}`);

  const report = await rpc('save_analysis_report', analysisId, finished.runId, randomUUID());
  assert.equal(report.sections.comparison.status, 'available');
  assert.equal(report.sections.funding.status, 'available');

  const afterCtx = await rpc('read_upload_supplement_context', analysisId, finished.runId);
  assert.equal(afterCtx.needsSupplement, false);
  assert.equal(afterCtx.currentSupplement.uploadId, upload.id);
  assert.equal(afterCtx.documents[0].source, 'upload');
  assert.equal(afterCtx.documents[0].status, 'accepted');
});

test('upload_duplicates_official alongside accepted official PDF clears needsSupplement without spurious reason codes', async () => {
  const owner = await createUser();
  const { analysisId } = await createNoticeWorkspace(owner);
  const baseRun = await finishBaseNoticeRun(owner, analysisId, { withEvidence: true });
  const upload = await registerUpload(owner, analysisId);
  const sharedHash = createHash('sha256').update('synthetic-official-recovered-pdf').digest('hex');

  await as('authenticated', owner);
  const queued = await rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, upload.id, randomUUID());
  await as('service_role');
  const job = await rpc('claim_analysis_run', 300, queued.runId);
  const payload = buildCollectedCapture({ docMode: 'official', uploadHash: sharedHash, withEvidence: true });
  payload.result.catalog.documents.push({
    id: `upload:${upload.id}`,
    version: `sha256:${sharedHash}`,
    source: 'upload',
    originCheck: 'confirmed',
    status: 'held',
    records: 0,
    reasons: ['upload_duplicates_official'],
    ...identity,
  });

  const finished = await rpc(
    'finish_notice_with_funding',
    job.runId, job.generation, job.leaseToken,
    json(payload.request), json(payload.result),
    json(payload.comparison), json(payload.schedules),
  );
  assert.equal(finished.status, 'finished');

  await as('authenticated', owner);
  const ctx = await rpc('read_upload_supplement_context', analysisId, finished.runId);
  assert.equal(ctx.eligible, true);
  assert.equal(ctx.needsSupplement, false);
  assert.deepEqual(ctx.reasonCodes, []);
  assert.equal(ctx.currentSupplement.uploadId, upload.id);
});

test('official attachment hashes are recorded only from collected captures and ambiguous slots are withheld', async () => {
  const owner = await createUser();
  const { analysisId } = await createNoticeWorkspace(owner);
  const officialId = 'applyhome:9900000001:9900000042:11:1';
  const officialHash = createHash('sha256').update('synthetic-official-attachment').digest('hex');
  // 공식 첨부를 받아 해시를 계산한 기준 실행(합성)이 색인을 남긴다. 계정·분석 식별자는 색인에 없다.
  const baseRun = await finishBaseNoticeRun(owner, analysisId, { docMode: 'official', uploadHash: officialHash });
  await db.exec('reset role');
  const recorded = (await db.query(
    'select document_id, house_manage_no, notice_no, edition, sha256, role from private.official_notice_document_index',
  )).rows;
  assert.deepEqual(recorded, [{
    document_id: officialId, house_manage_no: identity.houseManageNo, notice_no: identity.noticeNo,
    edition: identity.edition, sha256: officialHash, role: 'unclassified',
  }]);
  const columns = (await db.query(
    `select column_name from information_schema.columns
     where table_schema = 'private' and table_name = 'official_notice_document_index'`,
  )).rows.map(row => row.column_name);
  assert.ok(!columns.includes('user_id') && !columns.includes('analysis_id'));

  // 다른 공고(합성)의 공식 첨부와 같은 파일은 작업자 조회에서 다른 공고 기록으로만 돌려준다.
  const otherNotice = { houseManageNo: '9900000009', noticeNo: '9900000099', edition: '2026-09-01' };
  await seedOfficialIndex('applyhome:9900000009:9900000099:3:1', officialHash, otherNotice);

  const upload = await registerUpload(owner, analysisId);
  await as('authenticated', owner);
  const queued = await rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, upload.id, randomUUID());
  await as('service_role');
  const job = await rpc('claim_analysis_run', 300, queued.runId);
  let work = await rpc('read_upload_supplement_work', job.runId, job.generation, job.leaseToken);
  assert.deepEqual(work.officialIndex.map(row => [row.id, row.sha256, row.edition]), [[officialId, officialHash, identity.edition]]);
  const byHash = await rpc('lookup_official_notice_document_index', job.runId, job.generation, job.leaseToken, officialHash);
  assert.deepEqual(byHash.map(row => [row.houseManageNo, row.noticeNo]), [[otherNotice.houseManageNo, otherNotice.noticeNo]]);
  await assert.rejects(
    rpc('lookup_official_notice_document_index', job.runId, job.generation, job.leaseToken, 'not-a-hash'),
    { code: '22023' },
  );

  // 같은 첨부 자리에서 다른 판본이 관찰되면 어느 쪽이 현재 판인지 알 수 없으므로 대조 목록에서 뺀다.
  await seedOfficialIndex(officialId, 'f'.repeat(64));
  await as('service_role');
  work = await rpc('read_upload_supplement_work', job.runId, job.generation, job.leaseToken);
  assert.deepEqual(work.officialIndex, []);

  // 다른 실행의 임대로는 색인을 조회할 수 없다.
  await assert.rejects(
    rpc('lookup_official_notice_document_index', job.runId, job.generation, randomUUID(), officialHash),
    { code: 'PT409' },
  );
});

test('A-56 single upload deletion previews and removes all derived runs, snapshots, turns, reports, proposals and blocks reuse', async () => {
  const owner = await createUser();
  const { analysisId } = await createNoticeWorkspace(owner);
  const baseRun = await finishBaseNoticeRun(owner, analysisId, { withEvidence: true });

  const upload1 = await registerUpload(owner, analysisId);
  const upload2 = await registerUpload(owner, analysisId);
  const uploadHash = createHash('sha256').update('synthetic-delete-check-pdf').digest('hex');

  // upload1으로 보완 실행 R1 완료
  await as('authenticated', owner);
  const run1 = await rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, upload1.id, randomUUID());
  await as('service_role');
  const job1 = await rpc('claim_analysis_run', 300, run1.runId);
  const cap1 = buildCollectedCapture({ docMode: 'upload', uploadId: upload1.id, uploadHash, withEvidence: true });
  const done1 = await rpc(
    'finish_notice_with_funding',
    job1.runId, job1.generation, job1.leaseToken,
    json(cap1.request), json(cap1.result), json(cap1.comparison), json(cap1.schedules),
  );

  // R1에서 저장 보고서 1건 + 기간 변경 대화 턴 1건(후속 실행 R2) + 공유 프로필 제안 1건 생성
  await as('authenticated', owner);
  const report1 = await rpc('save_analysis_report', analysisId, done1.runId, randomUUID());
  const submittedTurn = await rpc(
    'submit_analysis_chat_turn',
    analysisId, done1.runId, randomUUID(),
    '2026-10-01부터 2026-10-31까지 다시 비교해줘',
    'change_period', '2026-10-01', '2026-10-31',
  );
  const turnId = submittedTurn.turns.at(-1).id;
  const approvedTurn = await rpc('decide_analysis_chat_turn', analysisId, done1.runId, turnId, 'approve');
  const descendantRunId = approvedTurn.turns.find(t => t.id === turnId).proposal.resultRunId;

  await rpc('propose_search_profile_change', randomUUID(), 0, json({ budget_max_won: '750000000' }), '업로드 결과 확인 후 조정', analysisId, done1.runId);

  // upload1으로 대기 중인 추가 보완 실행 R3(스냅샷 미생성 상태)
  const pendingRun3 = await rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, upload1.id, randomUUID());

  // 무관한 upload2로 보완 실행 R4(삭제 대상이 아님)
  const unrelatedRun4 = await rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, upload2.id, randomUUID());

  // 1) 영향 미리보기: R1(보완 완료) + R2(기간 변경 파생) + R3(대기 중 보완) = 3건, 턴 1건, 보고서 1건, 프로필 제안 1건, Storage 1건
  const impact = await rpc('read_deletion_impact', 'upload', upload1.id);
  assert.equal(impact.scope, 'upload');
  assert.equal(impact.targetId, upload1.id);
  assert.equal(impact.counts.uploads, 1);
  assert.equal(impact.counts.runs, 3);
  assert.equal(impact.counts.turns, 1);
  assert.equal(impact.counts.reports, 1);
  assert.equal(impact.reportsDeleted, 1);
  assert.equal(impact.counts.profileChanges, 1);
  assert.equal(impact.storageObjects, 1);

  // 2) 업로드 1건 삭제 실행
  const receiptId = randomUUID();
  const receipt = await rpc('delete_personal_data', 'upload', receiptId, upload1.id);
  assert.equal(receipt.scope, 'upload');
  assert.equal(receipt.status, 'processing');

  // 3) 파생 자료 전량 제거·재조회 차단·최신 실행 재동기화·무관 자료 보존 검증
  await assert.rejects(rpc('get_analysis_run', analysisId, done1.runId), missing);
  await assert.rejects(rpc('get_analysis_run', analysisId, descendantRunId), missing);
  await assert.rejects(rpc('get_analysis_run', analysisId, pendingRun3.runId), missing);
  await assert.rejects(rpc('read_saved_analysis_report', report1.reportId), missing);
  await assert.rejects(rpc('read_analysis_funding_inputs', analysisId, done1.snapshotId, modelNo, roomName), missing);

  // 삭제된 업로드로 새 보완 실행 접수 불가(A-56)
  await assert.rejects(
    rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, upload1.id, randomUUID()),
    conflict,
  );

  // 원래 기준 실행과 무관한 upload2 실행은 보존된다.
  const keptBase = await rpc('get_analysis_run', analysisId, baseRun.runId);
  assert.equal(keptBase.runId, baseRun.runId);
  const keptOther = await rpc('get_upload_supplement_run', analysisId, unrelatedRun4.runId);
  assert.equal(keptOther.runId, unrelatedRun4.runId);

  await db.exec('reset role');
  const bindingCount = await one('select count(*)::int as n from private.snapshot_upload_bindings where upload_id = $1', [upload1.id]);
  const usrCount = await one('select count(*)::int as n from private.upload_supplement_runs where upload_id = $1', [upload1.id]);
  const analysisRow = await one('select latest_run_id from public.analyses where id = $1', [analysisId]);
  assert.equal(bindingCount.n, 0);
  assert.equal(usrCount.n, 0);
  assert.notEqual(analysisRow.latest_run_id, done1.runId);
  assert.notEqual(analysisRow.latest_run_id, pendingRun3.runId);
  assert.equal(analysisRow.latest_run_id, unrelatedRun4.runId);
});

function runWorkerPrepare(selection, work) {
  const python = `
import json, sys
sys.path.insert(0, 'scripts')
from run_analysis_worker import prepare_comparison

selection, work = json.load(sys.stdin)
inputs, capture, comparison = prepare_comparison(selection, work)
print(json.dumps({'input': inputs, 'result': capture, 'comparison': comparison}, ensure_ascii=False))
`;
  return JSON.parse(
    execFileSync('python3', ['-B', '-c', python], {
      cwd: root,
      encoding: 'utf8',
      input: JSON.stringify([selection, work]),
    }),
  );
}

test('approved condition changes on upload-supplement snapshots accept matching results, reject mismatches and cascade on upload deletion', async () => {
  // 1) 비교 근거가 승계된 업로드 보완 수집본에서 면적 허용 범위(±3%, Q-41에 따라 좁히는 변경)와 거래 종류(매매만) 변경을 승인해 재계산한다.
  const owner = await createUser();
  const { analysisId } = await createNoticeWorkspace(owner);
  const baseRun = await finishBaseNoticeRun(owner, analysisId, { withEvidence: true });
  const upload = await registerUpload(owner, analysisId);
  const uploadHash = createHash('sha256').update('synthetic-condition-change-supplement-pdf').digest('hex');

  await as('authenticated', owner);
  const queued = await rpc('enqueue_upload_supplement_run', analysisId, baseRun.runId, upload.id, randomUUID());
  await as('service_role');
  const job1 = await rpc('claim_analysis_run', 300, queued.runId);
  const cap1 = buildCollectedCapture({ docMode: 'upload', uploadId: upload.id, uploadHash, withEvidence: true });
  const done1 = await rpc(
    'finish_notice_with_funding',
    job1.runId, job1.generation, job1.leaseToken,
    json(cap1.request), json(cap1.result), json(cap1.comparison), json(cap1.schedules),
  );
  assert.equal(done1.status, 'finished');

  await as('authenticated', owner);
  const conv1 = await rpc('read_analysis_conversation', analysisId, done1.runId);
  assert.equal(conv1.conditionBounds.editable, true);
  assert.equal(conv1.conditionBounds.areaEditable, true);
  assert.equal(conv1.conditionBounds.replacementsEditable, true);

  const submitted = await rpc(
    'submit_analysis_condition_turn',
    analysisId, done1.runId, randomUUID(),
    '공급면적 ±3%로 좁히고 매매만 비교해줘',
    json({ areaTolerancePercent: '3', tradeKinds: ['sale'] }),
  );
  const turn = submitted.turns.at(-1);
  assert.equal(turn.intent, 'change_conditions');
  assert.equal(turn.proposal.status, 'pending');
  assert.deepEqual(turn.proposal.effective, { areaTolerancePercent: '3', tradeKinds: ['sale'] });

  const approved = await rpc('decide_analysis_chat_turn', analysisId, done1.runId, turn.id, 'approve');
  const r2 = approved.turns.find(t => t.id === turn.id).proposal.resultRunId;
  assert.ok(r2);

  await as('service_role');
  const job2 = await rpc('claim_analysis_run', 300, r2);
  const work2 = await rpc('read_comparison_work', job2.runId, job2.generation, job2.leaseToken);
  assert.deepEqual(work2.comparisonConditions, { areaTolerancePercent: '3', tradeKinds: ['sale'] });
  assert.ok(work2.evidence !== null);

  const prepared2 = runWorkerPrepare(job2.input, work2).comparison;
  assert.equal(prepared2.conditions.area.tolerancePercent, '3');
  assert.deepEqual(prepared2.conditions.tradeKinds, ['sale']);
  assert.equal(Array.isArray(prepared2.candidatePool), true);
  assert.equal(prepared2.target.supplyArea.evidence[0].document, `upload:${upload.id}`);

  // 승인 조건과 다르거나 candidatePool 형식이 잘못된 결과는 저장을 거부한다.
  for (const badComparison of [
    cap1.comparison,
    { ...prepared2, conditions: { ...prepared2.conditions, area: { ...prepared2.conditions.area, tolerancePercent: '4' } } },
    { ...prepared2, conditions: { ...prepared2.conditions, tradeKinds: ['sale', 'presale_right', 'occupancy_right'] } },
    { ...prepared2, candidatePool: { invalid: true } },
  ]) {
    await assert.rejects(
      rpc('finish_analysis_comparison', job2.runId, job2.generation, job2.leaseToken, null, null, json(badComparison)),
      { code: '22023' },
    );
  }

  const done2 = await rpc(
    'finish_analysis_comparison',
    job2.runId, job2.generation, job2.leaseToken,
    null, null, json(prepared2),
  );
  assert.equal(done2.status, 'finished');
  assert.equal(done2.snapshotId, done1.snapshotId);

  await as('authenticated', owner);
  const comp2 = await rpc('get_analysis_comparison', analysisId, r2);
  assert.equal(comp2.result.conditions.area.tolerancePercent, '3');
  assert.deepEqual(comp2.result.conditions.tradeKinds, ['sale']);
  assert.equal(Array.isArray(comp2.result.candidatePool), true);
  assert.equal(comp2.result.target.supplyArea.evidence[0].document, `upload:${upload.id}`);
  assert.equal((await rpc('read_analysis_conversation', analysisId, r2)).previousRunId, done1.runId);

  // 업로드 1건 삭제 시 보완 실행(done1)과 조건 변경 재계산 실행(r2)이 함께 미리보기·삭제된다.
  const impact = await rpc('read_deletion_impact', 'upload', upload.id);
  assert.equal(impact.counts.runs, 2);
  assert.equal(impact.counts.turns, 1);
  await rpc('delete_personal_data', 'upload', randomUUID(), upload.id);
  await assert.rejects(rpc('get_analysis_run', analysisId, done1.runId), missing);
  await assert.rejects(rpc('get_analysis_run', analysisId, r2), missing);

  // 2) 비교 근거가 없는 업로드 보완 수집본의 조건 변경 재계산에서도 비근거 권한 상승·수집목록 변조를 차단한다.
  const unpinnedOwner = await createUser();
  const { analysisId: unpinnedAnalysisId } = await createNoticeWorkspace(unpinnedOwner);
  const unpinnedBase = await finishBaseNoticeRun(unpinnedOwner, unpinnedAnalysisId, { withEvidence: false });
  const unpinnedUpload = await registerUpload(unpinnedOwner, unpinnedAnalysisId);
  const unpinnedHash = createHash('sha256').update('synthetic-unpinned-supplement-pdf').digest('hex');

  await as('authenticated', unpinnedOwner);
  const uQueued = await rpc('enqueue_upload_supplement_run', unpinnedAnalysisId, unpinnedBase.runId, unpinnedUpload.id, randomUUID());
  await as('service_role');
  const uJob1 = await rpc('claim_analysis_run', 300, uQueued.runId);
  const uCap1 = buildCollectedCapture({ docMode: 'upload', uploadId: unpinnedUpload.id, uploadHash: unpinnedHash, withEvidence: false });
  const uDone1 = await rpc(
    'finish_notice_with_funding',
    uJob1.runId, uJob1.generation, uJob1.leaseToken,
    json(uCap1.request), json(uCap1.result), json(uCap1.comparison), json(uCap1.schedules),
  );
  assert.equal(uDone1.status, 'finished');

  await as('authenticated', unpinnedOwner);
  assert.equal((await rpc('read_analysis_conversation', unpinnedAnalysisId, uDone1.runId)).conditionBounds.replacementsEditable, false);
  const uSubmitted = await rpc(
    'submit_analysis_condition_turn',
    unpinnedAnalysisId, uDone1.runId, randomUUID(),
    '매매만 비교해줘',
    json({ tradeKinds: ['sale'] }),
  );
  const uTurnId = uSubmitted.turns.at(-1).id;
  const uR2 = (await rpc('decide_analysis_chat_turn', unpinnedAnalysisId, uDone1.runId, uTurnId, 'approve'))
    .turns.find(t => t.id === uTurnId).proposal.resultRunId;

  await as('service_role');
  const uJob2 = await rpc('claim_analysis_run', 300, uR2);
  const uWork2 = await rpc('read_comparison_work', uJob2.runId, uJob2.generation, uJob2.leaseToken);
  assert.equal(uWork2.evidence, null);
  assert.deepEqual(uWork2.comparisonConditions, { tradeKinds: ['sale'] });
  const uPrepared2 = runWorkerPrepare(uJob2.input, uWork2).comparison;
  assert.equal(uPrepared2.collections.length > 0, true);

  // 비근거 업로드 보완 수집본에서 candidatePool 끼워넣기·수집목록 누락·거래 종류 불일치는 모두 거부한다.
  for (const badUnpinned of [
    { ...uPrepared2, candidatePool: [{ complexId: 'forged-complex' }] },
    { ...uPrepared2, collections: [] },
    { ...uPrepared2, conditions: { ...uPrepared2.conditions, tradeKinds: ['sale', 'presale_right', 'occupancy_right'] } },
  ]) {
    await assert.rejects(
      rpc('finish_analysis_comparison', uJob2.runId, uJob2.generation, uJob2.leaseToken, null, null, json(badUnpinned)),
      { code: '22023' },
    );
  }

  const uDone2 = await rpc(
    'finish_analysis_comparison',
    uJob2.runId, uJob2.generation, uJob2.leaseToken,
    null, null, json(uPrepared2),
  );
  assert.equal(uDone2.status, 'finished');
});
