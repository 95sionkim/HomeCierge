// 공유 검색 프로필 자연어 변경 요청을 해석한다. 일반 비교 대화·질문·부정은 null로 돌려보낸다.
const MAX_CODE_POINTS = 800;
const CONTROL_OR_SURROGATE = /[\u0000-\u0009\u000b-\u001f\u007f]|\p{Cs}/u;

const REGION_CODE_RE = /^[0-9]{5}$/;
const WON_RE = /^(?:0|[1-9]\d{0,19})$/;
const POSITIVE_AREA_RE = /^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)$/;
const MONTH_RE = /^(?!0000)\d{4}-(?:0[1-9]|1[0-2])$/;

const EXPLICIT_SCOPE_RE =
  /(?:공유\s*프로필|내\s*프로필|검색\s*프로필|프로필|다음\s*검색|앞으로(?:\s*의)?\s*(?:검색|분석|채팅|모든)|이후(?:\s*의)?\s*(?:검색|분석|채팅)|모든\s*(?:검색|채팅|분석)|다른\s*(?:채팅|분석)|전체\s*(?:검색|채팅|분석)|기본\s*(?:검색\s*조건|탐색\s*조건|조건|프로필|구매\s*예산|예산|희망\s*지역|공급\s*면적|입주))/u;

const CURRENT_ONLY_SCOPE_RE =
  /(?:이번\s*(?:분석|비교)(?:만|에만)|이\s*(?:분석|비교)(?:만|에만)|현재\s*(?:분석|비교)(?:만|에만))/u;

const CHANGE_VERB_RE =
  /(?:바꿔|바꾸어|바꾸고\s*싶|바꿀게|바꿉니다|변경해|변경하|변경\s*요청|변경할게|변경합니다|수정해|수정하|수정할게|수정합니다|설정해|설정하|설정할게|설정합니다|저장해|저장하|저장할게|저장합니다|반영해|반영하|반영할게|반영합니다|적용해|적용하|적용할게|적용합니다|맞춰|맞추어|맞출게|올려|낮춰|줄여|늘려|지워|삭제해|삭제하|비워|초기화해|초기화하|해제해|해제하|없애|제거해|제거하|지정해|지정하|정해\s*(?:줘|주)|업데이트해|갱신해|추가해|빼\s*(?:줘|주))/u;

const NEGATION_RE =
  /(?:(?:바꾸|변경하|수정하|설정하|저장하|반영하|적용하|건드리|지우|삭제하|비우|초기화하|해제하|없애|제거하|올리|낮추|줄이|늘리)지\s*(?:마|말|않)|안\s*(?:바꿔|바꿀|바꾸|변경|수정|설정|저장|반영|지워|삭제|비워|해제|초기화|올릴|낮출|줄일|늘릴)|(?:그대로|원래대로)\s*(?:유지|둬|두|놔)|(?:바꿀|변경할|수정할|저장할|반영할)\s*필요\s*없|(?:공유\s*|내\s*|검색\s*)?프로필(?:은|을|에|의)?\s*(?:말고|유지|그대로)|(?:바꾸|변경하)지\s*않)/u;

const QUESTION_OR_HYPOTHETICAL_RE =
  /(?:[?？]\s*$|어떻게\s*(?:바꿔|바꾸|변경|수정|설정|저장|지워|삭제|해제|적용)|(?:바꾸|변경하|수정하|설정하|저장하|반영하|지우|삭제하|비우|해제하)면\b|(?:바꿀|변경할|수정할|설정할|저장할|반영할|지울|삭제할|비울|해제할)\s*수\s*있|(?:바꿔|변경해|수정해|설정해|저장해|반영해|지워|삭제해|비워|해제해)도\s*(?:돼|되|될)|(?:바꾸|변경하|수정하)는\s*게|(?:바꿔야|변경해야|수정해야)\s*(?:해|하|할|될)|(?:바꿀까|변경할까|수정할까|저장할까|적용할까)|(?:저장돼|적용돼|반영돼|바뀌어|변경돼)|얼마(?:야|예요|인가|인지)|뭐(?:야|예요|인가|인지)|(?:인가요|되나요|하나요|할까요|될까요|인지\s*알려|어떨까)\s*$)/u;

const CLEAR_VERB_RE =
  /(?:지워|삭제해|삭제하|비워|초기화해|초기화하|해제해|해제하|없애|제거해|제거하)/u;

const ACTUAL_FUNDS_RE =
  /(?:보유\s*현금|보유\s*자금|보유\s*잔액|현재\s*자금|현재\s*현금|현금|잔액|잔고|추가\s*자금|유입\s*자금|이체|송금|입금|출금|계좌|예금|적금|청약\s*통장|통장|대출|주담대|신용\s*대출|생활\s*자금|비상금|계약금|중도금|잔금|자금표|실제\s*자금|가용\s*자금)/u;

const COMMUTE_RE = /(?:출퇴근|목적지|직장|회사\s*주소|통근)/u;
const ANALYSIS_EDIT_RE =
  /(?:비교\s*기간|계약\s*기간|실거래\s*기간|거래\s*종류|비교\s*단지|허용\s*오차|±\s*\d+|주택형|호실)/u;
const EXCLUSIVE_AREA_RE = /(?:전용\s*면적|전용\s*\d)/u;

const AMBIGUOUS_MONEY_RE =
  /(?:약\s*\d|대략|정도|쯤|가량|전후|안팎|내외|근처|\d\s*억대|또는|아니면|혹은|중에서|말고|~|～|\/|달러|USD|\$|엔|유로|EUR|JPY)/iu;
const RELATIVE_DELTA_RE = /(?:더\s*(?:올려|낮춰|줄여|늘려|높여)|만큼|추가로|증액|감액)/u;
const DISALLOWED_BUDGET_BOUND_RE = /(?:이상|초과|미만)/u;

const FIELD_ANCHOR_RE =
  /(최대\s*구매\s*예산|구매\s*예산\s*상한|최대\s*구매\s*가격|구매\s*가격\s*상한|구매\s*예산|최대\s*예산|예산\s*상한|구매\s*가격|예산|희망\s*공급\s*면적|공급\s*면적|희망\s*면적|면적|희망\s*입주\s*시기|입주\s*예정월|입주\s*시기|입주\s*예정|입주\s*월|입주월|입주|희망\s*지역|검색\s*지역|지역)/gu;

const FIELD_KEY_MAP = new Map([
  ['최대 구매 예산', 'budget'],
  ['구매 예산 상한', 'budget'],
  ['최대 구매 가격', 'budget'],
  ['구매 가격 상한', 'budget'],
  ['구매 예산', 'budget'],
  ['최대 예산', 'budget'],
  ['예산 상한', 'budget'],
  ['구매 가격', 'budget'],
  ['예산', 'budget'],
  ['희망 공급 면적', 'area'],
  ['희망공급면적', 'area'],
  ['공급 면적', 'area'],
  ['공급면적', 'area'],
  ['희망 면적', 'ambiguous_area'],
  ['희망면적', 'ambiguous_area'],
  ['면적', 'ambiguous_area'],
  ['희망 입주 시기', 'moveIn'],
  ['입주 예정월', 'moveIn'],
  ['입주 시기', 'moveIn'],
  ['입주 예정', 'moveIn'],
  ['입주 월', 'moveIn'],
  ['입주월', 'moveIn'],
  ['입주', 'moveIn'],
  ['희망 지역', 'region'],
  ['검색 지역', 'region'],
  ['지역', 'region'],
]);

const SINO_DIGITS = {
  영: 0n,
  공: 0n,
  일: 1n,
  이: 2n,
  삼: 3n,
  사: 4n,
  오: 5n,
  육: 6n,
  칠: 7n,
  팔: 8n,
  구: 9n,
};

const TRAILING_VERB_TAIL_RE =
  /\s*(?:으로|로)?\s*(?:바꿔|바꾸어|바꾸고\s*싶|바꿀게|바꿉니다|변경해|변경하|변경\s*요청|변경할게|변경합니다|수정해|수정하|수정할게|수정합니다|설정해|설정하|설정할게|설정합니다|저장해|저장하|저장할게|저장합니다|반영해|반영하|반영할게|반영합니다|적용해|적용하|적용할게|적용합니다|맞춰|맞추어|맞출게|올려|낮춰|줄여|늘려|지워|삭제해|삭제하|비워|초기화해|초기화하|해제해|해제하|없애|제거해|제거하|지정해|지정하|정해|업데이트해|갱신해)(?:\s*(?:줘요|줘|주세요|주십시오|주시겠어요|주실래요|주고|주시고|고|고요|요|어|어요|니다|합니다|할게요|할게|해줘|해주세요|하고|하며))*\s*[.,!]?\s*$/u;

const CLAUSE_CONNECTOR_TAIL_RE = /\s*(?:,|;|하고|이고|으로\s*하고|로\s*하고|및|그리고)\s*$/u;

const SCOPE_STRIP_RE =
  /(?:공유\s*프로필|내\s*프로필|검색\s*프로필|프로필|다음\s*검색|앞으로(?:\s*의)?\s*(?:검색|분석|채팅|모든)|이후(?:\s*의)?\s*(?:검색|분석|채팅)|모든\s*(?:검색|채팅|분석)|다른\s*(?:채팅|분석)|전체\s*(?:검색|채팅|분석)|기본\s*(?:검색\s*조건|탐색\s*조건|조건|프로필)|기본)(?:부터|에서|에|의|은|는|을|를|할\s*때|시)?/gu;

const FILLER_WORDS_RE = /^(?:이제|앞으로|앞으로는|좀|제발|그리고|또한|그냥|조건|조건을|조건은|검색|탐색|[\s,·.:;])+$/u;

function codePointLength(value) {
  return Array.from(value).length;
}

function normalizeAnchor(raw) {
  const collapsed = raw.replace(/\s+/gu, ' ').trim();
  return FIELD_KEY_MAP.get(collapsed) ?? FIELD_KEY_MAP.get(collapsed.replace(/\s+/gu, '')) ?? null;
}

function parsePlainUnsignedInt(token) {
  if (/^(?:0|[1-9]\d*)$/.test(token)) return BigInt(token);
  if (/^[1-9]\d{0,2}(?:,\d{3})+$/.test(token)) return BigInt(token.replaceAll(',', ''));
  return null;
}

function parseSmallDigit(token) {
  if (/^[1-9]$/.test(token)) return BigInt(token);
  if (Object.hasOwn(SINO_DIGITS, token) && SINO_DIGITS[token] > 0n) return SINO_DIGITS[token];
  return null;
}

// 천·백·십·일의 1만 미만 조합 또는 순수 정수를 정확한 BigInt로 변환한다.
function parseSegmentValue(raw, allowLargeInteger) {
  const compact = raw.replace(/\s+/gu, '');
  if (!compact) return null;

  const direct = parsePlainUnsignedInt(compact);
  if (direct !== null) {
    if (!allowLargeInteger && direct >= 10000n) return null;
    return direct;
  }

  if (compact.includes(',')) return null;

  let cursor = compact;
  let total = 0n;
  const subUnits = [
    ['천', 1000n],
    ['백', 100n],
    ['십', 10n],
  ];
  let matchedAnyUnit = false;
  let smallestUnit = 10000n;

  for (const [symbol, factor] of subUnits) {
    const idx = cursor.indexOf(symbol);
    if (idx === -1) continue;
    if (cursor.indexOf(symbol, idx + 1) !== -1) return null;
    const before = cursor.slice(0, idx);
    let coeff;
    if (before === '') {
      coeff = 1n;
    } else {
      coeff = parseSmallDigit(before);
      if (coeff === null) return null;
    }
    total += coeff * factor;
    cursor = cursor.slice(idx + 1);
    matchedAnyUnit = true;
    smallestUnit = factor;
  }

  if (cursor !== '') {
    if (/^[1-9]\d*$/.test(cursor)) {
      const tail = BigInt(cursor);
      if (matchedAnyUnit && tail >= smallestUnit) return null;
      if (!allowLargeInteger && total + tail >= 10000n) return null;
      total += tail;
    } else if (Object.hasOwn(SINO_DIGITS, cursor)) {
      const tail = SINO_DIGITS[cursor];
      if (matchedAnyUnit && tail === 0n) return null;
      total += tail;
    } else {
      return null;
    }
  }

  if (!allowLargeInteger && total >= 10000n) return null;
  return total;
}

function parseDecimalWithScale(raw, scaleZeros) {
  const compact = raw.replace(/\s+/gu, '');
  const match = /^(0|[1-9]\d*)\.(\d+)$/.exec(compact);
  if (!match) return null;
  const whole = match[1];
  const trimmedFrac = match[2].replace(/0+$/, '');
  if (trimmedFrac.length > scaleZeros) return null;
  const scale = 10n ** BigInt(scaleZeros - trimmedFrac.length);
  return BigInt(whole + trimmedFrac) * scale;
}

// 한국어 원 단위 금액 표현을 부동소수점 없이 정확한 BigInt 원 문자열로 해석한다.
function parseKoreanWonExact(rawExpr) {
  const expr = rawExpr.trim();
  if (!expr) return { error: '구매 예산 금액을 입력하세요. 예: 7억 원, 7억 5천만 원' };
  if (/[-−+]/u.test(expr) || /(?:마이너스|음수)/u.test(expr)) {
    return { error: '구매 예산은 0원 이상의 정수로 입력하세요.' };
  }
  if (AMBIGUOUS_MONEY_RE.test(expr)) {
    return { error: '구매 예산은 범위나 추정 없이 하나의 확정 금액으로 입력하세요. 예: 7억 5천만 원' };
  }
  if (DISALLOWED_BUDGET_BOUND_RE.test(expr)) {
    return { error: '구매 예산은 상한 금액으로 지정합니다. 예: 7억 원 또는 7억 원 이하' };
  }
  if (/[eE]/u.test(expr)) {
    return { error: '구매 예산은 일반 숫자나 한국어 금액 단위로 입력하세요.' };
  }

  let body = expr.replace(/\s*(?:이하|까지)\s*$/u, '').trim();
  let hasWon = false;
  if (body.endsWith('원')) {
    hasWon = true;
    body = body.slice(0, -1).trim();
  }
  if (!body || body.includes('원')) {
    return { error: '구매 예산 금액 형식을 확인할 수 없습니다. 예: 7억 5천만 원' };
  }

  const majorUnits = [
    ['조', 12, 1_000_000_000_000n],
    ['억', 8, 100_000_000n],
    ['만', 4, 10_000n],
  ];

  // 상위 단위가 반드시 내림차순이며 중복되지 않는지 확인한다.
  let lastIdx = -1;
  const foundUnits = [];
  for (const [symbol, zeros, factor] of majorUnits) {
    const idx = body.indexOf(symbol);
    if (idx === -1) continue;
    if (body.indexOf(symbol, idx + 1) !== -1) {
      return { error: '구매 예산의 금액 단위가 중복됐습니다. 예: 7억 5천만 원' };
    }
    if (idx < lastIdx) {
      return { error: '구매 예산의 금액 단위 순서가 올바르지 않습니다. 예: 7억 5천만 원' };
    }
    foundUnits.push({ symbol, zeros, factor, idx });
    lastIdx = idx;
  }

  if (!foundUnits.length && !hasWon) {
    return { error: '금액 단위(원, 만 원, 억 원)를 함께 입력하세요. 예: 7억 원' };
  }

  let total = 0n;
  let cursor = 0;
  let hasHigherUnit = false;

  for (let i = 0; i < foundUnits.length; i++) {
    const unit = foundUnits[i];
    const segment = body.slice(cursor, unit.idx).trim();
    cursor = unit.idx + 1;

    if (!segment) {
      return { error: '금액 단위 앞에 숫자를 입력하세요. 예: 7억 원' };
    }

    if (segment.includes('.')) {
      // 소수 표기는 단독 상위 단위(예: 7.5억 원)에만 허용한다.
      if (hasHigherUnit || i !== foundUnits.length - 1 || body.slice(cursor).trim() !== '') {
        return { error: '소수 금액과 하위 단위를 섞어 쓸 수 없습니다. 예: 7.5억 원 또는 7억 5천만 원' };
      }
      const scaled = parseDecimalWithScale(segment, unit.zeros);
      if (scaled === null) {
        return { error: '구매 예산은 원 단위 정수로 떨어지는 금액만 입력할 수 있습니다.' };
      }
      total += scaled;
    } else {
      const value = parseSegmentValue(segment, !hasHigherUnit);
      if (value === null || (hasHigherUnit && value === 0n)) {
        return { error: '구매 예산 금액을 정확히 해석할 수 없습니다. 예: 7억 5천만 원' };
      }
      total += value * unit.factor;
    }
    hasHigherUnit = true;
  }

  const remainder = body.slice(cursor).trim();
  if (remainder) {
    if (!hasWon) {
      return { error: '금액 단위가 모호합니다. 예: 7억 5천만 원 또는 750,000,000원' };
    }
    if (remainder.includes('.')) {
      return { error: '구매 예산은 원 단위 정수로 입력하세요.' };
    }
    const remValue = parseSegmentValue(remainder, !hasHigherUnit);
    if (remValue === null || (hasHigherUnit && remValue === 0n)) {
      return { error: '구매 예산 금액을 정확히 해석할 수 없습니다. 예: 700,000,000원' };
    }
    total += remValue;
  }

  const result = total.toString();
  if (!WON_RE.test(result)) {
    return { error: '구매 예산은 20자리 이하의 원 단위 정수로 입력하세요.' };
  }
  return { won: result };
}

function areaToScaledBigInt(value, scale) {
  const [whole, frac = ''] = value.split('.');
  return BigInt(whole + frac.padEnd(scale, '0'));
}

function parseSupplyAreaRange(rawExpr) {
  const expr = rawExpr.trim();
  if (!expr) return { error: '공급면적은 ㎡ 단위의 최소·최대 값을 함께 입력하세요. 예: 84㎡~115㎡' };
  if (/평/u.test(expr)) {
    return { error: '공유 프로필 면적은 ㎡(제곱미터) 단위로만 저장합니다. ㎡ 기준 최소·최대 공급면적을 입력하세요.' };
  }
  if (/전용/u.test(expr)) {
    return { error: '공유 프로필의 희망 면적은 전용면적이 아니라 공급면적(㎡) 기준입니다.' };
  }
  if (/(?:또는|아니면|혹은|말고|이상|이하|초과|미만|약\s*\d|대략|정도|쯤)/u.test(expr)) {
    return { error: '공급면적은 최소와 최대 값을 ㎡ 단위로 함께 입력하세요. 예: 84㎡~115㎡' };
  }

  const cleaned = expr.replace(/\s*(?:까지|사이)\s*$/u, '').trim();
  const unit = '(?:㎡|m2|m²|제곱미터)';
  const num = '(-?\\d+(?:\\.\\d+)?)';
  const rangeRe = new RegExp(
    `^${num}\\s*(${unit})?\\s*(?:~|～|–|—|에서|부터|(?<=\\d)\\s*-\\s*(?=\\d))\\s*${num}\\s*(${unit})?$`,
    'iu',
  );
  const match = rangeRe.exec(cleaned);
  if (!match) {
    return { error: '공급면적은 최소와 최대 값을 ㎡ 단위로 함께 입력하세요. 예: 84㎡~115㎡' };
  }

  const [, rawMin, unit1, rawMax, unit2] = match;
  if (!unit1 && !unit2) {
    return { error: '공급면적 단위(㎡ 또는 m2)를 함께 입력하세요. 예: 84㎡~115㎡' };
  }
  if (
    rawMin.length > 24 ||
    rawMax.length > 24 ||
    !POSITIVE_AREA_RE.test(rawMin) ||
    !POSITIVE_AREA_RE.test(rawMax)
  ) {
    return { error: '공급면적은 0보다 큰 양수(㎡)로 입력하세요. 예: 84㎡~115㎡' };
  }
  const scale = Math.max((rawMin.split('.')[1] ?? '').length, (rawMax.split('.')[1] ?? '').length);
  if (areaToScaledBigInt(rawMin, scale) > areaToScaledBigInt(rawMax, scale)) {
    return { error: '최대 공급면적은 최소 면적 이상이어야 합니다.' };
  }
  return { min: rawMin, max: rawMax };
}

function parseMonthToken(token) {
  const iso = /^(\d{4})[-.](\d{2})$/.exec(token);
  if (iso) {
    const formatted = `${iso[1]}-${iso[2]}`;
    return MONTH_RE.test(formatted) ? formatted : null;
  }
  const korean = /^(\d{4})년\s*(\d{1,2})월$/.exec(token);
  if (korean) {
    const formatted = `${korean[1]}-${korean[2].padStart(2, '0')}`;
    return MONTH_RE.test(formatted) ? formatted : null;
  }
  return null;
}

function parseMoveInRange(rawExpr) {
  const expr = rawExpr.trim();
  if (!expr) return { error: '입주 시기는 시작월과 종료월(YYYY-MM)을 함께 입력하세요. 예: 2027-01~2027-06' };
  if (/\d{4}[-.]\d{1,2}[-.]\d{1,2}|\d+\s*일/u.test(expr)) {
    return { error: '입주 시기는 날짜가 아니라 YYYY-MM 형식의 월 범위로 입력하세요. 예: 2027-01~2027-06' };
  }
  if (/(?:내년|올해|상반기|하반기|분기|년\s*안|년\s*이내|개월|또는|아니면|혹은|말고|이상|이하|이후|이전)/u.test(expr)) {
    return { error: '입주 시기는 YYYY-MM 형식의 시작월과 종료월을 함께 입력하세요. 예: 2027-01~2027-06' };
  }

  const cleaned = expr.replace(/\s*(?:까지|사이)\s*$/u, '').trim();
  const monthPat = '(\\d{4}(?:[-.]\\d{1,2}|년\\s*\\d{1,2}월))';
  const rangeRe = new RegExp(`^${monthPat}\\s*(?:~|～|–|—|에서|부터)\\s*${monthPat}$`, 'u');
  const match = rangeRe.exec(cleaned);
  if (!match) {
    return { error: '입주 시기는 시작월과 종료월(YYYY-MM)을 함께 입력하세요. 예: 2027-01~2027-06' };
  }

  const start = parseMonthToken(match[1]);
  const end = parseMonthToken(match[2]);
  if (!start || !end) {
    return { error: '유효한 입주 예정월(YYYY-MM)을 입력하세요. 예: 2027-01~2027-06' };
  }
  if (start > end) {
    return { error: '입주 종료월은 시작월 이후여야 합니다.' };
  }
  return { start, end };
}

function parseRegionsList(rawExpr, regions, fullSlice) {
  if (/(?:추가해|추가하|더해|빼\s*줘|빼\s*주|제외해|제외하)/u.test(fullSlice)) {
    return {
      error: '희망 지역은 전체 목록으로 지정해야 합니다. 기존 지역에 추가·제외하려면 공유 프로필 화면에서 선택하세요.',
    };
  }
  if (/(?:또는|아니면|혹은|말고|중에서)/u.test(rawExpr)) {
    return { error: '희망 지역은 적용할 시·군·구를 명확히 지정하세요.' };
  }
  const catalog = Array.isArray(regions)
    ? regions.filter((r) => r && typeof r.code === 'string' && REGION_CODE_RE.test(r.code))
    : [];

  const tokens = rawExpr
    .split(/(?:,|·|및|\s+하고\s+|\s+와\s+|\s+과\s+|(?<=[시군구])\s*(?:와|과)\s+)/u)
    .map((part) => part.trim())
    .filter(Boolean);

  if (!tokens.length) {
    return { error: '희망 지역은 시·군·구 이름이나 5자리 코드로 입력하세요.' };
  }

  const codes = [];
  const seen = new Set();

  for (const rawToken of tokens) {
    const clean = (token) => token.replace(/(?:으로|로)$/u, '').trim();
    const resolve = (term) => {
      if (!term) return null;
      if (REGION_CODE_RE.test(term)) {
        if (!catalog.length) return { code: term };
        const found = catalog.filter((r) => r.code === term);
        if (found.length === 1) return { code: found[0].code };
        return { error: `지역 코드 ${term}을 현재 공고 검색 지역 목록에서 확인할 수 없습니다.` };
      }
      if (!catalog.length) {
        return { error: '지역 목록이 없어 지역명을 확인할 수 없습니다. 공유 프로필 화면에서 시·군·구를 선택하세요.' };
      }
      const exact = catalog.filter((r) => r.name === term);
      if (exact.length === 1) return { code: exact[0].code };
      if (exact.length > 1) {
        return { error: `같은 이름의 지역(${term})이 여러 곳 있습니다. 5자리 지역 코드를 입력하세요.` };
      }
      const suffix = catalog.filter((r) => typeof r.name === 'string' && r.name.split(/\s+/u).at(-1) === term);
      if (suffix.length === 1) return { code: suffix[0].code };
      if (suffix.length > 1) {
        return {
          error: `같은 이름의 지역(${term})이 여러 곳 있습니다. 시·도를 포함한 전체 지역명이나 5자리 코드를 입력하세요.`,
        };
      }
      return null;
    };

    let resolved = resolve(rawToken);
    if (!resolved) {
      const stripped = clean(rawToken);
      if (stripped && stripped !== rawToken) resolved = resolve(stripped);
    }
    if (!resolved) {
      return {
        error: `희망 지역(${rawToken})을 확인할 수 없습니다. 공유 프로필 화면에서 시·군·구를 선택하세요.`,
      };
    }
    if (resolved.error) return resolved;
    if (!seen.has(resolved.code)) {
      seen.add(resolved.code);
      codes.push(resolved.code);
    }
  }

  if (codes.length < 1 || codes.length > 50) {
    return { error: '희망 지역은 1개 이상 50개 이하로 선택하세요.' };
  }
  return { codes };
}

function stripFieldEdge(text, fieldKey, isLast) {
  let slice = text.trim();
  // 조사 제거: "을/를/은/는/이/가/의/에서/에"
  slice = slice.replace(/^(?:조건(?:을|를|은|는)?\s*)?(?:을|를|은|는|이|가|의|에서|에)\s*/u, '');
  if (isLast) {
    slice = slice.replace(TRAILING_VERB_TAIL_RE, '');
  } else {
    slice = slice.replace(TRAILING_VERB_TAIL_RE, '');
    slice = slice.replace(CLAUSE_CONNECTOR_TAIL_RE, '');
  }
  if (fieldKey !== 'region') {
    slice = slice.replace(/(?:으로|로)$/u, '').trim();
  }
  return slice.trim();
}

function isRelativeBudgetDelta(fullSlice) {
  if (RELATIVE_DELTA_RE.test(fullSlice)) return true;
  if (/(?:올려|낮춰|줄여|늘려)/u.test(fullSlice) && !/(?:으로|로)\s*(?:올려|낮춰|줄여|늘려)/u.test(fullSlice)) {
    return true;
  }
  return false;
}

export function parseSharedProfileMessage(message, regions = []) {
  if (typeof message !== 'string') return null;
  const normalized = message.normalize('NFC');
  const trimmed = normalized.trim();
  if (!trimmed) return null;

  const plain = trimmed.replace(/\s+/gu, ' ');

  // 질문·가정·부정·"공유 프로필 말고"는 쓰기 요청으로 바꾸지 않는다.
  if (QUESTION_OR_HYPOTHETICAL_RE.test(plain)) return null;
  if (NEGATION_RE.test(plain)) return null;

  // 명시적 공유 프로필 범위와 변경·초기화 의도가 함께 있어야만 프로필 요청으로 본다.
  if (!EXPLICIT_SCOPE_RE.test(plain)) return null;
  if (!CHANGE_VERB_RE.test(plain)) return null;

  if (CONTROL_OR_SURROGATE.test(trimmed) || codePointLength(trimmed) > MAX_CODE_POINTS) {
    return { error: `공유 프로필 요청은 제어 문자 없이 ${MAX_CODE_POINTS}자 이하로 입력하세요.` };
  }

  if (CURRENT_ONLY_SCOPE_RE.test(plain)) {
    return { error: '이번 분석 조건과 공유 프로필 변경은 함께 처리할 수 없습니다. 공유 프로필 화면에서 따로 변경하세요.' };
  }
  if (ACTUAL_FUNDS_RE.test(plain)) {
    return { error: '보유 현금·잔액·이체·추가 자금·대출 정보는 공유 프로필이 아니라 각 분석의 호실 자금표에서 관리합니다.' };
  }
  if (COMMUTE_RE.test(plain)) {
    return { error: '출퇴근 목적지는 이 흐름에서 변경할 수 없습니다. 분석 화면의 출퇴근 경로 탭에서 확인 후 변경하세요.' };
  }
  if (ANALYSIS_EDIT_RE.test(plain)) {
    return { error: '분석별 비교 기간·단지·주택형 조건은 공유 프로필이 아니라 해당 분석 화면에서 따로 변경합니다.' };
  }
  if (EXCLUSIVE_AREA_RE.test(plain)) {
    return { error: '공유 프로필의 희망 면적은 전용면적이 아니라 공급면적(㎡) 기준입니다. 공급면적 최소·최대 값을 입력하세요.' };
  }

  const anchors = [];
  for (const match of plain.matchAll(FIELD_ANCHOR_RE)) {
    const field = normalizeAnchor(match[0]);
    if (!field) continue;
    anchors.push({ field, start: match.index, end: match.index + match[0].length, raw: match[0] });
  }

  if (!anchors.length) {
    if (CLEAR_VERB_RE.test(plain)) {
      return {
        error: '프로필 전체 삭제는 지원하지 않습니다. 비울 항목(희망 지역, 구매 예산, 공급면적, 입주 시기)을 지정하거나 공유 프로필 화면에서 수정하세요.',
      };
    }
    return {
      error: '변경할 공유 프로필 항목(희망 지역, 구매 예산, 공급면적, 입주 시기)과 값을 함께 입력하세요. 예: 다음 검색부터 구매 예산을 7억 원으로 바꿔줘',
    };
  }

  const seenFields = new Set();
  for (const anchor of anchors) {
    if (anchor.field === 'ambiguous_area') {
      return {
        error:
          '공유 프로필 면적은 공급면적 기준만 저장합니다. 전용면적과 구분되도록 "공급면적"을 명시해 입력하세요. 예: 다음 검색부터 공급면적을 84㎡~100㎡로 바꿔줘',
      };
    }
    if (seenFields.has(anchor.field)) {
      return { error: '같은 공유 프로필 항목을 한 번에 여러 값으로 지정할 수 없습니다. 하나의 값만 입력하세요.' };
    }
    seenFields.add(anchor.field);
  }

  const prefix = plain.slice(0, anchors[0].start).trim();
  const prefixRemainder = prefix.replace(SCOPE_STRIP_RE, '').trim();

  const patch = {};
  let consumedPrefixAsValue = false;

  for (let i = 0; i < anchors.length; i++) {
    const current = anchors[i];
    const nextStart = i + 1 < anchors.length ? anchors[i + 1].start : plain.length;
    const rawSlice = plain.slice(current.end, nextStart).trim();
    const isLast = i === anchors.length - 1;
    let valueExpr = stripFieldEdge(rawSlice, current.field, isLast);

    // 값이 항목명 앞에 온 단일 절(예: "다음 검색부터 7억 원으로 구매 예산을 바꿔줘")을 지원한다.
    if (!valueExpr && i === 0 && anchors.length === 1 && prefixRemainder && !FILLER_WORDS_RE.test(prefixRemainder)) {
      const candidate = prefixRemainder.replace(/(?:으로|로)$/u, '').trim();
      if (candidate) {
        valueExpr = candidate;
        consumedPrefixAsValue = true;
      }
    }

    const isClear = !valueExpr && CLEAR_VERB_RE.test(rawSlice);
    if (isClear) {
      if (current.field === 'budget') {
        patch.budget_max_won = null;
      } else if (current.field === 'area') {
        patch.supply_area_min_m2 = null;
        patch.supply_area_max_m2 = null;
      } else if (current.field === 'moveIn') {
        patch.move_in_start_month = null;
        patch.move_in_end_month = null;
      } else if (current.field === 'region') {
        patch.region_codes = null;
      }
      continue;
    }

    if (current.field === 'budget') {
      const sliceForRelative = consumedPrefixAsValue ? `${prefixRemainder} ${rawSlice}` : rawSlice;
      if (isRelativeBudgetDelta(sliceForRelative)) {
        return { error: '증감 폭이 아니라 적용할 최종 구매 예산 금액을 입력하세요. 예: 7억 5천만 원으로 바꿔줘' };
      }
      const parsed = parseKoreanWonExact(valueExpr);
      if (parsed.error) return { error: parsed.error };
      patch.budget_max_won = parsed.won;
    } else if (current.field === 'area') {
      const parsed = parseSupplyAreaRange(valueExpr);
      if (parsed.error) return { error: parsed.error };
      patch.supply_area_min_m2 = parsed.min;
      patch.supply_area_max_m2 = parsed.max;
    } else if (current.field === 'moveIn') {
      const parsed = parseMoveInRange(valueExpr);
      if (parsed.error) return { error: parsed.error };
      patch.move_in_start_month = parsed.start;
      patch.move_in_end_month = parsed.end;
    } else if (current.field === 'region') {
      const parsed = parseRegionsList(valueExpr, regions, rawSlice);
      if (parsed.error) return { error: parsed.error };
      patch.region_codes = parsed.codes;
    }
  }

  if (!consumedPrefixAsValue && prefixRemainder && !FILLER_WORDS_RE.test(prefixRemainder)) {
    return {
      error: '해석할 수 없는 조건이 함께 포함되어 있습니다. 공유 프로필 화면의 입력 양식에서 직접 지정하세요.',
    };
  }

  if (!Object.keys(patch).length) {
    return { error: '변경할 공유 프로필 항목과 값을 함께 입력하세요.' };
  }

  return { patch, reason: trimmed };
}

export function isSharedProfileMessage(message) {
  return parseSharedProfileMessage(message) !== null;
}
