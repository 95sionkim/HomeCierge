// 격리된 Supabase에서 두 실로그인 사용자와 합성 공고로 법령 원문 조회를 확인한다.
import { randomUUID } from 'node:crypto';

export async function checkLegalEvidence({ config, accounts, admin, capture, requestApi, check, result }) {
  check(['localhost', '127.0.0.1'].includes(new URL(config.origin).hostname), 'be09_ephemeral_database_required');
  const [owner, peer] = accounts;
  const target = { ...capture.input.target, noticeSource: capture.input.noticeSource };
  const { id: analysisId } = result(await owner.client.from('analyses').insert({
    user_id: owner.id, chat_id: owner.chatId, conditions_snapshot: { ingestion_target: target },
  }).select('id').single(), 'be09_select_notice');

  // BE-07이 앞서 등록한 청약홈 출처를 그대로 쓰고, 이 임시 DB에만 거래·법령 시험 출처를 등록한다.
  const sources = ['apt_trade', 'apt_rights', 'law_eflaw'].map(id => ({
    id, display_name: '합성 법령 조회 검수', storage_permission: 'allowed', reuse_permission: 'allowed', display_permission: 'allowed',
  }));
  result(await admin.from('source_registry').insert(sources), 'be09_register_sources');
  const snapshotId = result(await admin.rpc('save_ingestion_snapshot', {
    p_analysis_id: analysisId, p_user_id: owner.id, p_capture_key: randomUUID(), p_input: capture.input,
    p_result: { ...capture.original, dataOrigin: 'collected' },
  }), 'be09_notice_snapshot');
  const path = `/api/v1/analyses/${analysisId}/snapshots/${snapshotId}/legal-evidence`;
  const read = (account) => requestApi(path, { headers: { Authorization: 'Bearer ' + account.accessToken } });
  const asOf = capture.original.catalog.notice.fields.RCRIT_PBLANC_DE.value;
  const reference = { contractVersion: 'law-reference/v1', dataOrigin: 'collected',
    asOf, observedAt: asOf + 'T11:00:00+09:00', title: '주택공급에 관한 규칙',
    lawId: '008243', mst: '99900001', effectiveOn: '2026-09-01', promulgatedOn: '2026-08-01',
    articles: [{ number: '21', branch: null, heading: '합성 공고 확인' }] };
  const publish = client => client.rpc('publish_law_reference', { p_reference: reference });
  const pending = await read(owner);
  check(pending.status === 200 && (await pending.json()).status === 'version_unverified', 'be09_pending');
  check((await publish(owner.client)).error?.code === '42501', 'be09_user_cannot_publish');
  result(await publish(admin), 'be09_publish');
  result(await publish(admin), 'be09_retry_publication');
  const response = await read(owner);
  check(response.status === 200 && response.headers.get('cache-control') === 'private, no-store', 'be09_owner_read');
  const body = await response.json();
  check(body.status === 'available' && body.noticeDate === asOf && body.reference.mst === reference.mst
    && body.reference.sourceUrl.endsWith('lsiSeq=99900001&efYd=20260901') && body.reference.articles[0].label === '제21조'
    && body.personalEligibility === 'not_assessed' && body.transitionalProvisions === 'requires_review', 'be09_historical_version');
  check((await read(peer)).status === 404, 'be09_owner_isolation');
  // 두 작업자가 같은 시각의 서로 다른 결과를 게시하면 승자 한 건만 이후 조회에 나타난다.
  const candidates = ['합성 공고 확인 A', '합성 공고 확인 B'].map(heading => ({
    ...reference, observedAt: asOf + 'T11:01:00+09:00', articles: [{ number: '21', branch: null, heading }],
  }));
  const replies = await Promise.all(candidates.map(p_reference => admin.rpc('publish_law_reference', { p_reference })));
  const winner = replies.findIndex(reply => !reply.error);
  check(winner >= 0 && replies[1 - winner].error?.code === 'PT409', 'be09_concurrent_publication');
  const reread = await read(owner);
  check(reread.status === 200 && (await reread.json()).reference.articles[0].heading === candidates[winner].articles[0].heading,
    'be09_consistent_publication');
  result(await admin.from('source_registry').update({ display_permission: 'denied' }).eq('id', 'law_eflaw'), 'be09_revoke_source');
  const denied = await read(owner);
  const withheld = await denied.json();
  check(denied.status === 200 && withheld.status === 'source_restricted' && withheld.reference === null, 'be09_source_revoked');
}
