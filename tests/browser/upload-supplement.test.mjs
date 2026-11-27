// 공식 PDF 확보 실패·판본 미확인 시 '공고 PDF로 보완' 패널의 업로드→접수→진행→새 결과(출처 표기)·보류·재시도·반응형(1440px/390px) 흐름을 검증한다.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { createDevServer } from '../../dev/server.ts';
import { serveWorkspace } from '../../dev/static.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYNTHETIC_PDF = Buffer.from('%PDF-1.4\n%synthetic notice upload\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'utf8');

let server, browser, origin, comparisonFixture;

before(async () => {
  comparisonFixture = JSON.parse(
    await readFile(new URL('../../public/app/assets/comparison-example.json', import.meta.url), 'utf8'),
  );
  const config = { supabaseUrl: 'https://synthetic.invalid', publishableKey: 'sb_publishable_TEST_ONLY' };
  const api = async (request) =>
    new URL(request.url).pathname === '/api/v1/client-config'
      ? Response.json(config)
      : Response.json({ error: 'authentication_required' }, { status: 401 });
  server = createDevServer((request) => serveWorkspace(request, api));
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  origin = 'http://127.0.0.1:' + server.address().port;
  const executablePath =
    process.env.CHROME_BIN ||
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : '/usr/bin/google-chrome');
  browser = await chromium.launch({ executablePath, headless: true });
});

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
});

async function installMockSupabase(context, owner, analyses) {
  await context.addInitScript(
    ({ user, rows }) => {
      window.__uploadCalls = { register: [], storage: [] };
      const auth = {
        getSession: async () => ({
          data: { session: { user, access_token: 'TOKEN_' + user.id } },
          error: null,
        }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      };
      const query = {
        select() { return this; },
        eq() { return this; },
        not() { return this; },
        order() { return this; },
        limit: async () => ({ data: rows, error: null }),
      };
      globalThis.supabase = {
        createClient: () => ({
          auth,
          from: () => query,
          rpc: (name, args) => {
            const p = Promise.resolve().then(() => {
              if (name === 'register_analysis_upload') {
                window.__uploadCalls.register.push(args);
                return {
                  data: {
                    id: args.upload_id,
                    user_id: user.id,
                    analysis_id: args.analysis_id,
                    object_path: `${user.id}/${args.analysis_id}/${args.upload_id}.pdf`,
                    status: 'registered',
                  },
                  error: null,
                };
              }
              return { data: null, error: { code: 'PT404', message: 'unexpected_rpc' } };
            });
            p.setHeader = () => p;
            p.abortSignal = () => p;
            return p;
          },
          storage: {
            from: (bucket) => ({
              upload: async (path, file, options) => {
                window.__uploadCalls.storage.push({
                  bucket,
                  path,
                  size: file?.size ?? 0,
                  type: file?.type ?? '',
                  options,
                });
                return { data: { path }, error: null };
              },
            }),
          },
        }),
      };
    },
    { user: owner, rows: analyses },
  );
}

function makeHeldComparison() {
  const held = structuredClone(comparisonFixture);
  held.dataOrigin = 'collected';
  held.completeness = 'unavailable';
  held.appliedScope = null;
  held.rankingComplete = false;
  held.target.supplyArea = { status: 'unverified', basis: 'supply', m2: null, evidence: [] };
  held.noticePrice = {
    status: 'unverified',
    scope: 'selected_room',
    room: '101동 101호',
    reasons: ['no_confirmed_room_subtotal'],
    confirmedRooms: [],
    heldRooms: [],
  };
  held.comparables = [];
  held.targetReferences = [];
  held.holds = [
    { subject: 'selection', reasonCode: 'target_supply_area_unverified' },
    { subject: 'selection', reasonCode: 'no_confirmed_room_subtotal' },
  ];
  return held;
}

function makeSupplementedComparison(uploadId, hash) {
  const ok = structuredClone(comparisonFixture);
  const docId = `upload:${uploadId}`;
  const version = `sha256:${hash}`;
  ok.dataOrigin = 'collected';
  ok.target.supplyArea = {
    status: 'confirmed',
    basis: 'supply',
    m2: '112.40',
    evidence: [{ document: docId, version, page: 1 }],
  };
  ok.noticePrice = {
    status: 'confirmed',
    scope: 'selected_room',
    room: '101동 101호',
    basis: 'sale_price_plus_required_options',
    won: '710000000',
    confirmedRooms: [{
      room: '101동 101호',
      salePriceWon: '700000000',
      requiredOptionsWon: '10000000',
      subtotalWon: '710000000',
      evidence: {
        salePrice: [{ document: docId, version, page: 2 }],
        requiredOptions: [{ document: docId, version, page: 3 }],
      },
    }],
    heldRooms: [],
  };
  return ok;
}

for (const width of [1440, 390]) {
  test(`held result displays upload-supplement panel, uploads PDF, polls to finished result with upload provenance at ${width}px`, async () => {
    const owner = { id: 'a1000000-0000-4000-8000-000000000001', email: 'owner@example.invalid' };
    const aid = 'a1000000-0000-4000-8000-000000000010';
    const baseRunId = 'a1000000-0000-4000-8000-000000000011';
    const nextRunId = 'a1000000-0000-4000-8000-000000000012';
    const snap1 = 'a1000000-0000-4000-8000-000000000013';
    const snap2 = 'a1000000-0000-4000-8000-000000000014';
    const fakeHash = 'a'.repeat(64);

    const ctx = await browser.newContext({ viewport: { width, height: 900 } });
    await installMockSupabase(ctx, owner, [
      { id: aid, latest_run_id: baseRunId, title: '합성 가람 아파트', status: 'partial', updated_at: '2026-11-26T01:00:00Z' },
    ]);

    const heldComparison = makeHeldComparison();
    let enqueuedPayload = null;
    let enqueuedKey = null;
    let pollCount = 0;

    await ctx.route('**/*', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin !== origin) return route.abort();
      const p = url.pathname;

      if (p === `/api/v1/analyses/${aid}/runs/${baseRunId}`) {
        return route.fulfill({
          json: {
            analysisId: aid,
            runId: baseRunId,
            snapshotId: snap1,
            status: 'finished',
            attempt: 1,
            submittedAt: '2026-11-26T01:00:00Z',
            finishedAt: '2026-11-26T01:01:00Z',
            errorCode: null,
            input: {
              kind: 'notice',
              noticeSource: 'applyhome_apt',
              houseManageNo: '9900000001',
              noticeNo: '9900000042',
              edition: '2026-10-05',
              modelNo: '01',
            },
          },
        });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${baseRunId}/result`) {
        return route.fulfill({ json: { analysisId: aid, runId: baseRunId, snapshotId: snap1, rulesVersion: 'v0', result: heldComparison } });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${baseRunId}/conversation` || p === `/api/v1/analyses/${aid}/runs/${nextRunId}/conversation`) {
        return route.fulfill({ json: { analysisId: aid, runId: p.includes(nextRunId) ? nextRunId : baseRunId, turns: [], previousRunId: null } });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${baseRunId}/upload-supplement` && req.method() === 'GET') {
        return route.fulfill({
          json: {
            contractVersion: 'upload-supplement-context/v1',
            analysisId: aid,
            runId: baseRunId,
            runStatus: 'finished',
            snapshotId: snap1,
            eligible: true,
            needsSupplement: true,
            target: {
              title: '합성 가람 아파트',
              noticeSource: 'applyhome_apt',
              houseManageNo: '9900000001',
              noticeNo: '9900000042',
              edition: '2026-10-05',
              modelNo: '01',
              houseType: '084.0000A',
              room: '101동 101호',
            },
            reasonCodes: ['attachment_not_found', 'target_supply_area_unverified', 'no_confirmed_room_subtotal'],
            documents: [],
            issues: [{ code: 'attachment_not_found', stage: 'document_acquisition', modelNo: null, houseType: null, room: null, item: null }],
            currentSupplement: null,
            recentSupplements: [],
            uploadRules: { bucket: 'analysis-uploads', accept: 'application/pdf', maxBytes: 50 * 1024 * 1024, sameNoticeRequired: true },
          },
        });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${baseRunId}/upload-supplement` && req.method() === 'POST') {
        enqueuedPayload = JSON.parse(req.postData() || '{}');
        enqueuedKey = req.headers()['idempotency-key'];
        return route.fulfill({
          status: 202,
          headers: { Location: `/api/v1/analyses/${aid}/upload-supplements/${nextRunId}` },
          json: {
            contractVersion: 'upload-supplement-run/v1',
            runId: nextRunId,
            analysisId: aid,
            baseRunId,
            uploadId: enqueuedPayload.uploadId,
            status: 'queued',
            attempt: 0,
            submittedAt: '2026-11-26T01:02:00Z',
            finishedAt: null,
            snapshotId: null,
            errorCode: null,
            input: {
              kind: 'upload_supplement',
              baseRunId,
              uploadId: enqueuedPayload.uploadId,
              noticeSource: 'applyhome_apt',
              houseManageNo: '9900000001',
              noticeNo: '9900000042',
              edition: '2026-10-05',
              modelNo: '01',
            },
            documents: [],
            issues: [],
          },
        });
      }
      if (p === `/api/v1/analyses/${aid}/upload-supplements/${nextRunId}`) {
        pollCount += 1;
        const done = pollCount >= 1;
        return route.fulfill({
          json: {
            contractVersion: 'upload-supplement-run/v1',
            runId: nextRunId,
            analysisId: aid,
            baseRunId,
            uploadId: enqueuedPayload.uploadId,
            status: done ? 'finished' : 'running',
            attempt: 1,
            submittedAt: '2026-11-26T01:02:00Z',
            finishedAt: done ? '2026-11-26T01:02:05Z' : null,
            snapshotId: done ? snap2 : null,
            errorCode: null,
            input: {
              kind: 'upload_supplement',
              baseRunId,
              uploadId: enqueuedPayload.uploadId,
              noticeSource: 'applyhome_apt',
              houseManageNo: '9900000001',
              noticeNo: '9900000042',
              edition: '2026-10-05',
              modelNo: '01',
            },
            documents: done ? [{
              id: `upload:${enqueuedPayload.uploadId}`,
              version: `sha256:${fakeHash}`,
              source: 'upload',
              originCheck: 'confirmed',
              status: 'accepted',
              reasons: [],
              houseManageNo: '9900000001',
              noticeNo: '9900000042',
              edition: '2026-10-05',
            }] : [],
            issues: [],
          },
        });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${nextRunId}`) {
        return route.fulfill({
          json: {
            analysisId: aid,
            runId: nextRunId,
            snapshotId: snap2,
            status: 'finished',
            attempt: 1,
            submittedAt: '2026-11-26T01:02:00Z',
            finishedAt: '2026-11-26T01:02:05Z',
            errorCode: null,
            input: {
              kind: 'upload_supplement',
              baseRunId,
              uploadId: enqueuedPayload.uploadId,
              noticeSource: 'applyhome_apt',
              houseManageNo: '9900000001',
              noticeNo: '9900000042',
              edition: '2026-10-05',
              modelNo: '01',
            },
          },
        });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${nextRunId}/result`) {
        return route.fulfill({
          json: {
            analysisId: aid,
            runId: nextRunId,
            snapshotId: snap2,
            rulesVersion: 'v0',
            result: makeSupplementedComparison(enqueuedPayload.uploadId, fakeHash),
          },
        });
      }
      if (p === `/api/v1/analyses/${aid}/runs/${nextRunId}/upload-supplement`) {
        return route.fulfill({
          json: {
            contractVersion: 'upload-supplement-context/v1',
            analysisId: aid,
            runId: nextRunId,
            runStatus: 'finished',
            snapshotId: snap2,
            eligible: true,
            needsSupplement: false,
            target: {
              title: '합성 가람 아파트',
              noticeSource: 'applyhome_apt',
              houseManageNo: '9900000001',
              noticeNo: '9900000042',
              edition: '2026-10-05',
              modelNo: '01',
              houseType: '084.0000A',
              room: '101동 101호',
            },
            reasonCodes: [],
            documents: [{
              id: `upload:${enqueuedPayload.uploadId}`,
              version: `sha256:${fakeHash}`,
              source: 'upload',
              originCheck: 'confirmed',
              status: 'accepted',
              reasons: [],
              houseManageNo: '9900000001',
              noticeNo: '9900000042',
              edition: '2026-10-05',
            }],
            issues: [],
            currentSupplement: { uploadId: enqueuedPayload.uploadId, baseRunId },
            recentSupplements: [],
            uploadRules: { bucket: 'analysis-uploads', accept: 'application/pdf', maxBytes: 50 * 1024 * 1024, sameNoticeRequired: true },
          },
        });
      }
      if (p === '/api/v1/notices') {
        return route.fulfill({
          json: {
            contractVersion: 'notice-directory/v1',
            dataOrigin: 'collected',
            observedAt: '2026-11-26T00:00:00Z',
            asOf: '2026-11-26',
            counts: { open: 0, upcoming: 0, closed: 0, unknown: 0 },
            page: { offset: 0, limit: 50, nextCursor: null },
            notices: [],
          },
        });
      }
      return route.continue();
    });

    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(`${origin}/#run/${aid}/${baseRunId}`, { waitUntil: 'networkidle' });
    await page.locator('#upload-supp-title').waitFor({ state: 'visible' });

    const panelText = await page.locator('.upload-supp-panel').innerText();
    assert.match(panelText, /공고 PDF로 보완/);
    assert.match(panelText, /모집공고문 첨부를 찾지 못했습니다/);
    assert.match(panelText, /9900000042/);
    assert.match(panelText, /2026\.10\.05/);
    assert.match(panelText, /50 MiB/);
    assert.match(panelText, /공식성이나 값의 정확성을 확정하지 않습니다/);

    // 가로 넘침 없음 확인
    const overflowBefore = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflowBefore, false, `horizontal overflow before upload at ${width}px`);

    // 비PDF 파일은 거부되며 전송되지 않는다.
    await page.setInputFiles('#upload-supplement-file', {
      name: 'not-a-pdf.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('plain text'),
    });
    await page.locator('.upload-supp-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#upload-supplement-form button[type="submit"]').isDisabled(), true);

    // 정상 합성 PDF 선택 후 취소 시 업로드되지 않는다.
    await page.setInputFiles('#upload-supplement-file', {
      name: 'synthetic-notice.pdf',
      mimeType: 'application/pdf',
      buffer: SYNTHETIC_PDF,
    });
    await page.locator('[data-upload-supp="clear"]').click();
    assert.equal((await page.evaluate(() => window.__uploadCalls.register.length)), 0);

    // 다시 PDF 선택 후 점검 요청 실행
    await page.setInputFiles('#upload-supplement-file', {
      name: 'synthetic-notice.pdf',
      mimeType: 'application/pdf',
      buffer: SYNTHETIC_PDF,
    });
    await page.locator('#upload-supplement-form button[type="submit"]').click();

    // 새 결과(#run/aid/nextRunId)로 자동 이동 후 업로드 출처 표기 확인
    await page.waitForFunction((expectedHash) => location.hash === expectedHash, `#run/${aid}/${nextRunId}`, { timeout: 10000 });
    await page.locator('.upload-supp-panel.is-verified').waitFor({ state: 'visible' });

    // 브라우저는 uploadId 단일 필드만 전송하고 해시·채택 필드를 보내지 않는다.
    assert.deepEqual(Object.keys(enqueuedPayload), ['uploadId']);
    assert.match(enqueuedPayload.uploadId, UUID_RE);
    assert.match(enqueuedKey, UUID_RE);

    // 기존 비공개 버킷 계약(register_analysis_upload + analysis-uploads + cacheControl:'0' + upsert:false) 준수 확인
    const calls = await page.evaluate(() => window.__uploadCalls);
    assert.equal(calls.register.length, 1);
    assert.equal(calls.storage.length, 1);
    assert.equal(calls.storage[0].bucket, 'analysis-uploads');
    assert.deepEqual(calls.storage[0].options, { contentType: 'application/pdf', cacheControl: '0', upsert: false });

    // 값별 근거에 '사용자 업로드 · 파일 ID · 판본 해시 · 쪽'이 표시된다.
    const evidenceDetails = page.locator('.result-evidence details.evidence-disclosure');
    await evidenceDetails.locator('summary').click();
    const evText = await evidenceDetails.innerText();
    assert.match(evText, new RegExp(`사용자 업로드 · ${enqueuedPayload.uploadId} · sha256:${fakeHash} · 1쪽`));

    const overflowAfter = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflowAfter, false, `horizontal overflow after upload at ${width}px`);
    assert.deepEqual(errors, []);
    await ctx.close();
  });
}

test('enqueue failure after storage upload retries with identical uploadId and Idempotency-Key without re-uploading, and rejected upload preserves hold reasons', async () => {
  const owner = { id: 'b2000000-0000-4000-8000-000000000001', email: 'retry@example.invalid' };
  const aid = 'b2000000-0000-4000-8000-000000000010';
  const baseRunId = 'b2000000-0000-4000-8000-000000000011';
  const rejectedRunId = 'b2000000-0000-4000-8000-000000000012';
  const snap1 = 'b2000000-0000-4000-8000-000000000013';
  const snap2 = 'b2000000-0000-4000-8000-000000000014';

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await installMockSupabase(ctx, owner, []);

  const heldComparison = makeHeldComparison();
  const postAttempts = [];

  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== origin) return route.abort();
    const p = url.pathname;

    if (p === `/api/v1/analyses/${aid}/runs/${baseRunId}` || p === `/api/v1/analyses/${aid}/runs/${rejectedRunId}`) {
      const isNext = p.endsWith(rejectedRunId);
      return route.fulfill({
        json: {
          analysisId: aid,
          runId: isNext ? rejectedRunId : baseRunId,
          snapshotId: isNext ? snap2 : snap1,
          status: 'finished',
          attempt: 1,
          submittedAt: '2026-11-26T01:00:00Z',
          finishedAt: '2026-11-26T01:01:00Z',
          errorCode: null,
          input: { kind: 'notice', noticeSource: 'applyhome_apt', houseManageNo: '9900000001', noticeNo: '9900000042', edition: '2026-10-05', modelNo: '01' },
        },
      });
    }
    if (p.endsWith('/result')) {
      return route.fulfill({ json: { analysisId: aid, runId: p.includes(rejectedRunId) ? rejectedRunId : baseRunId, snapshotId: p.includes(rejectedRunId) ? snap2 : snap1, rulesVersion: 'v0', result: heldComparison } });
    }
    if (p.endsWith('/conversation')) {
      return route.fulfill({ json: { analysisId: aid, runId: baseRunId, turns: [], previousRunId: null } });
    }
    if (p === `/api/v1/analyses/${aid}/runs/${baseRunId}/upload-supplement` && req.method() === 'GET') {
      return route.fulfill({
        json: {
          contractVersion: 'upload-supplement-context/v1',
          analysisId: aid,
          runId: baseRunId,
          runStatus: 'finished',
          snapshotId: snap1,
          eligible: true,
          needsSupplement: true,
          target: { title: '합성 가람 아파트', noticeSource: 'applyhome_apt', houseManageNo: '9900000001', noticeNo: '9900000042', edition: '2026-10-05', modelNo: '01', houseType: '084.0000A', room: '101동 101호' },
          reasonCodes: ['detail_not_found'],
          documents: [],
          issues: [],
          currentSupplement: null,
          recentSupplements: [],
          uploadRules: { bucket: 'analysis-uploads', accept: 'application/pdf', maxBytes: 50 * 1024 * 1024, sameNoticeRequired: true },
        },
      });
    }
    if (p === `/api/v1/analyses/${aid}/runs/${baseRunId}/upload-supplement` && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      postAttempts.push({ uploadId: body.uploadId, key: req.headers()['idempotency-key'] });
      if (postAttempts.length === 1) {
        return route.fulfill({ status: 503, json: { error: 'backend_unavailable' } });
      }
      return route.fulfill({
        status: 202,
        json: {
          contractVersion: 'upload-supplement-run/v1',
          runId: rejectedRunId,
          analysisId: aid,
          baseRunId,
          uploadId: body.uploadId,
          status: 'finished',
          attempt: 1,
          submittedAt: '2026-11-26T01:02:00Z',
          finishedAt: '2026-11-26T01:02:02Z',
          snapshotId: snap2,
          errorCode: null,
          input: { kind: 'upload_supplement', baseRunId, uploadId: body.uploadId, noticeSource: 'applyhome_apt', houseManageNo: '9900000001', noticeNo: '9900000042', edition: '2026-10-05', modelNo: '01' },
          documents: [{
            id: `upload:${body.uploadId}`,
            version: `sha256:${'c'.repeat(64)}`,
            source: 'upload',
            originCheck: 'conflict',
            status: 'rejected',
            reasons: ['upload_matches_other_notice'],
            houseManageNo: '9900000001',
            noticeNo: '9900000042',
            edition: '2026-10-05',
          }],
          issues: [],
        },
      });
    }
    if (p === `/api/v1/analyses/${aid}/runs/${rejectedRunId}/upload-supplement` && req.method() === 'GET') {
      const uid = postAttempts[0].uploadId;
      return route.fulfill({
        json: {
          contractVersion: 'upload-supplement-context/v1',
          analysisId: aid,
          runId: rejectedRunId,
          runStatus: 'finished',
          snapshotId: snap2,
          eligible: true,
          needsSupplement: true,
          target: { title: '합성 가람 아파트', noticeSource: 'applyhome_apt', houseManageNo: '9900000001', noticeNo: '9900000042', edition: '2026-10-05', modelNo: '01', houseType: '084.0000A', room: '101동 101호' },
          reasonCodes: ['upload_matches_other_notice'],
          documents: [{
            id: `upload:${uid}`,
            version: `sha256:${'c'.repeat(64)}`,
            source: 'upload',
            originCheck: 'conflict',
            status: 'rejected',
            reasons: ['upload_matches_other_notice'],
            houseManageNo: '9900000001',
            noticeNo: '9900000042',
            edition: '2026-10-05',
          }],
          issues: [],
          currentSupplement: { uploadId: uid, baseRunId },
          recentSupplements: [],
          uploadRules: { bucket: 'analysis-uploads', accept: 'application/pdf', maxBytes: 50 * 1024 * 1024, sameNoticeRequired: true },
        },
      });
    }
    if (p === '/api/v1/notices') {
      return route.fulfill({
        json: { contractVersion: 'notice-directory/v1', dataOrigin: 'collected', observedAt: '2026-11-26T00:00:00Z', asOf: '2026-11-26', counts: { open: 0, upcoming: 0, closed: 0, unknown: 0 }, page: { offset: 0, limit: 50, nextCursor: null }, notices: [] },
      });
    }
    return route.continue();
  });

  const page = await ctx.newPage();
  await page.goto(`${origin}/#run/${aid}/${baseRunId}`, { waitUntil: 'networkidle' });
  await page.locator('#upload-supp-title').waitFor({ state: 'visible' });
  await page.setInputFiles('#upload-supplement-file', {
    name: 'other-round.pdf',
    mimeType: 'application/pdf',
    buffer: SYNTHETIC_PDF,
  });
  await page.locator('#upload-supplement-form button[type="submit"]').click();
  await page.locator('.upload-supp-error').waitFor({ state: 'visible' });

  // 재시도 클릭 시 저장소에 중복 업로드하지 않고 같은 uploadId + Idempotency-Key로 접수한다.
  await page.locator('#upload-supplement-form button[type="submit"]').click();
  await page.waitForFunction((expectedHash) => location.hash === expectedHash, `#run/${aid}/${rejectedRunId}`, { timeout: 10000 });
  await page.locator('.upload-supp-docs').waitFor({ state: 'visible' });

  assert.equal(postAttempts.length, 2);
  assert.deepEqual(postAttempts[1], postAttempts[0]);
  const calls = await page.evaluate(() => window.__uploadCalls);
  assert.equal(calls.storage.length, 1);

  const rejectedText = await page.locator('.upload-supp-panel').innerText();
  assert.match(rejectedText, /반영 거부/);
  assert.match(rejectedText, /다른 공고 또는 다른 회차/);
  assert.match(await page.locator('h1').innerText(), /합성 가람 아파트/);
  await ctx.close();
});
