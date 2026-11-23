// 공유 검색 프로필 자연어 파서의 정확한 BigInt 예산 해석, 근거 항목, 거절 및 일반 대화 분리를 검증한다.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

type RegionOption = { code: string; name?: string };
type ProfileParseResult =
  | null
  | { patch: Record<string, unknown>; reason: string }
  | { error: string };
type ProfileLanguageModule = {
  parseSharedProfileMessage(message: unknown, regions?: RegionOption[]): ProfileParseResult;
  isSharedProfileMessage(message: unknown): boolean;
};

const moduleUrl = new URL('../../public/app/profile-language.js', import.meta.url).href;
const { parseSharedProfileMessage, isSharedProfileMessage } = (await import(moduleUrl)) as ProfileLanguageModule;

// 모든 지역 코드는 합성 단위 검사 표본이다.
const sampleRegions: RegionOption[] = [
  { code: '11215', name: '서울특별시 광진구' },
  { code: '11200', name: '서울특별시 성동구' },
  { code: '11140', name: '서울특별시 중구' },
  { code: '26110', name: '부산광역시 중구' },
  { code: '41135', name: '경기도 성남시 분당구' },
];

test('명시적 범위의 한국어 구매 예산 변경 요청을 정확한 BigInt 원 문자열로 해석한다', () => {
  const cases: [string, string][] = [
    ['다음 검색부터 구매 예산을 7억 원으로 바꿔줘', '700000000'],
    ['공유 프로필의 구매 예산을 7억 5천만 원으로 바꿔줘', '750000000'],
    ['다음 검색부터 구매 예산을 7억원으로 바꿔주세요', '700000000'],
    ['공유 프로필의 최대 예산을 7억 5,000만 원으로 설정해줘', '750000000'],
    ['앞으로 검색할 때 구매 예산을 7.5억 원으로 맞춰줘', '750000000'],
    ['모든 검색의 구매 예산을 700,000,000원으로 저장해줘', '700000000'],
    ['기본 구매 예산을 12억 3천4백만 원으로 바꿔줘', '1234000000'],
    ['공유 프로필의 구매 예산을 1조 2천억 원으로 바꿔줘', '1200000000000'],
    ['공유 프로필의 구매 예산을 75,000만 원으로 바꿔줘', '750000000'],
    ['공유 프로필의 구매 예산을 칠억 오천만 원으로 바꿔줘', '750000000'],
    ['공유 프로필의 구매 예산을 8억 원 이하로 바꿔줘', '800000000'],
    ['다음 검색부터 구매 예산을 8억 원으로 올려줘', '800000000'],
    ['다음 검색부터 구매 예산을 6억 원으로 낮춰줘', '600000000'],
    ['다음 검색부터 구매 예산을 0원으로 바꿔줘', '0'],
    ['다음 검색부터 7억 원으로 구매 예산을 바꿔줘', '700000000'],
    ['공유 프로필의 구매 예산을 9007199254740993원으로 바꿔줘', '9007199254740993'],
    ['공유 프로필의 구매 예산을 99999999999999999999원으로 바꿔줘', '99999999999999999999'],
  ];

  for (const [message, expectedWon] of cases) {
    assert.equal(isSharedProfileMessage(message), true, message);
    assert.deepEqual(
      parseSharedProfileMessage(message, sampleRegions),
      { patch: { budget_max_won: expectedWon }, reason: message },
      message,
    );
  }

  assert.deepEqual(parseSharedProfileMessage('공유 프로필의 구매 예산을 비워줘'), {
    patch: { budget_max_won: null },
    reason: '공유 프로필의 구매 예산을 비워줘',
  });
});

test('모호하거나 음수·범위·상대 증감·오버플로·비단위 예산 요청은 오류로 거절한다', () => {
  const rejected = [
    '공유 프로필의 구매 예산을 -7억 원으로 바꿔줘',
    '다음 검색부터 구매 예산을 마이너스 5억 원으로 바꿔줘',
    '공유 프로필의 구매 예산을 100000000000000000000원으로 바꿔줘',
    '공유 프로필의 구매 예산을 100000000조 원으로 바꿔줘',
    '공유 프로필의 구매 예산을 7.123456789억 원으로 바꿔줘',
    '공유 프로필의 구매 예산을 700000000.5원으로 바꿔줘',
    '공유 프로필의 구매 예산을 7억 5천으로 바꿔줘',
    '공유 프로필의 구매 예산을 700으로 바꿔줘',
    '공유 프로필의 구매 예산을 7억~8억 원으로 바꿔줘',
    '공유 프로필의 구매 예산을 7억 아니면 8억으로 바꿔줘',
    '공유 프로필의 구매 예산을 약 7억 원으로 바꿔줘',
    '공유 프로필의 구매 예산을 7억 원 정도로 바꿔줘',
    '공유 프로필의 구매 예산을 7억대로 바꿔줘',
    '공유 프로필의 구매 예산을 5천만 원 올려줘',
    '공유 프로필의 구매 예산을 5천만 원 더 올려줘',
    '다음 검색부터 구매 예산을 1억만큼 낮춰줘',
    '공유 프로필의 구매 예산을 7억 원 이상으로 바꿔줘',
    '공유 프로필의 구매 예산을 5천만 7억 원으로 바꿔줘',
    '공유 프로필의 구매 예산을 7억 3억 원으로 바꿔줘',
    '공유 프로필의 구매 예산을 07억 원으로 바꿔줘',
    '공유 프로필의 구매 예산을 70,00원으로 바꿔줘',
    '공유 프로필의 구매 예산을 50만 달러로 바꿔줘',
    '공유 프로필의 구매 예산을 6억 원에서 7억 원으로 바꿔줘',
  ];

  for (const message of rejected) {
    assert.equal(isSharedProfileMessage(message), true, message);
    const parsed = parseSharedProfileMessage(message, sampleRegions);
    assert.ok(parsed && 'error' in parsed && typeof parsed.error === 'string' && parsed.error.length > 0, message);
  }
});

test('실제 보유 현금·잔액·이체·대출·출퇴근 목적지·분석 전용 조건·전용면적 요청은 거절한다', () => {
  const forbidden = [
    '공유 프로필의 보유 현금을 3억 원으로 바꿔줘',
    '다음 검색부터 보유 자금을 3억 원으로 저장해줘',
    '공유 프로필 잔액을 2억 원으로 수정해줘',
    '다음 검색부터 계좌 이체 5천만 원을 반영해줘',
    '공유 프로필에 추가 자금 입금 5천만 원을 저장해줘',
    '공유 프로필 대출 한도를 4억 원으로 바꿔줘',
    '공유 프로필의 출퇴근 목적지를 강남역으로 바꿔줘',
    '다음 검색부터 직장 주소를 판교역으로 변경해줘',
    '공유 프로필의 비교 기간을 최근 6개월로 바꿔줘',
    '공유 프로필의 전용면적을 59㎡~84㎡로 바꿔줘',
    '공유 프로필의 공급면적을 25평~34평으로 바꿔줘',
    '다음 검색부터 면적을 84㎡~100㎡로 바꿔줘',
    '공유 프로필의 면적을 84㎡~115㎡로 바꿔줘',
    '공유 프로필의 희망 면적을 84㎡~100㎡로 바꿔줘',
    '공유 프로필의 면적을 비워줘',
    '공유 프로필의 희망 면적을 해제해줘',
    '공유 프로필의 구매 예산을 7억 원으로 바꾸고 보유 현금도 3억으로 저장해줘',
    '이번 분석만 공유 프로필 구매 예산을 7억 원으로 바꿔줘',
    '공유 프로필 변경해줘',
    '공유 프로필을 7억 원으로 바꿔줘',
    '공유 프로필 삭제해줘',
  ];

  for (const message of forbidden) {
    assert.equal(isSharedProfileMessage(message), true, message);
    const parsed = parseSharedProfileMessage(message, sampleRegions);
    assert.ok(parsed && 'error' in parsed, message);
  }
});

test('근거 있는 공급면적·입주월·희망 지역 쌍과 해제, 다중 항목을 검증한다', () => {
  assert.deepEqual(parseSharedProfileMessage('다음 검색부터 공급면적을 84㎡~115㎡로 바꿔줘'), {
    patch: { supply_area_min_m2: '84', supply_area_max_m2: '115' },
    reason: '다음 검색부터 공급면적을 84㎡~115㎡로 바꿔줘',
  });
  assert.deepEqual(parseSharedProfileMessage('다음 검색부터 희망 공급면적을 84㎡~100㎡로 바꿔줘'), {
    patch: { supply_area_min_m2: '84', supply_area_max_m2: '100' },
    reason: '다음 검색부터 희망 공급면적을 84㎡~100㎡로 바꿔줘',
  });
  assert.deepEqual(parseSharedProfileMessage('공유 프로필의 공급면적을 84.5m2부터 115.25m2까지로 변경해줘'), {
    patch: { supply_area_min_m2: '84.5', supply_area_max_m2: '115.25' },
    reason: '공유 프로필의 공급면적을 84.5m2부터 115.25m2까지로 변경해줘',
  });
  assert.deepEqual(parseSharedProfileMessage('공유 프로필의 공급면적을 비워줘'), {
    patch: { supply_area_min_m2: null, supply_area_max_m2: null },
    reason: '공유 프로필의 공급면적을 비워줘',
  });

  for (const badArea of [
    '공유 프로필의 공급면적을 115㎡~84㎡로 바꿔줘',
    '공유 프로필의 공급면적을 0㎡~84㎡로 바꿔줘',
    '공유 프로필의 공급면적을 -10㎡~84㎡로 바꿔줘',
    '공유 프로필의 공급면적을 84㎡ 이상으로 바꿔줘',
    '공유 프로필의 공급면적을 84㎡로 바꿔줘',
  ]) {
    const parsed = parseSharedProfileMessage(badArea);
    assert.ok(parsed && 'error' in parsed, badArea);
  }

  assert.deepEqual(parseSharedProfileMessage('다음 검색부터 입주 시기를 2027-01~2027-06으로 바꿔줘'), {
    patch: { move_in_start_month: '2027-01', move_in_end_month: '2027-06' },
    reason: '다음 검색부터 입주 시기를 2027-01~2027-06으로 바꿔줘',
  });
  assert.deepEqual(parseSharedProfileMessage('공유 프로필의 입주 예정월을 2027년 1월부터 2027년 6월까지로 변경해줘'), {
    patch: { move_in_start_month: '2027-01', move_in_end_month: '2027-06' },
    reason: '공유 프로필의 입주 예정월을 2027년 1월부터 2027년 6월까지로 변경해줘',
  });
  assert.deepEqual(parseSharedProfileMessage('공유 프로필의 입주 시기를 해제해줘'), {
    patch: { move_in_start_month: null, move_in_end_month: null },
    reason: '공유 프로필의 입주 시기를 해제해줘',
  });

  for (const badMoveIn of [
    '공유 프로필의 입주 시기를 2027-06~2027-01로 바꿔줘',
    '공유 프로필의 입주 시기를 2027-13~2028-01로 바꿔줘',
    '공유 프로필의 입주 시기를 2027-01-01~2027-06-30으로 바꿔줘',
    '공유 프로필의 입주 시기를 2027-01부터로 바꿔줘',
    '공유 프로필의 입주 시기를 내년 상반기로 바꿔줘',
  ]) {
    const parsed = parseSharedProfileMessage(badMoveIn);
    assert.ok(parsed && 'error' in parsed, badMoveIn);
  }

  assert.deepEqual(parseSharedProfileMessage('다음 검색부터 희망 지역을 광진구로 바꿔줘', sampleRegions), {
    patch: { region_codes: ['11215'] },
    reason: '다음 검색부터 희망 지역을 광진구로 바꿔줘',
  });
  assert.deepEqual(parseSharedProfileMessage('다음 검색부터 희망 지역을 광진구와 성동구로 바꿔줘', sampleRegions), {
    patch: { region_codes: ['11215', '11200'] },
    reason: '다음 검색부터 희망 지역을 광진구와 성동구로 바꿔줘',
  });
  assert.deepEqual(parseSharedProfileMessage('다음 검색부터 희망 지역을 서울특별시 중구로 바꿔줘', sampleRegions), {
    patch: { region_codes: ['11140'] },
    reason: '다음 검색부터 희망 지역을 서울특별시 중구로 바꿔줘',
  });
  assert.deepEqual(parseSharedProfileMessage('다음 검색부터 희망 지역을 11215로 바꿔줘'), {
    patch: { region_codes: ['11215'] },
    reason: '다음 검색부터 희망 지역을 11215로 바꿔줘',
  });
  assert.deepEqual(parseSharedProfileMessage('공유 프로필의 희망 지역을 비워줘', sampleRegions), {
    patch: { region_codes: null },
    reason: '공유 프로필의 희망 지역을 비워줘',
  });

  // 지역 목록이 비어 있어도 명시적 공유 프로필 지역 요청은 감지되고 오류로 안내된다.
  assert.equal(isSharedProfileMessage('다음 검색부터 희망 지역을 광진구로 바꿔줘'), true);
  assert.ok('error' in (parseSharedProfileMessage('다음 검색부터 희망 지역을 광진구로 바꿔줘', []) as object));

  // 동명 지역(중구), 목록 외 코드, 상대 추가/제외는 거절한다.
  for (const badRegion of [
    '다음 검색부터 희망 지역을 중구로 바꿔줘',
    '다음 검색부터 희망 지역을 99999로 바꿔줘',
    '다음 검색부터 희망 지역을 없는구로 바꿔줘',
    '다음 검색부터 희망 지역에 성동구를 추가해줘',
    '다음 검색부터 희망 지역에서 광진구를 빼줘',
  ]) {
    const parsed = parseSharedProfileMessage(badRegion, sampleRegions);
    assert.ok(parsed && 'error' in parsed, badRegion);
  }

  // 다중 항목
  assert.deepEqual(
    parseSharedProfileMessage(
      '다음 검색부터 희망 지역은 서울특별시 광진구, 성동구로 하고 구매 예산은 7억 5천만 원으로 바꿔줘',
      sampleRegions,
    ),
    {
      patch: { region_codes: ['11215', '11200'], budget_max_won: '750000000' },
      reason: '다음 검색부터 희망 지역은 서울특별시 광진구, 성동구로 하고 구매 예산은 7억 5천만 원으로 바꿔줘',
    },
  );
});

test('일반 비교 대화·질문·가정·부정·무범위 문장은 null을 반환해 쓰기로 오인하지 않는다', () => {
  const ordinary = [
    '',
    '   ',
    '왜 이 거래만 포함됐어?',
    '어떤 거래가 포함됐어?',
    '더 알려줘',
    '분양가와 필수 옵션 소계가 얼마야?',
    '최근 6개월로 다시 비교해줘',
    '2026-10-12부터 2026-10-25까지로 바꿔줘',
    '2026년 10월 24일부터 2026년 10월 26일까지 다시 비교해줘',
    '잔액은 3000만원이야',
    '보유 현금이 3억이야',
    '구매 예산을 7억 원으로 바꿔줘',
    '이번 분석만 기간을 최근 6개월로 바꿔줘',
    '공유 프로필 예산이 얼마야?',
    '공유 프로필은 어떻게 바꿔요?',
    '공유 프로필 구매 예산을 7억 원으로 바꾸면 어떻게 돼?',
    '공유 프로필 구매 예산을 7억 원으로 바꿀 수 있어?',
    '공유 프로필 구매 예산을 7억 원으로 바꿔줄까?',
    '공유 프로필 보여줘',
    '공유 프로필 확인해줘',
    '다음 검색부터 구매 예산을 7억 원으로 바꾸지 마',
    '공유 프로필은 변경하지 마세요',
    '공유 프로필은 그대로 둬',
    '공유 프로필은 안 바꿀게',
    '공유 프로필 말고 이번 분석 기간을 최근 6개월로 바꿔줘',
  ];

  for (const message of ordinary) {
    assert.equal(isSharedProfileMessage(message), false, message);
    assert.equal(parseSharedProfileMessage(message), null, message);
    assert.equal(parseSharedProfileMessage(message, sampleRegions), null, message);
  }

  for (const nonString of [null, undefined, 123, {}]) {
    assert.equal(isSharedProfileMessage(nonString), false);
    assert.equal(parseSharedProfileMessage(nonString, sampleRegions), null);
  }
});
