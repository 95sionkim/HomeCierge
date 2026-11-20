#!/usr/bin/env python3
"""응답 해석과 분리해, 저장·로그·CLI로 나가는 사본에서만 인증값 반향을 가린다.

공급자 응답은 호출한 쪽이 원문으로 해석한다. 유효한 JSON/XML은 표준 파서의 구조를 순회해 문자열 값만
정제한다. 가릴 값이 없으면 원문 텍스트를 그대로 저장하고, 있을 때만 정제한 구조를 다시 직렬화한다.
직렬화 사본에도 반향이 남으면 RedactionError로 저장을 막는다. 키·태그·숫자는 바꾸지 않는다.

값을 가리는 규칙
1. 인증 항목(serviceKey·OC·Authorization 등) 이름의 값과 하위 값은 길이·등록 여부와 무관하게 전체를 가린다.
2. URL 질의(`?OC=…`, `%3FserviceKey%3D…`)·인증 헤더(`Authorization: KakaoAK …`) 문법의 값은 등록 여부와
   무관하게 가린다. 이름 앞에 영숫자가 붙은 `doc:`·`loc=`는 인증 문법이 아니다.
3. DISTINCTIVE_LENGTH 이상인 설정 인증값은 모든 문자열 값에서 부분 일치를 가린다. 글자별 퍼센트(대소문자·
   이중) 인코딩, JSON `\\/`·`\\uXXXX`, XML 문자 참조 형태도 같은 일치로 본다.
4. 더 짧은 인증값은 서비스 구분 없이 모든 설정값에 같은 규칙을 적용한다. 앞뒤가 영숫자가 아닌 일치(값 전체 포함)는
   오류 메시지 항목과 자유 텍스트에서 가린다. 정상 업무값 근거가 있는 항목(호출자가 넘긴 known: 서비스 명세 필드·
   건수·상태 코드)은 바꾸지 않고 `ambiguous_short_matches`만 센다. 근거가 없는 항목(unknown)에서 나타나면
   `unverified_short_matches`를 세고 값을 바꾸지 않은 채 저장을 보류한다(RedactionError). 부분 문자열은 해당 없다.
"""
import json
import re
import urllib.parse
import xml.etree.ElementTree as ET
from functools import lru_cache

MARKER = '[REDACTED]'
# 짧은 문자열은 거래 필드와 겹칠 수 있어 이름·값의 문맥을 함께 확인한다.
DISTINCTIVE_LENGTH = 12

AUTH_FIELDS = frozenset({'servicekey', 'apikey', 'appkey', 'authkey', 'oc', 'authorization',
                         'clientid', 'clientsecret', 'xncpapigwapikey', 'xncpapigwapikeyid'})
MESSAGE_FIELDS = frozenset({'message', 'msg', 'errmsg', 'errormsg', 'errormessage', 'returnauthmsg', 'resultmsg',
                            'reason', 'detail', 'details', 'error', 'errordescription', 'errordetail', 'faultstring'})


class RedactionError(ValueError):
    """안전한 저장 사본을 만들 수 없을 때. 메시지는 원문 값을 담지 않는 사유 코드, stats는 값 없는 건수다."""

    def __init__(self, code, stats=None):
        super().__init__(code)
        self.stats = stats


def field_role(name):
    if not isinstance(name, str):
        return 'data'
    normalized = re.sub(r'[-_\s]', '', name.split('}')[-1].split(':')[-1]).lower()
    if normalized in AUTH_FIELDS:
        return 'auth'
    return 'message' if normalized in MESSAGE_FIELDS else 'data'


_NOT_MARKER = r'(?!\[REDACTED\])'
_QUERY_NAMES = r'service_?key|api_?key|app_?key|auth_?key|client_?secret|client_?id|oc'
_HEADER_NAMES = r'authorization|x-ncp-apigw-api-key-id|x-ncp-apigw-api-key'
_SCHEMES = r'(?:kakaoak|bearer|basic|token)\s+'
# (패턴, 남길 앞부분 그룹, 남길 뒷부분 그룹). 모든 패턴은 이미 가린 값을 다시 일치시키지 않는다.
_SYNTAX_RULES = [
    (re.compile(r'(?<![0-9a-z_\-])(?P<name>' + _HEADER_NAMES + r')(?P<sep>["\']?\s*[:=]\s*["\']?)(?!(?:' + _SCHEMES
                + r')?\[REDACTED\])(?P<scheme>' + _SCHEMES + r')?(?P<value>[^\s"\'<>&,;]+)', re.I), ('name', 'sep', 'scheme'), ()),
    (re.compile(r'(?<![0-9A-Za-z_])(?P<scheme>KakaoAK\s+)' + _NOT_MARKER + r'(?P<value>[^\s"\'<>&,;]+)'), ('scheme',), ()),
    (re.compile(r'(?P<lead>(?P<q>["\'])(?:' + _QUERY_NAMES + '|' + _HEADER_NAMES + r')(?P=q)\s*:\s*(?P<vq>["\']))'
                + _NOT_MARKER + r'(?P<value>(?:\\.|(?!(?P=vq)).)+)(?P=vq)', re.I | re.S), ('lead',), ('vq',)),
    (re.compile(r'(?P<lead><(?P<tag>(?:[\w.\-]+:)?(?:' + _QUERY_NAMES + '|' + _HEADER_NAMES + r'))(?:\s[^<>]*)?>)'
                + _NOT_MARKER + r'(?P<value>[^<]+)(?P<end></(?P=tag)\s*>)', re.I), ('lead',), ('end',)),
    (re.compile(r'(?:(?<=%26)|(?<=%3f)|(?<![0-9a-z_.\-]))(?P<name>' + _QUERY_NAMES + r')(?P<sep>=|%3d)'
                + _NOT_MARKER + r'(?P<value>(?:\\/|(?!%26)[^&#\s"\'<>\\,;)\]])+)', re.I), ('name', 'sep'), ()),
]
_MARKER_ONLY = re.compile(r'\s*(?:\[REDACTED\]\s*)+')
# 표준 파서가 구조에서 버리는 주석·처리 명령·DOCTYPE. XML 선언(<?xml …?>)은 고정 문법이라 제외한다.
_XML_HIDDEN = re.compile(r'<!--(.*?)-->|<\?(?!xml[\s?])(.*?)\?>|<!DOCTYPE(.*?)>', re.S)


def _ci_hex(digits):
    return ''.join('[%s%s]' % (d.upper(), d.lower()) if d.isalpha() else d for d in digits)


def _char_pattern(char):
    """한 글자의 원문·퍼센트(이중) 인코딩·JSON `\\uXXXX`·XML 문자 참조 형태를 모두 일치시킨다."""
    code, data = ord(char), char.encode('utf-8')
    options = {re.escape(char), ''.join('%' + _ci_hex('%02X' % b) for b in data),
               '&#0*%d;' % code, '&#[xX]0*' + _ci_hex('%X' % code) + ';'}
    if not (char.isascii() and char.isalnum()):
        options.add(''.join('%25' + _ci_hex('%02X' % b) for b in data))
    if code <= 0xFFFF:
        options.add(r'\\u' + _ci_hex('%04X' % code))
    named = {'&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos'}
    if char in named:
        options.add('&' + named[char] + ';')
    if char in '/"\\':
        options.add(r'\\' + re.escape(char))
    return '(?:' + '|'.join(sorted(options, key=len, reverse=True)) + ')'


def _compile(secrets, bounded):
    if not secrets:
        return None
    body = '|'.join(''.join(map(_char_pattern, s)) for s in sorted(secrets, key=len, reverse=True))
    return re.compile(r'(?<![0-9A-Za-z])(?:' + body + r')(?![0-9A-Za-z])' if bounded else '(?:' + body + ')')


def new_stats():
    return {'changed_values': 0, 'ambiguous_short_matches': 0, 'unverified_short_matches': 0}


def _local_name(name):
    return name.split('}')[-1].split(':')[-1] if isinstance(name, str) else None


class Redactor:
    def __init__(self, secrets=()):
        strong, weak = set(), set()
        for secret in secrets:
            decoded = urllib.parse.unquote(secret)
            (strong if len(decoded) >= DISTINCTIVE_LENGTH else weak).update({secret, decoded})
        self.strong, self.weak = _compile(strong, False), _compile(weak, True)

    @staticmethod
    def _role(name, known):
        """known이 주어지면(공급자 문서) 일반 항목을 근거 있는 known과 근거 없는 unknown으로 나눈다."""
        role = field_role(name)
        if role != 'data' or known is None:
            return role
        return 'known' if _local_name(name) in known else 'unknown'

    def redact_string(self, text, role, stats):
        if role == 'auth':
            if text.strip() and not _MARKER_ONLY.fullmatch(text):
                stats['changed_values'] += 1
                return MARKER
            return text
        count = 0
        for pattern, head, tail in _SYNTAX_RULES:
            text, n = pattern.subn(lambda m, head=head, tail=tail: ''.join(m.group(g) or '' for g in head)
                                   + MARKER + ''.join(m.group(g) for g in tail), text)
            count += n
        if self.strong:
            text, n = self.strong.subn(MARKER, text)
            count += n
        if self.weak:
            if role in ('message', 'free'):
                text, n = self.weak.subn(MARKER, text)
                count += n
            elif self.weak.search(text):
                counter = 'unverified_short_matches' if role == 'unknown' else 'ambiguous_short_matches'
                stats[counter] += 1
        stats['changed_values'] += bool(count)
        return text

    def redact_value(self, value, role='data', stats=None, strict=False, known=None):
        """해석된 JSON 구조를 복사하며 문자열 값만 정제한다. 키·숫자·불리언·null은 그대로다.

        strict는 도구가 만드는 결과·파생 JSON용이다. 키에 반향이 있는 항목은 버리고 숫자 반향은 가린다.
        known은 공급자 문서용 정상 업무 항목 이름 집합이다(규칙 4).
        """
        stats = new_stats() if stats is None else stats
        if isinstance(value, dict):
            out = {}
            for k, v in value.items():
                if strict and isinstance(k, str) and self.find_echo(k):
                    stats['changed_values'] += 1
                    continue
                out[k] = self.redact_value(v, 'auth' if role == 'auth' else self._role(k, known), stats, strict, known)
            return out
        if isinstance(value, (list, tuple)):
            return [self.redact_value(v, role, stats, strict, known) for v in value]
        if isinstance(value, str):
            return self.redact_string(value, role, stats)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            if role == 'auth' or (strict and self.strong and self.strong.search(str(value))):
                stats['changed_values'] += 1
                return MARKER
            if role == 'unknown' and self.weak and self.weak.fullmatch(str(value)):
                stats['unverified_short_matches'] += 1
        return value

    def redact_element(self, element, parent_role, stats, known=None):
        """XML 요소의 텍스트·꼬리 텍스트·속성값을 제자리에서 정제한다. 태그·속성 이름은 그대로다."""
        role = 'auth' if parent_role == 'auth' else self._role(element.tag, known)
        for name, value in list(element.attrib.items()):
            element.set(name, self.redact_string(value, 'auth' if role == 'auth' else self._role(name, known), stats))
        if element.text:
            element.text = self.redact_string(element.text, role, stats)
        for child in element:
            self.redact_element(child, role, stats, known)
            if child.tail:
                child.tail = self.redact_string(child.tail, role, stats)

    def find_echo(self, text):
        """원문 어디든(키·태그·숫자·주석 포함) 긴 인증값이나 가리지 않은 인증 문법 값이 있는지 본다."""
        return bool(self.strong and self.strong.search(text)) or any(p.search(text) for p, _, _ in _SYNTAX_RULES)

    def redact_document(self, text, fmt, stats, known=frozenset()):
        """유효한 JSON/XML 원문의 저장용 텍스트. 바꿀 값이 없으면 원문 그대로, 있으면 정제 구조의 직렬화다.

        known은 정상 업무값 근거가 있는 항목 이름이다. 기본값(빈 집합)은 모든 일반 항목을 근거 없음으로 본다.
        """
        known = frozenset(known)
        local = new_stats()
        if fmt == 'json':
            duplicate_keys = False

            def read_object(pairs):
                nonlocal duplicate_keys
                obj = dict(pairs)
                if len(obj) != len(pairs):
                    duplicate_keys = True
                return obj

            tree = json.loads(text, object_pairs_hook=read_object)
            names = _json_keys(tree)
            safe = self.redact_value(tree, 'unknown', local, known=known)
            # 중복 키는 파서가 앞 값을 버려 검사할 수 없으므로 해석 결과대로 다시 직렬화한다.
            rewrite = local['changed_values'] or duplicate_keys or self.find_echo(text)
            safe_text = _json_text(safe) if rewrite else text
        elif fmt == 'xml':
            root = ET.fromstring(text)
            # 네임스페이스 URI를 포함한 태그와 속성 이름. 바꾸면 구조가 달라지므로 반향이 있으면 저장하지 않는다.
            names = [n for e in root.iter() for n in [e.tag, *e.attrib]]
            self.redact_element(root, 'unknown', local, known)
            hidden = self.weak and any(self.weak.search(''.join(g or '' for g in m.groups()))
                                       for m in _XML_HIDDEN.finditer(text))
            # 직렬화 사본에는 표준 파서가 버리는 주석·처리 명령·DOCTYPE이 남지 않는다.
            rewrite = local['changed_values'] or hidden or self.find_echo(text)
            safe_text = ET.tostring(root, encoding='unicode') if rewrite else text
        else:
            raise RedactionError('unsupported_format')
        for key in stats:
            stats[key] += local[key]
        if local['unverified_short_matches']:
            # 근거 없는 항목의 짧은 인증값 일치는 반향과 구분할 수 없으므로 값을 바꾸지 않고 저장을 보류한다.
            raise RedactionError('unverified_short_credential_match', dict(stats))
        # 이스케이프된 키·이름은 원문 텍스트에 그대로 보이지 않아도 parsed 사본에서 복원되므로 해석된 이름도 본다.
        if any(isinstance(n, str) and self.find_echo(n) for n in names):
            raise RedactionError('residual_credential', dict(stats))
        if rewrite and self.find_echo(safe_text):
            raise RedactionError('residual_credential', dict(stats))  # 키·태그·숫자·네임스페이스 등 구조 위치의 반향
        return safe_text

    def redact_text(self, value, stats=None):
        """로그용 문자열. 유효한 JSON/XML이면 구조 정제를, 아니면 자유 텍스트 규칙을 적용한다."""
        stats = new_stats() if stats is None else stats
        text = str(value)
        head = text.lstrip()
        fmt = 'json' if head.startswith(('{', '[')) else 'xml' if head.startswith('<') else None
        if fmt:
            try:
                return self.redact_document(text, fmt, stats)
            except (ValueError, SyntaxError, RecursionError):
                pass  # 해석 불가(ET.ParseError는 SyntaxError)·구조 위치 반향은 자유 텍스트 규칙으로 가린다.
        return self.redact_string(text, 'free', stats)


def _json_keys(value):
    """중복으로 버려진 키를 제외한 해석 결과의 모든 객체 키."""
    stack, names = [value], []
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            names.extend(item)
            stack.extend(item.values())
        elif isinstance(item, list):
            stack.extend(item)
    return names


def _json_text(value):
    text = json.dumps(value, ensure_ascii=False)
    try:
        text.encode('utf-8')
    except UnicodeEncodeError:  # 원문의 짝 없는 \uD800 같은 이스케이프는 ASCII 이스케이프로 유지한다.
        text = json.dumps(value)
    return text


def same_structure(original, redacted):
    """정제 사본이 원문 해석과 같은 키·순서·길이·비문자 값을 갖고, 바뀐 문자열에는 표시가 있는지 본다."""
    if isinstance(original, dict):
        return (isinstance(redacted, dict) and list(original) == list(redacted)
                and all(same_structure(original[k], redacted[k]) for k in original))
    if isinstance(original, list):
        return (isinstance(redacted, list) and len(original) == len(redacted)
                and all(same_structure(a, b) for a, b in zip(original, redacted)))
    if isinstance(original, str):
        return isinstance(redacted, str) and (original == redacted or MARKER in redacted)
    if redacted == MARKER and isinstance(original, (int, float)) and not isinstance(original, bool):
        return True  # 인증 항목의 숫자 값
    return type(original) is type(redacted) and (original == redacted or (original != original and redacted != redacted))


@lru_cache(maxsize=16)
def _cached(secrets):
    return Redactor(secrets)


def redactor_for(keys):
    return _cached(tuple(sorted({str(v) for v in (keys or {}).values() if v is not None and str(v).strip()})))


def redact_structure(value, keys, stats=None):
    """결과·요약·정규화 등 도구가 만드는 JSON의 저장·출력 사본(strict)."""
    return redactor_for(keys).redact_value(value, 'data', stats, strict=True)


def redact_text(value, keys, stats=None):
    return redactor_for(keys).redact_text(value, stats)


def error_diagnostic(exc):
    """자유 형식 오류 문장은 URL·헤더를 담을 수 있으므로 형식 이름과 errno만 남긴다."""
    name, reason = type(exc).__name__, getattr(exc, 'reason', None)
    source = exc
    if isinstance(reason, BaseException):
        name, source = name + '(' + type(reason).__name__ + ')', reason
    errno = getattr(source, 'errno', None)
    return name + (' errno=%d' % errno if isinstance(errno, int) else '')
