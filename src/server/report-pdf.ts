// 저장 보고서 공개 계약(saved-report/v1)을 오프라인 서버 PDF(A4, Pretendard 임베드)로 렌더링한다.
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import type { SavedReport } from './saved-report.js';

type ReportSection = SavedReport['sections'][number];
type ReportRow = ReportSection['rows'][number];
type ReportTable = ReportSection['tables'][number];
type SectionId = ReportSection['id'];
type SectionState = ReportSection['state'];

type FontWeight = 'Regular' | 'Medium' | 'SemiBold' | 'Bold';
type FontBuffers = Record<FontWeight, Buffer>;

type TextOptions = PDFKit.Mixins.TextOptions;

// HomeCierge 라이트 디자인 토큰(HomeCierge-design_system/tokens.json OKLCH -> sRGB 변환값).
const COLORS = {
  background: '#e7e5e4',
  foreground: '#1e293b',
  card: '#f5f5f4',
  cardZebra: '#fafaf9',
  surface: '#ffffff',
  primary: '#4f46e5',
  primaryDark: '#3730a3',
  primarySoft: '#e9edff',
  primaryBorder: '#c7d2fe',
  secondary: '#d6d3d1',
  secondaryFg: '#4b5563',
  mutedFg: '#545b68',
  border: '#d6d3d1',
  softLine: '#e8e6e4',
  input: '#858991',
  statusVerified: '#006a42',
  statusVerifiedSoft: '#d9f7e5',
  statusVerifiedBorder: '#8fd1ae',
  statusZero: '#444e5e',
  statusZeroSoft: '#e1e5ea',
  statusZeroBorder: '#b8c1ce',
  statusPartial: '#874e00',
  statusPartialSoft: '#ffecc1',
  statusPartialBorder: '#e2bd6b',
  statusConflict: '#892f84',
  statusConflictSoft: '#fbe8f8',
  statusConflictBorder: '#d29ad0',
  statusUnknown: '#5f5650',
} as const;

const PAGE = {
  width: 595.28,
  height: 841.89,
  marginX: 40,
  firstPageTop: 34,
  continuationTop: 50,
  contentBottom: 786,
  footerRuleY: 798,
  footerTextY: 806,
  headerTextY: 20,
  headerRuleY: 36,
} as const;

const CONTENT_WIDTH = PAGE.width - PAGE.marginX * 2;
const MAX_BODY_HEIGHT = PAGE.contentBottom - PAGE.continuationTop;

const TNUM_FEATURES: PDFKit.Mixins.OpenTypeFeatures[] = ['tnum'];

const SECTION_KIND_LABELS: Record<SectionId, string> = {
  notice: '공고 요약',
  comparison: '실거래 비교',
  funding: '기초 자금표',
  law: '법령 근거',
  news: '지역 뉴스',
  commute: '출퇴근 경로',
  evidence: '근거 · 출처',
};

type StateBadgeStyle = {
  label: string;
  fg: string;
  bg: string;
  border: string;
  accent: string;
  dashed: boolean;
  icon: 'check' | 'partial' | 'held' | 'reference' | 'excluded';
};

const STATE_STYLES: Record<SectionState, StateBadgeStyle> = {
  confirmed: {
    label: '확인됨',
    fg: COLORS.statusVerified,
    bg: COLORS.statusVerifiedSoft,
    border: COLORS.statusVerifiedBorder,
    accent: COLORS.statusVerified,
    dashed: false,
    icon: 'check',
  },
  partial: {
    label: '일부 확인',
    fg: COLORS.statusPartial,
    bg: COLORS.statusPartialSoft,
    border: COLORS.statusPartialBorder,
    accent: COLORS.statusPartial,
    dashed: false,
    icon: 'partial',
  },
  held: {
    label: '보류',
    fg: COLORS.statusConflict,
    bg: COLORS.statusConflictSoft,
    border: COLORS.statusConflictBorder,
    accent: COLORS.statusConflict,
    dashed: true,
    icon: 'held',
  },
  reference: {
    label: '참고',
    fg: COLORS.statusZero,
    bg: COLORS.statusZeroSoft,
    border: COLORS.statusZeroBorder,
    accent: COLORS.statusZero,
    dashed: false,
    icon: 'reference',
  },
};

const EXCLUDED_BADGE_STYLE: StateBadgeStyle = {
  label: '내보내기 제외',
  fg: COLORS.statusUnknown,
  bg: COLORS.surface,
  border: COLORS.input,
  accent: COLORS.input,
  dashed: true,
  icon: 'excluded',
};

const EXCLUDED_NOTICE_TITLE =
  '이 항목은 출처 이용 조건 또는 내보내기 제한에 따라 PDF 문서에 포함하지 않았습니다.';
const EXCLUDED_NOTICE_DETAIL =
  '항목의 판정 상태만 유지하며, 원본 내용은 서비스 화면에서 허용된 범위로 확인할 수 있습니다.';

const FONT_PACKAGE_PATHS: Record<FontWeight, string> = {
  Regular: 'pretendard/dist/public/static/alternative/Pretendard-Regular.ttf',
  Medium: 'pretendard/dist/public/static/alternative/Pretendard-Medium.ttf',
  SemiBold: 'pretendard/dist/public/static/alternative/Pretendard-SemiBold.ttf',
  Bold: 'pretendard/dist/public/static/alternative/Pretendard-Bold.ttf',
};

const requireFromHere = createRequire(import.meta.url);
let cachedFontsPromise: Promise<FontBuffers> | null = null;

async function loadFonts(): Promise<FontBuffers> {
  if (!cachedFontsPromise) {
    cachedFontsPromise = (async () => {
      const [regular, medium, semiBold, bold] = await Promise.all([
        readFile(requireFromHere.resolve(FONT_PACKAGE_PATHS.Regular)),
        readFile(requireFromHere.resolve(FONT_PACKAGE_PATHS.Medium)),
        readFile(requireFromHere.resolve(FONT_PACKAGE_PATHS.SemiBold)),
        readFile(requireFromHere.resolve(FONT_PACKAGE_PATHS.Bold)),
      ]);
      return { Regular: regular, Medium: medium, SemiBold: semiBold, Bold: bold };
    })().catch((error: unknown) => {
      cachedFontsPromise = null;
      throw error;
    });
  }
  return cachedFontsPromise;
}

function stripUnsafeChars(raw: string): string {
  // 제어 문자와 짝 없는 UTF-16 서로게이트를 제거해 스트림 손상 및 글꼴 예외를 막는다.
  const normalized = raw.replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
  let out = '';
  for (let i = 0; i < normalized.length; i += 1) {
    const code = normalized.charCodeAt(i);
    if (code === 0x0a) {
      out += '\n';
      continue;
    }
    if (code < 0x20 || code === 0x7f) continue;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = normalized.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += normalized.slice(i, i + 2);
        i += 1;
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) continue;
    out += normalized[i];
  }
  return out;
}

function cleanText(raw: unknown, fallback = '—'): string {
  if (typeof raw !== 'string') return fallback;
  const cleaned = stripUnsafeChars(raw).trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function cleanSingleLine(raw: unknown, fallback = '—'): string {
  const cleaned = cleanText(raw, fallback).replace(/\n+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return cleaned.length > 0 ? cleaned : fallback;
}

function parseSafePdfDate(timestamp: unknown): Date {
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  return new Date(0);
}

function isNumericValue(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '—' || trimmed === '-') return true;
  // 원화 금액, 억/만 표기, 면적(㎡/평), 건수, 비율, 기간/시간, 날짜는 우측 정렬 후보로 판별한다.
  if (/^[+-]?[0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?(?:\s*(?:원|만\s*원|억|㎡|평|건|%|분|시간|km|m|세대|호실|층|년|개월|일))?$/u.test(trimmed)) {
    return true;
  }
  if (/^(?:약\s*)?[0-9]+억(?:\s*[0-9,]+만)?\s*원(?:\s*~\s*(?:[0-9]+억\s*)?[0-9,]+만\s*원)?$/u.test(trimmed)) {
    return true;
  }
  if (/^[0-9,]+원\s*~\s*[0-9,]+원$/u.test(trimmed)) {
    return true;
  }
  if (/^[0-9]{4}[.-][0-9]{2}(?:[.-][0-9]{2})?(?:\s*[~–-]\s*[0-9]{4}[.-][0-9]{2}(?:[.-][0-9]{2})?)?$/u.test(trimmed)) {
    return true;
  }
  return false;
}

function isNumericColumn(header: string, columnValues: string[]): boolean {
  const nonEmpty = columnValues.filter(v => v.trim().length > 0 && v.trim() !== '—' && v.trim() !== '-');
  if (nonEmpty.length === 0) {
    return /(?:금액|가격|원|면적|㎡|건수|부족|누적|납부|거리|시간|비율|분양가|중위|최소|최대)/u.test(header);
  }
  const numericHits = nonEmpty.filter(isNumericValue).length;
  return numericHits / nonEmpty.length >= 0.7;
}

function validateReportInput(report: SavedReport): void {
  if (!report || typeof report !== 'object') {
    throw new Error('invalid_saved_report');
  }
  if (report.contractVersion !== 'saved-report/v1') {
    throw new Error('unsupported_saved_report_contract');
  }
  if (!Array.isArray(report.sections)) {
    throw new Error('invalid_saved_report_sections');
  }
  if (typeof report.version !== 'number' || !Number.isFinite(report.version) || report.version < 0) {
    throw new Error('invalid_saved_report_version');
  }
}

class PdfRenderer {
  private readonly doc: PDFKit.PDFDocument;
  private y: number = PAGE.firstPageTop;
  private readonly report: SavedReport;
  private readonly titleText: string;
  private readonly dataOriginLabel: string;
  private readonly createdAtText: string;
  private readonly queriedAtText: string;

  constructor(doc: PDFKit.PDFDocument, report: SavedReport) {
    this.doc = doc;
    this.report = report;
    const mayNameNotice = report.sections.some(section => section.id === 'notice' && section.exportAllowed);
    this.titleText = mayNameNotice ? cleanSingleLine(report.title, 'HomeCierge 분석 보고서') : 'HomeCierge 분석 보고서';
    this.dataOriginLabel = report.dataOrigin === 'synthetic' ? '합성 자료' : '수집 자료';
    this.createdAtText = cleanSingleLine(report.createdAt, '—');
    this.queriedAtText = cleanSingleLine(report.queriedAt, '—');
  }

  private setFont(weight: FontWeight, size: number, color: string = COLORS.foreground): void {
    this.doc.font(weight).fontSize(size).fillColor(color);
  }

  private measureHeight(text: string, width: number, weight: FontWeight, size: number, lineGap: number): number {
    this.setFont(weight, size);
    const h = this.doc.heightOfString(text, {
      width: Math.max(10, width),
      lineGap,
      features: TNUM_FEATURES,
    });
    return Math.max(size + 2, h);
  }

  private measureWidth(text: string, weight: FontWeight, size: number): number {
    this.setFont(weight, size);
    return this.doc.widthOfString(text, { features: TNUM_FEATURES });
  }

  private addPage(): void {
    this.doc.addPage({
      size: [PAGE.width, PAGE.height],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
    });
    this.y = PAGE.continuationTop;
  }

  private ensureSpace(neededHeight: number): boolean {
    if (this.y + neededHeight <= PAGE.contentBottom) return false;
    this.addPage();
    return true;
  }

  private drawStateIcon(x: number, centerY: number, style: StateBadgeStyle): void {
    const r = 3.6;
    const cx = x + r;
    const doc = this.doc;
    doc.save();
    doc.lineWidth(0.95).strokeColor(style.fg).fillColor(style.fg);
    if (style.icon === 'check') {
      doc.circle(cx, centerY, r).stroke();
      doc
        .moveTo(cx - 1.7, centerY + 0.1)
        .lineTo(cx - 0.3, centerY + 1.5)
        .lineTo(cx + 2.0, centerY - 1.4)
        .stroke();
    } else if (style.icon === 'partial') {
      doc.circle(cx, centerY, r).stroke();
      doc.path(`M ${cx} ${centerY - r} A ${r} ${r} 0 0 1 ${cx} ${centerY + r} Z`).fill();
    } else if (style.icon === 'held') {
      doc.circle(cx, centerY, r).stroke();
      doc.moveTo(cx - 1.2, centerY - 1.6).lineTo(cx - 1.2, centerY + 1.6).stroke();
      doc.moveTo(cx + 1.2, centerY - 1.6).lineTo(cx + 1.2, centerY + 1.6).stroke();
    } else if (style.icon === 'excluded') {
      doc.circle(cx, centerY, r).stroke();
      doc.moveTo(cx - 2.3, centerY + 2.3).lineTo(cx + 2.3, centerY - 2.3).stroke();
    } else {
      doc.circle(cx, centerY, r).stroke();
      doc.circle(cx, centerY, 1.1).fill();
    }
    doc.restore();
  }

  private measureBadgeWidth(style: StateBadgeStyle): number {
    const textW = this.measureWidth(style.label, 'SemiBold', 7.5);
    return 7 + 7.2 + 4 + textW + 7;
  }

  private drawStateBadge(x: number, y: number, style: StateBadgeStyle): number {
    const badgeH = 16;
    const badgeW = this.measureBadgeWidth(style);
    const doc = this.doc;

    doc.save();
    doc.roundedRect(x, y, badgeW, badgeH, 8).fillColor(style.bg).fill();
    if (style.dashed) {
      doc.dash(2.2, { space: 1.8 });
    }
    doc.roundedRect(x, y, badgeW, badgeH, 8).lineWidth(0.75).strokeColor(style.border).stroke();
    doc.restore();

    this.drawStateIcon(x + 6.5, y + badgeH / 2, style);
    this.setFont('SemiBold', 7.5, style.fg);
    doc.text(style.label, x + 17.5, y + 3.6, {
      lineBreak: false,
      features: TNUM_FEATURES,
    });
    return badgeW;
  }

  private drawPill(
    x: number,
    y: number,
    text: string,
    fg: string,
    bg: string,
    border: string,
    dashed = false,
  ): number {
    const h = 16;
    const textW = this.measureWidth(text, 'SemiBold', 7.5);
    const w = textW + 14;
    const doc = this.doc;

    doc.save();
    doc.roundedRect(x, y, w, h, 8).fillColor(bg).fill();
    if (dashed) doc.dash(2.2, { space: 1.8 });
    doc.roundedRect(x, y, w, h, 8).lineWidth(0.75).strokeColor(border).stroke();
    doc.restore();

    this.setFont('SemiBold', 7.5, fg);
    doc.text(text, x + 7, y + 3.6, { lineBreak: false, features: TNUM_FEATURES });
    return w;
  }

  private splitTextToLines(
    text: string,
    maxWidth: number,
    weight: FontWeight,
    size: number,
  ): string[] {
    const widthLimit = Math.max(14, maxWidth);
    const lines: string[] = [];
    const paragraphs = text.split('\n');

    for (const para of paragraphs) {
      if (para.length === 0) {
        lines.push('');
        continue;
      }
      let remaining = para;
      while (remaining.length > 0) {
        if (this.measureWidth(remaining, weight, size) <= widthLimit) {
          lines.push(remaining);
          break;
        }
        // 이진 탐색으로 한 줄에 들어가는 최대 접두 길이를 구한다.
        let low = 1;
        let high = remaining.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (this.measureWidth(remaining.slice(0, mid), weight, size) <= widthLimit) {
            low = mid;
          } else {
            high = mid - 1;
          }
        }
        let breakAt = low;
        // 공백 경계가 줄 후반부에 있으면 단어 단위로 깔끔하게 줄바꿈한다.
        const lastSpace = remaining.lastIndexOf(' ', breakAt);
        if (lastSpace > Math.floor(breakAt * 0.45)) {
          breakAt = lastSpace;
        }
        const chunk = remaining.slice(0, breakAt).trimEnd();
        lines.push(chunk.length > 0 ? chunk : remaining.slice(0, Math.max(1, low)));
        remaining = remaining.slice(chunk.length > 0 ? breakAt : Math.max(1, low)).trimStart();
      }
    }
    return lines.length > 0 ? lines : ['—'];
  }

  public render(): void {
    this.renderDocumentHeader();
    this.renderMetadataCard();
    this.renderSectionOverview();

    const sections = this.report.sections;
    if (sections.length === 0) {
      this.renderNoticeBox(
        '수록된 분석 항목이 없습니다.',
        '저장된 보고서에 표시 가능한 섹션이 포함되지 않았습니다.',
        true,
      );
    } else {
      sections.forEach((section, index) => {
        this.renderSection(section, index);
      });
    }

    this.stampRunningChrome();
  }

  private renderDocumentHeader(): void {
    const doc = this.doc;
    // 페이지 상단 HomeCierge 브랜드 강조 바.
    doc.save();
    doc.rect(0, 0, PAGE.width, 4.5).fillColor(COLORS.primary).fill();
    doc.restore();

    const topY = 22;
    this.setFont('Bold', 13, COLORS.primary);
    doc.text('HomeCierge', PAGE.marginX, topY, { lineBreak: false });
    const brandW = this.measureWidth('HomeCierge', 'Bold', 13);

    this.setFont('Medium', 9, COLORS.mutedFg);
    doc.text('·  저장 보고서', PAGE.marginX + brandW + 7, topY + 2.8, { lineBreak: false });

    // 우측 버전 + 자료 출처 구분 배지.
    const isSynthetic = this.report.dataOrigin === 'synthetic';
    const originFg = isSynthetic ? COLORS.statusPartial : COLORS.primary;
    const originBg = isSynthetic ? COLORS.statusPartialSoft : COLORS.primarySoft;
    const originBorder = isSynthetic ? COLORS.statusPartialBorder : COLORS.primaryBorder;
    const originTextW = this.measureWidth(this.dataOriginLabel, 'SemiBold', 7.5) + 14;

    const versionText = `버전 v${this.report.version}`;
    const versionTextW = this.measureWidth(versionText, 'SemiBold', 7.5) + 14;

    const rightEdge = PAGE.width - PAGE.marginX;
    this.drawPill(rightEdge - originTextW, topY + 0.5, this.dataOriginLabel, originFg, originBg, originBorder);
    this.drawPill(
      rightEdge - originTextW - 6 - versionTextW,
      topY + 0.5,
      versionText,
      COLORS.foreground,
      COLORS.card,
      COLORS.border,
    );

    this.y = topY + 26;

    // 문서 제목 (공고·분석 보고서 제목).
    const titleH = this.measureHeight(this.titleText, CONTENT_WIDTH, 'Bold', 18, 3);
    this.setFont('Bold', 18, COLORS.foreground);
    doc.text(this.titleText, PAGE.marginX, this.y, {
      width: CONTENT_WIDTH,
      lineGap: 3,
      features: TNUM_FEATURES,
    });
    this.y += titleH + 8;

    // 합성 자료인 경우 혼동 방지를 위한 명시적 안내 띠.
    if (isSynthetic) {
      const bannerText =
        '기능 검수용 합성 공고와 거래 자료입니다.';
      const bannerH = this.measureHeight(bannerText, CONTENT_WIDTH - 24, 'Medium', 8.25, 2) + 12;
      doc.save();
      doc
        .roundedRect(PAGE.marginX, this.y, CONTENT_WIDTH, bannerH, 6)
        .fillColor(COLORS.statusPartialSoft)
        .fill();
      doc
        .roundedRect(PAGE.marginX, this.y, CONTENT_WIDTH, bannerH, 6)
        .lineWidth(0.75)
        .strokeColor(COLORS.statusPartialBorder)
        .stroke();
      doc.restore();
      this.setFont('Medium', 8.25, COLORS.statusPartial);
      doc.text(bannerText, PAGE.marginX + 12, this.y + 6, {
        width: CONTENT_WIDTH - 24,
        lineGap: 2,
        features: TNUM_FEATURES,
      });
      this.y += bannerH + 10;
    }
  }

  private renderMetadataCard(): void {
    const doc = this.doc;
    const pairs: [string, string][] = [
      ['보고서 저장 시각', this.createdAtText],
      ['원자료 수집본 저장', this.queriedAtText],
      ['보고서 ID', cleanSingleLine(this.report.reportId)],
      ['분석 ID', cleanSingleLine(this.report.analysisId)],
      ['실행 ID', cleanSingleLine(this.report.runId)],
      ['수집본 ID', cleanSingleLine(this.report.snapshotId)],
    ];

    const colGap = 16;
    const colWidth = (CONTENT_WIDTH - 24 - colGap) / 2;
    const labelW = 92;
    const valW = colWidth - labelW - 6;

    const rowHeights: number[] = [];
    for (let r = 0; r < pairs.length; r += 2) {
      const left = pairs[r];
      const right = pairs[r + 1];
      const lh = Math.max(
        this.measureHeight(left[0], labelW, 'SemiBold', 7.75, 1.5),
        this.measureHeight(left[1], valW, 'Regular', 8, 1.5),
      );
      const rh = right
        ? Math.max(
            this.measureHeight(right[0], labelW, 'SemiBold', 7.75, 1.5),
            this.measureHeight(right[1], valW, 'Regular', 8, 1.5),
          )
        : 0;
      rowHeights.push(Math.max(14, lh, rh) + 5);
    }

    const padY = 9;
    const totalH = padY * 2 + rowHeights.reduce((acc, h) => acc + h, 0) - 5;

    this.ensureSpace(totalH + 12);

    doc.save();
    doc
      .roundedRect(PAGE.marginX, this.y, CONTENT_WIDTH, totalH, 7)
      .fillColor(COLORS.card)
      .fill();
    doc
      .roundedRect(PAGE.marginX, this.y, CONTENT_WIDTH, totalH, 7)
      .lineWidth(0.75)
      .strokeColor(COLORS.border)
      .stroke();
    doc.restore();

    let rowY = this.y + padY;
    for (let i = 0; i < rowHeights.length; i += 1) {
      const left = pairs[i * 2];
      const right = pairs[i * 2 + 1];

      const lx = PAGE.marginX + 12;
      this.setFont('SemiBold', 7.75, COLORS.mutedFg);
      doc.text(left[0], lx, rowY, { width: labelW, lineGap: 1.5, features: TNUM_FEATURES });
      this.setFont('Regular', 8, COLORS.foreground);
      doc.text(left[1], lx + labelW + 6, rowY, { width: valW, lineGap: 1.5, features: TNUM_FEATURES });

      if (right) {
        const rx = PAGE.marginX + 12 + colWidth + colGap;
        this.setFont('SemiBold', 7.75, COLORS.mutedFg);
        doc.text(right[0], rx, rowY, { width: labelW, lineGap: 1.5, features: TNUM_FEATURES });
        this.setFont('Regular', 8, COLORS.foreground);
        doc.text(right[1], rx + labelW + 6, rowY, { width: valW, lineGap: 1.5, features: TNUM_FEATURES });
      }

      if (i < rowHeights.length - 1) {
        const divY = rowY + rowHeights[i] - 3;
        doc.save();
        doc
          .moveTo(PAGE.marginX + 12, divY)
          .lineTo(PAGE.marginX + CONTENT_WIDTH - 12, divY)
          .lineWidth(0.5)
          .strokeColor(COLORS.softLine)
          .stroke();
        doc.restore();
      }
      rowY += rowHeights[i];
    }

    this.y += totalH + 12;
  }

  private renderSectionOverview(): void {
    const sections = this.report.sections;
    if (sections.length === 0) return;

    const chips = sections.map((sec, idx) => {
      const style = STATE_STYLES[sec.state] ?? STATE_STYLES.reference;
      const fallbackTitle = SECTION_KIND_LABELS[sec.id] ?? sec.id;
      const secTitle = cleanSingleLine(sec.title, fallbackTitle);
      const shortTitle =
        secTitle.length > 16
          ? `${secTitle.slice(0, 15).replace(/[\s(（[·,:\-–—]+$/u, '')}…`
          : secTitle;
      const statusSuffix = sec.exportAllowed ? style.label : `${style.label} · 제외`;
      const text = `${String(idx + 1).padStart(2, '0')} ${shortTitle} (${statusSuffix})`;
      const width = this.measureWidth(text, 'Medium', 7.5) + 14;
      return {
        text,
        width: Math.min(width, CONTENT_WIDTH),
        fg: sec.exportAllowed ? style.fg : EXCLUDED_BADGE_STYLE.fg,
        bg: sec.exportAllowed ? style.bg : EXCLUDED_BADGE_STYLE.bg,
        border: sec.exportAllowed ? style.border : EXCLUDED_BADGE_STYLE.border,
        dashed: !sec.exportAllowed || style.dashed,
      };
    });

    // 칩을 행 단위로 배치해 필요한 높이를 먼저 계산한다.
    const rows: typeof chips[] = [];
    let currentRow: typeof chips = [];
    let currentW = 0;
    const gapX = 5;
    for (const chip of chips) {
      if (currentRow.length > 0 && currentW + gapX + chip.width > CONTENT_WIDTH) {
        rows.push(currentRow);
        currentRow = [chip];
        currentW = chip.width;
      } else {
        currentW += (currentRow.length > 0 ? gapX : 0) + chip.width;
        currentRow.push(chip);
      }
    }
    if (currentRow.length > 0) rows.push(currentRow);

    const neededH = 14 + rows.length * 20 + 6;
    this.ensureSpace(neededH);

    this.setFont('SemiBold', 8, COLORS.mutedFg);
    this.doc.text('수록 항목 요약', PAGE.marginX, this.y, { lineBreak: false });
    this.y += 13;

    const doc = this.doc;
    for (const row of rows) {
      let cx = PAGE.marginX;
      for (const chip of row) {
        doc.save();
        doc.roundedRect(cx, this.y, chip.width, 16, 8).fillColor(chip.bg).fill();
        if (chip.dashed) doc.dash(2.2, { space: 1.8 });
        doc.roundedRect(cx, this.y, chip.width, 16, 8).lineWidth(0.65).strokeColor(chip.border).stroke();
        doc.restore();

        this.setFont('Medium', 7.5, chip.fg);
        doc.text(chip.text, cx + 7, this.y + 3.7, {
          width: chip.width - 14,
          lineBreak: false,
          features: TNUM_FEATURES,
        });
        cx += chip.width + gapX;
      }
      this.y += 20;
    }

    // 요약과 본문 섹션 사이 구분선.
    this.y += 3;
    doc.save();
    doc
      .moveTo(PAGE.marginX, this.y)
      .lineTo(PAGE.marginX + CONTENT_WIDTH, this.y)
      .lineWidth(0.75)
      .strokeColor(COLORS.border)
      .stroke();
    doc.restore();
    this.y += 14;
  }

  private renderSectionHeader(
    section: ReportSection,
    index: number,
    reservedBelow: number,
  ): void {
    const stateStyle = STATE_STYLES[section.state] ?? STATE_STYLES.reference;
    const kindLabel = SECTION_KIND_LABELS[section.id] ?? cleanSingleLine(section.id);
    const title = cleanSingleLine(section.title, kindLabel);
    const numTag = String(index + 1).padStart(2, '0');

    const stateBadgeW = this.measureBadgeWidth(stateStyle);
    const excludedBadgeW = section.exportAllowed ? 0 : this.measureBadgeWidth(EXCLUDED_BADGE_STYLE) + 5;
    const badgesTotalW = stateBadgeW + excludedBadgeW;

    const titleAvailW = Math.max(150, CONTENT_WIDTH - 14 - badgesTotalW - 12);
    const titleH = this.measureHeight(title, titleAvailW, 'Bold', 12.25, 2);
    const showKindCaption = title !== kindLabel;
    const headerContentH = (showKindCaption ? 11 : 0) + titleH;
    const headerTotalH = Math.max(24, headerContentH) + 8;

    this.ensureSpace(headerTotalH + reservedBelow);

    const doc = this.doc;
    const startY = this.y;
    const accentColor =
      !section.exportAllowed
        ? COLORS.input
        : section.id === 'notice' && section.state === 'confirmed'
          ? COLORS.primary
          : stateStyle.accent;

    // 좌측 상태 강조 바.
    doc.save();
    doc
      .roundedRect(PAGE.marginX, startY + 1, 3, Math.max(18, headerContentH - 1), 1.5)
      .fillColor(accentColor)
      .fill();
    doc.restore();

    let textY = startY;
    if (showKindCaption) {
      this.setFont('SemiBold', 7.5, COLORS.mutedFg);
      doc.text(`${numTag}  ·  ${kindLabel}`, PAGE.marginX + 10, textY, {
        lineBreak: false,
        features: TNUM_FEATURES,
      });
      textY += 11;
    }

    const displayTitle = showKindCaption ? title : `${numTag}. ${title}`;
    this.setFont('Bold', 12.25, COLORS.foreground);
    doc.text(displayTitle, PAGE.marginX + 10, textY, {
      width: titleAvailW,
      lineGap: 2,
      features: TNUM_FEATURES,
    });

    // 우측 상태 배지(+ 내보내기 제외 배지).
    const rightEdge = PAGE.width - PAGE.marginX;
    const badgeY = startY + 2;
    let badgeRight = rightEdge;
    if (!section.exportAllowed) {
      const w = this.measureBadgeWidth(EXCLUDED_BADGE_STYLE);
      this.drawStateBadge(badgeRight - w, badgeY, EXCLUDED_BADGE_STYLE);
      badgeRight -= w + 5;
    }
    this.drawStateBadge(badgeRight - stateBadgeW, badgeY, stateStyle);

    // 섹션 제목 하단 구분선.
    const ruleY = startY + Math.max(24, headerContentH) + 3;
    doc.save();
    doc
      .moveTo(PAGE.marginX, ruleY)
      .lineTo(PAGE.marginX + CONTENT_WIDTH, ruleY)
      .lineWidth(0.75)
      .strokeColor(COLORS.border)
      .stroke();
    doc.restore();

    this.y = ruleY + 8;
  }

  private renderNoticeBox(title: string, detail: string | null, dashed: boolean): void {
    const padX = 12;
    const padY = 9;
    const textW = CONTENT_WIDTH - padX * 2;
    const titleH = this.measureHeight(title, textW, 'Medium', 8.75, 2.2);
    const detailH = detail ? this.measureHeight(detail, textW, 'Regular', 8, 2) + 4 : 0;
    const boxH = padY * 2 + titleH + detailH;

    this.ensureSpace(boxH + 4);

    const doc = this.doc;
    doc.save();
    doc.roundedRect(PAGE.marginX, this.y, CONTENT_WIDTH, boxH, 6).fillColor(COLORS.cardZebra).fill();
    if (dashed) {
      doc.dash(3.2, { space: 2.2 });
    }
    doc
      .roundedRect(PAGE.marginX, this.y, CONTENT_WIDTH, boxH, 6)
      .lineWidth(0.8)
      .strokeColor(dashed ? COLORS.input : COLORS.border)
      .stroke();
    doc.restore();

    this.setFont('Medium', 8.75, COLORS.foreground);
    doc.text(title, PAGE.marginX + padX, this.y + padY, {
      width: textW,
      lineGap: 2.2,
      features: TNUM_FEATURES,
    });

    if (detail) {
      this.setFont('Regular', 8, COLORS.mutedFg);
      doc.text(detail, PAGE.marginX + padX, this.y + padY + titleH + 4, {
        width: textW,
        lineGap: 2,
        features: TNUM_FEATURES,
      });
    }

    this.y += boxH + 12;
  }

  private renderContinuationHint(sectionTitle: string, suffix: string): void {
    this.setFont('SemiBold', 8, COLORS.mutedFg);
    this.doc.text(`${sectionTitle} · ${suffix}`, PAGE.marginX, this.y, {
      width: CONTENT_WIDTH,
      lineBreak: false,
      features: TNUM_FEATURES,
    });
    this.y += 13;
  }

  private renderSection(section: ReportSection, index: number): void {
    const fallbackTitle = SECTION_KIND_LABELS[section.id] ?? cleanSingleLine(section.id);
    const sectionTitle = cleanSingleLine(section.title, fallbackTitle);

    // exportAllowed=false이면 rows/tables/notes가 채워져 있어도 원본 내용을 일절 읽거나 출력하지 않는다.
    if (!section.exportAllowed) {
      this.renderSectionHeader(section, index, 58);
      this.renderNoticeBox(EXCLUDED_NOTICE_TITLE, EXCLUDED_NOTICE_DETAIL, true);
      this.y += 4;
      return;
    }

    const rows = Array.isArray(section.rows) ? section.rows : [];
    const tables = Array.isArray(section.tables)
      ? section.tables.filter(
          t => t && (Array.isArray(t.headers) && t.headers.length > 0 || Array.isArray(t.rows) && t.rows.length > 0),
        )
      : [];
    const notes = Array.isArray(section.notes) ? section.notes : [];

    // 첫 본문 블록의 실제 최소 높이를 선계산해 섹션 제목이 페이지 하단에 홀로 남지 않도록 한다.
    let reservedBelow = 52;
    if (rows.length > 0) {
      const firstLabel = cleanText(rows[0]?.label);
      const firstVal = cleanText(rows[0]?.value);
      const lh = this.measureHeight(firstLabel, 130, 'SemiBold', 8.25, 2.2);
      const vh = this.measureHeight(firstVal, CONTENT_WIDTH - 148 - 18, 'Regular', 8.75, 2.2);
      reservedBelow = Math.min(120, Math.max(36, Math.max(lh, vh) + 18));
    } else if (tables.length > 0) {
      reservedBelow = 96;
    } else if (notes.length > 0) {
      const firstNote = cleanText(notes[0], '');
      const nh = firstNote ? this.measureHeight(firstNote, CONTENT_WIDTH - 36, 'Regular', 8.25, 2.2) : 20;
      reservedBelow = Math.min(110, Math.max(48, nh + 30));
    }

    this.renderSectionHeader(section, index, reservedBelow);

    if (rows.length === 0 && tables.length === 0 && notes.length === 0) {
      const emptyMsg =
        section.state === 'held'
          ? '보류 상태로 표시할 상세 항목이 없습니다.'
          : '표시할 상세 항목이 없습니다.';
      this.renderNoticeBox(emptyMsg, null, section.state === 'held');
      this.y += 4;
      return;
    }

    if (rows.length > 0) {
      this.renderKeyValueRows(rows, sectionTitle);
    }

    for (const table of tables) {
      this.renderTable(table, sectionTitle);
    }

    if (notes.length > 0) {
      this.renderNotes(notes, section.state, sectionTitle);
    }

    this.y += 8;
  }

  private renderKeyValueRows(rows: ReportRow[], sectionTitle: string): void {
    const labelColW = 148;
    const valueColW = CONTENT_WIDTH - labelColW;
    const padX = 9;
    const padY = 6.5;
    const lineGap = 2.2;
    const labelTextW = labelColW - padX * 2;
    const valueTextW = valueColW - padX * 2;
    const doc = this.doc;

    const drawKvRowSlice = (label: string, value: string, isFirstOnBlock: boolean, height: number): void => {
      const rowY = this.y;
      doc.save();
      doc.rect(PAGE.marginX, rowY, labelColW, height).fillColor(COLORS.card).fill();
      doc.rect(PAGE.marginX + labelColW, rowY, valueColW, height).fillColor(COLORS.surface).fill();
      // 셀 경계선.
      doc.lineWidth(0.6).strokeColor(COLORS.border);
      if (isFirstOnBlock) {
        doc.moveTo(PAGE.marginX, rowY).lineTo(PAGE.marginX + CONTENT_WIDTH, rowY).stroke();
      }
      doc.moveTo(PAGE.marginX, rowY + height).lineTo(PAGE.marginX + CONTENT_WIDTH, rowY + height).stroke();
      doc.moveTo(PAGE.marginX, rowY).lineTo(PAGE.marginX, rowY + height).stroke();
      doc.moveTo(PAGE.marginX + CONTENT_WIDTH, rowY).lineTo(PAGE.marginX + CONTENT_WIDTH, rowY + height).stroke();
      doc
        .lineWidth(0.5)
        .strokeColor(COLORS.softLine)
        .moveTo(PAGE.marginX + labelColW, rowY)
        .lineTo(PAGE.marginX + labelColW, rowY + height)
        .stroke();
      doc.restore();

      this.setFont('SemiBold', 8.25, COLORS.mutedFg);
      doc.text(label, PAGE.marginX + padX, rowY + padY, {
        width: labelTextW,
        lineGap,
        features: TNUM_FEATURES,
      });

      this.setFont('Regular', 8.75, COLORS.foreground);
      doc.text(value, PAGE.marginX + labelColW + padX, rowY + padY, {
        width: valueTextW,
        lineGap,
        features: TNUM_FEATURES,
      });

      this.y = rowY + height;
    };

    let blockHasStarted = false;
    for (const row of rows) {
      const label = cleanText(row?.label);
      const value = cleanText(row?.value);
      const lh = this.measureHeight(label, labelTextW, 'SemiBold', 8.25, lineGap);
      const vh = this.measureHeight(value, valueTextW, 'Regular', 8.75, lineGap);
      const rowH = Math.max(22, Math.max(lh, vh) + padY * 2 + 1);

      if (rowH <= MAX_BODY_HEIGHT - 20) {
        if (this.y + rowH > PAGE.contentBottom) {
          this.addPage();
          this.renderContinuationHint(sectionTitle, '항목 계속');
          blockHasStarted = false;
        }
        drawKvRowSlice(label, value, !blockHasStarted, rowH);
        blockHasStarted = true;
      } else {
        // 한 행의 값이 한 페이지를 초과할 때 줄 단위로 분할해 잘림 없이 출력한다.
        const valueLines = this.splitTextToLines(value, valueTextW, 'Regular', 8.75);
        const approxLineH = this.measureHeight('가', valueTextW, 'Regular', 8.75, lineGap);
        let cursor = 0;
        while (cursor < valueLines.length) {
          if (this.y + 44 > PAGE.contentBottom) {
            this.addPage();
            this.renderContinuationHint(sectionTitle, '항목 계속');
            blockHasStarted = false;
          }
          const avail = PAGE.contentBottom - this.y - padY * 2 - 2;
          const take = Math.max(1, Math.floor(avail / Math.max(11, approxLineH)));
          const sliceText = valueLines.slice(cursor, cursor + take).join('\n');
          const sliceLabel = cursor === 0 ? label : `${label} (계속)`;
          const sh = Math.max(
            22,
            Math.max(
              this.measureHeight(sliceLabel, labelTextW, 'SemiBold', 8.25, lineGap),
              this.measureHeight(sliceText, valueTextW, 'Regular', 8.75, lineGap),
            ) + padY * 2 + 1,
          );
          drawKvRowSlice(sliceLabel, sliceText, !blockHasStarted, sh);
          blockHasStarted = true;
          cursor += take;
        }
      }
    }

    this.y += 10;
  }

  private computeColumnLayout(
    headers: string[],
    bodyRows: string[][],
  ): { widths: number[]; numericFlags: boolean[] } {
    const colCount = headers.length;
    const numericFlags: boolean[] = [];
    const desiredWidths: number[] = [];
    const headerSize = colCount >= 7 ? 7.25 : 8;
    const cellSize = colCount >= 7 ? 7.5 : 8.25;
    const padX = colCount >= 7 ? 4.5 : 6;
    const cellPadTotal = padX * 2 + 2; // 좌우 여백 + 측정 여유(2)

    for (let c = 0; c < colCount; c += 1) {
      const colVals = bodyRows.map(r => r[c] ?? '—');
      const numeric = isNumericColumn(headers[c], colVals);
      numericFlags.push(numeric);

      const headerW = this.measureWidth(headers[c], 'SemiBold', headerSize) + cellPadTotal;
      const cellWeight: FontWeight = c === 0 && !numeric ? 'Medium' : 'Regular';
      const sampleWidths = colVals
        .slice(0, 40)
        .map(v => {
          const longestLine = v.split('\n').reduce((a, b) => (a.length >= b.length ? a : b), '');
          return this.measureWidth(longestLine, cellWeight, cellSize) + cellPadTotal;
        })
        .sort((a, b) => a - b);

      const p85 =
        sampleWidths.length > 0
          ? sampleWidths[Math.min(sampleWidths.length - 1, Math.floor(sampleWidths.length * 0.85))]
          : headerW;

      if (numeric) {
        // 숫자·금액·면적 열은 단위('원', '㎡')가 다음 줄로 분리되지 않도록 단일 행 폭을 우선 보존한다.
        const maxNumW = sampleWidths.length > 0 ? sampleWidths[sampleWidths.length - 1] : headerW;
        const numFloor = colCount >= 7 ? 32 : 44;
        desiredWidths.push(Math.min(Math.max(headerW, maxNumW + 2, numFloor), 116));
      } else {
        const textFloor = colCount >= 7 ? 40 : 56;
        desiredWidths.push(Math.min(Math.max(headerW, p85, textFloor), 240));
      }
    }

    const minColW = Math.min(colCount >= 7 ? 32 : 44, Math.floor(CONTENT_WIDTH / colCount));
    const totalDesired = desiredWidths.reduce((a, b) => a + b, 0);

    let widths: number[];
    if (totalDesired <= CONTENT_WIDTH) {
      // 남는 폭은 텍스트 열에 우선 배분해 긴 한글 셀의 가독성을 높인다.
      const extra = CONTENT_WIDTH - totalDesired;
      const textIndices = numericFlags
        .map((isNum, idx) => (!isNum ? idx : -1))
        .filter(idx => idx >= 0);
      const targets = textIndices.length > 0 ? textIndices : headers.map((_, idx) => idx);
      const targetWeightSum = targets.reduce((acc, idx) => acc + desiredWidths[idx], 0);
      widths = desiredWidths.map((w, idx) => {
        if (!targets.includes(idx)) return w;
        return w + (extra * w) / Math.max(1, targetWeightSum);
      });
    } else {
      // 1단계: 긴 텍스트 열에서 먼저 여유 폭을 줄여 숫자·금액·면적 열의 단일 행 가독성을 유지한다.
      widths = [...desiredWidths];
      let excess = totalDesired - CONTENT_WIDTH;

      const shrinkGroup = (indices: number[], floorFn: (idx: number) => number): void => {
        if (excess <= 0.01 || indices.length === 0) return;
        const slacks = indices.map(idx => ({ idx, slack: Math.max(0, widths[idx] - floorFn(idx)) }));
        const totalSlack = slacks.reduce((acc, s) => acc + s.slack, 0);
        if (totalSlack <= 0) return;
        const take = Math.min(excess, totalSlack);
        for (const item of slacks) {
          widths[item.idx] -= (take * item.slack) / totalSlack;
        }
        excess -= take;
      };

      const proseCols = widths
        .map((w, idx) => (!numericFlags[idx] && w > 110 ? idx : -1))
        .filter(idx => idx >= 0);
      const otherTextCols = widths
        .map((w, idx) => (!numericFlags[idx] && w <= 110 ? idx : -1))
        .filter(idx => idx >= 0);
      const allCols = widths.map((_, idx) => idx);

      shrinkGroup(proseCols, () => Math.max(minColW, 110));
      shrinkGroup(otherTextCols, () => Math.max(minColW, 64));
      shrinkGroup(proseCols, () => Math.max(minColW, 64));
      shrinkGroup(allCols, () => minColW);

      if (excess > 0.01) {
        const even = CONTENT_WIDTH / colCount;
        widths = widths.map(() => even);
      }
    }

    // 부동소수점 오차를 마지막 열에 흡수해 정확히 CONTENT_WIDTH와 맞춘다.
    const sum = widths.reduce((a, b) => a + b, 0);
    widths[widths.length - 1] += CONTENT_WIDTH - sum;
    return { widths, numericFlags };
  }

  private renderTable(table: ReportTable, sectionTitle: string): void {
    const rawHeaders = Array.isArray(table.headers) ? table.headers : [];
    const rawRows = Array.isArray(table.rows) ? table.rows : [];
    const colCount = Math.max(
      rawHeaders.length,
      ...rawRows.map(r => (Array.isArray(r) ? r.length : 0)),
      0,
    );
    if (colCount === 0) return;

    const headers = Array.from({ length: colCount }, (_, i) => cleanText(rawHeaders[i]));
    const bodyRows = rawRows.map(row =>
      Array.from({ length: colCount }, (_, i) => cleanText(Array.isArray(row) ? row[i] : undefined)),
    );

    const { widths, numericFlags } = this.computeColumnLayout(headers, bodyRows);
    const padX = colCount >= 7 ? 4.5 : 6;
    const headerPadY = 6;
    const cellPadY = 5.5;
    const lineGap = 2;
    const headerSize = colCount >= 7 ? 7.25 : 8;
    const cellSize = colCount >= 7 ? 7.5 : 8.25;

    const headerHeights = headers.map((h, i) =>
      this.measureHeight(h, widths[i] - padX * 2, 'SemiBold', headerSize, lineGap),
    );
    const headerRowH = Math.max(22, Math.max(...headerHeights) + headerPadY * 2 + 1);

    const measureRowHeight = (cells: string[]): number => {
      let maxH = 0;
      for (let c = 0; c < colCount; c += 1) {
        const h = this.measureHeight(cells[c], widths[c] - padX * 2, 'Regular', cellSize, lineGap);
        if (h > maxH) maxH = h;
      }
      return Math.max(21, maxH + cellPadY * 2 + 1);
    };

    const firstRowH = bodyRows.length > 0 ? measureRowHeight(bodyRows[0]) : 24;
    // 표 머리글이 페이지 하단에 홀로 남지 않도록 첫 행(또는 최소 본문 높이) 공간을 함께 확보한다.
    this.ensureSpace(headerRowH + Math.min(firstRowH, 68));

    const doc = this.doc;
    const drawTableHeader = (): void => {
      const y0 = this.y;
      doc.save();
      doc.rect(PAGE.marginX, y0, CONTENT_WIDTH, headerRowH).fillColor(COLORS.primarySoft).fill();
      doc
        .lineWidth(0.7)
        .strokeColor(COLORS.primaryBorder)
        .moveTo(PAGE.marginX, y0)
        .lineTo(PAGE.marginX + CONTENT_WIDTH, y0)
        .stroke();
      doc
        .moveTo(PAGE.marginX, y0)
        .lineTo(PAGE.marginX, y0 + headerRowH)
        .stroke();
      doc
        .moveTo(PAGE.marginX + CONTENT_WIDTH, y0)
        .lineTo(PAGE.marginX + CONTENT_WIDTH, y0 + headerRowH)
        .stroke();
      doc
        .lineWidth(1.2)
        .strokeColor(COLORS.primary)
        .moveTo(PAGE.marginX, y0 + headerRowH)
        .lineTo(PAGE.marginX + CONTENT_WIDTH, y0 + headerRowH)
        .stroke();

      let x = PAGE.marginX;
      for (let c = 0; c < colCount; c += 1) {
        if (c > 0) {
          doc
            .lineWidth(0.45)
            .strokeColor(COLORS.primaryBorder)
            .moveTo(x, y0)
            .lineTo(x, y0 + headerRowH)
            .stroke();
        }
        x += widths[c];
      }
      doc.restore();

      x = PAGE.marginX;
      for (let c = 0; c < colCount; c += 1) {
        this.setFont('SemiBold', headerSize, COLORS.primaryDark);
        const textOpts: TextOptions = {
          width: Math.max(10, widths[c] - padX * 2),
          align: numericFlags[c] ? 'right' : 'left',
          lineGap,
          features: TNUM_FEATURES,
        };
        doc.text(headers[c], x + padX, y0 + headerPadY, textOpts);
        x += widths[c];
      }

      this.y = y0 + headerRowH;
    };

    const drawBodyRow = (cells: string[], rowH: number, rowIndex: number): void => {
      const y0 = this.y;
      const fill = rowIndex % 2 === 1 ? COLORS.cardZebra : COLORS.surface;

      doc.save();
      doc.rect(PAGE.marginX, y0, CONTENT_WIDTH, rowH).fillColor(fill).fill();
      doc
        .lineWidth(0.55)
        .strokeColor(COLORS.border)
        .moveTo(PAGE.marginX, y0 + rowH)
        .lineTo(PAGE.marginX + CONTENT_WIDTH, y0 + rowH)
        .stroke();
      doc
        .moveTo(PAGE.marginX, y0)
        .lineTo(PAGE.marginX, y0 + rowH)
        .stroke();
      doc
        .moveTo(PAGE.marginX + CONTENT_WIDTH, y0)
        .lineTo(PAGE.marginX + CONTENT_WIDTH, y0 + rowH)
        .stroke();

      let x = PAGE.marginX;
      for (let c = 0; c < colCount; c += 1) {
        if (c > 0) {
          doc
            .lineWidth(0.45)
            .strokeColor(COLORS.softLine)
            .moveTo(x, y0)
            .lineTo(x, y0 + rowH)
            .stroke();
        }
        x += widths[c];
      }
      doc.restore();

      x = PAGE.marginX;
      for (let c = 0; c < colCount; c += 1) {
        const isFirstTextCol = c === 0 && !numericFlags[0];
        this.setFont(isFirstTextCol ? 'Medium' : 'Regular', cellSize, COLORS.foreground);
        const textOpts: TextOptions = {
          width: Math.max(10, widths[c] - padX * 2),
          align: numericFlags[c] ? 'right' : 'left',
          lineGap,
          features: TNUM_FEATURES,
        };
        doc.text(cells[c], x + padX, y0 + cellPadY, textOpts);
        x += widths[c];
      }

      this.y = y0 + rowH;
    };

    const startContinuedTablePage = (): void => {
      this.addPage();
      this.renderContinuationHint(sectionTitle, '표 계속');
      drawTableHeader();
    };

    drawTableHeader();

    if (bodyRows.length === 0) {
      const emptyH = 24;
      const y0 = this.y;
      doc.save();
      doc.rect(PAGE.marginX, y0, CONTENT_WIDTH, emptyH).fillColor(COLORS.surface).fill();
      doc
        .lineWidth(0.55)
        .strokeColor(COLORS.border)
        .rect(PAGE.marginX, y0, CONTENT_WIDTH, emptyH)
        .stroke();
      doc.restore();
      this.setFont('Regular', cellSize, COLORS.mutedFg);
      doc.text('표시할 행이 없습니다.', PAGE.marginX + 8, y0 + 7, {
        width: CONTENT_WIDTH - 16,
        features: TNUM_FEATURES,
      });
      this.y = y0 + emptyH + 10;
      return;
    }

    const maxSinglePageRowH = MAX_BODY_HEIGHT - headerRowH - 22;

    bodyRows.forEach((cells, rowIdx) => {
      const rowH = measureRowHeight(cells);
      if (rowH <= maxSinglePageRowH) {
        if (this.y + rowH > PAGE.contentBottom) {
          startContinuedTablePage();
        }
        drawBodyRow(cells, rowH, rowIdx);
        return;
      }

      // 한 행 자체가 페이지 본문보다 클 때는 셀을 줄 단위로 분할하고 페이지마다 표 머리글을 반복한다.
      const colLines = cells.map((cell, c) =>
        this.splitTextToLines(cell, widths[c] - padX * 2, c === 0 && !numericFlags[0] ? 'Medium' : 'Regular', cellSize),
      );
      const maxTotalLines = Math.max(...colLines.map(lines => lines.length));
      const approxLineH = this.measureHeight('가', 80, 'Regular', cellSize, lineGap);
      let lineCursor = 0;

      while (lineCursor < maxTotalLines) {
        if (this.y + 34 > PAGE.contentBottom) {
          startContinuedTablePage();
        }
        const avail = PAGE.contentBottom - this.y - cellPadY * 2 - 2;
        let linesThisSlice = Math.max(1, Math.floor(avail / Math.max(10.5, approxLineH)));
        const buildSlice = (count: number): string[] =>
          colLines.map(lines => {
            const part = lines.slice(lineCursor, lineCursor + count).join('\n');
            return part.length > 0 ? part : ' ';
          });
        let sliceCells = buildSlice(linesThisSlice);
        let sliceH = measureRowHeight(sliceCells);
        while (linesThisSlice > 1 && this.y + sliceH > PAGE.contentBottom) {
          linesThisSlice -= 1;
          sliceCells = buildSlice(linesThisSlice);
          sliceH = measureRowHeight(sliceCells);
        }
        if (this.y + sliceH > PAGE.contentBottom && this.y > PAGE.continuationTop + headerRowH + 20) {
          startContinuedTablePage();
          continue;
        }
        drawBodyRow(sliceCells, sliceH, rowIdx);
        lineCursor += linesThisSlice;
      }
    });

    this.y += 10;
  }

  private renderNotes(notes: string[], state: SectionState, sectionTitle: string): void {
    const cleanedNotes = notes.map(n => cleanText(n, '')).filter(n => n.length > 0);
    if (cleanedNotes.length === 0) return;

    const accent = state === 'held' ? COLORS.statusConflict : state === 'partial' ? COLORS.statusPartial : COLORS.mutedFg;
    const padX = 11;
    const padY = 7;
    const bulletW = 10;
    const textW = CONTENT_WIDTH - padX * 2 - bulletW - 4;
    const lineGap = 2.2;
    const doc = this.doc;

    const drawNoteCardSlice = (items: string[], isContinuation: boolean): void => {
      const heading = isContinuation ? '참고 및 확인 사항 (계속)' : '참고 및 확인 사항';
      const itemHeights = items.map(item => this.measureHeight(item, textW, 'Regular', 8.25, lineGap));
      const bodyH = itemHeights.reduce((acc, h, idx) => acc + h + (idx > 0 ? 4 : 0), 0);
      const boxH = padY * 2 + 13 + bodyH;

      const y0 = this.y;
      doc.save();
      doc.roundedRect(PAGE.marginX, y0, CONTENT_WIDTH, boxH, 5).fillColor(COLORS.card).fill();
      doc
        .roundedRect(PAGE.marginX, y0, CONTENT_WIDTH, boxH, 5)
        .lineWidth(0.6)
        .strokeColor(COLORS.border)
        .stroke();
      doc.rect(PAGE.marginX, y0 + 2, 2.5, boxH - 4).fillColor(accent).fill();
      doc.restore();

      this.setFont('SemiBold', 8, COLORS.mutedFg);
      doc.text(heading, PAGE.marginX + padX + 2, y0 + padY, {
        lineBreak: false,
        features: TNUM_FEATURES,
      });

      let itemY = y0 + padY + 13;
      items.forEach((item, idx) => {
        this.setFont('Bold', 8.25, accent);
        doc.text('•', PAGE.marginX + padX + 2, itemY, { lineBreak: false });
        this.setFont('Regular', 8.25, COLORS.foreground);
        doc.text(item, PAGE.marginX + padX + bulletW + 2, itemY, {
          width: textW,
          lineGap,
          features: TNUM_FEATURES,
        });
        itemY += itemHeights[idx] + 4;
      });

      this.y = y0 + boxH + 8;
    };

    // 페이지 높이에 맞춰 노트 항목을 묶어 카드 형태로 페이지 분할한다.
    let pending: string[] = [];
    let pendingBodyH = 0;
    let isContinuation = false;

    const flush = (): void => {
      if (pending.length === 0) return;
      drawNoteCardSlice(pending, isContinuation);
      pending = [];
      pendingBodyH = 0;
      isContinuation = true;
    };

    for (const note of cleanedNotes) {
      const h = this.measureHeight(note, textW, 'Regular', 8.25, lineGap);
      if (h > MAX_BODY_HEIGHT - 44) {
        flush();
        const noteLines = this.splitTextToLines(note, textW, 'Regular', 8.25);
        const approxLineH = this.measureHeight('가', textW, 'Regular', 8.25, lineGap);
        let cursor = 0;
        while (cursor < noteLines.length) {
          if (this.y + 52 > PAGE.contentBottom) {
            this.addPage();
            this.renderContinuationHint(sectionTitle, '참고 사항 계속');
          }
          const avail = PAGE.contentBottom - this.y - padY * 2 - 20;
          const take = Math.max(1, Math.floor(avail / Math.max(11, approxLineH)));
          drawNoteCardSlice([noteLines.slice(cursor, cursor + take).join('\n')], isContinuation);
          isContinuation = true;
          cursor += take;
        }
        continue;
      }

      const nextBoxH = padY * 2 + 13 + pendingBodyH + (pending.length > 0 ? 4 : 0) + h;
      if (this.y + nextBoxH > PAGE.contentBottom) {
        if (pending.length > 0) {
          flush();
        }
        this.addPage();
        this.renderContinuationHint(sectionTitle, '참고 사항 계속');
      }
      pendingBodyH += (pending.length > 0 ? 4 : 0) + h;
      pending.push(note);
    }
    flush();
  }

  private stampRunningChrome(): void {
    const doc = this.doc;
    const range = doc.bufferedPageRange();
    const totalPages = range.count;
    const shortHeaderTitle =
      this.titleText.length > 44 ? `${this.titleText.slice(0, 43)}…` : this.titleText;
    const rightHeaderMeta = `v${this.report.version} · ${this.dataOriginLabel}`;
    const footerLeft = `HomeCierge 저장 보고서 · 저장 ${this.createdAtText} · 수집본 ${this.queriedAtText}`;

    for (let i = 0; i < totalPages; i += 1) {
      doc.switchToPage(range.start + i);
      const savedMargins = { ...doc.page.margins };
      doc.page.margins = { top: 0, bottom: 0, left: 0, right: 0 };

      // 2페이지부터 상단 러닝 헤더 표시.
      if (i > 0) {
        this.setFont('Bold', 8, COLORS.primary);
        doc.text('HomeCierge', PAGE.marginX, PAGE.headerTextY, { lineBreak: false });
        const bw = this.measureWidth('HomeCierge', 'Bold', 8);

        this.setFont('Regular', 8, COLORS.mutedFg);
        doc.text(` · ${shortHeaderTitle}`, PAGE.marginX + bw + 2, PAGE.headerTextY, {
          lineBreak: false,
          features: TNUM_FEATURES,
        });

        const metaW = this.measureWidth(rightHeaderMeta, 'Medium', 7.75);
        this.setFont('Medium', 7.75, COLORS.mutedFg);
        doc.text(rightHeaderMeta, PAGE.width - PAGE.marginX - metaW, PAGE.headerTextY + 0.3, {
          lineBreak: false,
          features: TNUM_FEATURES,
        });

        doc.save();
        doc
          .moveTo(PAGE.marginX, PAGE.headerRuleY)
          .lineTo(PAGE.width - PAGE.marginX, PAGE.headerRuleY)
          .lineWidth(0.5)
          .strokeColor(COLORS.softLine)
          .stroke();
        doc.restore();
      }

      // 모든 페이지 하단 푸터 및 페이지 번호 표시.
      doc.save();
      doc
        .moveTo(PAGE.marginX, PAGE.footerRuleY)
        .lineTo(PAGE.width - PAGE.marginX, PAGE.footerRuleY)
        .lineWidth(0.5)
        .strokeColor(COLORS.border)
        .stroke();
      doc.restore();

      const pageLabel = `페이지 ${i + 1} / ${totalPages}`;
      const pageLabelW = this.measureWidth(pageLabel, 'SemiBold', 7.5);
      const footerMaxW = CONTENT_WIDTH - pageLabelW - 14;

      let leftText = footerLeft;
      while (leftText.length > 16 && this.measureWidth(leftText, 'Regular', 7.25) > footerMaxW) {
        leftText = `${leftText.slice(0, -4)}…`;
      }

      this.setFont('Regular', 7.25, COLORS.mutedFg);
      doc.text(leftText, PAGE.marginX, PAGE.footerTextY, {
        lineBreak: false,
        features: TNUM_FEATURES,
      });

      this.setFont('SemiBold', 7.5, COLORS.foreground);
      doc.text(pageLabel, PAGE.width - PAGE.marginX - pageLabelW, PAGE.footerTextY - 0.2, {
        lineBreak: false,
        features: TNUM_FEATURES,
      });

      doc.page.margins = savedMargins;
    }
  }
}

export async function renderSavedReportPdf(report: SavedReport): Promise<Uint8Array> {
  validateReportInput(report);
  const fonts = await loadFonts();

  return new Promise<Uint8Array>((resolve, reject) => {
    const doc = new PDFDocument({
      size: [PAGE.width, PAGE.height],
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      autoFirstPage: true,
      bufferPages: true,
      compress: true,
      pdfVersion: '1.7',
      font: '',
      lang: 'ko-KR',
      info: {
        Title: 'HomeCierge 분석 보고서',
        Author: 'HomeCierge',
        Subject: 'HomeCierge 저장 보고서',
        Creator: 'HomeCierge',
        Producer: 'HomeCierge',
        CreationDate: parseSafePdfDate(report.createdAt),
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer | Uint8Array) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    doc.on('error', reject);
    doc.on('end', () => {
      const merged = Buffer.concat(chunks);
      resolve(new Uint8Array(merged.buffer, merged.byteOffset, merged.byteLength));
    });

    try {
      doc.registerFont('Regular', fonts.Regular);
      doc.registerFont('Medium', fonts.Medium);
      doc.registerFont('SemiBold', fonts.SemiBold);
      doc.registerFont('Bold', fonts.Bold);
      doc.font('Regular');

      const renderer = new PdfRenderer(doc, report);
      renderer.render();
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}
