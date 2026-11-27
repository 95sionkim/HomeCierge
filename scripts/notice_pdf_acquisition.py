#!/usr/bin/env python3
"""선택한 공고의 공식 상세 페이지에서 같은 공고의 첨부 PDF를 확보하고, 실패·보류이면 업로드 보완 경로를 돌려준다.

서버 작업자 전용이다. 전송(fetch)은 호출자가 주입한다. 기본 검사는 합성 응답만 쓰고, 표준 라이브러리 실호출 어댑터
(make_live_fetch)는 수동 실행에서만 만든다. 이 모듈은 키를 읽지 않고 쿠키·인증 헤더를 보내지 않으며 원문을 저장하지 않는다.

fetch(url, *, max_bytes, timeout)는 리디렉션을 따르지 않고 응답 봉투 하나를 돌려준다.
  {'status': int, 'headers': {이름: str}, 'body': bytes}  또는  {'error': TRANSPORT_ERRORS 중 하나}
리디렉션은 커넥터가 Location을 단계마다 같은 출처·경로·식별 정책으로 검사한 뒤에만 따라간다.

식별: 청약홈 상세 주소와 첨부 주소의 houseManageNo·pblancNo가 target의 두 번호와 같아야 한다. 링크 문구·파일명·
업로드 시각으로 문서를 고르지 않는다. 문구는 원본·정정·참고 역할 분류에만 쓰고 결과에는 원문 대신 표지만 남긴다.
전량 대체는 정정 문서 하나의 문구가 앞선 원공고 전체의 대체를 긍정문으로 명시할 때만 적용한다. 그 밖의 정정·복수·
누락·미분류는 관계 미확정으로 두고 문서별 bytes를 함께 돌려준다(A-59). PDF 본문의 공고 식별·값 점검은 후속 점검기 몫이다.
"""
import argparse
import hashlib
import http.client
import json
import re
import socket
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.parse import parse_qsl, quote, urlencode, urljoin, urlsplit

CONTRACT = 'notice-pdf-acquisition/v0'
# Supabase analysis-uploads 버킷의 file_size_limit(50MiB)와 같은 상한. 자동 확보와 업로드 읽기에 함께 쓴다.
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_HTML_BYTES = 2 * 1024 * 1024
MAX_URL_LENGTH = 2048
MAX_ID_LENGTH = 128
DEFAULT_LIMITS = {'requestTimeout': 20, 'deadline': 90, 'redirects': 3, 'attachments': 5}
LIMIT_CEILINGS = {'requestTimeout': 60, 'deadline': 300, 'redirects': 5, 'attachments': 10}
SOURCES = ('applyhome', 'business_entity')
ROLES = ('notice', 'correction', 'unclassified')  # 관계 판정 대상. 참고 표시 문서는 references로 따로 둔다.
ADOPTIONS = ('standalone', 'with_set', 'not_adoptable')
TRANSPORT_ERRORS = ('timeout', 'connection', 'tls', 'too_large')
RETRYABLE = frozenset(('timeout', 'connection', 'tls', 'deadline_exceeded', 'upstream_unavailable',
                       'unexpected_http_status', 'transport_malformed'))
# 2026-11-21 공개 정상 경로에서 확인한 청약홈 상세(APT·잔여세대)와 첨부 다운로드 형식. 다른 경로는 허용하지 않는다.
APPLYHOME = {
    'detail': {'origins': ('https://www.applyhome.co.kr',),
               'paths': ('/ai/aia/selectAPTLttotPblancDetail.do', '/ai/aia/selectAPTRemndrLttotPblancDetailView.do'),
               'query': ('houseManageNo', 'pblancNo')},
    'attachment': {'origins': ('https://static.applyhome.co.kr',), 'paths': ('/ai/aia/getAtchmnfl.do',),
                   'query': ('houseManageNo', 'pblancNo', 'atchmnflSeqNo', 'atchmnflSn')},
}
# 실제 첨부 응답은 application/octet-stream이었다. 선언 형식은 이 목록으로 거르고 실제 형식은 PDF 머리·꼬리로 확인한다.
PDF_TYPES = ('application/pdf', 'application/x-pdf', 'application/octet-stream')
REDIRECT_STATUSES = (301, 302, 303, 307, 308)
NUMBER = re.compile(r'[0-9]{1,20}')
LENGTH = re.compile(r'[0-9]+')
SHA256 = re.compile(r'[0-9a-f]{64}')
OFFICIAL_ID = re.compile(r'applyhome:([0-9]{1,20}):([0-9]{1,20}):[0-9]{1,20}:[0-9]{1,20}')
DATE = re.compile(r'[0-9]{4}-[0-9]{2}-[0-9]{2}')
MODEL_CELL = re.compile(r'([0-9]{1,20})\(([0-9]{1,4})\)')
PDF_HEADER = re.compile(rb'%PDF-[12]\.[0-9][\r\n \t%]')
UNSAFE_TEXT = re.compile(r'[\x00-\x1f\x7f]')
HREF_SAFE = "%/:=&?~#+!$,;'@()*[]"
# 전량 대체는 앞선 원공고 전체를 이 문서로 대체한다는 긍정 문장만 인정한다. '정정 공고 전문'·'일부 대체'·
# '전체 공고를 대체하지 않음'처럼 단어만 겹치거나 부정·부분인 문구는 관계 미확정이다. 실제 청약홈 정정 첨부 문구는
# 아직 관측하지 못했으므로 이 패턴은 보수적인 설계값이다.
FULL_REPLACEMENT = re.compile(r'(기존|당초|최초|종전|앞선|원)\s*(입주자\s*)?모집\s*공고(문)?\s*(의\s*)?(전부|전체|전문)\s*'
                              r'(를|을)?\s*(본|이)\s*(정정\s*)?(공고|문서)(문)?\s*(으로|로)\s*대체(합니다|함|한다|됩니다|됨)')
NOT_FULL = re.compile(r'않|아니|불가|미대체|제외|일부|부분|별도|단,')
FULL_REPLACEMENT_MAX_LABEL = 80  # 이보다 긴 문구는 부정·조건이 섞일 수 있어 전량 대체 해석을 보류한다.
# 참고 전용·이전 회차 자료임을 드러낸 문구만 참조로 뺀다. '모집공고문(참고사항 포함)'처럼 애매한 문구는 대조에 남긴다.
REFERENCE_ONLY = re.compile(r'[(\[<【]\s*참고\s*(용|자료|전용)?\s*[)\]>】]|참고\s*(용|자료|전용)|(이전|종전|직전|지난)\s*회차')
DOCUMENT_EXTENSIONS = ('.pdf', '.hwp', '.hwpx', '.doc', '.docx', '.zip')
MISSING_REASON = {'notice': 'original_document_missing', 'correction': 'correction_document_missing',
                  'unclassified': 'related_document_missing'}


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _parse_url(url):
    """HTTPS·기본 포트·사용자 정보 없음·ASCII 호스트만 받는다. (origin, path, 쿼리 쌍) 또는 None."""
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH or UNSAFE_TEXT.search(url) or ' ' in url:
        return None
    try:
        parts = urlsplit(url)
        port = parts.port
        pairs = parse_qsl(parts.query, keep_blank_values=True, strict_parsing=True) if parts.query else []
    except ValueError:
        return None
    host = parts.hostname
    if (parts.scheme != 'https' or parts.username is not None or parts.password is not None
            or port not in (None, 443) or not host or not host.isascii()):
        return None
    return 'https://' + host, parts.path, pairs


def _origin(url):
    parsed = _parse_url(url)
    return parsed[0] if parsed else None


def _canonical(url):
    """요청·표시용 주소. fragment를 버리고 출처·경로·해석한 쿼리만 남긴다. 해석 불가면 None."""
    parsed = _parse_url(url) if url else None
    if parsed is None:
        return None
    origin, path, pairs = parsed
    return origin + path + ('?' + urlencode(pairs) if pairs else '')


def _join(base, href):
    """페이지 링크·Location을 절대 주소로 만든다. 공백·비ASCII는 백분율 부호화만 하고 해석 불가면 None."""
    if not _text(href) or len(href) > MAX_URL_LENGTH:
        return None
    try:
        return urljoin(base, quote(href.strip(), safe=HREF_SAFE))
    except (ValueError, TypeError):
        return None


def _match(url, stage, numbers):
    """stage 정책에 맞으면 (쿼리, None). 번호가 다른 공고면 (쿼리, 'other_notice'), 정책 밖이면 (None, 'url_not_allowed')."""
    parsed = _parse_url(url)
    if parsed is None:
        return None, 'url_not_allowed'
    origin, path, pairs = parsed
    keys = [k for k, _ in pairs]
    if (origin not in stage['origins'] or path not in stage['paths'] or len(keys) != len(set(keys))
            or set(keys) != set(stage['query']) or not all(NUMBER.fullmatch(v) for _, v in pairs)):
        return None, 'url_not_allowed'
    query = dict(pairs)
    return query, (None if (query['houseManageNo'], query['pblancNo']) == numbers else 'other_notice')


def _http_reason(status, stage):
    if status in (401, 403):
        return 'access_restricted'  # 세션·접근 제한을 우회하지 않는다.
    if status in (404, 410):
        return stage + '_not_found'
    if status == 429 or 500 <= status <= 599:
        return 'upstream_unavailable'
    return 'unexpected_http_status'


def _response(response, max_bytes):
    if isinstance(response, dict) and set(response) == {'error'}:
        code = response['error']
        return {'error': code if code in TRANSPORT_ERRORS else 'transport_malformed'}
    if not (isinstance(response, dict) and type(response.get('status')) is int and 100 <= response['status'] <= 599
            and isinstance(response.get('headers'), dict) and isinstance(response.get('body'), bytes)
            and all(isinstance(k, str) and isinstance(v, str) for k, v in response['headers'].items())):
        return {'error': 'transport_malformed'}
    if len(response['body']) > max_bytes:
        return {'error': 'too_large'}
    headers = {k.lower(): v for k, v in response['headers'].items()}
    return {'status': response['status'], 'headers': headers, 'body': response['body']}


class _Context:
    def __init__(self, fetch, limits, monotonic):
        self.fetch, self.limits, self.monotonic = fetch, limits, monotonic
        self.started = monotonic()
        self.requests = 0

    def get(self, url, allowed, max_bytes):
        """정책을 통과한 주소만 요청하고 리디렉션을 단계별로 다시 검사한다. allowed(url) -> bool."""
        current, hops = url, 0
        while True:
            remaining = self.limits['deadline'] - (self.monotonic() - self.started)
            if remaining <= 0:
                return {'error': 'deadline_exceeded', 'url': current, 'redirects': hops}
            self.requests += 1
            try:
                response = self.fetch(current, max_bytes=max_bytes,
                                      timeout=min(self.limits['requestTimeout'], remaining))
            except Exception:  # 주입 전송의 예외 문장에는 주소·헤더가 담길 수 있어 형식 오류로만 기록한다.
                response = None
            checked = _response(response, max_bytes)
            checked.update(url=current, redirects=hops)
            if 'error' in checked or checked['status'] not in REDIRECT_STATUSES:
                return checked
            hops += 1
            following = _canonical(_join(current, checked['headers'].get('location')))
            if hops > self.limits['redirects']:
                return dict(checked, error='redirect_limit')
            if following is None or not allowed(following):
                return dict(checked, error='redirect_not_allowed')
            current = following


class _PageParser(HTMLParser):
    """링크(href·문구)와 표 셀(th/td·문구)만 모은다. 스크립트는 실행·해석하지 않는다."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links, self.cells = [], []
        self._link = self._cell = None
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self._skip += 1
        elif tag == 'a':
            self._close_link()
            self._link = [dict(attrs).get('href'), []]
        elif tag in ('td', 'th'):
            self._close_cell()
            self._cell = [tag, []]

    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self._skip = max(0, self._skip - 1)
        elif tag == 'a':
            self._close_link()
        elif tag in ('td', 'th', 'tr', 'table'):
            self._close_cell()

    def handle_data(self, data):
        if self._skip:
            return
        for part in (self._link, self._cell):
            if part is not None:
                part[1].append(data)

    def close(self):
        super().close()
        self._close_link()
        self._close_cell()

    def _close_link(self):
        if self._link is not None:
            self.links.append((self._link[0], ' '.join(''.join(self._link[1]).split())))
            self._link = None

    def _close_cell(self):
        if self._cell is not None:
            self.cells.append((self._cell[0], ' '.join(''.join(self._cell[1]).split())))
            self._cell = None


def _read_page(page):
    media, _, params = page['headers'].get('content-type', '').partition(';')
    if media.strip().lower() != 'text/html':
        return None, 'detail_page_not_html'
    charset = 'utf-8'
    for param in params.split(';'):
        name, _, value = param.partition('=')
        if name.strip().lower() == 'charset' and value.strip():
            charset = value.strip().strip('"').lower()
    try:
        parser = _PageParser()
        parser.feed(page['body'].decode(charset))
        parser.close()
    except (LookupError, UnicodeDecodeError, ValueError, AssertionError):
        return None, 'detail_page_malformed'
    return parser, None


def _page_identity(cells, house_no):
    """상세 페이지 주택형 표의 '주택관리번호(모델번호)' 셀. 다른 번호가 보이면 충돌이다."""
    numbers = sorted({m.group(1) for tag, text in cells if tag == 'td' for m in [MODEL_CELL.fullmatch(text)] if m})
    if not numbers:
        return {'status': 'not_shown', 'numbers': []}
    return {'status': 'confirmed' if numbers == [house_no] else 'conflict', 'numbers': numbers}


def _page_notice_date(cells, expected):
    shown = []
    for index, (tag, text) in enumerate(cells):
        if tag == 'th' and text == '모집공고일' and index + 1 < len(cells) and cells[index + 1][0] == 'td':
            shown.extend(DATE.findall(cells[index + 1][1]))
    shown = sorted(set(shown))
    if expected is None:
        return {'status': 'not_requested', 'page': shown}
    if not shown:
        return {'status': 'not_shown', 'page': shown}
    if len(shown) > 1:
        return {'status': 'ambiguous', 'page': shown}
    return {'status': 'confirmed' if shown == [expected] else 'conflict', 'page': shown}


def _markers(label):
    """링크 문구 전체에서 찾은 역할 표지. 원 문구는 결과에 내보내지 않는다."""
    return {'correction': '정정' in label, 'notice': '모집공고' in label or '공고문' in label,
            'noticeDocument': '공고문' in label,
            'reference': '정정' not in label and REFERENCE_ONLY.search(label) is not None,
            'fullReplacementStatement': (len(label) <= FULL_REPLACEMENT_MAX_LABEL and FULL_REPLACEMENT.search(label)
                                         is not None and NOT_FULL.search(label) is None)}


def _role(markers):
    if markers['correction']:
        return 'correction'
    if markers['reference']:
        return 'reference'
    return 'notice' if markers['notice'] else 'unclassified'


def _merged_role(marker_list):
    """같은 첨부에 붙은 모든 문구의 역할. 순서와 무관하며 서로 다르면 미분류다."""
    roles = {_role(m) for m in marker_list}
    role = roles.pop() if len(roles) == 1 else 'unclassified'
    merged = {k: any(m[k] for m in marker_list) for k in marker_list[0]}
    merged['fullReplacementStatement'] = role == 'correction' and all(m['fullReplacementStatement'] for m in marker_list)
    return role, merged


def _applicable_document(markers, path):
    """지원하지 않는 형식이라도 현재 공고의 원본·정정 문서로 보이는 링크. 사이트 메뉴('모집공고' 목록)는 제외한다."""
    if markers['reference']:
        return False
    return markers['correction'] or (markers['notice'] and (markers['noticeDocument'] or path is None
                                                             or path.lower().endswith(DOCUMENT_EXTENSIONS)))


def _pdf_problem(body, headers, declared_check=True):
    if declared_check:
        media = headers.get('content-type', '').partition(';')[0].strip().lower()
        if media and media not in PDF_TYPES:
            return 'attachment_type_not_pdf'
        length = headers.get('content-length')
        # 비정상적으로 긴 숫자도 int 변환 없이 자릿수로 먼저 비교해 이 문서만 거부한다.
        if length is not None and (not LENGTH.fullmatch(length.strip()) or len(length.strip()) > 20
                                   or int(length.strip()) != len(body)):
            return 'attachment_length_mismatch'
    if not PDF_HEADER.match(body[:16]):
        return 'not_pdf'
    if b'%%EOF' not in body[-1024:]:
        return 'pdf_truncated'
    return None


def _document(doc_id, target, content, *, source, origin, role, acquisition):
    digest = hashlib.sha256(content).hexdigest() if content is not None else None
    return {'id': doc_id, 'version': 'sha256:' + digest if digest else None, 'sha256': digest,
            'bytes': len(content) if content is not None else None, 'content': content,
            'mediaType': 'application/pdf' if content is not None else None,
            'source': source, 'originCheck': origin, 'houseManageNo': target['houseManageNo'],
            'noticeNo': target['noticeNo'], 'edition': target['edition'], 'role': role,
            'adoption': 'not_adoptable', 'reasons': [], 'acquisition': acquisition}


def _download(ctx, entry, target, numbers):
    def same_attachment(url):  # 리디렉션도 같은 공고 번호쌍·첨부 번호로만 허용한다.
        query, why = _match(url, APPLYHOME['attachment'], numbers)
        return why is None and query is not None and (query['atchmnflSeqNo'], query['atchmnflSn']) == entry['key']

    fetched = ctx.get(entry['url'], same_attachment, MAX_PDF_BYTES)
    acquisition = {'url': entry['url'], 'markers': entry['markers'], 'httpStatus': fetched.get('status'),
                   'declaredContentType': fetched.get('headers', {}).get('content-type'),
                   'redirects': fetched['redirects'], 'error': None, 'matchedBy': 'detail_page'}
    error = fetched.get('error')
    if error is None and fetched['status'] != 200:
        error = _http_reason(fetched['status'], 'attachment')
    if error is None:
        error = _pdf_problem(fetched['body'], fetched['headers'])
    if error is not None:
        acquisition['error'] = error
        return None, acquisition
    return _document(entry['id'], target, fetched['body'], source='official', origin='confirmed', role=entry['role'],
                     acquisition=acquisition), acquisition


def _relation(kind, basis, entries, *, set_known, documents=(), superseded=(), reasons=()):
    missing = [{'id': e['id'], 'role': e['role'], 'reason': (e['acquisition'] or {}).get('error')}
               for e in entries if e['doc'] is None]
    if 'original_document_missing' in reasons and not any(e['role'] == 'notice' for e in entries):
        missing.append({'id': None, 'role': 'notice', 'reason': 'original_document_missing'})
    return {'kind': kind, 'basis': basis, 'setKnown': set_known,
            'allDocumentsAvailable': bool(set_known and entries and not missing),
            'documents': list(documents), 'missing': missing, 'superseded': list(superseded), 'reasons': list(reasons)}


def _resolve(entries, set_known):
    """같은 공고 첨부들의 관계. 문서에 adoption·reasons를 채운다. 사용자 업로드는 관계를 풀지 못하고 빈 자리만 채운다."""
    if not entries:
        return _relation('none', None, entries, set_known=set_known)
    basis = 'detail_page+official_index' if any(e.get('substitutedBy') for e in entries) else 'detail_page'
    ready = [e for e in entries if e['doc'] is not None]
    by_role = {role: [e for e in entries if e['role'] == role] for role in ROLES}
    corrections = by_role['correction']
    if (len(corrections) == 1 and corrections[0]['markers']['fullReplacementStatement']
            and corrections[0]['doc'] is not None and not by_role['unclassified']):
        winner = corrections[0]['doc']
        winner['adoption'] = 'standalone'
        for entry in by_role['notice']:
            if entry['doc'] is not None:
                entry['doc']['reasons'].append('superseded_by_full_replacement')
        return _relation('full_replacement', basis, entries, set_known=set_known, documents=[winner['id']],
                         superseded=[e['id'] for e in by_role['notice']])
    if len(entries) == 1 and entries[0]['role'] == 'notice':
        if not ready:
            return _relation('none', None, entries, set_known=set_known)
        ready[0]['doc']['adoption'] = 'standalone'
        return _relation('sole', basis, entries, set_known=set_known, documents=[ready[0]['doc']['id']])
    reasons = []
    if len(corrections) > 1:
        reasons.append('multiple_correction_documents')
    elif corrections:
        reasons.append('correction_scope_unverified')
    if len(by_role['notice']) > 1:
        reasons.append('multiple_notice_documents')
    if by_role['unclassified']:
        reasons.append('attachment_role_unclassified')
    if corrections and not by_role['notice']:
        reasons.append('original_document_missing')  # 정정이 가리키는 원본 첨부가 이 페이지에 없다.
    for entry in entries:
        if entry['doc'] is None and MISSING_REASON[entry['role']] not in reasons:
            reasons.append(MISSING_REASON[entry['role']])
    for entry in ready:
        entry['doc']['adoption'] = 'with_set'
        entry['doc']['reasons'].extend(reasons)
    return _relation('unresolved' if ready else 'none', basis if ready else None, entries, set_known=set_known,
                     documents=[e['doc']['id'] for e in ready], reasons=reasons)


def _validate_limits(limits):
    merged = dict(DEFAULT_LIMITS)
    if limits is not None:
        if not isinstance(limits, dict) or not set(limits) <= set(DEFAULT_LIMITS):
            raise ValueError('limits에는 ' + ', '.join(DEFAULT_LIMITS) + '만 둡니다.')
        for name, value in limits.items():
            if type(value) is not int or not 1 <= value <= LIMIT_CEILINGS[name]:
                raise ValueError('limits 값은 1 이상 상한 이하의 정수여야 합니다.')
        merged.update(limits)
    return merged


def _validate_business(policy):
    if not isinstance(policy, dict) or set(policy) != {'detailOrigins', 'attachmentOrigins'}:
        raise ValueError('business_policy는 detailOrigins·attachmentOrigins만 가집니다.')
    out = {}
    for name in ('detailOrigins', 'attachmentOrigins'):
        origins = policy[name]
        if not isinstance(origins, (list, tuple)) or not origins:
            raise ValueError('사업주체 허용 출처가 필요합니다.')
        for origin in origins:
            parsed = _parse_url(origin) if isinstance(origin, str) else None
            if parsed is None or parsed[0] != origin or parsed[1] or parsed[2]:
                raise ValueError('허용 출처는 https://호스트 형식이어야 합니다.')
        out[name] = tuple(origins)
    return out


def _index_records(official_index, reasons):
    if not isinstance(official_index, (list, tuple)):
        raise TypeError('official_index는 기록의 list 또는 tuple이어야 합니다.')
    records = []
    for record in official_index:
        # 이전에 공식 경로로 확보한 첨부 영수증만 받는다. upload:<id> 같은 비공식 식별자, 명시된 비공식 출처·미확인
        # 출처 대조, 첨부 ID 안의 번호쌍과 기록의 번호쌍이 다른 행은 공식 첨부의 빈 자리를 채우지 못한다.
        attachment = OFFICIAL_ID.fullmatch(record['id']) if isinstance(record, dict) and isinstance(
            record.get('id'), str) else None
        if (attachment and all(_text(record.get(k)) for k in ('houseManageNo', 'noticeNo', 'edition'))
                and attachment.group(1, 2) == (record['houseManageNo'], record['noticeNo'])
                and isinstance(record.get('sha256'), str) and SHA256.fullmatch(record['sha256'])
                and record.get('role') in ROLES and record.get('source', 'official') == 'official'
                and record.get('originCheck', 'confirmed') == 'confirmed'):
            records.append(record)
        else:
            _add(reasons, 'official_index_record_invalid')
    return records


def _read_upload(upload, needed, notes):
    """dict는 그대로, callable은 확정 원문이 없을 때만 한 번 부른다. 반환·입력 형식이 틀리면 ValueError."""
    notes.update(provided=False, called=False)
    if upload is None:
        return None
    if callable(upload):
        if not needed:
            return None
        notes['called'] = True
        try:
            upload = upload()
        except Exception:  # 등록 파일 조회 실패의 세부 문장(경로·세션)은 결과에 넣지 않는다.
            notes['error'] = 'upload_read_failed'
            return None
        if upload is None:
            return None
    if not (isinstance(upload, dict) and set(upload) == {'id', 'content'} and _text(upload['id'])
            and len(upload['id']) <= MAX_ID_LENGTH and not UNSAFE_TEXT.search(upload['id'])
            and isinstance(upload['content'], bytes)):
        raise ValueError('upload는 id 문자열과 content bytes만 가집니다.')
    notes['provided'] = True
    return upload


def _apply_upload(upload, target, entries, set_known, records, prior_records=()):
    """업로드는 내용 해시가 같은 호출의 공식 문서 또는 서버 공식 확보 기록(같은 공고·회차·첨부 ID)과 같을 때만 출처 확인이다.

    현재 페이지의 같은 첨부 ID 자리에 공식 bytes가 없을 때 그 자리를 채운다(관계 판정은 그대로).
    같은 공고·회차의 이전 공식 해시(prior_records)와 일치하고 현재 공식 판본과 해시가 다르면
    A-59 복수 판본 대조(with_set)로 보존한다.
    """
    content = upload['content']
    doc_id = 'upload:' + upload['id']
    acquisition = {'url': None, 'markers': None, 'httpStatus': None, 'declaredContentType': None, 'redirects': 0,
                   'error': None, 'matchedBy': None, 'uploadId': upload['id'], 'indexRecord': None}
    problem = 'upload_too_large' if len(content) > MAX_PDF_BYTES else (
        'upload_not_pdf' if _pdf_problem(content, {}, declared_check=False) else None)
    if problem:
        doc = _document(doc_id, target, None, source='upload', origin='unverified', role='unclassified',
                        acquisition=dict(acquisition, error=problem))
        doc['reasons'].append(problem)
        return doc
    digest = hashlib.sha256(content).hexdigest()
    same = [e for e in entries if e['doc'] is not None and e['doc']['sha256'] == digest]
    if same:
        doc = _document(doc_id, target, content, source='upload', origin='confirmed', role=same[0]['role'],
                        acquisition=dict(acquisition, matchedBy='same_call_official'))
        doc['reasons'].append('upload_duplicates_official')  # 같은 판이 공식 경로로 확보돼 중복 채택하지 않는다.
        return doc
    triple = (target['houseManageNo'], target['noticeNo'], target['edition'])
    matches = [r for r in records if r['sha256'] == digest]
    own = [r for r in matches if (r['houseManageNo'], r['noticeNo'], r['edition']) == triple]
    if own and len(own) == len(matches):
        slots = {e['id']: e for e in entries}
        empty = [r for r in own if r['id'] in slots and slots[r['id']]['doc'] is None]
        record = empty[0] if empty else own[0]
        doc = _document(doc_id, target, content, source='upload', origin='confirmed', role=record['role'],
                        acquisition=dict(acquisition, matchedBy='official_index', indexRecord=record['id']))
        if empty:
            slots[record['id']]['doc'] = doc
            slots[record['id']]['substitutedBy'] = doc_id
            return None
        if set_known:
            doc['reasons'].append('upload_version_differs_from_current' if record['id'] in slots
                                  else 'upload_not_in_current_attachments')
        else:
            doc['adoption'] = 'with_set'  # 현재 첨부 목록을 읽지 못해 정정 등 관계를 확인할 수 없다.
            doc['reasons'].append('attachment_set_unverified')
        return doc
    # 같은 공고·회차의 이전 공식 해시 이력(prior_records)에 기록된 판본이고 다른 공고 충돌이 없으면 A-59 비교용으로 보존한다.
    prior_matches = [r for r in prior_records if r['sha256'] == digest]
    prior_own = [r for r in prior_matches if (r['houseManageNo'], r['noticeNo'], r['edition']) == triple]
    if prior_own and not matches and any(e['doc'] is not None for e in entries):
        record = prior_own[0]
        doc = _document(doc_id, target, content, source='upload', origin='confirmed', role=record['role'],
                        acquisition=dict(acquisition, matchedBy='official_index', indexRecord=record['id']))
        doc['reasons'].append('upload_version_differs_from_current')
        return doc
    official = any(e['doc'] is not None for e in entries)
    origin, reason = ('conflict', 'upload_matches_other_notice') if matches else (
        'unverified', 'upload_differs_from_official' if official else 'upload_origin_unverified')
    doc = _document(doc_id, target, content, source='upload', origin=origin, role='unclassified',
                    acquisition=acquisition)
    doc['reasons'].append(reason)
    return doc


def _apply_prior_revisions(target, entries, relation, upload_doc, prior_records):
    """같은 공고·회차의 공식 색인에 해시가 다른 이전 판이 있으면 두 판을 모두 보존하고 A-59 관계 미확정으로 처리한다."""
    if not entries or relation['kind'] == 'full_replacement':
        return
    ready_entries = [e for e in entries if e['doc'] is not None and e['doc']['sha256']]
    if not ready_entries:
        return
    triple = (target['houseManageNo'], target['noticeNo'], target['edition'])
    current_hashes = {e['doc']['sha256'] for e in ready_entries}
    differing = []
    seen_hashes = set()
    for record in prior_records:
        if (record['houseManageNo'], record['noticeNo'], record['edition']) != triple:
            continue
        digest = record['sha256']
        if digest in current_hashes or digest in seen_hashes:
            continue
        seen_hashes.add(digest)
        differing.append(record)
    if not differing:
        return

    extra_reasons = ('official_document_hash_changed', 'correction_relation_unverified')
    for entry in ready_entries:
        entry['doc']['adoption'] = 'with_set'
        for reason in extra_reasons:
            _add(entry['doc']['reasons'], reason)

    upload_supplied = None
    if (upload_doc is not None and upload_doc['originCheck'] == 'confirmed'
            and upload_doc['sha256'] in seen_hashes and isinstance(upload_doc.get('content'), bytes)):
        upload_doc['adoption'] = 'with_set'
        for reason in extra_reasons:
            _add(upload_doc['reasons'], reason)
        upload_supplied = upload_doc['sha256']

    relation['kind'] = 'unresolved'
    relation['basis'] = 'detail_page+official_index'
    for reason in extra_reasons:
        _add(relation['reasons'], reason)
    if upload_supplied and upload_doc['id'] not in relation['documents']:
        relation['documents'].append(upload_doc['id'])
    for record in differing:
        if record['sha256'] == upload_supplied:
            continue
        relation['missing'].append({
            'id': record['id'], 'version': 'sha256:' + record['sha256'],
            'role': record['role'], 'reason': 'prior_official_revision_unavailable',
        })
    relation['allDocumentsAvailable'] = bool(relation['setKnown'] and not relation['missing'])


def _upload_next(target, reason):
    return {'action': 'upload', 'target': dict(target), 'accept': 'application/pdf', 'maxBytes': MAX_PDF_BYTES,
            'reason': reason, 'equivalence': 'sha256_matches_official'}


def _add(reasons, reason):
    if reason and reason not in reasons:
        reasons.append(reason)


def acquire_notice_pdf(target, detail_url, *, fetch, source='applyhome', upload=None, official_index=(),
                       prior_revisions=(), notice_date=None, business_policy=None, now=None, monotonic=None, limits=None):
    """한 공고·회차의 공식 PDF bytes와 문서별 상태·근거, 또는 명시적 보류·재시도·업로드 요청을 돌려준다.

    target: {'houseManageNo', 'noticeNo', 'edition'}. edition은 호출자의 회차 라벨이며 번호쌍으로만 대조한다.
    detail_url: 서버가 고른 출처의 상세 주소. 청약홈은 API PBLANC_URL 그대로, 사업주체는 business_policy의 출처.
      None이면 업로드 보완만 안내한다. 주소를 조립하거나 추측하지 않는다.
    upload: None | {'id': 등록 업로드 ID, 'content': bytes} | 같은 dict 또는 None을 돌려주는 callable.
      callable은 공식 첨부가 모두 확보되면 부르지 않고, 확보 자료가 없거나 빠진 첨부가 있을 때 한 번 부른다.
    official_index: 서버가 이전에 공식 경로로 확보한 기록 [{'id', 'houseManageNo', 'noticeNo', 'edition', 'sha256', 'role'}].
    prior_revisions: 같은 공고·회차에서 관측된 이전 공식 판본 해시 이력(같은 첨부 ID의 복수 해시 포함).
    notice_date: API 모집공고일(YYYY-MM-DD). 상세 페이지 표시값과 다르면 보류한다.
    """
    if not (isinstance(target, dict) and all(_text(target.get(k)) for k in ('houseManageNo', 'noticeNo', 'edition'))):
        raise ValueError('target needs houseManageNo, noticeNo and edition strings')
    if not callable(fetch):
        raise TypeError('fetch must be callable')
    if source not in SOURCES:
        raise ValueError('source는 applyhome 또는 business_entity입니다.')
    if notice_date is not None and not (isinstance(notice_date, str) and DATE.fullmatch(notice_date)):
        raise ValueError('notice_date는 YYYY-MM-DD 문자열이어야 합니다.')
    if detail_url is not None and not isinstance(detail_url, str):
        raise TypeError('detail_url must be a string or None')
    if upload is not None and not (callable(upload) or isinstance(upload, dict)):
        raise TypeError('upload must be None, a dict or a callable')
    target = {k: target[k] for k in ('houseManageNo', 'noticeNo', 'edition')}
    if source == 'applyhome' and not all(NUMBER.fullmatch(target[k]) for k in ('houseManageNo', 'noticeNo')):
        raise ValueError('청약홈 공고 번호는 숫자 문자열이어야 합니다.')
    if source == 'applyhome' and business_policy is not None:
        raise ValueError('business_policy는 business_entity 출처에서만 씁니다.')
    business = _validate_business(business_policy) if source == 'business_entity' else None
    ctx = _Context(fetch, _validate_limits(limits), monotonic or time.monotonic)
    observed = (now or (lambda: datetime.now(timezone.utc)))()
    reasons, candidates, references, entries = [], [], [], []
    records = _index_records(official_index, reasons)
    prior_records = _index_records(prior_revisions, reasons) if prior_revisions else []
    all_prior = list(records) + [r for r in prior_records if r not in records]
    numbers = (target['houseManageNo'], target['noticeNo'])

    if source == 'applyhome':
        def detail_allowed(url):
            return _match(url, APPLYHOME['detail'], numbers)[1] is None
    else:
        def detail_allowed(url):
            return _origin(url) in business['detailOrigins']

    url_allowed = detail_url is not None and detail_allowed(detail_url)
    # 허용 정책 밖의 주소는 결과에 그대로 내보내지 않는다(출처만).
    detail = {'source': source, 'url': _canonical(detail_url) if url_allowed else None,
              'rejectedOrigin': None if url_allowed or detail_url is None else _origin(detail_url),
              'finalUrl': None, 'httpStatus': None, 'redirects': 0, 'error': None,
              'identity': {'status': 'not_checked', 'numbers': []}, 'noticeDate': {'status': 'not_checked', 'page': []}}
    failure, page = None, None  # failure: 사용 문서가 없을 때 status를 정하는 대표 사유
    if detail_url is None:
        failure = 'detail_url_missing'
    elif not url_allowed:
        failure = 'detail_url_not_allowed'
    else:
        fetched = ctx.get(detail['url'], detail_allowed, MAX_HTML_BYTES)
        detail.update(finalUrl=fetched['url'], httpStatus=fetched.get('status'), redirects=fetched['redirects'])
        failure = fetched.get('error')
        if failure is None and fetched['status'] != 200:
            failure = _http_reason(fetched['status'], 'detail')
        if failure is None:
            page, failure = _read_page(fetched)
        if failure is None:
            detail['identity'] = (_page_identity(page.cells, target['houseManageNo']) if source == 'applyhome'
                                  else {'status': 'not_shown', 'numbers': []})
            detail['noticeDate'] = _page_notice_date(page.cells, notice_date)
            if detail['identity']['status'] == 'conflict':
                failure = 'detail_identity_conflict'
            elif detail['noticeDate']['status'] in ('conflict', 'ambiguous'):
                failure = 'detail_notice_date_' + detail['noticeDate']['status']
        detail['error'] = failure
        if failure is not None:
            page = None

    set_known = page is not None and source == 'applyhome'
    if page is not None:
        groups, unsupported, unsupported_urls = {}, [], set()
        for order, (href, label) in enumerate(page.links):
            raw, markers = (href or '').strip(), _markers(label)
            if raw.lower().startswith(('tel:', 'mailto:')):
                continue
            if not raw or raw.startswith('#') or raw.lower().startswith('javascript:'):
                # 주소 없이 스크립트로 첨부를 여는 링크도 역할이 드러나면 확보하지 못한 문서로 남긴다.
                if source == 'applyhome' and _applicable_document(markers, None):
                    unsupported.append((order, None, markers, 'attachment_link_without_url'))
                continue
            joined = _join(detail['finalUrl'], raw)
            url = _canonical(joined) or joined
            parsed = _parse_url(url) if url else None
            path = parsed[1] if parsed else (url or raw).lower().split('?')[0]
            if source == 'business_entity':
                if path.lower().endswith('.pdf'):
                    allowed = parsed is not None and parsed[0] in business['attachmentOrigins']
                    # 사업주체 링크에는 공고 번호가 없어 같은 회차임을 확인할 수 없다. 내려받지 않고 후보로만 남긴다.
                    candidates.append({'origin': parsed[0] if parsed else None,
                                       'url': parsed[0] + parsed[1] if allowed else None, 'markers': markers,
                                       'reason': 'attachment_identity_unverified' if allowed
                                       else 'attachment_origin_not_allowed'})
                continue
            query, why = _match(url, APPLYHOME['attachment'], numbers) if parsed else (None, 'url_not_allowed')
            if query is not None and why is None:
                key = (query['atchmnflSeqNo'], query['atchmnflSn'])
                groups.setdefault(key, {'order': order, 'url': url, 'markers': []})['markers'].append(markers)
            elif why == 'other_notice':  # 다른 번호임이 확인된 첨부는 참조 이력으로만 남긴다.
                references.append({'id': 'applyhome:%s:%s:%s:%s' % (query['houseManageNo'], query['pblancNo'],
                                                                   query['atchmnflSeqNo'], query['atchmnflSn']),
                                   'url': url, 'origin': parsed[0], 'markers': markers,
                                   'reason': 'other_notice_attachment'})
            elif _applicable_document(markers, path):
                # 원본·정정으로 표시됐지만 지원하지 않는 주소다. 조회하지 않고 누락 문서로 관계 판정에 넣는다.
                if (url, _role(markers)) not in unsupported_urls:  # 같은 주소·역할의 반복 링크는 한 문서다
                    unsupported_urls.add((url, _role(markers)))
                    unsupported.append((order, parsed[0] if parsed else None, markers,
                                        'attachment_url_not_supported' if parsed else 'attachment_url_unparseable'))
            elif markers['reference'] and (path.lower().endswith(DOCUMENT_EXTENSIONS) or 'getatchmnfl' in path.lower()):
                references.append({'id': None, 'url': None, 'origin': parsed[0] if parsed else None,
                                   'markers': markers, 'reason': 'marked_reference'})
            elif path.lower().endswith(DOCUMENT_EXTENSIONS) or 'getatchmnfl' in path.lower():
                candidates.append({'origin': parsed[0] if parsed else None, 'url': None,
                                   'reason': 'attachment_origin_not_allowed' if parsed else 'attachment_url_unparseable'})
        ordered = []
        for key, group in groups.items():
            role, markers = _merged_role(group['markers'])
            entry = {'id': 'applyhome:%s:%s:%s:%s' % (numbers + key), 'key': key, 'url': group['url'], 'role': role,
                     'markers': markers, 'doc': None, 'acquisition': None}
            if role == 'reference':
                # 참고 전용으로만 표시한 첨부(예: 이전 회차 원문)는 정정 후보·가격 근거에서 빼고 참조 이력으로 남긴다.
                references.append({'id': entry['id'], 'url': entry['url'], 'origin': _origin(entry['url']),
                                   'markers': markers, 'reason': 'marked_reference'})
            else:
                ordered.append((group['order'], entry))
        for number, (order, origin, markers, error) in enumerate(unsupported, 1):
            role = 'correction' if markers['correction'] else 'notice'
            ordered.append((order, {'id': 'unsupported:%d' % number, 'key': None, 'url': None, 'role': role,
                                    'markers': markers, 'doc': None,
                                    'acquisition': {'url': None, 'origin': origin, 'markers': markers, 'httpStatus': None,
                                                    'declaredContentType': None, 'redirects': 0, 'error': error,
                                                    'matchedBy': 'detail_page'}}))
        entries = [entry for _, entry in sorted(ordered, key=lambda pair: pair[0])]
        downloadable = [e for e in entries if e['key'] is not None]
        if source == 'business_entity':
            failure = ('attachment_identity_unverified' if any(c['reason'] == 'attachment_identity_unverified'
                                                                for c in candidates) else 'attachment_not_found')
        elif not entries:
            failure = 'attachment_not_found'
        elif len(downloadable) > ctx.limits['attachments']:
            failure = 'attachment_limit_exceeded'
            candidates.extend({'origin': _origin(e['url']), 'url': e['url'], 'reason': failure} for e in downloadable)
            entries, set_known = [], False
        else:
            for entry in downloadable:
                entry['doc'], entry['acquisition'] = _download(ctx, entry, target, numbers)

    upload_notes = {}
    triple = (target['houseManageNo'], target['noticeNo'], target['edition'])
    live_hashes = {e['doc']['sha256'] for e in entries if e['doc'] is not None and e['doc']['sha256']}
    prior_hash_changed = bool(live_hashes) and any(
        (r['houseManageNo'], r['noticeNo'], r['edition']) == triple and r['sha256'] not in live_hashes
        for r in all_prior
    )
    needed = not entries or any(e['doc'] is None for e in entries) or prior_hash_changed
    received = _read_upload(upload, needed, upload_notes)
    upload_doc = _apply_upload(received, target, entries, set_known, records, all_prior) if received else None
    relation = _resolve(entries, set_known)
    _apply_prior_revisions(target, entries, relation, upload_doc, all_prior)
    if upload_doc is not None and upload_doc['adoption'] == 'with_set' and relation['kind'] != 'unresolved':
        relation.update(kind='unresolved', basis='official_index', documents=[upload_doc['id']],
                        reasons=['attachment_set_unverified'])  # 이전 공식 기록과 같은 판이나 현재 집합은 미확인
    documents = []
    for entry in entries:
        if entry['doc'] is None:
            entry['doc'] = _document(entry['id'], target, None, source='official', origin='confirmed',
                                     role=entry['role'], acquisition=entry['acquisition'])
            entry['doc']['reasons'].append(entry['acquisition']['error'])
        documents.append(entry['doc'])
    if upload_doc is not None:
        documents.append(upload_doc)

    adoptions = {d['adoption'] for d in documents}
    errors = [d['acquisition']['error'] for d in documents if d['source'] == 'official' and d['acquisition']['error']]
    if 'with_set' in adoptions:
        status = 'partial'
    elif 'standalone' in adoptions:
        status = 'acquired'
    else:
        failure = failure or (errors[0] if errors else 'attachment_not_found')
        status = 'failed' if failure in RETRYABLE or any(e in RETRYABLE for e in errors) else 'held'
    ordered_reasons = []  # 대표 사유를 맨 앞에 둔다. 색인 형식 오류 등 부가 사유는 뒤에 남긴다.
    for reason in ([failure] if status in ('failed', 'held') else []) + relation['reasons'] + (
            upload_doc['reasons'] if upload_doc else []) + [upload_notes.get('error')] + reasons:
        _add(ordered_reasons, reason)
    reasons = ordered_reasons
    actions = [{'action': 'retry'}] if status == 'failed' else []
    if status in ('failed', 'held'):
        actions.append(_upload_next(target, reasons[0]))
    elif relation['missing'] and relation['kind'] != 'full_replacement':
        first_missing = relation['missing'][0]
        next_reason = (first_missing['reason'] if first_missing.get('reason') == 'prior_official_revision_unavailable'
                       else MISSING_REASON[first_missing['role']])
        actions.append(_upload_next(target, next_reason))
    return {'contract': CONTRACT, 'target': target, 'status': status, 'reasons': reasons, 'detail': detail,
            'documents': documents, 'relation': relation, 'references': references, 'candidates': candidates,
            'upload': {'provided': upload_notes['provided'], 'called': upload_notes['called']},
            'next': actions, 'requests': ctx.requests, 'observedAt': observed.isoformat(timespec='seconds')}


def without_content(result):
    """로그·출력 전용 사본. PDF bytes를 빼고 해시·크기만 남긴다. 다른 항목은 이미 허용 주소·표지만 담는다."""
    return dict(result, documents=[dict(d, content=None) for d in result['documents']])


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # 커넥터가 Location을 정책으로 검사한 뒤 새 요청을 만든다.


KEPT_HEADERS = ('content-type', 'content-length', 'location')  # 쿠키 등 다른 응답 헤더는 넘기지 않는다.


def make_live_fetch(opener=None, user_agent='Mozilla/5.0 (compatible; notice-pdf-acquisition/0)', clock=None,
                    chunk=65536):
    """표준 라이브러리 실호출 전송. 쿠키 저장소·인증 헤더 없이 GET 한 번, 리디렉션 미추적, 크기·시간 상한을 지킨다."""
    transport = opener or urllib.request.build_opener(_NoRedirect())
    clock = clock or time.monotonic

    def kept(headers):
        return {k.lower(): v for k, v in headers.items() if k.lower() in KEPT_HEADERS}

    def fetch(url, *, max_bytes, timeout):
        request = urllib.request.Request(url, headers={'User-Agent': user_agent, 'Accept': '*/*'}, method='GET')
        started = clock()
        try:
            try:
                response = transport.open(request, timeout=timeout)
            except urllib.error.HTTPError as exc:  # 3xx(미추적)·4xx·5xx는 상태와 허용 헤더만 돌려준다.
                headers = kept(exc.headers or {})
                try:
                    exc.close()
                except Exception:  # 본문이 없는 오류 응답
                    pass
                return {'status': exc.code, 'headers': headers, 'body': b''}
            with response:
                headers = kept(response.headers)
                length = headers.get('content-length', '').strip()
                if LENGTH.fullmatch(length) and (len(length) > 20 or int(length) > max_bytes):
                    return {'error': 'too_large'}
                parts, size = [], 0
                while True:
                    if clock() - started > timeout:
                        return {'error': 'timeout'}
                    part = response.read(chunk)
                    if not part:
                        break
                    size += len(part)
                    if size > max_bytes:
                        return {'error': 'too_large'}
                    parts.append(part)
                return {'status': response.status, 'headers': headers, 'body': b''.join(parts)}
        except (socket.timeout, TimeoutError):
            return {'error': 'timeout'}
        except (ssl.SSLError, ssl.CertificateError):
            return {'error': 'tls'}
        except urllib.error.URLError as exc:
            reason = getattr(exc, 'reason', None)
            if isinstance(reason, (socket.timeout, TimeoutError)):
                return {'error': 'timeout'}
            return {'error': 'tls' if isinstance(reason, ssl.SSLError) else 'connection'}
        except (OSError, http.client.HTTPException, ValueError):
            return {'error': 'connection'}

    return fetch


def main(argv=None):
    parser = argparse.ArgumentParser(description='공식 상세 페이지에서 공고 PDF를 확보해 해시·상태만 출력한다(수동 실호출).')
    parser.add_argument('--live', action='store_true', required=True, help='명시한 상세 주소 하나를 실제로 조회')
    parser.add_argument('--house-manage-no', required=True)
    parser.add_argument('--notice-no', required=True)
    parser.add_argument('--edition', required=True)
    parser.add_argument('--detail-url', required=True, help='API PBLANC_URL 그대로')
    parser.add_argument('--notice-date', help='API 모집공고일(YYYY-MM-DD)')
    args = parser.parse_args(argv)
    try:
        result = acquire_notice_pdf({'houseManageNo': args.house_manage_no, 'noticeNo': args.notice_no,
                                     'edition': args.edition}, args.detail_url, fetch=make_live_fetch(),
                                    notice_date=args.notice_date)
    except (TypeError, ValueError):
        print('입력을 확인하세요: 공고 번호·회차·상세 주소·공고일 형식.', file=sys.stderr)
        return 2
    print(json.dumps(without_content(result), ensure_ascii=False, indent=2))  # 원문 bytes는 출력·저장하지 않는다.
    return 0 if result['status'] == 'acquired' else 1


if __name__ == '__main__':
    raise SystemExit(main())
