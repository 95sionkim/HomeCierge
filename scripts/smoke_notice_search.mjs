// 새로 시작한 로컬 Supabase CI에서만 합성 색인으로 두 실로그인 사용자의 공유 검색을 검수한다.
export async function checkNoticeSearch({ config, accounts, admin, requestApi, check, result }) {
  check(['127.0.0.1', 'localhost'].includes(new URL(config.origin).hostname), 'be07_ephemeral_database_required');
  const now = new Date();
  const koreaDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' });
  const today = koreaDate.format(now);
  const tomorrow = koreaDate.format(new Date(now.getTime() + 86_400_000));
  const sources = ['applyhome_apt', 'applyhome_remainder', 'mois_legal_region_codes', 'applyhome_apt_model', 'applyhome_notice_pdf'];
  const ids = { houseManageNo: '9900000010', noticeNo: '9900000010' };
  const ref = { document: 'applyhome:9900000010:9900000010:4:1', version: 'sha256:' + 'a'.repeat(64), page: 3 };
  const base = { ...ids, edition: today, title: '합성 검색 공고', kind: 'new_sale', regionCode: '99999',
    application: { start: today, end: tomorrow }, moveIn: { start: '2030-03', end: '2030-03' },
    inventoryComplete: true, models: [{ modelNo: '01', houseType: '084.0000A', supplyAreaM2: '110',
      areaEvidence: [ref], rooms: [{ room: '101동 101호', subtotalWon: '710000000', priceEvidence: [ref] }] }],
    sourceIds: ['applyhome_apt', 'applyhome_apt_model', 'applyhome_notice_pdf'], reasonCodes: [] };
  const index = { contractVersion: 'notice-search-index/v1', dataOrigin: 'collected', observedAt: now.toISOString(),
    publicationWindow: { start: today, end: today }, regionCodes: ['99999'], coverage: { status: 'complete', sources: [
      { source: 'applyhome_apt', status: 'complete' }, { source: 'applyhome_remainder', status: 'complete' }] },
    notices: [base, { ...base, houseManageNo: '9900000011', noticeNo: '9900000011', kind: 'resupply',
      inventoryComplete: false, models: [], sourceIds: ['applyhome_remainder'], reasonCodes: [] }] };
  const conditions = { regionCodes: ['99999'], budgetMaxWon: '710000000', supplyArea: { unit: 'm2', min: '110', max: '110' } };
  const search = (account, body = conditions) => requestApi('/api/v1/notices/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(account ? { Authorization: 'Bearer ' + account.accessToken } : {}) },
    body: JSON.stringify(body),
  });
  check((await search(null)).status === 401, 'be07_login_required');
  const initial = await search(accounts[0]);
  check(initial.status === 503 && (await initial.json()).error === 'search_index_not_ready', 'be07_no_published_index');
  const prior = result(await admin.from('source_registry').select('id').in('id', sources), 'be07_read_registered_sources');
  check(prior.length === 0, 'be07_empty_fixture_registry_required');
  const sourceRows = sources.map(id => ({ id, display_name: '합성 CI 자료', reuse_permission: 'allowed',
    storage_permission: 'allowed', display_permission: 'allowed' }));
  result(await admin.from('source_registry').insert(sourceRows), 'be07_seed_source_rights');
  const publishName = 'publish_notice_search_index';
  check((await accounts[0].client.rpc(publishName, { p_index: index })).error?.code === '42501', 'be07_user_cannot_publish');
  check((await admin.rpc(publishName, { p_index: { ...index, dataOrigin: 'synthetic' } })).error?.code === '22023',
    'be07_synthetic_publication_rejected');
  result(await admin.rpc(publishName, { p_index: index }), 'be07_worker_publishes');
  // 같은 새 관측 시각에 서로 다른 두 색인을 발행하면 한 내용만 남아야 한다.
  const next = new Date(now.getTime() + 1);
  const nextDay = koreaDate.format(next);
  const publications = ['합성 동시 발행 A', '합성 동시 발행 B'].map(title => ({
    ...index, observedAt: next.toISOString(), publicationWindow: { start: today, end: nextDay },
    notices: [{ ...base, title }, index.notices[1]],
  }));
  const replies = await Promise.all(publications.map(p_index => admin.rpc(publishName, { p_index })));
  const winner = replies.findIndex(reply => !reply.error);
  check(winner >= 0 && replies[1 - winner].error?.code === 'PT409', 'be07_concurrent_publication');
  for (const account of accounts) {
    const response = await search(account);
    check(response.status === 200, 'be07_authenticated_search');
    const body = await response.json();
    check(body.counts.matched === 1 && body.counts.needsReview === 1 && body.matched[0].noticeNo === ids.noticeNo
      && body.matched[0].title === publications[winner].notices[0].title
      && body.matched[0].models[0].matchedRooms[0].subtotalWon === '710000000'
      && body.needsReview[0].noticeNo === '9900000011', 'be07_search_results');
  }
  const budget = await search(accounts[0], { ...conditions, budgetMaxWon: '709999999' });
  check(budget.status === 200 && (await budget.json()).counts.matched === 0, 'be07_exact_budget_boundary');
  result(await admin.from('source_registry').update({ display_permission: 'denied' }).eq('id', 'applyhome_notice_pdf'),
    'be07_revoke_test_source');
  const denied = await search(accounts[1]);
  check(denied.status === 403 && (await denied.json()).error === 'search_source_restricted', 'be07_revocation_applied');
}
