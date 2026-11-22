// 합성 공고와 PGlite 인증 자료로 저장된 조회 대상과 외부 호출 전 조건을 검증한다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterEach, before, beforeEach, test } from 'node:test';
import { createBe03Db } from './helpers/be03-db.mjs';

const apt = 'applyhome_apt';
const remainder = 'applyhome_remainder';
const naver = 'naver_news';
const regionSource = 'mois_legal_region_codes';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/ingestion-v0.json', import.meta.url), 'utf8'));
const fixtureReplays = new Map();
const roadAddress = '서울특별시 광진구 가람로 999 (가람동, 합성아파트)';
const unrelatedSources = ['apt_trade', 'apt_rights', 'applyhome_notice_pdf'];
const authRequired = { code: '42501', message: 'regional_news_authentication_required' };
const notFound = { code: 'PT404', message: 'analysis_snapshot_not_found' };
const limited = { code: 'PT429', message: 'regional_news_rate_limited' };
let db;

before(() => {
  const replayCommand = ['import json, sys', 'sys.path.insert(0, "scripts")',
    'from replay_ingestion import loads_source_json, replay',
    'print(json.dumps(replay(loads_source_json(sys.stdin.read())), ensure_ascii=False))'].join('\n');
  for (const source of [apt, remainder]) {
    const copy = structuredClone(fixture);
    copy.request.noticeSource = source;
    for (const page of copy.pages) {
      if (page.source === apt || page.source === apt + '_model') page.source = page.source.replace(apt, source);
      if (page.source === source) page.body.data[0].HSSPLY_ADRES = roadAddress;
    }
    const result = JSON.parse(execFileSync('python3', ['-B', '-c', replayCommand], {
      cwd: new URL('../../', import.meta.url), input: JSON.stringify(copy), encoding: 'utf8',
    }));
    fixtureReplays.set(source, { input: copy.request, result });
  }
});

beforeEach(async () => {
  db = await createBe03Db();
  await db.exec(`alter table auth.users add column confirmed_at timestamptz,
    add column is_anonymous boolean not null default false,
    add column banned_until timestamptz, add column deleted_at timestamptz`);
});

afterEach(async () => { await db?.close(); });

async function one(sql, params = []) {
  return (await db.query(sql, params)).rows[0];
}

async function setCaller(role, userId = '', anonymous = false) {
  await db.exec('reset role');
  await db.query(`select set_config('request.jwt.claim.sub',$1,false),
    set_config('request.jwt.claims',$2,false)`, [userId, JSON.stringify({ sub: userId, is_anonymous: anonymous })]);
  await db.exec(`set role ${role}`);
}

async function permitCollection(source = apt) {
  await db.exec('reset role');
  await db.query(`insert into public.source_registry(id,display_name,storage_permission,reuse_permission,display_permission)
    select id,'합성 출처','allowed','allowed','allowed' from unnest($1::text[]) as sources(id)
    on conflict (id) do nothing`, [[source, source + '_model', regionSource, ...unrelatedSources]]);
}

async function permitNaver() {
  // 뉴스는 요청할 때만 표시한다. 영속 이용에 해당하는 권한을 모두 거절해도 표시 권한으로만 판정한다.
  await db.exec('reset role');
  await db.query(`insert into public.source_registry(id,display_name,storage_permission,reuse_permission,
    display_permission,llm_permission,export_permission,retention_days)
    values ($1,'합성 뉴스 출처','denied','denied','allowed','denied','denied',1)`, [naver]);
}

async function makeAnalysis({ userId, source = apt, conditions, noticeId = null } = {}) {
  await db.exec('reset role');
  if (!userId) {
    userId = randomUUID();
    await db.query('insert into auth.users(id,confirmed_at) values ($1,now())', [userId]);
  }
  const chat = await one("insert into public.chats(user_id,title) values ($1,'합성 대화') returning id", [userId]);
  const binding = conditions ?? { ingestion_target: { noticeSource: source, ...fixtureReplays.get(source).input.target },
    region: '부산광역시 해운대구', keyword: '사용자 입력 검색문', homeAddress: '사용자 합성 주소' };
  const row = await one(`insert into public.analyses(user_id,chat_id,conditions_snapshot,notice_id)
    values ($1,$2,$3,$4) returning id`, [userId, chat.id, JSON.stringify(binding), noticeId]);
  return { userId, analysisId: row.id, source };
}

async function capture(owner, { origin = 'collected', adjust = () => {} } = {}) {
  const { input, result } = fixtureReplays.get(owner.source);
  const snapshot = { ...structuredClone(result), dataOrigin: origin };
  adjust(snapshot);
  await setCaller('service_role');
  return (await one('select public.save_ingestion_snapshot($1,$2,$3,$4,$5) as id', [
    owner.userId, owner.analysisId, randomUUID(), JSON.stringify(input), JSON.stringify(snapshot),
  ])).id;
}

async function prepare(analysisId, snapshotId) {
  return (await one('select public.prepare_analysis_regional_news($1,$2) as value', [analysisId, snapshotId])).value;
}

function result(owner, snapshotId, status, region = null) {
  return { analysisId: owner.analysisId, snapshotId, status, region };
}

async function counter(userId) {
  await db.exec('reset role');
  return one('select attempts from private.regional_news_attempts where user_id = $1', [userId]);
}

test('requires a verified owner and grants no direct access to the private counter', async () => {
  const { rows: grants } = await db.query(`select n.nspname as schema, p.prosecdef as definer,
    has_function_privilege('anon',p.oid,'execute') as anon,
    has_function_privilege('authenticated',p.oid,'execute') as authenticated,
    has_function_privilege('service_role',p.oid,'execute') as service_role
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('private','public') and p.proname = 'prepare_analysis_regional_news'
    order by n.nspname`);
  assert.deepEqual(grants, [
    { schema: 'private', definer: true, anon: false, authenticated: true, service_role: false },
    { schema: 'public', definer: false, anon: false, authenticated: true, service_role: false },
  ]);
  assert.deepEqual(await one(`select relrowsecurity as rls, to_regclass('public.regional_news_attempts') is null as private_only
    from pg_class where oid = 'private.regional_news_attempts'::regclass`), { rls: true, private_only: true });
  for (const role of ['anon', 'authenticated', 'service_role']) {
    assert.equal((await one(`select has_table_privilege($1,'private.regional_news_attempts','select,insert,update,delete') as allowed`, [role])).allowed, false);
    assert.equal((await one(`select has_function_privilege($1,'private.regional_news_region(text)','execute') as allowed`, [role])).allowed, false);
  }

  const owner = await makeAnalysis();
  const sibling = await makeAnalysis({ userId: owner.userId });
  const stranger = await makeAnalysis();
  const snapshot = await capture(owner, { origin: 'synthetic' });
  for (const role of ['anon', 'service_role']) {
    await setCaller(role, owner.userId);
    await assert.rejects(prepare(owner.analysisId, snapshot), { code: '42501' });
  }
  for (const [userId, anonymous] of [['', false], [randomUUID(), false], [owner.userId, true]]) {
    await setCaller('authenticated', userId, anonymous);
    await assert.rejects(prepare(owner.analysisId, snapshot), authRequired);
  }
  for (const [change, restore] of [
    ['confirmed_at = null', 'confirmed_at = now()'], ['is_anonymous = true', 'is_anonymous = false'],
    ["banned_until = now() + interval '1 minute'", 'banned_until = null'], ['deleted_at = now()', 'deleted_at = null'],
  ]) {
    await db.exec('reset role');
    await db.query(`update auth.users set ${change} where id = $1`, [owner.userId]);
    await setCaller('authenticated', owner.userId);
    await assert.rejects(prepare(owner.analysisId, snapshot), authRequired);
    await db.exec('reset role');
    await db.query(`update auth.users set ${restore} where id = $1`, [owner.userId]);
  }
  await setCaller('authenticated', stranger.userId);
  await assert.rejects(prepare(owner.analysisId, snapshot), notFound);
  await setCaller('authenticated', owner.userId);
  for (const [analysisId, snapshotId] of [[sibling.analysisId, snapshot], [owner.analysisId, randomUUID()],
    [null, snapshot], [owner.analysisId, null]]) {
    await assert.rejects(prepare(analysisId, snapshotId), notFound);
  }
  assert.deepEqual(await prepare(owner.analysisId, snapshot), result(owner, snapshot, 'synthetic_input'));
  assert.equal(await counter(owner.userId), undefined);
});

test('uses only a canonical administrative prefix from the frozen official notice address', async () => {
  await permitCollection();
  await permitCollection(remainder);
  await permitNaver();
  const owner = await makeAnalysis();
  const second = await makeAnalysis({ source: remainder });
  await db.query(`insert into public.user_profiles(user_id, commute_destination) values ($1,'사용자 합성 주소')`, [owner.userId]);
  const firstSnapshot = await capture(owner);
  await db.exec('reset role');
  await db.query(`update public.analyses set conditions_snapshot = '{"region":"제주특별자치도 제주시"}' where id = $1`, [owner.analysisId]);
  await setCaller('authenticated', owner.userId);
  assert.deepEqual(await prepare(owner.analysisId, firstSnapshot), result(owner, firstSnapshot, 'ready', '서울특별시 광진구'));
  await db.exec('reset role');
  await db.query(`update public.analyses set conditions_snapshot = $2 where id = $1`,
    [owner.analysisId, JSON.stringify({ ingestion_target: { noticeSource: apt, ...fixtureReplays.get(apt).input.target } })]);

  const cases = [
    ['서울시\u00a0광진구  가람동 999-3번지 외 2필지', '서울특별시 광진구'],
    ['경기 수원시 영통구 가람로2번길 999', '경기도 수원시 영통구'],
    ['경기도 수원시 가람택지지구 A1블록', '경기도 수원시'],
    ['강원도 고성군 가람읍 가람리 산999-3', '강원특별자치도 고성군'],
    ['세종특별자치시 가람면 새빛로 999', '세종특별자치시'],
    ['제주 서귀포시 가람동 산999', '제주특별자치도 서귀포시'],
    ['전남광주통합특별시 광산구 가람동 999', '전남광주통합특별시 광산구'],
    ['인천광역시 검단구 가람대로 999', '인천광역시 검단구'],
    ['전라북도 전주시 덕진구 가람로 999', '전북특별자치도 전주시 덕진구'],
    ['경기도 화성시 동탄구 가람동 999'.normalize('NFD'), '경기도 화성시 동탄구'],
    ['경기도 광주시 가람동 999', '경기도 광주시'],
  ];
  // 한 계정당 요청량 제한을 넘기지 않도록 두 독립 소유자의 수집본을 준비한다.
  for (const [index, [address, region]] of cases.entries()) {
    const account = index < 5 ? owner : second;
    const snapshot = await capture(account, { adjust: replay => { replay.catalog.notice.fields.HSSPLY_ADRES.value = address; } });
    await setCaller('authenticated', account.userId);
    assert.deepEqual(await prepare(account.analysisId, snapshot), result(account, snapshot, 'ready', region));
  }
});

test('holds unspecified selection, mismatched edition and incomplete or unreportable notice identity', async () => {
  await permitCollection();
  await permitNaver();
  const owner = await makeAnalysis();
  const unknown = await makeAnalysis({ userId: owner.userId, conditions: {} });
  const legacy = await one(`insert into public.notices(source_id,external_id,title,notice_kind,collected_at)
    values ($1,'synthetic-legacy','합성 공고','unknown',now()) returning id`, [apt]);
  const keyed = await makeAnalysis({ userId: owner.userId, noticeId: legacy.id });
  const unbound = await capture(unknown);
  const legacySnapshot = await capture(keyed);
  await setCaller('authenticated', owner.userId);
  assert.deepEqual(await prepare(unknown.analysisId, unbound), result(unknown, unbound, 'selection_unverified'));
  assert.deepEqual(await prepare(keyed.analysisId, legacySnapshot), result(keyed, legacySnapshot, 'selection_unverified'));

  const wrongEdition = await capture(owner);
  await db.exec('reset role');
  await db.query(`update public.analysis_input_snapshots set edition = 'conflicting-synthetic-edition' where id = $1`, [wrongEdition]);
  await setCaller('authenticated', owner.userId);
  assert.deepEqual(await prepare(owner.analysisId, wrongEdition), result(owner, wrongEdition, 'selection_unverified'));

  for (const adjust of [
    replay => { replay.catalog.notice.status = 'partially_collected'; },
    replay => { replay.catalog.notice.evidence = []; },
    replay => { replay.catalog.notice.reasons = ['row_out_of_scope']; },
    replay => { replay.catalog.collections.notice.status = 'partial'; },
    replay => { replay.catalog.collections.notice.inScope = 0; },
    replay => { replay.catalog.issues.push({ code: 'row_out_of_scope', collection: 'notice' }); },
    replay => {
      const coverage = replay.catalogCollections.find(collection => collection.source === apt);
      coverage.status = 'partial';
      coverage.reasons = ['total_count_mismatch'];
      replay.catalog.collections.notice.declaredStatus = 'partial';
      replay.catalog.collections.notice.status = 'partial';
    },
  ]) {
    const snapshot = await capture(owner, { adjust });
    await setCaller('authenticated', owner.userId);
    assert.deepEqual(await prepare(owner.analysisId, snapshot), result(owner, snapshot, 'selection_unverified'));
  }
  assert.equal(await counter(owner.userId), undefined);
});

test('holds ambiguous addresses and missing, conflicted or reason-marked official address fields', async () => {
  await permitCollection();
  await permitNaver();
  const owner = await makeAnalysis();
  for (const address of ['', null, {}, 42, '광진구 가람동 999', '서울특별시 가람동 999', '서울특별시 없는구 가람동 999',
    '서울특별시 남구 가람동 999', '경기도 수정구 가람동 999', '경기도 수원시 분당구 가람동 999',
    '인천광역시 중구 가람동 999', '광주광역시 광산구 가람동 999', '서울특별시 광진구 및 성동구와 접한 가람동 999',
    '서울특별시 광진구 (성동구) 가람동 999', '서울특별시 광진구 가람동 999 / 다른 주소', '세종특별자치시 서울',
    '경기도 가람신도시 가람로 999', '서울특별시 광진구\n부산광역시 해운대구 가람로 999']) {
    const snapshot = await capture(owner, { adjust: replay => { replay.catalog.notice.fields.HSSPLY_ADRES.value = address; } });
    await setCaller('authenticated', owner.userId);
    assert.deepEqual(await prepare(owner.analysisId, snapshot), result(owner, snapshot, 'region_unverified'), String(address));
  }
  for (const adjust of [
    replay => { delete replay.catalog.notice.fields.HSSPLY_ADRES; },
    replay => { replay.catalog.notice.fields.HSSPLY_ADRES.status = 'conflict'; },
    replay => { replay.catalog.notice.fields.HSSPLY_ADRES.reasons = ['address_conflict']; },
    replay => { replay.catalog.notice.fields.HSSPLY_ADRES.values = [roadAddress, '부산광역시 해운대구 가람로 123']; },
    replay => { replay.catalog.issues.push({ code: 'notice_field_conflict', field: 'HSSPLY_ADRES' }); },
  ]) {
    const snapshot = await capture(owner, { adjust });
    await setCaller('authenticated', owner.userId);
    assert.deepEqual(await prepare(owner.analysisId, snapshot), result(owner, snapshot, 'region_unverified'));
  }
  assert.equal(await counter(owner.userId), undefined);
});

test('enforces notice and region source rights and requires only explicit news display permission', async () => {
  await permitCollection();
  const owner = await makeAnalysis();
  const snapshot = await capture(owner);
  await setCaller('authenticated', owner.userId);
  assert.deepEqual(await prepare(owner.analysisId, snapshot), result(owner, snapshot, 'source_restricted'));
  await permitNaver();

  for (const [source, column, held, restore] of [
    [apt, 'storage_permission', 'denied', 'allowed'], [apt, 'reuse_permission', 'unknown', 'allowed'],
    [apt, 'display_permission', 'denied', 'allowed'], [apt, 'retention_days', 1, null],
    [regionSource, 'storage_permission', 'unknown', 'allowed'], [regionSource, 'display_permission', 'denied', 'allowed'],
    [regionSource, 'reuse_permission', 'denied', 'allowed'], [regionSource, 'retention_days', 1, null],
    [naver, 'display_permission', 'unknown', 'allowed'], [naver, 'display_permission', 'denied', 'allowed'],
  ]) {
    await db.exec('reset role');
    await db.query(`update public.source_registry set ${column} = $1 where id = $2`, [held, source]);
    await setCaller('authenticated', owner.userId);
    assert.deepEqual(await prepare(owner.analysisId, snapshot), result(owner, snapshot, 'source_restricted'));
    await db.exec('reset role');
    await db.query(`update public.source_registry set ${column} = $1 where id = $2`, [restore, source]);
  }
  assert.equal(await counter(owner.userId), undefined);
  for (const source of [apt, regionSource]) {
    await db.query('delete from public.source_registry where id = $1', [source]);
    await setCaller('authenticated', owner.userId);
    assert.deepEqual(await prepare(owner.analysisId, snapshot), result(owner, snapshot, 'source_restricted'));
    await permitCollection();
  }
  await db.query(`update public.source_registry set storage_permission = 'unknown',
    reuse_permission = 'denied',display_permission = 'denied' where id = any($1::text[])`, [[apt + '_model', ...unrelatedSources]]);
  await setCaller('authenticated', owner.userId);
  assert.deepEqual(await prepare(owner.analysisId, snapshot), result(owner, snapshot, 'ready', '서울특별시 광진구'));
});

test('bounds ready attempts per user and window, preserves holds and cascades on account removal', async () => {
  await permitCollection();
  await permitNaver();
  const owner = await makeAnalysis();
  const sibling = await makeAnalysis({ userId: owner.userId });
  const stranger = await makeAnalysis();
  const snapshot = await capture(owner);
  const siblingSnapshot = await capture(sibling);
  const strangerSnapshot = await capture(stranger);
  const syntheticSnapshot = await capture(owner, { origin: 'synthetic' });

  await setCaller('authenticated', owner.userId);
  // PGlite 큐에 동시에 제출한다. Postgres 기동 환경에서는 같은 upsert가 사용자 기본키를 잠근다.
  const attempts = await Promise.all(Array.from({ length: 6 }, (_, index) => index < 3
    ? prepare(owner.analysisId, snapshot) : prepare(sibling.analysisId, siblingSnapshot)));
  assert.ok(attempts.every(attempt => attempt.status === 'ready'));
  await assert.rejects(prepare(owner.analysisId, snapshot), limited);
  assert.deepEqual(await prepare(owner.analysisId, syntheticSnapshot), result(owner, syntheticSnapshot, 'synthetic_input'));
  assert.deepEqual(await counter(owner.userId), { attempts: 6 });

  await setCaller('authenticated', stranger.userId);
  assert.deepEqual(await prepare(stranger.analysisId, strangerSnapshot), result(stranger, strangerSnapshot, 'ready', '서울특별시 광진구'));
  assert.deepEqual(await counter(stranger.userId), { attempts: 1 });
  await db.query(`update private.regional_news_attempts set window_start = window_start - interval '1 minute' where user_id = $1`, [owner.userId]);
  await setCaller('authenticated', owner.userId);
  assert.deepEqual(await prepare(owner.analysisId, snapshot), result(owner, snapshot, 'ready', '서울특별시 광진구'));
  assert.deepEqual(await counter(owner.userId), { attempts: 1 });

  await db.query('delete from auth.users where id = $1', [owner.userId]);
  assert.equal(await counter(owner.userId), undefined);
  await setCaller('authenticated', owner.userId);
  await assert.rejects(prepare(owner.analysisId, snapshot), authRequired);
});
