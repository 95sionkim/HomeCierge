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
const newsExampleItems = [
  ['가람구, 겨울 주거 상담 일정 안내', '가상의 가람구에서 주거 상담 창구 운영 일정을 알렸다는 예시입니다.', 'example.org', '2026-11-22T00:00:00Z'],
  ['가람구 주택 공급 설명회 개최', '가상의 지역 설명회에서 분양 일정을 소개했다는 예시입니다.', 'example.com', '2026-11-21T05:10:00Z'],
  ['가람구 생활권 보행로 정비 계획 공개', '가상의 가람구 보행 환경 개선 사업 안내를 정리한 합성 기사입니다.', 'example.org', '2026-11-20T07:30:00Z'],
  ['가람구 복합문화도서관 착공 소식', '가상의 지역 도서관 건립 일정을 전하는 합성 검색 발췌입니다.', 'example.com', '2026-11-19T06:20:00Z'],
  ['가람구 주거단지 주변 버스 노선 조정 예고', '가상의 시내버스 노선 개편 일정을 안내하는 합성 기사 예시입니다.', 'example.org', '2026-11-18T03:45:00Z'],
  ['가람구 신축 단지 입주 전 점검 안내문 배포', '가상의 입주 예정자 사전 점검 절차를 소개하는 합성 발췌입니다.', 'example.com', '2026-11-17T08:00:00Z'],
  ['가람구 공원 산책로 야간 조명 교체', '가상의 근린공원 환경 정비 소식을 담은 합성 기사 예시입니다.', 'example.org', '2026-11-16T02:15:00Z'],
  ['가람구 청약 절차 안내 자료집 발간', '가상의 첫 주택 마련자 대상 안내 자료 발간 소식 예시입니다.', 'example.com', '2026-11-15T04:50:00Z'],
  ['가람구 생활체육시설 확장 공사 추진', '가상의 지역 체육시설 증축 계획을 전하는 합성 발췌입니다.', 'example.org', '2026-11-14T01:40:00Z'],
  ['가람구 초등학교 통학로 안전 시설 보강', '가상의 어린이 보호구역 시설 점검 결과를 전하는 합성 기사입니다.', 'example.com', '2026-11-13T09:10:00Z'],
  ['가람구 지역 상권 활성화 간담회 열려', '가상의 생활권 상권 간담회 개최 내용을 요약한 합성 발췌입니다.', 'example.org', '2026-11-12T06:00:00Z'],
  ['가람구 공공주차장 확충 후보지 검토', '가상의 주택가 주차 공간 확보 검토 소식을 담은 합성 기사입니다.', 'example.com', '2026-11-11T05:25:00Z'],
  ['가람구 하천변 자전거 도로 정비 완료', '가상의 하천변 자전거길 포장 보수 완료 안내 예시입니다.', 'example.org', '2026-11-10T03:05:00Z'],
  ['가람구 동절기 상수도 동파 예방 점검', '가상의 겨울철 주거 시설 안전 점검 일정을 전하는 합성 발췌입니다.', 'example.com', '2026-11-09T07:45:00Z'],
  ['가람구 신설 교차로 신호 체계 개선', '가상의 출퇴근 시간대 교차로 신호 조정 소식을 담은 합성 기사입니다.', 'example.org', '2026-11-08T02:30:00Z'],
  ['가람구 주민센터 무인민원발급기 추가 설치', '가상의 행정 편의 시설 확충 안내를 담은 합성 기사 예시입니다.', 'example.com', '2026-11-07T08:20:00Z'],
  ['가람구 공동주택 관리비 공개 제도 안내', '가상의 공동주택 관리 정보 확인 방법을 소개하는 합성 발췌입니다.', 'example.org', '2026-11-06T04:10:00Z'],
  ['가람구 주말 생활문화 프로그램 참가자 모집', '가상의 지역 문화 강좌 접수 일정을 전하는 합성 기사 예시입니다.', 'example.com', '2026-11-05T01:55:00Z'],
  ['가람구 주거환경 정비 구역 안내 지도 갱신', '가상의 정비 구역 현황 안내 자료 갱신 소식을 담은 합성 발췌입니다.', 'example.org', '2026-11-04T06:40:00Z'],
  ['가람구 지역 보건소 건강 검진 일정 공지', '가상의 보건소 검진 예약 일정을 안내하는 합성 기사 예시입니다.', 'example.com', '2026-11-03T03:15:00Z'],
  ['가람구 친환경 에너지 절감 지원 사업 안내', '가상의 가정용 에너지 효율 개선 지원 내용을 전하는 합성 발췌입니다.', 'example.org', '2026-11-02T07:05:00Z'],
  ['가람구 신축 주거지 주변 가로수 식재', '가상의 가로 경관 정비 사업 진행 소식을 담은 합성 기사 예시입니다.', 'example.com', '2026-11-01T05:35:00Z'],
  ['가람구 가을철 주거 안전 점검 결과 발표', '가상의 지역 주거 시설 합동 점검 결과를 요약한 합성 발췌입니다.', 'example.org', '2026-10-31T02:00:00Z'],
].map(([title, snippet, originalHost, publishedAt]) => ({ title, snippet, originalHost, publishedAt }));

export function newsExamplePage(page = 1) {
  const size = 10;
  const total = newsExampleItems.length;
  const lastPage = Math.min(Math.ceil(total / size), 100);
  const number = Number.isSafeInteger(page) && page >= 1 && page <= lastPage ? page : 1;
  const start = (number - 1) * size + 1;
  return {
    status: 'available',
    search: {
      queriedAt: '2026-11-22T02:30:00Z',
      conditions: {
        region: '합성시 가람구',
        query: '합성시 가람구 분양',
        sort: 'date',
        display: size,
        start,
        format: 'json',
      },
      page: {
        number,
        size,
        total,
        lastPage,
        hasPrevious: number > 1,
        hasNext: number < lastPage,
      },
      source: {
        provider: 'naver_api_hub',
        name: '네이버 검색결과',
        url: 'https://www.ncloud.com/product/applicationService/NAVERAPIHUB',
      },
      textFormat: 'plain_text',
      geographicRelevance: 'unverified',
      factVerification: 'unverified',
      items: newsExampleItems.slice(start - 1, start - 1 + size),
      omittedCount: 0,
    },
  };
}
export const newsExample = newsExamplePage(1);
