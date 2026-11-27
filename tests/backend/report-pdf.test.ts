// 네트워크·실제 계정·외부 도구 없이 합성 저장 보고서 PDF 생성·한글 임베드·내보내기 제외·페이지 분할을 검사한다.
import assert from 'node:assert/strict';
import { globSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { inflateSync } from 'node:zlib';
import { renderSavedReportPdf } from '../../src/server/report-pdf.js';
import type { SavedReport } from '../../src/server/saved-report.js';

type ReportSection = SavedReport['sections'][number];

// PDF 바이트에서 압축 스트림을 해제하고 각 페이지의 ToUnicode CMap으로 실제 검색 가능한 유니코드 문자열을 복원한다.
function parsePdfObjects(pdfBytes: Uint8Array): Map<number, { dict: string; stream: Buffer | null }> {
  const raw = Buffer.from(pdfBytes);
  const latin1 = raw.toString('latin1');
  const objects = new Map<number, { dict: string; stream: Buffer | null }>();
  const objRegex = /(\d+)\s+0\s+obj\b([\s\S]*?)endobj/g;
  let match: RegExpExecArray | null;
  while ((match = objRegex.exec(latin1)) !== null) {
    const num = Number(match[1]);
    const bodyStart = match.index + match[0].indexOf(match[2]);
    const body = match[2];
    const streamIdx = body.indexOf('stream');
    if (streamIdx === -1) {
      objects.set(num, { dict: body, stream: null });
      continue;
    }
    const dict = body.slice(0, streamIdx);
    let dataStart = bodyStart + streamIdx + 'stream'.length;
    if (raw[dataStart] === 0x0d && raw[dataStart + 1] === 0x0a) dataStart += 2;
    else if (raw[dataStart] === 0x0a) dataStart += 1;
    const endStreamIdx = body.lastIndexOf('endstream');
    let dataEnd = bodyStart + endStreamIdx;
    while (dataEnd > dataStart && (raw[dataEnd - 1] === 0x0a || raw[dataEnd - 1] === 0x0d)) {
      dataEnd -= 1;
    }
    const slice = raw.subarray(dataStart, dataEnd);
    let stream: Buffer | null = slice;
    if (/\/Filter\s*\/FlateDecode/.test(dict)) {
      try {
        stream = inflateSync(slice);
      } catch {
        stream = slice;
      }
    }
    objects.set(num, { dict, stream });
  }
  return objects;
}

function decodeUtf16BeHex(hex: string): string {
  const buf = Buffer.from(hex, 'hex');
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    out += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
  }
  return out;
}

function parseToUnicodeCMap(cmapText: string): Map<number, string> {
  const map = new Map<number, string>();
  const rangeBlockRe = /beginbfrange([\s\S]*?)endbfrange/g;
  let block: RegExpExecArray | null;
  while ((block = rangeBlockRe.exec(cmapText)) !== null) {
    const lineRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(block[1])) !== null) {
      const start = parseInt(m[1], 16);
      const end = parseInt(m[2], 16);
      let dst = parseInt(m[3], 16);
      for (let code = start; code <= end; code += 1) {
        map.set(code, String.fromCodePoint(dst));
        dst += 1;
      }
    }
    const arrayLineRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([^\]]+)\]/g;
    while ((m = arrayLineRe.exec(block[1])) !== null) {
      const start = parseInt(m[1], 16);
      const entries = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map(e => decodeUtf16BeHex(e[1]));
      entries.forEach((ch, idx) => map.set(start + idx, ch));
    }
  }
  const charBlockRe = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((block = charBlockRe.exec(cmapText)) !== null) {
    const lineRe = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(block[1])) !== null) {
      map.set(parseInt(m[1], 16), decodeUtf16BeHex(m[2]));
    }
  }
  return map;
}

function decodePdfStringValue(raw: string): string {
  const trimmed = raw.trim();
  const hexMatch = trimmed.match(/^<([0-9a-fA-F]+)>$/);
  if (hexMatch) {
    const hex = hexMatch[1];
    if (hex.toLowerCase().startsWith('feff')) {
      return decodeUtf16BeHex(hex.slice(4));
    }
    return Buffer.from(hex, 'hex').toString('utf8');
  }
  const parenMatch = trimmed.match(/^\(([\s\S]*)\)$/);
  if (parenMatch) {
    const inner = parenMatch[1].replace(/\\([()\\])/g, '$1');
    const bytes = Buffer.from(inner, 'latin1');
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      let out = '';
      for (let i = 2; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      }
      return out;
    }
    return inner;
  }
  return trimmed;
}

function extractPdfInspection(pdfBytes: Uint8Array): {
  header: string;
  eofPresent: boolean;
  pageCount: number;
  pageTexts: string[];
  allText: string;
  embeddedFonts: string[];
  infoFields: Record<string, string>;
  allDecompressedText: string;
} {
  const rawLatin1 = Buffer.from(pdfBytes).toString('latin1');
  const objects = parsePdfObjects(pdfBytes);

  // Font object -> ToUnicode map.
  const fontMaps = new Map<number, Map<number, string>>();
  const embeddedFonts: string[] = [];
  for (const [objNum, obj] of objects) {
    const baseFont = obj.dict.match(/\/BaseFont\s*\/([^\s/[\]<>()]+)/);
    if (baseFont && /\/Subtype\s*\/Type0/.test(obj.dict)) {
      embeddedFonts.push(baseFont[1]);
    }
    const toUni = obj.dict.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
    if (toUni) {
      const cmapObj = objects.get(Number(toUni[1]));
      if (cmapObj?.stream) {
        fontMaps.set(objNum, parseToUnicodeCMap(cmapObj.stream.toString('latin1')));
      }
    }
  }

  // Info dictionary (resolving indirect string references like /Producer 16 0 R).
  const infoFields: Record<string, string> = {};
  const infoRef = rawLatin1.match(/\/Info\s+(\d+)\s+0\s+R/);
  if (infoRef) {
    const infoObj = objects.get(Number(infoRef[1]));
    if (infoObj) {
      for (const m of infoObj.dict.matchAll(/\/([A-Za-z]+)\s+(?:(\d+)\s+0\s+R|(<[0-9a-fA-F]+>|\([^)]*\)))/g)) {
        const key = m[1];
        const rawVal = m[2] ? (objects.get(Number(m[2]))?.dict ?? '') : (m[3] ?? '');
        infoFields[key] = decodePdfStringValue(rawVal);
      }
    }
  }

  // Pages in document order from /Pages /Kids.
  let pageObjNums: number[] = [];
  for (const [, obj] of objects) {
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) {
      const kids = obj.dict.match(/\/Kids\s*\[([^\]]+)\]/);
      if (kids) {
        pageObjNums = [...kids[1].matchAll(/(\d+)\s+0\s+R/g)].map(m => Number(m[1]));
        break;
      }
    }
  }

  const pageTexts: string[] = [];
  for (const pageNum of pageObjNums) {
    const pageObj = objects.get(pageNum);
    if (!pageObj) continue;

    // Resolve /Resources -> /Font mapping (F1 -> fontObjNum).
    let resDict = pageObj.dict;
    const resRef = pageObj.dict.match(/\/Resources\s+(\d+)\s+0\s+R/);
    if (resRef) {
      resDict = objects.get(Number(resRef[1]))?.dict ?? resDict;
    }
    const fontNameToObj = new Map<string, number>();
    const fontDictMatch = resDict.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (fontDictMatch) {
      for (const fm of fontDictMatch[1].matchAll(/\/(F\d+)\s+(\d+)\s+0\s+R/g)) {
        fontNameToObj.set(fm[1], Number(fm[2]));
      }
    }

    const contentRef = pageObj.dict.match(/\/Contents\s+(\d+)\s+0\s+R/);
    const contentStream = contentRef ? objects.get(Number(contentRef[1]))?.stream : null;
    if (!contentStream) {
      pageTexts.push('');
      continue;
    }

    const content = contentStream.toString('latin1');
    let currentFont = '';
    const pieces: string[] = [];
    const tokenRe = /\/(F\d+)\s+[\d.]+\s+Tf|\[([^\]]*)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g;
    let tok: RegExpExecArray | null;
    while ((tok = tokenRe.exec(content)) !== null) {
      if (tok[1]) {
        currentFont = tok[1];
        continue;
      }
      const cmap = fontMaps.get(fontNameToObj.get(currentFont) ?? -1);
      const hexChunks = tok[2]
        ? [...tok[2].matchAll(/<([0-9a-fA-F]+)>/g)].map(m => m[1])
        : tok[3]
          ? [tok[3]]
          : [];
      let line = '';
      for (const hex of hexChunks) {
        if (cmap) {
          for (let i = 0; i + 3 < hex.length; i += 4) {
            const gid = parseInt(hex.slice(i, i + 4), 16);
            line += cmap.get(gid) ?? '';
          }
        } else {
          line += Buffer.from(hex, 'hex').toString('latin1');
        }
      }
      if (line.length > 0) pieces.push(line);
    }
    pageTexts.push(pieces.join('\n'));
  }

  const decompressedParts: string[] = [rawLatin1];
  for (const [, obj] of objects) {
    if (obj.stream) decompressedParts.push(obj.stream.toString('utf8'));
  }

  return {
    header: rawLatin1.slice(0, 8),
    eofPresent: rawLatin1.includes('%%EOF'),
    pageCount: pageObjNums.length,
    pageTexts,
    allText: pageTexts.join('\n\n'),
    embeddedFonts,
    infoFields,
    allDecompressedText: decompressedParts.join('\n'),
  };
}

function makeShortSyntheticReport(): SavedReport {
  return {
    contractVersion: 'saved-report/v1',
    reportId: 'rep-syn-20261123-0001',
    analysisId: 'ana-syn-20261123-0001',
    runId: 'run-syn-20261123-0001',
    snapshotId: 'snap-syn-20261123-0001',
    version: 2,
    createdAt: '2026-11-23T14:00:00Z',
    queriedAt: '2026-11-23T13:55:00Z',
    dataOrigin: 'synthetic',
    title: '합성 예시 공고 — 광진구 구의동 84C 주택형 분석 보고서',
    sections: [
      {
        id: 'notice',
        title: '공고 요약 및 주택형 가격',
        state: 'confirmed',
        exportAllowed: true,
        rows: [
          { label: '공고명', value: '강변역 센트럴 아이파크 (합성 시험 자료)' },
          { label: '공고번호 / 회차', value: '2026930040 · 정정 0회' },
          { label: '소재지 및 법정동코드', value: '서울특별시 광진구 구의동 123-45 (1121510300)' },
          { label: '선택 주택형 면적', value: '공급 105.89㎡ · 전용 84.98㎡ (혼용 없음)' },
          { label: '분양가 + 필수 옵션 소계', value: '1,222,020,000원 ~ 1,264,500,000원 (확인 호실 기준)' },
        ],
        tables: [],
        notes: [
          '분양가 + 필수 옵션 소계는 총취득비용이 아니며, 취득세·등기비·금융비용은 별도입니다.',
        ],
      },
      {
        id: 'comparison',
        title: '주변 실거래 비교 (공급면적 ±5%)',
        state: 'partial',
        exportAllowed: true,
        rows: [
          { label: '비교 지역 범위', value: '광진구 구의동 정상 0건으로 서울특별시 광진구로 확대' },
          { label: '비교 기간 및 기준', value: '2025.11–2026.10 · 매매 · 해제 거래 제외 · 공급면적 ±5%' },
        ],
        tables: [
          {
            headers: ['단지명', '공급면적', '직선거리', '중위가', '최소~최대', '유효 건수'],
            rows: [
              ['합성 예시 단지 A', '106.12㎡', '420m', '1,340,000,000원', '1,310,000,000원 ~ 1,380,000,000원', '3건'],
              ['합성 예시 단지 B', '104.70㎡', '780m', '1,295,000,000원', '1,295,000,000원 ~ 1,295,000,000원', '1건 (적은 표본)'],
            ],
          },
        ],
        notes: [
          '1~2건 거래 단지는 적은 표본으로 표시했습니다. 공급면적 대응 미확인 1개 단지는 비교에서 보류했습니다.',
        ],
      },
      {
        id: 'funding',
        title: '기초 자금표 (분석별 입력)',
        state: 'confirmed',
        exportAllowed: true,
        rows: [
          { label: '현재 보유 자금', value: '250,000,000원 (확정 입력)' },
          { label: '동일 일자 입금 선후 미확인', value: '입금 전 부족액 50,000,000원 / 입금 후 부족액 0원 (예상 자금 포함)' },
        ],
        tables: [
          {
            headers: ['구분', '납부 예정일', '납부 금액', '누적 납부액', '부족액 판정'],
            rows: [
              ['계약금 1차', '2026.12.10', '122,202,000원', '122,202,000원', '0원'],
              ['중도금 1차', '2027.04.15', '177,798,000원', '300,000,000원', '입금 전 50,000,000원 / 입금 후 0원'],
            ],
          },
        ],
        notes: [
          '예상 자금 반영은 사용자 가정이며 금융기관 대출 승인 결과를 뜻하지 않습니다.',
        ],
      },
      {
        id: 'law',
        title: '법령 근거',
        state: 'reference',
        exportAllowed: true,
        rows: [
          { label: '적용 기준시점', value: '공고일 2026.09.23 시행본 기준' },
          { label: '참조 법령', value: '주택공급에 관한 규칙 제28조 (법령 MST 281920)' },
        ],
        tables: [],
        notes: ['개별 청약 자격 충족 여부는 공고 원문과 기관 안내를 직접 확인해야 합니다.'],
      },
      {
        id: 'news',
        title: '지역 뉴스',
        state: 'reference',
        exportAllowed: false,
        rows: [
          { label: '비공개 원문 항목', value: 'CANARY_NEWS_ROW_MUST_NOT_LEAK_7741' },
        ],
        tables: [
          {
            headers: ['CANARY_NEWS_HEADER_8821', '원문 링크'],
            rows: [['CANARY_NEWS_BODY_SECRET_9932', 'https://news-body.invalid/private-blob-url']],
          },
        ],
        notes: ['CANARY_NEWS_NOTE_FORBIDDEN_6610'],
      },
      {
        id: 'commute',
        title: '출퇴근 경로',
        state: 'held',
        exportAllowed: true,
        rows: [],
        tables: [],
        notes: ['자동차 경로 API 조회가 보류되어 대중교통 참고 시간만 별도 확인이 필요합니다.'],
      },
      {
        id: 'evidence',
        title: '근거 및 출처 요약',
        state: 'confirmed',
        exportAllowed: true,
        rows: [
          { label: '공고 PDF 근거', value: '공식 공고 PDF p.4 · p.7 (자동 점검 통과)' },
          { label: '실거래 출처', value: '국토교통부 실거래가 공개 API · 2026-11-23T13:55:00Z 수집' },
        ],
        tables: [],
        notes: [],
      },
    ],
  };
}

function makeLongMultiPageSyntheticReport(): SavedReport {
  const longComparisonRows: string[][] = Array.from({ length: 34 }, (_, idx) => {
    const num = idx + 1;
    const median = `${(11 + (num % 5)).toString()},${String(100 + num * 13).padStart(3, '0')},000,000원`;
    const area = `${(101.2 + (num % 9) * 0.85).toFixed(2)}㎡`;
    const dist = `${210 + num * 45}m`;
    const note =
      num % 4 === 0
        ? `장문 한글 셀 줄바꿈 검증 항목 ${num}번: 서울특별시 광진구 구의동·자양동 인접 생활권 내 공급면적 ±5% 기준 충족 및 해제 거래 제외 후 유효 거래 집계 결과입니다. (공고문 대조 완료, 2025.11–2026.10)`
        : `합성 비교 단지 ${num}차 · 공백없는장문한글토큰줄바꿈검증테스트용식별문자열${num}호실별기준확인`;
    return [
      `합성 단지 ${String(num).padStart(2, '0')} (${num % 2 === 0 ? '매매' : '분양권'})`,
      area,
      dist,
      median,
      `${(num % 6) + 1}건`,
      note,
    ];
  });

  const base = makeShortSyntheticReport();
  const longSections: ReportSection[] = [
    base.sections[0],
    {
      id: 'comparison',
      title: '장문 주변 실거래 비교표 (페이지 분할 및 머리글 반복 검증)',
      state: 'confirmed',
      exportAllowed: true,
      rows: [
        { label: '조회 범위', value: '서울특별시 광진구 전체 (공급면적 100.60㎡ ~ 111.18㎡)' },
      ],
      tables: [
        {
          headers: ['비교 단지명', '공급면적', '직선거리', '중위 거래금액', '유효 건수', '근거 및 확인 메모'],
          rows: longComparisonRows,
        },
      ],
      notes: [
        '이 표는 여러 페이지로 분할될 때 매 페이지 상단에 표 머리글이 반복되는지 확인하기 위한 합성 시험 표입니다.',
      ],
    },
    base.sections[2],
    {
      id: 'news',
      title: '지역 뉴스 (사전 마스킹 완료)',
      state: 'reference',
      exportAllowed: false,
      rows: [],
      tables: [],
      notes: [],
    },
    {
      id: 'commute',
      title: '출퇴근 경로 (보류 및 빈 섹션)',
      state: 'held',
      exportAllowed: true,
      rows: [],
      tables: [],
      notes: [],
    },
    base.sections[6],
  ];

  return {
    ...base,
    reportId: 'rep-syn-20261123-long',
    version: 4,
    dataOrigin: 'collected',
    title: '광진구 구의동 84C 주택형 다중 페이지 비교 보고서 (장문 표·페이지 분할 합성 검증)',
    sections: longSections,
  };
}

test('오프라인으로 한글 Pretendard가 임베드된 검색 가능한 PDF를 생성하고 안전 메타데이터를 설정한다', async (t: TestContext) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('unexpected_network_call_during_pdf_render');
  });

  const report = makeShortSyntheticReport();
  const pdf = await renderSavedReportPdf(report);

  assert.ok(pdf instanceof Uint8Array);
  assert.ok(pdf.byteLength > 4000, `PDF too small: ${pdf.byteLength}`);

  const info = extractPdfInspection(pdf);
  assert.equal(info.header, '%PDF-1.7');
  assert.equal(info.eofPresent, true);
  assert.ok(info.pageCount >= 1);

  // Pretendard 정적 TrueType 폰트가 Type0/Identity-H로 실제 임베드되어야 한다.
  assert.ok(
    info.embeddedFonts.some(f => f.includes('Pretendard-Regular')),
    `Expected Pretendard-Regular in ${info.embeddedFonts.join(', ')}`,
  );
  assert.ok(
    info.embeddedFonts.some(f => f.includes('Pretendard-Bold')),
    `Expected Pretendard-Bold in ${info.embeddedFonts.join(', ')}`,
  );

  // 일반 안전 메타데이터 검증 (원시 JSON, API 키, 비공개 경로, 보고서별 원문 금지).
  assert.equal(info.infoFields.Title, 'HomeCierge 분석 보고서');
  assert.equal(info.infoFields.Author, 'HomeCierge');
  assert.equal(info.infoFields.Creator, 'HomeCierge');
  assert.equal(info.infoFields.Producer, 'HomeCierge');
  const serializedInfo = JSON.stringify(info.infoFields);
  assert.doesNotMatch(serializedInfo, /CANARY|supabase|sb_publishable|analysis-uploads|saved-report\/v1|강변역/i);

  // 핵심 한국어, 원화 금액, 날짜, UTC 타임스탬프, 면적, 상태 판정, 합성 자료 표시 확인.
  for (const expected of [
    'HomeCierge',
    '합성 자료',
    '2026-11-23T14:00:00Z',
    '2026-11-23T13:55:00Z',
    '강변역 센트럴 아이파크',
    '공급 105.89㎡ · 전용 84.98㎡',
    '1,222,020,000원 ~ 1,264,500,000원',
    '1,340,000,000원',
    '입금 전 부족액 50,000,000원 / 입금 후 부족액 0원',
    '주택공급에 관한 규칙 제28조',
    '공식 공고 PDF p.4',
    '확인됨',
    '일부 확인',
    '보류',
    '참고',
    `페이지 1 / ${info.pageCount}`,
  ]) {
    assert.ok(info.allText.includes(expected), `Extracted PDF text missing: ${expected}`);
  }
});

test('exportAllowed=false 섹션은 원본 rows/tables/notes가 전달되어도 모든 내용을 제외하고 중립 안내로 대체한다', async () => {
  const report = makeShortSyntheticReport();
  report.title = '제한된 합성 공고명 9831';
  report.sections.find(section => section.id === 'notice')!.exportAllowed = false;
  const pdf = await renderSavedReportPdf(report);
  const info = extractPdfInspection(pdf);

  // 금지된 카나리 문자열은 추출 텍스트뿐 아니라 압축 해제된 전체 PDF 스트림에도 존재해서는 안 된다.
  for (const forbidden of [
    'CANARY_NEWS_ROW_MUST_NOT_LEAK_7741',
    'CANARY_NEWS_HEADER_8821',
    'CANARY_NEWS_BODY_SECRET_9932',
    'CANARY_NEWS_NOTE_FORBIDDEN_6610',
    'news-body.invalid',
    '비공개 원문 항목',
    '제한된 합성 공고명 9831',
  ]) {
    assert.equal(info.allText.includes(forbidden), false, `Forbidden string leaked to text: ${forbidden}`);
    assert.equal(
      info.allDecompressedText.includes(forbidden),
      false,
      `Forbidden string leaked to raw/decompressed PDF stream: ${forbidden}`,
    );
  }

  // 섹션 제목·보존된 상태·내보내기 제외 배지·중립 안내문은 유지한다.
  assert.ok(info.allText.includes('지역 뉴스'));
  assert.ok(info.allText.includes('내보내기 제외'));
  assert.ok(info.allText.includes('PDF 문서에 포함하지 않았습니다'));
});

test('긴 한글 표와 다중 페이지 보고서는 페이지를 분할하며 이어지는 페이지마다 표 머리글을 반복한다', async () => {
  const report = makeLongMultiPageSyntheticReport();
  const pdf = await renderSavedReportPdf(report);
  const info = extractPdfInspection(pdf);

  assert.ok(info.pageCount >= 3, `Expected >= 3 pages for long report, got ${info.pageCount}`);

  // 표 머리글('비교 단지명', '중위 거래금액')이 최소 2개 이상의 페이지에서 반복 출력되어야 한다.
  const pagesWithTableHeader = info.pageTexts.filter(
    text => text.includes('비교 단지명') && text.includes('중위 거래금액'),
  );
  assert.ok(
    pagesWithTableHeader.length >= 2,
    `Expected repeated table header on >= 2 pages, found on ${pagesWithTableHeader.length} pages`,
  );

  // 첫 행부터 마지막 34번째 행까지 누락 없이 포함되어야 한다.
  assert.ok(info.allText.includes('합성 단지 01'));
  assert.ok(info.allText.includes('합성 단지 34'));
  assert.ok(info.allText.includes('수집 자료'));

  // 사전 마스킹된 빈 exportAllowed=false 섹션과 빈 held 섹션도 안전하게 처리한다.
  assert.ok(info.allText.includes('지역 뉴스 (사전 마스킹 완료)'));
  assert.ok(info.allText.includes('보류 상태로 표시할 상세 항목이 없습니다.'));

  // 2페이지 이상에는 페이지 번호가 끝 페이지까지 정확히 찍힌다.
  assert.ok(info.pageTexts[info.pageCount - 1].includes(`페이지 ${info.pageCount} / ${info.pageCount}`));
});

test('한 페이지를 넘는 초대형 한글 셀·HTML 유사 문자열·제어 문자·빈 값도 누락이나 오류 없이 처리한다', async () => {
  const megaParagraph = Array.from(
    { length: 48 },
    (_, i) => `초대형셀줄${String(i + 1).padStart(2, '0')} 서울특별시 광진구 구의동 공고 원문 대조 근거 설명 및 호실별 필수 옵션 검토 기록입니다.`,
  ).join(' ');

  const report: SavedReport = {
    contractVersion: 'saved-report/v1',
    reportId: 'rep-edge-001',
    analysisId: 'ana-edge-001',
    runId: 'run-edge-001',
    snapshotId: 'snap-edge-001',
    version: 1,
    createdAt: '2026-11-23T14:30:00Z',
    queriedAt: '2026-11-23T14:25:00Z',
    dataOrigin: 'synthetic',
    title: '<script>alert("xss")</script> <b>안전 문자열 검증</b>',
    sections: [
      {
        id: 'notice',
        title: '공고 요약',
        state: 'held',
        exportAllowed: true,
        rows: [
          { label: 'HTML 리터럴', value: '<b>분양가</b> 미확인\u0000\u0007 (임의 합계 생성 금지)' },
          { label: '빈 값 처리', value: '   ' },
        ],
        tables: [
          {
            headers: ['항목', '상세 근거'],
            rows: [['장문 단일 셀', megaParagraph]],
          },
        ],
        notes: [],
      },
    ],
  };

  const pdf = await renderSavedReportPdf(report);
  const info = extractPdfInspection(pdf);

  assert.ok(info.pageCount >= 2, `Expected multi-page split for oversized cell, got ${info.pageCount}`);
  assert.ok(info.allText.includes('<script>alert("xss")</script>'));
  assert.ok(info.allText.includes('<b>분양가</b> 미확인'));
  assert.ok(info.allText.includes('초대형셀줄01'));
  assert.ok(info.allText.includes('초대형셀줄48'));
  // 빈 문자열을 0원으로 지어내지 않고 '—'를 사용한다.
  assert.equal(info.allText.includes('0원'), false);
  assert.ok(info.allText.includes('—'));
});

test('saved-report.ts의 8열 실거래 비교표와 3연속 자금표 구조도 원화 단위 분리 없이 렌더링한다', async () => {
  const report: SavedReport = {
    contractVersion: 'saved-report/v1',
    reportId: 'a1100000-0000-4000-8000-000000000101',
    analysisId: 'a1100000-0000-4000-8000-000000000102',
    runId: 'a1100000-0000-4000-8000-000000000103',
    snapshotId: 'a1100000-0000-4000-8000-000000000104',
    version: 1,
    createdAt: '2026-11-23T14:40:00Z',
    queriedAt: '2026-11-23T14:35:00Z',
    dataOrigin: 'synthetic',
    title: '강변역 센트럴 아이파크 84C 분석 보고서',
    sections: [
      {
        id: 'comparison',
        title: '주변 실거래 비교',
        state: 'confirmed',
        exportAllowed: true,
        rows: [
          { label: '적용 지역', value: '서울특별시 광진구' },
          { label: '거래 종류', value: '아파트 매매 · 분양권' },
        ],
        tables: [
          {
            headers: ['단지', '공급면적', '거래', '건수', '최저', '중위', '최고', '상태'],
            rows: [
              ['주변 · 합성 리버뷰 아파트', '106.12㎡', '아파트 매매', '3건', '1,310,000,000원', '1,340,000,000원', '1,380,000,000원', '확인'],
              ['자체 거래 · 강변역 센트럴', '105.89㎡', '분양권', '1건', '1,290,000,000원', '1,290,000,000원', '1,290,000,000원', '잠정 · 소표본'],
            ],
          },
        ],
        notes: [],
      },
      {
        id: 'funding',
        title: '호실 자금표',
        state: 'partial',
        exportAllowed: true,
        rows: [
          { label: '선택 호실', value: '101동 1201호' },
          { label: '분양가와 필수 옵션 합계', value: '1,222,020,000원' },
        ],
        tables: [
          {
            headers: ['자금', '기준일·입금일', '확정 여부', '금액'],
            rows: [
              ['보유 잔액', '2026-11-23', '확정', '250,000,000원'],
              ['추가 자금', '2027-04-15', '예상', '50,000,000원'],
            ],
          },
          {
            headers: ['납부일', '확인 납부액', '자금 기준', '입금 전 부족액', '입금 후 부족액', '보류 사유'],
            rows: [
              ['2027-04-15', '300,000,000원', '확정 자금', '50,000,000원', '50,000,000원', '—'],
              ['2027-04-15', '300,000,000원', '예상 자금 포함', '50,000,000원', '0원', '기준일 입금의 잔액 포함 여부 미확인'],
            ],
          },
        ],
        notes: [],
      },
    ],
  };

  const pdf = await renderSavedReportPdf(report);
  const info = extractPdfInspection(pdf);
  assert.equal(info.header, '%PDF-1.7');
  for (const needle of [
    '주변 · 합성 리버뷰 아파트',
    '1,310,000,000원',
    '1,340,000,000원',
    '1,380,000,000원',
    '106.12㎡',
    '잠정 · 소표본',
    '기준일 입금의 잔액 포함 여부 미확인',
  ]) {
    assert.ok(info.allText.includes(needle), `Missing 8-col/funding needle: ${needle}`);
  }
});

test('지원하지 않는 계약 버전이나 잘못된 섹션 배열은 명시적 오류로 거부한다', async () => {
  await assert.rejects(
    () =>
      renderSavedReportPdf({
        ...makeShortSyntheticReport(),
        contractVersion: 'saved-report/v2' as 'saved-report/v1',
      }),
    /unsupported_saved_report_contract/,
  );

  await assert.rejects(
    () =>
      renderSavedReportPdf({
        ...makeShortSyntheticReport(),
        sections: null as unknown as SavedReport['sections'],
      }),
    /invalid_saved_report_sections/,
  );
});

test('vercel.json의 includeFiles 글롭이 실제 설치된 Pretendard 정적 TTF 4종과 정확히 일치한다', () => {
  const vercelConfig = JSON.parse(
    readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'),
  ) as { functions?: Record<string, { includeFiles?: string }> };
  const includeFiles = vercelConfig.functions?.['api/index.ts']?.includeFiles;
  assert.equal(typeof includeFiles, 'string');
  assert.ok(includeFiles && includeFiles.length <= 256);

  const matched = globSync(includeFiles, {
    cwd: new URL('../../', import.meta.url),
  }).sort();
  assert.deepEqual(matched, [
    'node_modules/pretendard/dist/public/static/alternative/Pretendard-Bold.ttf',
    'node_modules/pretendard/dist/public/static/alternative/Pretendard-Medium.ttf',
    'node_modules/pretendard/dist/public/static/alternative/Pretendard-Regular.ttf',
    'node_modules/pretendard/dist/public/static/alternative/Pretendard-SemiBold.ttf',
  ]);
});
