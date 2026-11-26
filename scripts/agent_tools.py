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
