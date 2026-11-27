// 실제 로그인한 두 검수 계정과 같은 합성 분석으로 보고서의 저장·다른 세션 복원·PDF·삭제를 확인한다.
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// 상시 작업자가 먼저 인수할 수 있는 개발 환경에서는 이 검수가 만든 실행 하나의 결과만 기다린다.
export async function finishReportFixture({ owner, snapshotId, config, requestApi, check, result, workerOnce }) {
  const run = result(
    await owner.client.rpc('enqueue_analysis_run', {
      p_analysis_id: owner.analysisId,
      p_idempotency_key: randomUUID(),
      p_input: { kind: 'snapshot', snapshotId },
    }),
    'report_queue',
  );
  const execution = await workerOnce(config, run.runId, check, 'report_worker');
  check(['idle', 'finished'].includes(execution.status), 'report_worker_status');
  const path = '/api/v1/analyses/' + owner.analysisId + '/runs/' + run.runId + '/result';
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const reply = await requestApi(path, { headers: { Authorization: 'Bearer ' + owner.accessToken } });
    if (reply.ok) {
      const comparison = await reply.json();
      check(
        comparison.snapshotId === snapshotId && comparison.analysisId === owner.analysisId,
        'report_fixture_bound',
      );
      return comparison;
    }
    check(reply.status === 409, 'report_fixture_read');
    await reply.body?.cancel();
    await delay(400);
  }
  check(false, 'report_fixture_timeout');
}

export async function checkSavedReports({ owner, peer, saved, requestApi, freshToken, check, whileSaved }) {
  const savePath = '/api/v1/analyses/' + owner.analysisId + '/runs/' + saved.runId + '/reports';
  const request = (path, token, method = 'GET', body) =>
    requestApi(path, {
      method,
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const id = randomUUID();
  const save = () => request(savePath, owner.accessToken, 'POST', { requestId: id });
  const both = await Promise.all([save(), save()]);
  check(
    both.every((reply) => reply.status === 201),
    'report_concurrent_save',
  );
  const [first, second] = await Promise.all(both.map((reply) => reply.json()));
  check(
    isDeepStrictEqual(first, second) &&
      first.contractVersion === 'saved-report/v1' &&
      first.snapshotId === saved.snapshotId &&
      first.runId === saved.runId &&
      first.analysisId === owner.analysisId &&
      first.dataOrigin === 'synthetic' &&
      first.sections.length === 7,
    'report_one_version',
  );
  const detail = '/api/v1/reports/' + first.reportId;
  const list = async (token) => {
    const reply = await request('/api/v1/reports', token);
    check(reply.ok, 'report_list');
    return (await reply.json()).reports;
  };
  check(
    (await list(owner.accessToken)).filter((r) => r.reportId === first.reportId).length === 1,
    'report_visible_once',
  );
  check(!(await list(peer.accessToken)).some((r) => r.reportId === first.reportId), 'report_other_list');
  for (const [path, method] of [
    [detail, 'GET'],
    [detail + '/pdf', 'GET'],
    [detail, 'DELETE'],
  ])
    check((await request(path, peer.accessToken, method)).status === 404, 'report_other_owner');
  if (whileSaved) await whileSaved(first);
  const token = await freshToken(owner);
  const restored = await request(detail, token);
  check(restored.ok && isDeepStrictEqual(first, await restored.json()), 'report_same_after_relogin');
  const download = await request(detail + '/pdf', token);
  check(
    download.ok &&
      download.headers.get('content-type') === 'application/pdf' &&
      download.headers.get('cache-control')?.includes('no-store'),
    'report_pdf_response',
  );
  const bytes = Buffer.from(await download.arrayBuffer());
  check(
    bytes.subarray(0, 5).toString() === '%PDF-' && bytes.subarray(-32).toString().includes('%%EOF'),
    'report_pdf_file',
  );
  check((await request(detail, token, 'DELETE')).status === 204, 'report_delete');
  check((await save()).status === 409, 'report_deleted_request_not_recreated');
  for (const path of [detail, detail + '/pdf'])
    check((await request(path, token)).status === 404, 'report_deleted_read');
  check(!(await list(token)).some((r) => r.reportId === first.reportId), 'report_deleted_list');
  const original = await request(
    '/api/v1/analyses/' + owner.analysisId + '/runs/' + saved.runId + '/result',
    token,
  );
  check(original.ok && isDeepStrictEqual(await original.json(), saved), 'report_original_run');
}

export async function openReportInBrowser(page, report, check) {
  const origin = new URL(page.url()).origin;
  await page.goto(origin + '/#reports');
  await page.locator('a.report-card-link[href="#reports/' + report.reportId + '"]').click();
  await page.getByRole('heading', { level: 1, name: report.title, exact: true }).waitFor();
  for (const section of report.sections) {
    const node = page.locator('.report-section[data-section-id="' + section.id + '"]');
    check((await node.getAttribute('data-section-state')) === section.state, 'report_browser_section_status');
    for (const { value } of section.rows) {
      check((await node.innerText()).includes(value), 'report_browser_saved_value');
    }
  }
  const pending = page.waitForEvent('download');
  await page.locator('[data-report="download-pdf"]').first().click();
  const download = await pending;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  check(Buffer.concat(chunks).subarray(0, 5).toString() === '%PDF-', 'report_browser_pdf_file');
  await download.delete();
}
