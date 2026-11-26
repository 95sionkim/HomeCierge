"""에이전트 도구 계약(JSON 스키마), LLM 출처 권한 필터링, 읽기·제안 초안 도구 구현.

제안 도구는 조건 초안 값만 생성하며, 최종 검증과 저장은 DB 함수가 수행한다.
"""
import copy
import re
from datetime import date
from decimal import Decimal


ALLOWED_TRADE_KINDS = ('sale', 'presale_right', 'occupancy_right')
MAX_AREA_TOLERANCE = Decimal('5')
MAX_COMPARABLES = 5
MAX_COMPLEX_ID_LENGTH = 120
ALWAYS_LLM_DENIED_SOURCES = frozenset({'naver_news', 'user_upload', 'upload'})

REASON_DESCRIPTIONS = {
    'target_supply_area_unverified': '선택한 주택형의 공급면적을 공고문에서 확인해야 합니다.',
    'trade_supply_area_unverified': '거래 당시 주택형의 공급면적을 확인해야 합니다.',
    'trade_link_unverified': '거래를 해당 단지·주택형에 연결할 근거가 부족합니다.',
    'comparison_evidence_unverified': '주변 거래의 단지와 주택형을 연결할 근거가 부족합니다.',
    'trade_region_membership_unverified': '거래가 속한 법정동·읍·면을 확인해야 합니다.',
    'contract_period_unverified': '계약 기간이 확정되지 않았습니다.',
    'no_confirmed_room_subtotal': '분양가와 필수 옵션을 함께 확인한 호실이 없습니다.',
    'subtotal_documents_differ': '분양가와 필수 옵션의 문서 판본이 서로 다릅니다.',
    'cancelled_trade': '해제된 거래를 제외했습니다.',
    'outside_contract_period': '계약 기간 밖의 거래를 제외했습니다.',
    'outside_supply_area': '허용 공급면적 범위 밖의 거래를 제외했습니다.',
    'outside_applied_region': '적용 지역 밖의 단지여서 비교표에 넣을 수 없습니다.',
    'trade_kind_not_included': '선택한 거래 종류에 해당하는 거래가 없어 비교표에 넣을 수 없습니다.',
    'comparison_conditions_unmet': '현재 비교 기준을 충족한 거래가 없어 비교표에 넣을 수 없습니다.',
    'candidate_unverified': '근거가 확인되지 않아 비교표에 넣을 수 없습니다.',
    'replacement_target_required': '교체할 기존 비교 단지를 지정해야 합니다.',
    'replacement_candidate_ineligible': '요청한 단지가 현재 비교 기준을 통과하지 못해 교체하지 않았습니다.',
    'replacement_request_conflict': '중복되거나 충돌하는 단지 교체 요청을 보류했습니다.',
    'target_complex_trade': '대상 단지 자체 거래는 별도로 표시합니다.',
    'required_options_unverified': '필수 옵션 금액을 확인해야 합니다.',
    'straight_line_distance_unverified': '단지 대표 좌표 근거를 확인해야 합니다.',
}


def parse_iso_date(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def normalize_period(value):
    if not isinstance(value, dict) or set(value.keys()) != {'start', 'end'}:
        return None
    start = parse_iso_date(value.get('start'))
    end = parse_iso_date(value.get('end'))
    if start is None or end is None or start > end:
        return None
    return {'start': start.isoformat(), 'end': end.isoformat()}


def normalize_area_tolerance(value):
    if not isinstance(value, str) or not re.fullmatch(r'(?:0|[1-9][0-9]*)(?:\.[0-9]{1,4})?', value):
        return None
    amount = Decimal(value)
    if amount <= 0 or amount > MAX_AREA_TOLERANCE:
        return None
    text = format(amount, 'f')
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    return text


def normalize_trade_kinds(value):
    if not isinstance(value, list) or not (1 <= len(value) <= 3):
        return None
    seen = set()
    for item in value:
        if not isinstance(item, str) or item not in ALLOWED_TRADE_KINDS or item in seen:
            return None
        seen.add(item)
    return [kind for kind in ALLOWED_TRADE_KINDS if kind in seen]


def _valid_complex_id(value):
    return (
        isinstance(value, str)
        and 1 <= len(value) <= MAX_COMPLEX_ID_LENGTH
        and value == value.strip()
        and not re.search(r'[\x00-\x1f\x7f]', value)
    )


def normalize_replacements(value):
    if not isinstance(value, list) or len(value) > MAX_COMPARABLES:
        return None
    incoming, outgoing = set(), set()
    pairs = []
    for item in value:
        if not isinstance(item, dict) or set(item.keys()) != {'complexId', 'replaceComplexId'}:
            return None
        inc = item.get('complexId')
        out = item.get('replaceComplexId')
        if not _valid_complex_id(inc) or not _valid_complex_id(out) or inc == out:
            return None
        if inc in incoming or out in outgoing:
            return None
        incoming.add(inc)
        outgoing.add(out)
        pairs.append({'complexId': inc, 'replaceComplexId': out})
    if incoming & outgoing:
        return None
    pairs.sort(key=lambda pair: (pair['replaceComplexId'], pair['complexId']))
    return pairs


def _collect_sources_from_comparison(comparison):
    sources = set()
    if not isinstance(comparison, dict):
        return sources

    target = comparison.get('target')
    if isinstance(target, dict):
        ne = target.get('noticeEvidence')
        if isinstance(ne, dict):
            if isinstance(ne.get('source'), str):
                sources.add(ne['source'])
            le = ne.get('linkEvidence')
            if isinstance(le, dict) and isinstance(le.get('source'), str):
                sources.add(le['source'])
        sa = target.get('supplyArea')
        if isinstance(sa, dict) and isinstance(sa.get('evidence'), list) and sa['evidence']:
            sources.add('applyhome_notice_pdf')

    np = comparison.get('noticePrice')
    if isinstance(np, dict) and isinstance(np.get('confirmedRooms'), list) and np['confirmedRooms']:
        sources.add('applyhome_notice_pdf')

    rd = comparison.get('regionDecision')
    if isinstance(rd, dict):
        for scope_key in ('priority', 'expansion'):
            scope = rd.get(scope_key)
            if isinstance(scope, dict):
                ev = scope.get('evidence')
                if isinstance(ev, dict) and isinstance(ev.get('source'), str):
                    sources.add(ev['source'])

    for col in comparison.get('collections') or []:
        if isinstance(col, dict) and isinstance(col.get('source'), str):
            sources.add(col['source'])

    for group_key in ('comparables', 'targetReferences'):
        for comp in comparison.get(group_key) or []:
            if not isinstance(comp, dict):
                continue
            for ev_key in ('identityEvidence', 'regionEvidence'):
                ev = comp.get(ev_key)
                if isinstance(ev, dict) and isinstance(ev.get('source'), str):
                    sources.add(ev['source'])
            dist = comp.get('distance')
            if isinstance(dist, dict):
                for ev in dist.get('evidence') or []:
                    if isinstance(ev, dict) and isinstance(ev.get('source'), str):
                        sources.add(ev['source'])
            stats = comp.get('tradeStats')
            if isinstance(stats, dict):
                for st in stats.values():
                    if not isinstance(st, dict):
                        continue
                    for obs in st.get('observations') or []:
                        if not isinstance(obs, dict):
                            continue
                        if isinstance(obs.get('source'), str):
                            sources.add(obs['source'])
                        ev = obs.get('evidence')
                        if isinstance(ev, dict) and isinstance(ev.get('source'), str):
                            sources.add(ev['source'])
    return sources


def filter_comparison_for_llm(comparison, source_permissions=None):
    """llm_permission = 'allowed'인 출처의 값만 남기고 미허용 출처·지역 뉴스는 제외한다."""
    if not isinstance(comparison, dict):
        return {}, {
            'dataOrigin': 'unknown',
            'allowedSources': [],
            'restrictedSources': [],
            'hasRestrictedSources': False,
            'newsExcluded': True,
        }

    # 지역 뉴스는 약관상 LLM 입력 금지이므로 어떤 경우에도 제거한다.
    filtered = copy.deepcopy(comparison)
    news_stripped = False
    for forbidden_key in ('regionalNews', 'news', 'newsArticles', 'naverNews'):
        if forbidden_key in filtered:
            filtered.pop(forbidden_key, None)
            news_stripped = True

    data_origin = filtered.get('dataOrigin', 'synthetic')
    detected_sources = _collect_sources_from_comparison(filtered)
    if news_stripped:
        detected_sources.add('naver_news')

    if source_permissions is None:
        if data_origin == 'synthetic':
            restricted = sorted(s for s in detected_sources if s in ALWAYS_LLM_DENIED_SOURCES)
            return filtered, {
                'dataOrigin': 'synthetic',
                'allowedSources': [],
                'restrictedSources': restricted,
                'hasRestrictedSources': bool(restricted),
                'newsExcluded': True,
            }
        # 수집 자료인데 권한 맵이 전달되지 않으면 안전 측(전부 미허용)으로 닫는다.
        source_permissions = {}

    perms = dict(source_permissions)
    all_sources = sorted(detected_sources | set(perms.keys()))

    def is_allowed(source_id):
        if not isinstance(source_id, str) or not source_id:
            return False
        if source_id in ALWAYS_LLM_DENIED_SOURCES:
            return False
        return perms.get(source_id) == 'allowed'

    allowed_sources = [s for s in all_sources if is_allowed(s)]
    restricted_sources = [s for s in all_sources if not is_allowed(s)]

    if not restricted_sources:
        return filtered, {
            'dataOrigin': data_origin,
            'allowedSources': allowed_sources,
            'restrictedSources': [],
            'hasRestrictedSources': False,
            'newsExcluded': True,
        }

    # 1) 대상 공고·가격(PDF 및 공고 목록 출처 권한 점검)
    pdf_allowed = is_allowed('applyhome_notice_pdf')
    target = filtered.get('target')
    if isinstance(target, dict):
        ne = target.get('noticeEvidence')
        notice_src = ne.get('source') if isinstance(ne, dict) else None
        if notice_src and not is_allowed(notice_src):
            target['name'] = None
            target['houseManageNo'] = None
            target['noticeNo'] = None
            target['noticeEvidence'] = {'status': 'restricted_for_llm'}
        elif isinstance(ne, dict) and isinstance(ne.get('linkEvidence'), dict):
            if not is_allowed(ne['linkEvidence'].get('source')):
                ne['linkEvidence'] = {'status': 'restricted_for_llm'}
        if not pdf_allowed and isinstance(target.get('supplyArea'), dict):
            target['supplyArea'] = {
                'status': 'restricted_for_llm',
                'basis': 'supply',
                'm2': None,
                'reasons': ['source_llm_permission_not_allowed'],
            }
            if isinstance(filtered.get('conditions'), dict):
                filtered['conditions']['area'] = None

    if not pdf_allowed and isinstance(filtered.get('noticePrice'), dict):
        filtered['noticePrice'] = {
            'status': 'restricted_for_llm',
            'reasons': ['source_llm_permission_not_allowed'],
        }

    # 2) 지역 결정 근거
    rd = filtered.get('regionDecision')
    if isinstance(rd, dict):
        for scope_key in ('priority', 'expansion'):
            scope = rd.get(scope_key)
            if isinstance(scope, dict):
                ev = scope.get('evidence')
                if isinstance(ev, dict) and not is_allowed(ev.get('source')):
                    scope['name'] = None
                    scope['code'] = None
                    scope['requestRegionCodes'] = []
                    scope['evidence'] = {'status': 'restricted_for_llm'}
                    scope['restrictedForLlm'] = True

    # 3) 수집 기록
    if isinstance(filtered.get('collections'), list):
        filtered['collections'] = [
            c for c in filtered['collections']
            if isinstance(c, dict) and is_allowed(c.get('source'))
        ]

    # 4) 비교 단지 및 대상 단지 자체 거래
    for group_key in ('comparables', 'targetReferences'):
        raw_list = filtered.get(group_key)
        if not isinstance(raw_list, list):
            continue
        kept = []
        for comp in raw_list:
            if not isinstance(comp, dict):
                continue
            item = copy.deepcopy(comp)
            id_src = (item.get('identityEvidence') or {}).get('source') if isinstance(item.get('identityEvidence'), dict) else None
            reg_src = (item.get('regionEvidence') or {}).get('source') if isinstance(item.get('regionEvidence'), dict) else None
            id_ok = (id_src is None) or is_allowed(id_src)
            if not id_ok:
                item['name'] = None
                item['identityEvidence'] = {'status': 'restricted_for_llm'}
            if reg_src and not is_allowed(reg_src):
                item['localityCode'] = None
                item['regionEvidence'] = {'status': 'restricted_for_llm'}
            dist = item.get('distance')
            if isinstance(dist, dict):
                evs = dist.get('evidence') or []
                if any(isinstance(e, dict) and not is_allowed(e.get('source')) for e in evs):
                    item['distance'] = {'kind': dist.get('kind', 'straight_line'), 'status': 'restricted_for_llm'}

            stats = item.get('tradeStats')
            allowed_stats = {}
            area_allowed = True
            if isinstance(stats, dict):
                for kind, st in stats.items():
                    if not isinstance(st, dict):
                        continue
                    obs_list = st.get('observations') or []
                    if not obs_list:
                        continue
                    obs_sources_ok = all(
                        isinstance(o, dict)
                        and is_allowed(o.get('source'))
                        and (not isinstance(o.get('evidence'), dict) or is_allowed(o['evidence'].get('source')))
                        for o in obs_list
                    )
                    if obs_sources_ok:
                        allowed_stats[kind] = st
                    else:
                        if any(isinstance(o, dict) and isinstance(o.get('evidence'), dict)
                               and not is_allowed(o['evidence'].get('source')) for o in obs_list):
                            area_allowed = False
            if not area_allowed:
                item['supplyAreaM2'] = None
                item['areaDifferenceM2'] = None
            item['tradeStats'] = allowed_stats
            if id_ok and allowed_stats:
                kept.append(item)
        filtered[group_key] = kept

    # 5) 후보 풀은 관련 출처 중 미허용이 있으면 비워 둔다.
    if isinstance(filtered.get('candidatePool'), list) and restricted_sources:
        filtered['candidatePool'] = []

    return filtered, {
        'dataOrigin': data_origin,
        'allowedSources': allowed_sources,
        'restrictedSources': restricted_sources,
        'hasRestrictedSources': True,
        'newsExcluded': True,
    }


TOOL_SCHEMAS = [
    {
        'type': 'function',
        'name': 'read_comparison_summary',
        'description': '권한이 확인된 비교 결과의 요약(적용 범위, 조건, 공고 가격, 비교 단지별 통계, 제한된 출처 여부)을 읽습니다.',
        'strict': True,
        'parameters': {
            'type': 'object',
            'additionalProperties': False,
            'required': ['section'],
            'properties': {
                'section': {
                    'type': 'string',
                    'enum': ['all', 'scope', 'price', 'comparables', 'conditions'],
                },
            },
        },
    },
    {
        'type': 'function',
        'name': 'explain_holds',
        'description': '비교 결과의 보류(holds)·제외(exclusions) 사유와 확인이 필요한 항목을 구조화해 읽습니다.',
        'strict': True,
        'parameters': {
            'type': 'object',
            'additionalProperties': False,
            'required': ['includeExclusions'],
            'properties': {
                'includeExclusions': {'type': 'boolean'},
            },
        },
    },
    {
        'type': 'function',
        'name': 'propose_period_change',
        'description': '계약 기간 변경 제안 초안을 만듭니다. 검증과 저장·승인은 서버와 사용자가 처리합니다.',
        'strict': True,
        'parameters': {
            'type': 'object',
            'additionalProperties': False,
            'required': ['start', 'end'],
            'properties': {
                'start': {'type': 'string', 'description': '시작일 YYYY-MM-DD'},
                'end': {'type': 'string', 'description': '종료일 YYYY-MM-DD'},
            },
        },
    },
    {
        'type': 'function',
        'name': 'propose_condition_change',
        'description': '공급면적 허용 범위·거래 종류·단지 교체·계약 기간 변경 제안 초안을 만듭니다. 검증과 저장·승인은 서버와 사용자가 처리합니다.',
        'strict': True,
        'parameters': {
            'type': 'object',
            'additionalProperties': False,
            'required': ['period', 'areaTolerancePercent', 'tradeKinds', 'replacements'],
            'properties': {
                'period': {
                    'anyOf': [
                        {'type': 'null'},
                        {
                            'type': 'object',
                            'additionalProperties': False,
                            'required': ['start', 'end'],
                            'properties': {
                                'start': {'type': 'string'},
                                'end': {'type': 'string'},
                            },
                        },
                    ]
                },
                'areaTolerancePercent': {
                    'anyOf': [
                        {'type': 'null'},
                        {'type': 'string'},
                    ]
                },
                'tradeKinds': {
                    'anyOf': [
                        {'type': 'null'},
                        {
                            'type': 'array',
                            'items': {
                                'type': 'string',
                                'enum': list(ALLOWED_TRADE_KINDS),
                            },
                        },
                    ]
                },
                'replacements': {
                    'anyOf': [
                        {'type': 'null'},
                        {
                            'type': 'array',
                            'items': {
                                'type': 'object',
                                'additionalProperties': False,
                                'required': ['complexId', 'replaceComplexId'],
                                'properties': {
                                    'complexId': {'type': 'string'},
                                    'replaceComplexId': {'type': 'string'},
                                },
                            },
                        },
                    ]
                },
            },
        },
    },
]


def get_tool_schemas():
    return copy.deepcopy(TOOL_SCHEMAS)


def _tool_read_comparison_summary(arguments, context):
    section = arguments.get('section', 'all')
    if section not in ('all', 'scope', 'price', 'comparables', 'conditions'):
        return {'ok': False, 'error': 'invalid_section'}
    comp = context.get('comparison') if isinstance(context.get('comparison'), dict) else {}
    policy = context.get('llmSourcePolicy') if isinstance(context.get('llmSourcePolicy'), dict) else {}
    summary = {
        'ok': True,
        'completeness': comp.get('completeness'),
        'appliedScope': comp.get('appliedScope'),
        'rankingComplete': comp.get('rankingComplete'),
        'llmSourcePolicy': policy,
    }
    if section in ('all', 'scope'):
        summary['regionDecision'] = comp.get('regionDecision')
    if section in ('all', 'conditions'):
        summary['conditions'] = comp.get('conditions')
        summary['conditionBounds'] = context.get('conditionBounds')
    if section in ('all', 'price'):
        summary['target'] = comp.get('target')
        summary['noticePrice'] = comp.get('noticePrice')
    if section in ('all', 'comparables'):
        summary['comparables'] = comp.get('comparables', [])
        summary['targetReferences'] = comp.get('targetReferences', [])
        summary['tradeKinds'] = comp.get('tradeKinds', {})
    return summary


def _tool_explain_holds(arguments, context):
    include_exclusions = bool(arguments.get('includeExclusions', True))
    comp = context.get('comparison') if isinstance(context.get('comparison'), dict) else {}
    holds = comp.get('holds') if isinstance(comp.get('holds'), list) else []
    exclusions = comp.get('exclusions') if isinstance(comp.get('exclusions'), list) else []
    hold_items = [
        {
            'reasonCode': h.get('reasonCode'),
            'description': REASON_DESCRIPTIONS.get(h.get('reasonCode'), '추가 근거 확인이 필요합니다.'),
            'scope': h.get('scope'),
            'subject': h.get('subject'),
        }
        for h in holds if isinstance(h, dict)
    ]
    exclusion_items = []
    if include_exclusions:
        exclusion_items = [
            {
                'reasonCode': e.get('reasonCode'),
                'description': REASON_DESCRIPTIONS.get(e.get('reasonCode'), '비교 기준에 맞지 않아 제외했습니다.'),
                'scope': e.get('scope'),
                'tradeKind': e.get('tradeKind'),
            }
            for e in exclusions if isinstance(e, dict)
        ]
    return {
        'ok': True,
        'completeness': comp.get('completeness'),
        'rankingComplete': comp.get('rankingComplete'),
        'holdCount': len(hold_items),
        'holds': hold_items,
        'exclusionCount': len(exclusions),
        'exclusions': exclusion_items,
        'llmSourcePolicy': context.get('llmSourcePolicy'),
    }


def _tool_propose_period_change(arguments, context):
    period = normalize_period({'start': arguments.get('start'), 'end': arguments.get('end')})
    if period is None:
        return {'ok': False, 'error': 'invalid_period_format'}
    bounds = context.get('conditionBounds') if isinstance(context.get('conditionBounds'), dict) else {}
    p_bounds = bounds.get('period') if isinstance(bounds.get('period'), dict) else None
    if p_bounds:
        b_start = parse_iso_date(p_bounds.get('start'))
        b_end = parse_iso_date(p_bounds.get('end'))
        if b_start and b_end and (period['start'] < b_start.isoformat() or period['end'] > b_end.isoformat()):
            return {'ok': False, 'error': 'period_outside_collected_bounds', 'allowedBounds': p_bounds}
    return {
        'ok': True,
        'draft': {
            'kind': 'period',
            'period': period,
            'areaTolerancePercent': None,
            'tradeKinds': None,
            'replacements': None,
        },
        'serverValidationRequired': True,
        'approvalRequired': True,
        'sharedProfileUnchanged': True,
    }


def _tool_propose_condition_change(arguments, context):
    draft = {
        'kind': 'conditions',
        'period': None,
        'areaTolerancePercent': None,
        'tradeKinds': None,
        'replacements': None,
    }
    has_any = False
    if arguments.get('period') is not None:
        p = normalize_period(arguments['period'])
        if p is None:
            return {'ok': False, 'error': 'invalid_period_format'}
        draft['period'] = p
        has_any = True
    if arguments.get('areaTolerancePercent') is not None:
        tol = normalize_area_tolerance(arguments['areaTolerancePercent'])
        if tol is None:
            return {'ok': False, 'error': 'invalid_area_tolerance'}
        draft['areaTolerancePercent'] = tol
        has_any = True
    if arguments.get('tradeKinds') is not None:
        kinds = normalize_trade_kinds(arguments['tradeKinds'])
        if kinds is None:
            return {'ok': False, 'error': 'invalid_trade_kinds'}
        draft['tradeKinds'] = kinds
        has_any = True
    if arguments.get('replacements') is not None:
        reps = normalize_replacements(arguments['replacements'])
        if reps is None:
            return {'ok': False, 'error': 'invalid_replacements'}
        draft['replacements'] = reps
        has_any = True
    if not has_any:
        return {'ok': False, 'error': 'empty_condition_proposal'}
    return {
        'ok': True,
        'draft': draft,
        'serverValidationRequired': True,
        'approvalRequired': True,
        'sharedProfileUnchanged': True,
    }


_TOOL_HANDLERS = {
    'read_comparison_summary': _tool_read_comparison_summary,
    'explain_holds': _tool_explain_holds,
    'propose_period_change': _tool_propose_period_change,
    'propose_condition_change': _tool_propose_condition_change,
}


def execute_tool(name, arguments, context):
    handler = _TOOL_HANDLERS.get(name)
    if handler is None:
        return {'ok': False, 'error': 'unknown_tool'}
    if not isinstance(arguments, dict):
        return {'ok': False, 'error': 'invalid_arguments'}
    return handler(arguments, context if isinstance(context, dict) else {})


# ── 채팅 홈(S-01) 총괄 에이전트 도구·지역 검증·조건 정규화 ────────────────────────

REGION_CODE_RE = re.compile(r'^[0-9]{5}$')
WON_INT_RE = re.compile(r'^(?:0|[1-9][0-9]{0,19})$')
POSITIVE_AREA_RE = re.compile(r'^(?:[1-9][0-9]*(?:\.[0-9]+)?|0\.[0-9]*[1-9][0-9]*)$')
MONTH_RE = re.compile(r'^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])$')
CHAT_PROFILE_KEYS = (
    'region_codes',
    'budget_max_won',
    'supply_area_min_m2',
    'supply_area_max_m2',
    'move_in_start_month',
    'move_in_end_month',
)

_PROVINCE_ALIASES = {
    '서울': '서울특별시',
    '서울시': '서울특별시',
    '부산': '부산광역시',
    '부산시': '부산광역시',
    '대구': '대구광역시',
    '대구시': '대구광역시',
    '인천': '인천광역시',
    '인천시': '인천광역시',
    '광주': '광주광역시',
    '광주시': '광주광역시',
    '대전': '대전광역시',
    '대전시': '대전광역시',
    '울산': '울산광역시',
    '울산시': '울산광역시',
    '세종': '세종특별자치시',
    '세종시': '세종특별자치시',
    '경기': '경기도',
    '강원': '강원특별자치도',
    '강원도': '강원특별자치도',
    '충북': '충청북도',
    '충남': '충청남도',
    '전북': '전북특별자치도',
    '전라북도': '전북특별자치도',
    '전남': '전라남도',
    '경북': '경상북도',
    '경남': '경상남도',
    '제주': '제주특별자치도',
    '제주도': '제주특별자치도',
}

_TRAILING_REGION_PARTICLES_RE = re.compile(r'(?:에서|쪽|근처|주변|일대|이랑|랑|하고|와|과)$')


def _trim_decimal_str(value):
    text = format(value, 'f')
    if '.' in text:
        text = text.rstrip('0').rstrip('.')
    return text


def normalize_won_text(value):
    """정수 원 문자열이나 한국어 금액 표현(예: '7억', '7억 5천만 원', '6.5억')을 정확한 원 단위 정수 문자열로 변환한다."""
    if type(value) is int and 0 <= value <= 99_999_999_999_999_999_999:
        return str(value)
    if not isinstance(value, str):
        return None
    raw = re.sub(r'\s+', ' ', value.strip()).replace(',', '')
    if not raw:
        return None
    plain = raw[:-1].strip() if raw.endswith('원') else raw
    if WON_INT_RE.fullmatch(plain):
        return plain

    # X억 Y천만 / X억 Y만 / X억 / Y천만 / Y만
    m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*억(?:\s*(\d+)\s*천\s*만?)?(?:\s*(\d+(?:\.\d+)?)\s*만)?', plain)
    if m:
        total = Decimal(m.group(1)) * Decimal('100000000')
        if m.group(2):
            total += Decimal(m.group(2)) * Decimal('10000000')
        if m.group(3):
            total += Decimal(m.group(3)) * Decimal('10000')
        if total >= 0 and total == int(total):
            result = str(int(total))
            return result if WON_INT_RE.fullmatch(result) else None
        return None

    m = re.fullmatch(r'(\d+)\s*천\s*만?', plain)
    if m:
        total = Decimal(m.group(1)) * Decimal('10000000')
        result = str(int(total))
        return result if WON_INT_RE.fullmatch(result) else None

    m = re.fullmatch(r'(\d+(?:\.\d+)?)\s*만', plain)
    if m:
        total = Decimal(m.group(1)) * Decimal('10000')
        if total >= 0 and total == int(total):
            result = str(int(total))
            return result if WON_INT_RE.fullmatch(result) else None
        return None

    return None


def normalize_area_value(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        value = str(value)
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    if not cleaned or len(cleaned) > 24 or not POSITIVE_AREA_RE.fullmatch(cleaned):
        return None
    dec = Decimal(cleaned)
    if dec <= 0:
        return None
    return _trim_decimal_str(dec)


def normalize_supply_area_range(min_val, max_val, unit='m2'):
    if unit not in ('m2', 'pyeong'):
        return None
    low = normalize_area_value(min_val)
    high = normalize_area_value(max_val)
    if low is None or high is None or Decimal(low) > Decimal(high):
        return None
    return {'min': low, 'max': high, 'unit': unit}


def normalize_move_in_range(start_month, end_month):
    if not isinstance(start_month, str) or not isinstance(end_month, str):
        return None
    s = start_month.strip()
    e = end_month.strip()
    if not MONTH_RE.fullmatch(s) or not MONTH_RE.fullmatch(e) or s > e:
        return None
    return {'start': s, 'end': e}


def _clean_region_query(raw):
    text = re.sub(r'\s+', ' ', raw.strip())
    text = _TRAILING_REGION_PARTICLES_RE.sub('', text).strip()
    if not text:
        return ''
    tokens = text.split(' ')
    if tokens[0] in _PROVINCE_ALIASES:
        tokens[0] = _PROVINCE_ALIASES[tokens[0]]
    return ' '.join(tokens)


def resolve_official_regions(region_queries, regions_catalog):
    """공식 지역 목록(5자리 코드·명칭)에서만 지역을 해석한다. 모호하거나 없는 지역은 코드를 지어내지 않는다."""
    catalog = [
        {'code': item['code'], 'name': item.get('name')}
        for item in (regions_catalog or [])
        if isinstance(item, dict) and isinstance(item.get('code'), str) and REGION_CODE_RE.fullmatch(item['code'])
    ]
    if not catalog:
        return {
            'catalogAvailable': False,
            'resolved': [],
            'ambiguous': [],
            'unknown': [q for q in (region_queries or []) if isinstance(q, str) and q.strip()],
        }

    by_code = {entry['code']: entry for entry in catalog}
    resolved_by_code = {}
    ambiguous = []
    unknown = []

    for raw in region_queries or []:
        if not isinstance(raw, str):
            continue
        trimmed = raw.strip()
        if not trimmed:
            continue
        if REGION_CODE_RE.fullmatch(trimmed):
            entry = by_code.get(trimmed)
            if entry:
                resolved_by_code[entry['code']] = {'code': entry['code'], 'name': entry['name'], 'query': trimmed}
            else:
                unknown.append(trimmed)
            continue

        cleaned = _clean_region_query(trimmed)
        if not cleaned:
            continue
        compact_query = re.sub(r'\s+', '', cleaned)
        query_tokens = cleaned.split(' ')

        exact_matches = []
        suffix_matches = []
        for entry in catalog:
            name = entry.get('name')
            if not isinstance(name, str) or not name.strip():
                continue
            norm_name = re.sub(r'\s+', ' ', name.strip())
            if norm_name == cleaned or re.sub(r'\s+', '', norm_name) == compact_query:
                exact_matches.append(entry)
                continue
            name_tokens = norm_name.split(' ')
            if len(query_tokens) <= len(name_tokens) and name_tokens[-len(query_tokens):] == query_tokens:
                suffix_matches.append(entry)

        candidates = exact_matches if exact_matches else suffix_matches
        if len(candidates) == 1:
            entry = candidates[0]
            resolved_by_code[entry['code']] = {'code': entry['code'], 'name': entry['name'], 'query': trimmed}
        elif len(candidates) > 1:
            ambiguous.append({
                'query': trimmed,
                'candidates': [
                    {'code': c['code'], 'name': c['name']}
                    for c in sorted(candidates, key=lambda item: item['code'])
                ],
            })
        else:
            unknown.append(trimmed)

    resolved = [resolved_by_code[code] for code in sorted(resolved_by_code.keys())]
    return {
        'catalogAvailable': True,
        'resolved': resolved,
        'ambiguous': ambiguous,
        'unknown': unknown,
    }


def normalize_chat_search_proposal(raw, regions_catalog):
    """탐색 조건 제안 객체를 공식 지역 목록·원 단위 예산·선택 조건 규칙에 따라 정규화한다."""
    if not isinstance(raw, dict):
        return None, ['invalid_search_proposal']
    allowed = {'regionCodes', 'budgetMaxWon', 'supplyArea', 'moveIn', 'includeClosed'}
    if not set(raw.keys()).issubset(allowed):
        return None, ['invalid_search_proposal_keys']

    raw_codes = raw.get('regionCodes')
    if not isinstance(raw_codes, list) or not (1 <= len(raw_codes) <= 50):
        return None, ['missing_required_region_codes']

    catalog_codes = {
        item['code']
        for item in (regions_catalog or [])
        if isinstance(item, dict) and isinstance(item.get('code'), str) and REGION_CODE_RE.fullmatch(item['code'])
    }
    if not catalog_codes:
        return None, ['region_catalog_unavailable']

    seen = set()
    for code in raw_codes:
        if not isinstance(code, str) or not REGION_CODE_RE.fullmatch(code) or code in seen:
            return None, ['invalid_region_code']
        if code not in catalog_codes:
            return None, ['unverified_region_code']
        seen.add(code)

    budget = normalize_won_text(raw.get('budgetMaxWon'))
    if budget is None:
        return None, ['invalid_budget_max_won']

    include_closed = raw.get('includeClosed', False)
    if type(include_closed) is not bool:
        return None, ['invalid_include_closed']

    normalized = {
        'regionCodes': sorted(seen),
        'budgetMaxWon': budget,
        'includeClosed': include_closed,
    }

    if raw.get('supplyArea') is not None:
        sa = raw['supplyArea']
        if not isinstance(sa, dict) or set(sa.keys()) != {'min', 'max', 'unit'}:
            return None, ['invalid_supply_area']
        area = normalize_supply_area_range(sa.get('min'), sa.get('max'), sa.get('unit'))
        if area is None:
            return None, ['invalid_supply_area']
        normalized['supplyArea'] = area

    if raw.get('moveIn') is not None:
        mi = raw['moveIn']
        if not isinstance(mi, dict) or set(mi.keys()) != {'start', 'end'}:
            return None, ['invalid_move_in']
        move_in = normalize_move_in_range(mi.get('start'), mi.get('end'))
        if move_in is None:
            return None, ['invalid_move_in']
        normalized['moveIn'] = move_in

    return normalized, []


def normalize_chat_profile_proposal(raw, regions_catalog, current_conditions=None):
    """공유 프로필 변경안을 DB 패치 형식으로 정규화하고 6개 키·쌍 정합성·공식 지역 코드를 검증한다."""
    if not isinstance(raw, dict):
        return None, ['invalid_profile_proposal']

    reason = raw.get('reason')
    if not isinstance(reason, str) or re.search(r'[\x00-\x1f\x7f]', reason):
        return None, ['invalid_profile_reason']
    clean_reason = reason.strip()
    if not (1 <= len(clean_reason) <= 200):
        return None, ['invalid_profile_reason']

    patch = {}
    if 'patch' in raw and isinstance(raw.get('patch'), dict):
        raw_patch = raw['patch']
        if not raw_patch or not set(raw_patch.keys()).issubset(set(CHAT_PROFILE_KEYS)):
            return None, ['invalid_profile_patch']
        patch = copy.deepcopy(raw_patch)
    elif 'set' in raw and 'clear' in raw:
        raw_set = raw.get('set')
        raw_clear = raw.get('clear')
        if not isinstance(raw_set, dict) or not isinstance(raw_clear, list):
            return None, ['invalid_profile_patch']
        if not set(raw_set.keys()).issubset(set(CHAT_PROFILE_KEYS)):
            return None, ['invalid_profile_patch']
        clear_keys = set()
        for key in raw_clear:
            if not isinstance(key, str) or key not in CHAT_PROFILE_KEYS or key in clear_keys:
                return None, ['invalid_profile_patch']
            clear_keys.add(key)
        for key, val in raw_set.items():
            if val is not None:
                if key in clear_keys:
                    return None, ['conflicting_profile_patch_keys']
                patch[key] = val
        for key in clear_keys:
            patch[key] = None
        if not patch:
            return None, ['empty_profile_patch']
    else:
        return None, ['invalid_profile_patch']

    catalog_codes = {
        item['code']
        for item in (regions_catalog or [])
        if isinstance(item, dict) and isinstance(item.get('code'), str) and REGION_CODE_RE.fullmatch(item['code'])
    }
    normalized_patch = {}
    if 'region_codes' in patch:
        val = patch['region_codes']
        if val is None:
            normalized_patch['region_codes'] = None
        else:
            if not isinstance(val, list) or not (1 <= len(val) <= 50) or not catalog_codes:
                return None, ['invalid_profile_region_codes']
            seen = set()
            for code in val:
                if not isinstance(code, str) or not REGION_CODE_RE.fullmatch(code) or code in seen or code not in catalog_codes:
                    return None, ['invalid_profile_region_codes']
                seen.add(code)
            normalized_patch['region_codes'] = sorted(seen)

    if 'budget_max_won' in patch:
        val = patch['budget_max_won']
        if val is None:
            normalized_patch['budget_max_won'] = None
        else:
            won = normalize_won_text(val)
            if won is None:
                return None, ['invalid_profile_budget']
            normalized_patch['budget_max_won'] = won

    for key in ('supply_area_min_m2', 'supply_area_max_m2'):
        if key in patch:
            val = patch[key]
            if val is None:
                normalized_patch[key] = None
            else:
                area = normalize_area_value(val)
                if area is None:
                    return None, ['invalid_profile_area']
                normalized_patch[key] = area

    for key in ('move_in_start_month', 'move_in_end_month'):
        if key in patch:
            val = patch[key]
            if val is None:
                normalized_patch[key] = None
            else:
                if not isinstance(val, str) or not MONTH_RE.fullmatch(val.strip()):
                    return None, ['invalid_profile_move_in']
                normalized_patch[key] = val.strip()

    # 현재 공유 프로필과 합쳐 쌍(min/max, start/end)과 실질 변경 여부를 확인한다.
    base = dict(current_conditions) if isinstance(current_conditions, dict) else {}
    merged = dict(base)
    changed = False
    for key, val in normalized_patch.items():
        if val is None:
            if key in merged and merged[key] is not None:
                merged.pop(key, None)
                changed = True
        else:
            old_val = base.get(key)
            if key in ('supply_area_min_m2', 'supply_area_max_m2'):
                old_norm = normalize_area_value(old_val) if old_val is not None else None
                if old_norm != val:
                    changed = True
            elif key == 'region_codes':
                old_sorted = sorted(set(old_val)) if isinstance(old_val, list) else None
                if old_sorted != val:
                    changed = True
            else:
                if str(old_val) != str(val) if old_val is not None else True:
                    changed = True
            merged[key] = val

    if current_conditions is not None and not changed:
        return None, ['profile_proposal_unchanged']

    has_min = merged.get('supply_area_min_m2') is not None
    has_max = merged.get('supply_area_max_m2') is not None
    if has_min != has_max:
        return None, ['invalid_profile_area_pair']
    if has_min and Decimal(normalize_area_value(merged['supply_area_min_m2'])) > Decimal(normalize_area_value(merged['supply_area_max_m2'])):
        return None, ['invalid_profile_area_pair']

    has_start = merged.get('move_in_start_month') is not None
    has_end = merged.get('move_in_end_month') is not None
    if has_start != has_end:
        return None, ['invalid_profile_move_in_pair']
    if has_start and str(merged['move_in_start_month']) > str(merged['move_in_end_month']):
        return None, ['invalid_profile_move_in_pair']

    return {'patch': normalized_patch, 'reason': clean_reason}, []


def _compute_application_status(notice, as_of):
    if not isinstance(as_of, str) or not parse_iso_date(as_of):
        return 'unknown'
    app = notice.get('application')
    if not isinstance(app, dict):
        return 'unknown'
    start = app.get('start')
    end = app.get('end')
    if not isinstance(start, str) or not isinstance(end, str):
        return 'unknown'
    if as_of < start:
        return 'upcoming'
    if as_of > end:
        return 'closed'
    segments = notice.get('applicationSegments')
    if isinstance(segments, list) and segments:
        if any(isinstance(seg, dict) and isinstance(seg.get('start'), str) and isinstance(seg.get('end'), str)
               and seg['start'] <= as_of <= seg['end'] for seg in segments):
            return 'open'
        return 'unknown'
    return 'open'


CHAT_TOOL_SCHEMAS = [
    {
        'type': 'function',
        'name': 'lookup_notices',
        'description': '권한이 허용된 게시 공고 목록에서 공고명 또는 공고번호로 회차를 구분해 찾습니다. 같은 이름의 다른 회차는 합치지 않습니다.',
        'strict': True,
        'parameters': {
            'type': 'object',
            'additionalProperties': False,
            'required': ['query', 'mode'],
            'properties': {
                'query': {'type': 'string', 'description': '공고명 또는 1~10자리 공고번호/주택관리번호'},
                'mode': {'type': 'string', 'enum': ['auto', 'name', 'number']},
            },
        },
    },
    {
        'type': 'function',
        'name': 'extract_search_conditions',
        'description': '사용자 말에서 희망 지역(공식 5자리 코드)·최대 예산(원)·선택 공급면적·입주 시기를 추출·검증합니다. 검색을 실행하지 않고 확인 카드용 초안 또는 확인 질문을 반환합니다.',
        'strict': True,
        'parameters': {
            'type': 'object',
            'additionalProperties': False,
            'required': [
                'regionQueries', 'budgetMaxWon', 'supplyAreaMin', 'supplyAreaMax',
                'supplyAreaUnit', 'areaBasis', 'moveInStart', 'moveInEnd', 'includeClosed',
            ],
            'properties': {
                'regionQueries': {
                    'type': 'array',
                    'items': {'type': 'string'},
                    'description': '사용자가 언급한 시·군·구 이름 또는 5자리 지역 코드 목록',
                },
                'budgetMaxWon': {
                    'anyOf': [{'type': 'null'}, {'type': 'string'}],
                    'description': '최대 예산(원 단위 정수 문자열 또는 한국어 금액 표현). 없으면 null',
                },
                'supplyAreaMin': {'anyOf': [{'type': 'null'}, {'type': 'string'}]},
                'supplyAreaMax': {'anyOf': [{'type': 'null'}, {'type': 'string'}]},
                'supplyAreaUnit': {'anyOf': [{'type': 'null'}, {'type': 'string', 'enum': ['m2', 'pyeong']}]},
                'areaBasis': {'type': 'string', 'enum': ['supply', 'exclusive', 'unspecified']},
                'moveInStart': {'anyOf': [{'type': 'null'}, {'type': 'string'}], 'description': 'YYYY-MM 또는 null'},
                'moveInEnd': {'anyOf': [{'type': 'null'}, {'type': 'string'}], 'description': 'YYYY-MM 또는 null'},
                'includeClosed': {'type': 'boolean'},
            },
        },
    },
    {
        'type': 'function',
        'name': 'propose_shared_profile_change',
        'description': '다음 검색에도 재사용할 공유 프로필 변경안 초안을 검증합니다. 승인·반영은 O-3에서 사용자가 직접 결정합니다.',
        'strict': True,
        'parameters': {
            'type': 'object',
            'additionalProperties': False,
            'required': [
                'regionQueries', 'budgetMaxWon', 'supplyAreaMinM2', 'supplyAreaMaxM2',
                'moveInStartMonth', 'moveInEndMonth', 'clearKeys', 'reason',
            ],
            'properties': {
                'regionQueries': {
                    'anyOf': [{'type': 'null'}, {'type': 'array', 'items': {'type': 'string'}}],
                },
                'budgetMaxWon': {'anyOf': [{'type': 'null'}, {'type': 'string'}]},
                'supplyAreaMinM2': {'anyOf': [{'type': 'null'}, {'type': 'string'}]},
                'supplyAreaMaxM2': {'anyOf': [{'type': 'null'}, {'type': 'string'}]},
                'moveInStartMonth': {'anyOf': [{'type': 'null'}, {'type': 'string'}]},
                'moveInEndMonth': {'anyOf': [{'type': 'null'}, {'type': 'string'}]},
                'clearKeys': {
                    'type': 'array',
                    'items': {'type': 'string', 'enum': list(CHAT_PROFILE_KEYS)},
                },
                'reason': {'type': 'string'},
            },
        },
    },
    {
        'type': 'function',
        'name': 'describe_service_capabilities',
        'description': 'HomeCierge의 지원 기능과 금지·제한 범위를 사실 기준으로 읽습니다.',
        'strict': True,
        'parameters': {
            'type': 'object',
            'additionalProperties': False,
            'required': ['topic'],
            'properties': {
                'topic': {
                    'type': 'string',
                    'enum': ['overview', 'search', 'lookup', 'profile', 'pdf_guide', 'limits'],
                },
            },
        },
    },
]


def get_chat_tool_schemas():
    return copy.deepcopy(CHAT_TOOL_SCHEMAS)


def _tool_lookup_notices(arguments, context):
    raw_query = arguments.get('query')
    mode = arguments.get('mode', 'auto')
    if not isinstance(raw_query, str) or not raw_query.strip() or len(raw_query.strip()) > 120:
        return {'ok': False, 'error': 'invalid_lookup_query'}
    if mode not in ('auto', 'name', 'number'):
        return {'ok': False, 'error': 'invalid_lookup_mode'}

    directory = context.get('directoryIndex')
    policy = context.get('llmSourcePolicy') if isinstance(context.get('llmSourcePolicy'), dict) else {}
    if not isinstance(directory, dict) or not isinstance(directory.get('notices'), list):
        return {'ok': False, 'error': 'directory_unavailable', 'llmSourcePolicy': policy}

    trimmed = re.sub(r'\s+', ' ', raw_query.strip())
    digits = re.sub(r'[\s-]+', '', trimmed)
    if mode == 'number' or (mode == 'auto' and re.fullmatch(r'[0-9]{4,10}', digits)):
        if not re.fullmatch(r'[0-9]{1,10}', digits):
            return {'ok': False, 'error': 'invalid_lookup_number'}
        resolved_mode = 'number'
        normalized = digits
    else:
        resolved_mode = 'name'
        normalized = trimmed

    compact_needle = re.sub(r'\s+', '', normalized).lower()
    matched = []
    for notice in directory['notices']:
        if not isinstance(notice, dict) or notice.get('kind') == 'unsupported':
            continue
        if resolved_mode == 'number':
            n_no = str(notice.get('noticeNo') or '')
            hm_no = str(notice.get('houseManageNo') or '')
            hit = (n_no == normalized or hm_no == normalized) if len(normalized) == 10 else (normalized in n_no or normalized in hm_no)
            if hit:
                matched.append(notice)
        else:
            title = notice.get('title')
            if isinstance(title, str) and compact_needle in re.sub(r'\s+', '', title).lower():
                matched.append(notice)

    title_counts = {}
    for notice in matched:
        title = notice.get('title')
        if isinstance(title, str) and title.strip():
            key = title.strip()
            title_counts[key] = title_counts.get(key, 0) + 1
    same_title_groups = sum(1 for count in title_counts.values() if count > 1)

    as_of = context.get('asOf')
    projected = []
    for notice in matched:
        title = notice.get('title')
        projected.append({
            'houseManageNo': notice.get('houseManageNo'),
            'noticeNo': notice.get('noticeNo'),
            'edition': notice.get('edition'),
            'title': title,
            'kind': notice.get('kind'),
            'regionCode': notice.get('regionCode'),
            'regionName': notice.get('regionName'),
            'application': notice.get('application'),
            'applicationStatus': _compute_application_status(notice, as_of),
            'modelCount': len(notice.get('models') or []),
            'sameTitleCount': title_counts.get(title.strip(), 1) if isinstance(title, str) and title.strip() else 1,
        })

    projected.sort(
        key=lambda item: (
            0 if (resolved_mode == 'number' and (item['noticeNo'] == normalized or item['houseManageNo'] == normalized)) else 1,
            -(int(item['edition'].replace('-', '')) if isinstance(item.get('edition'), str) and parse_iso_date(item['edition']) else 0),
            str(item.get('houseManageNo') or ''),
            str(item.get('noticeNo') or ''),
        )
    )

    coverage = directory.get('coverage') if isinstance(directory.get('coverage'), dict) else {}
    coverage_complete = coverage.get('status') == 'complete'
    return {
        'ok': True,
        'query': {'query': normalized, 'mode': resolved_mode},
        'asOf': as_of,
        'observedAt': directory.get('observedAt'),
        'publicationWindow': directory.get('publicationWindow'),
        'coverage': coverage,
        'confirmedZero': len(matched) == 0 and coverage_complete,
        'counts': {
            'matched': len(matched),
            'returned': min(len(projected), 15),
            'sameTitleGroups': same_title_groups,
        },
        'notices': projected[:15],
        'llmSourcePolicy': policy,
    }


def _tool_extract_search_conditions(arguments, context):
    regions_catalog = context.get('regions') if isinstance(context.get('regions'), list) else []
    region_queries = arguments.get('regionQueries') if isinstance(arguments.get('regionQueries'), list) else []
    region_resolution = resolve_official_regions(region_queries, regions_catalog)

    raw_budget = arguments.get('budgetMaxWon')
    budget_won = normalize_won_text(raw_budget) if raw_budget is not None else None
    budget_invalid = raw_budget is not None and budget_won is None

    area_basis = arguments.get('areaBasis', 'unspecified')
    area_basis_conflict = area_basis == 'exclusive'
    raw_min = arguments.get('supplyAreaMin')
    raw_max = arguments.get('supplyAreaMax')
    raw_unit = arguments.get('supplyAreaUnit') or 'm2'
    supply_area = None
    area_invalid = False
    if raw_min is not None or raw_max is not None:
        if not area_basis_conflict:
            low = raw_min if raw_min is not None else raw_max
            high = raw_max if raw_max is not None else raw_min
            supply_area = normalize_supply_area_range(low, high, raw_unit)
            if supply_area is None:
                area_invalid = True

    raw_start = arguments.get('moveInStart')
    raw_end = arguments.get('moveInEnd')
    move_in = None
    move_in_invalid = False
    if raw_start is not None or raw_end is not None:
        s = raw_start if raw_start is not None else raw_end
        e = raw_end if raw_end is not None else raw_start
        move_in = normalize_move_in_range(s, e)
        if move_in is None:
            move_in_invalid = True

    include_closed = bool(arguments.get('includeClosed', False))
    missing_required = []
    if not region_resolution['resolved'] and not region_resolution['ambiguous'] and not region_resolution['unknown']:
        missing_required.append('regionCodes')
    if budget_won is None and not budget_invalid:
        missing_required.append('budgetMaxWon')

    errors = []
    if not region_resolution['catalogAvailable']:
        errors.append('region_catalog_unavailable')
    if region_resolution['ambiguous']:
        errors.append('ambiguous_region')
    if region_resolution['unknown']:
        errors.append('unknown_region')
    if budget_invalid:
        errors.append('invalid_budget')
    if area_basis_conflict:
        errors.append('exclusive_area_not_mixed_with_supply_area')
    if area_invalid:
        errors.append('invalid_supply_area')
    if move_in_invalid:
        errors.append('invalid_move_in')
    if missing_required:
        errors.append('missing_required_conditions')

    if errors:
        return {
            'ok': False,
            'status': 'clarify',
            'errors': errors,
            'resolvedRegions': region_resolution['resolved'],
            'ambiguousRegions': region_resolution['ambiguous'],
            'unknownRegions': region_resolution['unknown'],
            'missingRequired': missing_required,
            'areaBasisConflict': area_basis_conflict,
            'parsedBudgetMaxWon': budget_won,
            'parsedSupplyArea': supply_area,
            'parsedMoveIn': move_in,
            'searchExecuted': False,
            'requiresUserConfirmation': True,
        }

    proposal = {
        'regionCodes': [r['code'] for r in region_resolution['resolved']],
        'budgetMaxWon': budget_won,
        'supplyArea': supply_area,
        'moveIn': move_in,
        'includeClosed': include_closed,
    }
    return {
        'ok': True,
        'status': 'ready_to_confirm',
        'searchProposal': proposal,
        'resolvedRegions': region_resolution['resolved'],
        'searchExecuted': False,
        'requiresUserConfirmation': True,
    }


def _tool_propose_shared_profile_change(arguments, context):
    regions_catalog = context.get('regions') if isinstance(context.get('regions'), list) else []
    shared_profile = context.get('sharedProfile') if isinstance(context.get('sharedProfile'), dict) else {}
    current_conditions = shared_profile.get('conditions') if isinstance(shared_profile.get('conditions'), dict) else {}

    resolved_regions = []
    region_codes = None
    if arguments.get('regionQueries') is not None:
        resolution = resolve_official_regions(arguments['regionQueries'], regions_catalog)
        if not resolution['catalogAvailable'] or resolution['ambiguous'] or resolution['unknown'] or not resolution['resolved']:
            return {
                'ok': False,
                'status': 'clarify',
                'errors': ['region_resolution_required'],
                'resolvedRegions': resolution['resolved'],
                'ambiguousRegions': resolution['ambiguous'],
                'unknownRegions': resolution['unknown'],
                'approvalRequired': True,
                'approvalLocation': 'O-3',
                'autoApproved': False,
            }
        resolved_regions = resolution['resolved']
        region_codes = [r['code'] for r in resolved_regions]

    raw_budget = arguments.get('budgetMaxWon')
    budget_won = normalize_won_text(raw_budget) if raw_budget is not None else None
    if raw_budget is not None and budget_won is None:
        return {'ok': False, 'status': 'clarify', 'errors': ['invalid_budget'], 'approvalRequired': True, 'autoApproved': False}

    schema_draft = {
        'set': {
            'region_codes': region_codes,
            'budget_max_won': budget_won,
            'supply_area_min_m2': arguments.get('supplyAreaMinM2'),
            'supply_area_max_m2': arguments.get('supplyAreaMaxM2'),
            'move_in_start_month': arguments.get('moveInStartMonth'),
            'move_in_end_month': arguments.get('moveInEndMonth'),
        },
        'clear': list(arguments.get('clearKeys') or []),
        'reason': arguments.get('reason') or '채팅에서 요청한 공유 프로필 탐색 조건 변경안',
    }
    normalized, errors = normalize_chat_profile_proposal(schema_draft, regions_catalog, current_conditions)
    if errors:
        return {
            'ok': False,
            'status': 'clarify',
            'errors': errors,
            'currentConditions': current_conditions,
            'approvalRequired': True,
            'approvalLocation': 'O-3',
            'autoApproved': False,
        }

    # 스키마 출력용 정규화 형태도 함께 반환한다.
    norm_patch = normalized['patch']
    return {
        'ok': True,
        'status': 'ready_for_o3',
        'draft': {
            'set': {k: norm_patch.get(k) if norm_patch.get(k) is not None else None for k in CHAT_PROFILE_KEYS},
            'clear': [k for k, v in norm_patch.items() if v is None],
            'reason': normalized['reason'],
        },
        'patch': norm_patch,
        'resolvedRegions': resolved_regions,
        'currentConditions': current_conditions,
        'approvalRequired': True,
        'approvalLocation': 'O-3',
        'autoApproved': False,
    }


def _tool_describe_service_capabilities(arguments, context):
    topic = arguments.get('topic', 'overview')
    return {
        'ok': True,
        'topic': topic,
        'capabilities': {
            'noticeLookup': '공고명이나 10자리 공고번호로 게시된 공유 색인에서 회차를 구별해 찾고 주택형을 선택해 분석을 시작할 수 있습니다.',
            'customSearch': '희망 시·군·구(필수)와 최대 예산(필수, 분양가+필수 옵션 기준), 공급면적·입주 시기(선택)를 확인 카드로 확인한 뒤 맞춤 검색을 실행합니다.',
            'sharedProfile': '공유 프로필 변경은 승인 대기 변경안으로 생성되며, 사용자가 O-3(공유 프로필 변경 검토)에서 직접 승인해야 반영됩니다.',
            'pdfSupplement': '공고와 주택형을 선택해 분석 화면을 연 뒤 공고 PDF를 올려 누락된 분양가·필수 옵션 근거를 보완할 수 있습니다.',
        },
        'limits': {
            'noEligibilityJudgment': '개인 청약 자격·가점·당첨 확률·대출 승인은 판정하지 않습니다.',
            'noInvestmentAdvice': '구매 권유, 가격·시세 전망, 수익 예측은 제공하지 않습니다.',
            'supplyAreaBasis': '면적 비교와 맞춤 검색 면적 필터는 공급면적 기준이며 전용면적과 섞지 않습니다.',
            'separateCosts': '분양가+필수 옵션 소계에는 세금과 금융비용이 포함되지 않습니다.',
        },
        'llmSourcePolicy': context.get('llmSourcePolicy'),
    }


_CHAT_TOOL_HANDLERS = {
    'lookup_notices': _tool_lookup_notices,
    'extract_search_conditions': _tool_extract_search_conditions,
    'propose_shared_profile_change': _tool_propose_shared_profile_change,
    'describe_service_capabilities': _tool_describe_service_capabilities,
}


def execute_chat_tool(name, arguments, context):
    handler = _CHAT_TOOL_HANDLERS.get(name)
    if handler is None:
        return {'ok': False, 'error': 'unknown_tool'}
    if not isinstance(arguments, dict):
        return {'ok': False, 'error': 'invalid_arguments'}
    return handler(arguments, context if isinstance(context, dict) else {})
