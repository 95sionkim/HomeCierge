import {
  esc,
  icon,
  badge,
  kinds,
  scheduleBadge,
  publicationText,
  rangesFor,
  rangeLabel,
  dateText,
  reasonText,
} from './display.js';
import { noticeName } from './directory-view.js';

const closeButton =
  '<button class="quiet-icon" type="button" data-action="close" aria-label="닫기">' + icon('x') + '</button>';
export function frame(title, description, body) {
  return `<div class="dialog-wrap"><div class="dialog-head"><div><h2 id="dialog-title">${esc(title)}</h2>${description ? `<p class="dialog-sub">${esc(description)}</p>` : ''}</div>${closeButton}</div>${body}</div>`;
}
export function authDialog(register = false) {
  return frame(
    register ? '계정 만들기' : '로그인',
    register ? '이메일로 청약 분석 계정을 만드세요.' : '내 계정의 공고 목록과 분석을 이어보세요.',
    `<form id="auth-form" data-mode="${register ? 'signup' : 'signin'}"><label class="form-field" for="auth-email">이메일<input type="email" name="email" id="auth-email" autocomplete="username" required placeholder="name@example.com"></label><label class="form-field" for="auth-password">비밀번호<input type="password" name="password" id="auth-password" autocomplete="${register ? 'new-password' : 'current-password'}" required${register ? ' minlength="6"' : ''}></label><p class="form-message" id="form-message" role="status"></p><div class="form-actions"><button type="submit" class="action primary">${register ? '가입하기' : '로그인'}</button></div></form><button class="text-button auth-switch" type="button" data-action="${register ? 'auth' : 'signup'}">${register ? '이미 계정이 있으신가요? 로그인' : '새 계정 만들기'}</button>`,
  );
}
export function noticeDialog(n, synthetic) {
  const models = n.models ?? [],
    ranges = rangesFor(n);
  const modelList = models
    .map((m) => {
      const allowed = Boolean(m.analysisInput) && !m.selectionBlockers?.length;
      return `<label class="model-option${allowed ? '' : ' unavailable'}"><input name="model" type="radio" value="${esc(m.modelNo)}"${allowed ? '' : ' disabled'}><span><strong class="code">${esc(m.houseType ?? '—')}</strong>${!allowed ? `<span class="model-reason">${esc((m.selectionBlockers ?? []).map(reasonText).filter(Boolean).join(' ') || '분석 선택 근거를 확인 중입니다.')}</span>` : ''}</span><small>모델 <span class="code">${esc(m.modelNo)}</span></small></label>`;
    })
    .join('');
  return frame(
    noticeName(n),
    null,
    `<div class="tag-row detail-tags">${scheduleBadge(n.applicationStatus)}${badge('closed', synthetic ? 'layers' : 'database', synthetic ? '합성 자료' : '청약홈')}</div><ul class="detail-list"><li><span>공급 유형</span><strong>${esc(kinds[n.kind] ?? '미확인')}</strong></li><li><span>소재지</span><strong>${esc(n.regionName ?? '미확인')}</strong></li><li><span>공고일</span><strong>${esc(publicationText(n))}</strong></li><li><span>공고 번호</span><strong class="code">${esc(n.noticeNo)}</strong></li></ul><section class="detail-block"><h3>접수 일정</h3>${ranges.length ? `<ul class="source-list">${ranges.map((r) => `<li>${esc(rangeLabel(r, false))}</li>`).join('')}</ul>` : '<p class="dialog-sub">공식 접수 구간을 확인할 수 없습니다.</p>'}${n.applicationStatus === 'unknown' && ranges.length > 0 ? '<p class="dialog-sub">기준일의 접수 여부는 확인이 필요합니다.</p>' : ''}</section>
  <section class="detail-block"><h3 id="model-heading">분석할 주택형</h3>${modelList ? `<div class="model-list" role="radiogroup" aria-labelledby="model-heading">${modelList}</div>` : `<div class="state-box">${icon('circle-pause')}<div><strong>주택형 확인 필요</strong><p>공고와 연결된 모델 정보를 확인한 뒤 분석을 시작할 수 있습니다.</p></div></div>`}</section>
  <p role="status" id="form-message" class="form-message"></p><div class="form-actions"><a class="text-button" href="https://www.applyhome.co.kr/" target="_blank" rel="noopener noreferrer">청약홈 ${icon('external-link')}</a><button class="action primary" data-action="start" type="button" disabled>${synthetic ? '예시 결과 보기' : '분석 시작'} ${icon('arrow-right')}</button></div>`,
  );
}
export function sourceDialog(d) {
  const format = {
    complete: '수집 완료',
    partial: '부분 수집',
    empty: '정상 0건',
    failed: '수집 실패',
    unverified: '확인 필요',
  };
  const names = { applyhome_apt: '청약홈 아파트 공고', applyhome_remainder: '청약홈 잔여세대 공고' };
  const moment =
    d?.observedAt && Number.isFinite(Date.parse(d.observedAt))
      ? new Intl.DateTimeFormat('ko-KR', {
          dateStyle: 'medium',
          timeStyle: 'short',
          timeZone: 'Asia/Seoul',
        }).format(new Date(d.observedAt))
      : '—';
  return frame(
    '목록의 자료 근거',
    d?.dataOrigin === 'synthetic'
      ? '공고와 일정을 구성한 합성 예시입니다.'
      : '두 청약홈 공고 목록을 기준일에 맞춰 조회합니다.',
    `<ul class="detail-list"><li><span>기준일</span><strong>${esc(dateText(d?.asOf))}</strong></li><li><span>관측 시각 (한국)</span><strong>${esc(moment)}</strong></li><li><span>모집공고일 범위</span><strong>${esc(d ? rangeLabel(d.publicationWindow, false) : '—')}</strong></li></ul><ul class="source-list">${(d?.coverage?.sources ?? []).map((s) => `<li>${esc(names[s.source] ?? '공고 출처')}<small>${esc(format[s.status] ?? '확인 필요')}</small></li>`).join('')}</ul><a class="action secondary" href="https://www.applyhome.co.kr/" target="_blank" rel="noopener noreferrer">청약홈에서 공식 공고 확인 ${icon('external-link')}</a>`,
  );
}
export function accountDialog(session) {
  return frame(
    '내 계정',
    session.email,
    `<p class="auth-note">이 계정으로 접수한 분석은 로그인할 때 다시 볼 수 있습니다.</p><p class="form-message" id="form-message" role="status"></p><div class="form-actions"><button class="action secondary" type="button" data-action="logout">${icon('log-out')}로그아웃</button></div>`,
  );
}
