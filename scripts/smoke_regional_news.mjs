// 실제 Auth·PostgREST는 격리된 Supabase를 쓰고, 외부 뉴스 응답은 합성으로 제공한다.
import { randomUUID } from 'node:crypto';

export async function syntheticNewsFetch(input, init) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.origin !== 'https://naverapihub.apigw.ntruss.com' || url.pathname !== '/search/v1/news'
    || url.searchParams.get('query') !== '서울특별시 광진구 분양' || request.headers.has('authorization')) {
    throw new Error('be10_unexpected_provider_request');
  }
  return Response.json({ total: 1, start: 1, display: 1, lastBuildDate: 'Mon, 02 Nov 2026 09:00:00 +0900',
    items: [{ title: '합성 뉴스 제목', description: '합성 검색 발췌', originallink: 'https://example.org/article/1',
      pubDate: 'Mon, 02 Nov 2026 08:00:00 +0900' }] });
}

export async function checkRegionalNews({ config, accounts, admin, capture, requestApi, check, result }) {
  check(['localhost', '127.0.0.1'].includes(new URL(config.origin).hostname), 'be10_ephemeral_database_required');
  const [owner, peer] = accounts;
  const target = { ...capture.input.target, noticeSource: capture.input.noticeSource };
  const { id } = result(await owner.client.from('analyses').insert({
    user_id: owner.id, chat_id: owner.chatId, conditions_snapshot: { ingestion_target: target },
  }).select('id').single(), 'be10_analysis');
  const sample = structuredClone(capture.original);
  sample.dataOrigin = 'collected'; // 합성 공고로 실수집 판정 경로를 검사한다.
  sample.catalog.notice.fields.HSSPLY_ADRES.value = '서울특별시 광진구 합성로 1';
  const snapshot = result(await admin.rpc('save_ingestion_snapshot', { p_analysis_id: id, p_user_id: owner.id,
    p_capture_key: randomUUID(), p_input: capture.input, p_result: sample }), 'be10_snapshot');
  const path = `/api/v1/analyses/${id}/snapshots/${snapshot}/regional-news`;
  const read = account => requestApi(path, { method: 'POST', headers: { Authorization: 'Bearer ' + account.accessToken } });
  const initial = await read(owner);
  check(initial.status === 200 && (await initial.json()).status === 'source_restricted', 'be10_unknown_rights');
  result(await admin.from('source_registry').insert({ id: 'naver_news', display_name: '합성 검색결과', display_permission: 'allowed' }),
    'be10_display_only');
  check((await read(peer)).status === 404, 'be10_other_account');
  const res = await read(owner);
  check(res.status === 200 && res.headers.get('cache-control') === 'private, no-store', 'be10_news_http');
  const news = await res.json();
  check(news.status === 'available' && news.search.items.length === 1 && news.search.items[0].title === '합성 뉴스 제목'
    && news.search.geographicRelevance === 'unverified' && news.search.factVerification === 'unverified', 'be10_independent_result');
  result(await admin.from('source_registry').update({ display_permission: 'denied' }).eq('id', 'naver_news'), 'be10_revoke');
  const revoked = await read(owner);
  const body = await revoked.json();
  check(revoked.status === 200 && body.status === 'source_restricted' && body.search === null, 'be10_no_reuse');
}
