// 게스트가 고른 저장 예시에서만 사용한다. 실제 법령 판본이나 기사 원문 링크를 만들지 않는다.
export const lawExample = {
  status: 'available',
  noticeDate: '2026-10-05',
  noticeSource: 'applyhome_apt',
  reference: {
    title: '주택공급에 관한 규칙',
    mst: '예시 01',
    lawId: '예시 02',
    effectiveOn: '2026-09-01',
    promulgatedOn: '2026-08-10',
    observedAt: '2026-10-05T03:00:00Z',
    articles: [
      { label: '제12조', heading: '합성 모집공고 예시' },
      { label: '제25조의3', heading: '합성 재공급 예시' },
    ],
  },
};
export const newsExample = {
  status: 'available',
  search: {
    queriedAt: '2026-11-22T02:30:00Z',
    conditions: { region: '합성시 가람구', query: '합성시 가람구 분양', sort: 'date', display: 3 },
    items: [
      {
        title: '가람구, 겨울 주거 상담 일정 안내',
        snippet: '가상의 가람구에서 주거 상담 창구 운영 일정을 알렸다는 예시입니다.',
        originalHost: 'example.org',
        publishedAt: '2026-11-22T00:00:00Z',
      },
      {
        title: '가람구 주택 공급 설명회 개최',
        snippet: '가상의 지역 설명회에서 분양 일정을 소개했다는 예시입니다.',
        originalHost: 'example.com',
        publishedAt: '2026-11-21T05:10:00Z',
      },
    ],
    omittedCount: 0,
  },
};
