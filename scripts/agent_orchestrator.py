"""에이전트 턴 실행기(run_turn)와 A-58 근거 일치·금지 표현·제안 형식 검증기."""
import json
import re
from datetime import date
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

if __package__:
    from .agent_llm import LLMBadResponseError, merge_usage_records
    from .agent_prompts import AGENT_TURN_OUTPUT_SCHEMA, ALLOWED_INTENTS, CITATION_KINDS, PROMPT_VERSION, SYSTEM_PROMPT, build_user_input
    from .agent_tools import (
        execute_tool,
        filter_comparison_for_llm,
        get_tool_schemas,
        normalize_area_tolerance,
        normalize_period,
        normalize_replacements,
        normalize_trade_kinds,
        parse_iso_date,
    )
else:
    from agent_llm import LLMBadResponseError, merge_usage_records
    from agent_prompts import AGENT_TURN_OUTPUT_SCHEMA, ALLOWED_INTENTS, CITATION_KINDS, PROMPT_VERSION, SYSTEM_PROMPT, build_user_input
    from agent_tools import (
        execute_tool,
        filter_comparison_for_llm,
        get_tool_schemas,
        normalize_area_tolerance,
        normalize_period,
        normalize_replacements,
        normalize_trade_kinds,
        parse_iso_date,
    )


MAX_ANSWER_CHARS = 2000
MAX_MESSAGE_CHARS = 800

# 구매 권유·수익 예측·개인 자격 판정·승인 사칭·진행 중 허위 표기 금지 패턴
FORBIDDEN_RULES = (
    (
        'forbidden_purchase_recommendation',
        re.compile(
            r'(?:'
            r'(?:매수|청약|구매|신청)\s*(?:을|를)?\s*(?:강력\s*)?(?:추천|권유|권장)(?!\s*하지\s*않)'
            r'|강력\s*추천|적극\s*추천|추천(?:합니다|드립니다|해요)'
            r'|(?:지금\s*)?(?:사세요|매수하세요|청약하세요|신청하세요|사도\s*됩니다)'
            r'|(?:매우|아주|상당히|꽤|비교적)?\s*(?:저렴(?:합니다|해요|한\s*편|한\s*가격)|싸게\s*나왔|쌉니다|싸요)'
            r'|가성비가\s*좋|좋은\s*매수\s*기회|놓치지\s*마세요|꼭\s*(?:청약|신청|매수)'
            r')'
        ),
    ),
    (
        'forbidden_profit_prediction',
        re.compile(
            r'(?:'
            r'시세\s*차익(?!\s*(?:을|를)?\s*(?:예측|보장|판단)하지)'
            r'|안전\s*마진'
            r'|(?:수익|차익)(?:이|을)\s*(?:기대|예상|보장|확정|발생|얻을)'
            r'|(?:가격|집값|시세)(?:이|가)\s*(?:오를|상승할|뛸)'
            r'|상승\s*(?:전망|가능성이\s*높|여력)'
            r'|투자\s*가치가\s*(?:높|좋|있)|예상\s*수익률|로또\s*청약|프리미엄이\s*붙'
            r')'
        ),
    ),
    (
        'forbidden_eligibility_judgment',
        re.compile(
            r'(?:'
            r'(?:청약|특별공급|무주택|1순위|일반공급)\s*자격(?:이|을)\s*(?:충족|갖추|인정|있습니다|됩니다|없습니다)'
            r'|(?:청약|신청|접수)\s*(?:가능|불가)합니다'
            r'|당첨\s*(?:가능성(?:이)?\s*(?:높|있)|확률|유리합니다)'
            r'|1순위(?:에)?\s*(?:해당합니다|가능합니다)'
            r'|대출\s*(?:승인|한도)(?:이|가)\s*(?:가능합니다|확정|나옵니다)'
            r')'
        ),
    ),
    (
        'forbidden_approval_claim',
        re.compile(
            r'(?:'
            r'공유\s*프로필(?:을|이)\s*(?:변경했|수정했|반영했|업데이트했)'
            r'|조건(?:을|이)\s*자동(?:으로)?\s*(?:변경했|적용했|승인했)'
            r'|(?:제가|에이전트가|AI가)\s*(?:승인했|반영했|적용했)'
            r')'
        ),
    ),
    (
        'forbidden_total_acquisition_cost',
        re.compile(r'총\s*취득\s*비용(?:은|이|으로)\s*[0-9]'),
    ),
    (
        'forbidden_fake_in_progress',
        re.compile(
            r'(?:'
            r'(?:현재|지금)\s*(?:조회|수집|계산|분석|확인)\s*(?:중입니다|하고\s*있습니다)'
            r'|잠시만\s*기다려\s*주세요'
            r')'
        ),
    ),
)

_TEN_THOUSAND = Decimal('10000')
_TEN_MILLION = Decimal('10000000')
_HUNDRED_MILLION = Decimal('100000000')


def _to_decimal(text):
    try:
        return Decimal(str(text).replace(',', ''))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _valid_message(message):
    return (
        isinstance(message, str)
        and 1 <= len(message) <= MAX_MESSAGE_CHARS
        and message == message.strip()
        and not re.search(r'[\x00-\x09\x0b-\x1f\x7f]', message)
    )


def _current_conditions(comparison):
    conds = comparison.get('conditions') if isinstance(comparison.get('conditions'), dict) else {}
    target = comparison.get('target') if isinstance(comparison.get('target'), dict) else {}
    supply = target.get('supplyArea') if isinstance(target.get('supplyArea'), dict) else {}
    area = conds.get('area') if isinstance(conds.get('area'), dict) else {}

    period = None
    raw_period = conds.get('period')
    if isinstance(raw_period, dict) and raw_period.get('status') == 'confirmed':
        period = normalize_period({'start': raw_period.get('start'), 'end': raw_period.get('end')})

    tolerance = None
    if supply.get('status') == 'confirmed' and area.get('basis') == 'supply':
        tolerance = normalize_area_tolerance(area.get('tolerancePercent'))

    trade_kinds = normalize_trade_kinds(conds.get('tradeKinds'))

    replacements = []
    for item in comparison.get('comparables') or []:
        if (isinstance(item, dict) and item.get('selectionReason') == 'manual_replacement'
                and isinstance(item.get('complexId'), str) and isinstance(item.get('replacesComplexId'), str)):
            replacements.append({'complexId': item['complexId'], 'replaceComplexId': item['replacesComplexId']})
    replacements = normalize_replacements(replacements) or []

    return {
        'asOf': conds.get('asOf') if isinstance(conds.get('asOf'), str) else None,
        'period': period,
        'areaTolerancePercent': tolerance,
        'tradeKinds': trade_kinds,
        'replacements': replacements,
        'supplyAreaM2': _to_decimal(supply.get('m2')) if supply.get('status') == 'confirmed' else None,
    }


def _validate_and_normalize_proposal(intent, raw_proposal, context):
    """의도와 제안 객체의 형식·범위·현재 조건 대비 변경 여부를 검증한다."""
    if intent not in ('change_period', 'change_conditions'):
        if raw_proposal is not None:
            return None, ['unexpected_proposal_for_intent']
        return None, []

    if not isinstance(raw_proposal, dict):
        return None, ['missing_proposal']

    comparison = context.get('comparison') if isinstance(context.get('comparison'), dict) else {}
    bounds = context.get('conditionBounds') if isinstance(context.get('conditionBounds'), dict) else {}
    current = _current_conditions(comparison)
    existing_prop = context.get('existingProposal')

    kind = raw_proposal.get('kind')
    if intent == 'change_period':
        if kind != 'period':
            return None, ['invalid_proposal_kind']
        if any(raw_proposal.get(k) is not None for k in ('areaTolerancePercent', 'tradeKinds', 'replacements')):
            return None, ['unexpected_condition_fields_in_period_proposal']
        period = normalize_period(raw_proposal.get('period'))
        if period is None:
            return None, ['invalid_proposal_period']
        if current['asOf'] and period['end'] > current['asOf']:
            return None, ['proposal_period_after_as_of']
        if current['period'] and period == current['period']:
            # 이미 기존 턴에 동일 제안이 붙어 있는 경우가 아니면 동일 기간 제안은 거부한다.
            if not (isinstance(existing_prop, dict)
                    and existing_prop.get('start') == period['start']
                    and existing_prop.get('end') == period['end']):
                return None, ['proposal_unchanged_period']
        p_bounds = bounds.get('period') if isinstance(bounds.get('period'), dict) else None
        if p_bounds:
            if period['start'] < p_bounds.get('start', '') or period['end'] > p_bounds.get('end', ''):
                return None, ['proposal_period_out_of_bounds']
        return {'kind': 'period', 'period': period}, []

    # intent == 'change_conditions'
    if kind != 'conditions':
        return None, ['invalid_proposal_kind']
    patch = {}
    if raw_proposal.get('period') is not None:
        period = normalize_period(raw_proposal['period'])
        if period is None:
            return None, ['invalid_proposal_period']
        if current['asOf'] and period['end'] > current['asOf']:
            return None, ['proposal_period_after_as_of']
        p_bounds = bounds.get('period') if isinstance(bounds.get('period'), dict) else None
        if p_bounds and (period['start'] < p_bounds.get('start', '') or period['end'] > p_bounds.get('end', '')):
            return None, ['proposal_period_out_of_bounds']
        if current['period'] and period == current['period']:
            return None, ['proposal_unchanged_period']
        patch['period'] = period

    if raw_proposal.get('areaTolerancePercent') is not None:
        tol = normalize_area_tolerance(raw_proposal['areaTolerancePercent'])
        if tol is None:
            return None, ['invalid_proposal_area_tolerance']
        if current['areaTolerancePercent'] is None:
            return None, ['proposal_area_unavailable']
        if Decimal(tol) == Decimal(current['areaTolerancePercent']):
            return None, ['proposal_unchanged_area']
        patch['areaTolerancePercent'] = tol

    if raw_proposal.get('tradeKinds') is not None:
        kinds = normalize_trade_kinds(raw_proposal['tradeKinds'])
        if kinds is None:
            return None, ['invalid_proposal_trade_kinds']
        if current['tradeKinds'] is None:
            return None, ['proposal_trade_kinds_unavailable']
        allowed_kinds = bounds.get('tradeKinds') if isinstance(bounds.get('tradeKinds'), list) and bounds.get('tradeKinds') else None
        if allowed_kinds is not None and any(k not in allowed_kinds for k in kinds):
            return None, ['proposal_trade_kinds_out_of_bounds']
        if kinds == current['tradeKinds']:
            return None, ['proposal_unchanged_trade_kinds']
        patch['tradeKinds'] = kinds

    if raw_proposal.get('replacements') is not None:
        reps = normalize_replacements(raw_proposal['replacements'])
        if reps is None:
            return None, ['invalid_proposal_replacements']
        if comparison.get('appliedScope') not in ('priority', 'expansion'):
            return None, ['proposal_replacements_unavailable']
        if reps == current['replacements']:
            return None, ['proposal_unchanged_replacements']
        pool = comparison.get('candidatePool')
        if reps and isinstance(pool, list) and pool:
            pool_by_id = {e['complexId']: e for e in pool if isinstance(e, dict) and isinstance(e.get('complexId'), str)}
            base_slots = set()
            for item in comparison.get('comparables') or []:
                if isinstance(item, dict) and isinstance(item.get('complexId'), str):
                    slot = item.get('replacesComplexId') or item['complexId']
                    base_slots.add(slot)
            for pair in reps:
                if pair['replaceComplexId'] not in base_slots:
                    return None, ['proposal_replacement_target_missing']
                if pair['complexId'] in base_slots:
                    return None, ['proposal_replacement_base_slot_conflict']
                cand = pool_by_id.get(pair['complexId'])
                if not cand or cand.get('eligible') is not True:
                    return None, ['proposal_replacement_ineligible']
        patch['replacements'] = reps

    if not patch:
        return None, ['empty_condition_proposal']
    return {'kind': 'conditions', 'conditions': patch}, []


def _collect_grounding_sets(context, proposal):
    """구조화 결과·조건 경계·검증된 제안에서 허용된 모든 수치·날짜·식별자 집합을 수집한다."""
    comp = context.get('comparison') if isinstance(context.get('comparison'), dict) else {}
    bounds = context.get('conditionBounds') if isinstance(context.get('conditionBounds'), dict) else {}
    existing = context.get('existingProposal')

    dates = set()
    months = set()
    month_days = set()
    amounts_won = set()
    areas_m2 = set()
    percents = set()
    distances_m = set()
    pages = set()
    floors = set()
    ranks = set()
    complex_counts = set()
    room_counts = set()
    trade_item_counts = set()
    page_counts = set()
    max_limits = set()
    identifiers = set()
    durations_months = set()
    durations_days = set()
    durations_years = set()

    def add_date(value):
        d = parse_iso_date(value)
        if d is not None:
            iso = d.isoformat()
            dates.add(iso)
            months.add(iso[:7])
            month_days.add((d.month, d.day))

    def add_period_span(start_str, end_str):
        s = parse_iso_date(start_str)
        e = parse_iso_date(end_str)
        if s is None or e is None or s > e:
            return
        days = (e - s).days + 1
        durations_days.add(days)
        # 1년·월 단위 기간 표현(양 끝 포함 달력 기준) 지원
        for m in (1, 2, 3, 6, 12, 24, 36):
            # 근사 오차 +-3일 내면 해당 개월 기간으로 인정
            if abs(days - round(m * 30.4375)) <= 4:
                durations_months.add(m)
                if m % 12 == 0:
                    durations_years.add(m // 12)

    def add_amount(value):
        dec = _to_decimal(value)
        if dec is not None and dec >= 0:
            amounts_won.add(dec.normalize())

    def add_area(value):
        dec = _to_decimal(value)
        if dec is not None and dec >= 0:
            areas_m2.add(dec.normalize())

    def add_ident(value):
        if isinstance(value, str) and value.strip():
            identifiers.add(value.strip())

    # 1) conditions
    conds = comp.get('conditions') if isinstance(comp.get('conditions'), dict) else {}
    add_date(conds.get('asOf'))
    p = conds.get('period') if isinstance(conds.get('period'), dict) else {}
    add_date(p.get('start'))
    add_date(p.get('end'))
    add_period_span(p.get('start'), p.get('end'))
    for m in p.get('months') or []:
        if isinstance(m, str) and re.fullmatch(r'[0-9]{6}', m):
            months.add(f'{m[:4]}-{m[4:]}')
    area = conds.get('area') if isinstance(conds.get('area'), dict) else {}
    if area.get('tolerancePercent') is not None:
        dec = _to_decimal(area.get('tolerancePercent'))
        if dec is not None:
            percents.add(dec.normalize())
    add_area(area.get('minM2'))
    add_area(area.get('maxM2'))
    if type(conds.get('maxComparables')) is int:
        max_limits.add(conds['maxComparables'])

    # 2) target & noticePrice
    target = comp.get('target') if isinstance(comp.get('target'), dict) else {}
    for k in ('houseManageNo', 'noticeNo', 'edition', 'modelNo', 'houseType', 'complexId', 'name'):
        add_ident(target.get(k))
    sa = target.get('supplyArea') if isinstance(target.get('supplyArea'), dict) else {}
    add_area(sa.get('m2'))
    for ev in sa.get('evidence') or []:
        if isinstance(ev, dict) and type(ev.get('page')) is int:
            pages.add(ev['page'])

    np = comp.get('noticePrice') if isinstance(comp.get('noticePrice'), dict) else {}
    add_ident(np.get('room'))
    for k in ('won', 'minWon', 'maxWon'):
        add_amount(np.get(k))
    confirmed_rooms = np.get('confirmedRooms') if isinstance(np.get('confirmedRooms'), list) else []
    held_rooms = np.get('heldRooms') if isinstance(np.get('heldRooms'), list) else []
    if np.get('status') == 'confirmed':
        room_counts.add(len(confirmed_rooms))
        room_counts.add(len(held_rooms))
        room_counts.add(len(confirmed_rooms) + len(held_rooms))
    for room in confirmed_rooms:
        if not isinstance(room, dict):
            continue
        add_ident(room.get('room'))
        for k in ('salePriceWon', 'requiredOptionsWon', 'subtotalWon'):
            add_amount(room.get(k))
        ev_map = room.get('evidence') if isinstance(room.get('evidence'), dict) else {}
        for ev_list in ev_map.values():
            if isinstance(ev_list, list):
                for ev in ev_list:
                    if isinstance(ev, dict) and type(ev.get('page')) is int:
                        pages.add(ev['page'])
    for room in held_rooms:
        if isinstance(room, dict):
            add_ident(room.get('room'))

    # 3) regionDecision
    rd = comp.get('regionDecision') if isinstance(comp.get('regionDecision'), dict) else {}
    for scope_key in ('priority', 'expansion'):
        scope = rd.get(scope_key)
        if not isinstance(scope, dict):
            continue
        add_ident(scope.get('code'))
        for rcode in scope.get('requestRegionCodes') or []:
            add_ident(rcode)
        if type(scope.get('confirmedCandidateCount')) is int:
            complex_counts.add(scope['confirmedCandidateCount'])
        if type(scope.get('unresolvedRows')) is int:
            trade_item_counts.add(scope['unresolvedRows'])
        for tk in (scope.get('tradeKinds') or {}).values():
            if not isinstance(tk, dict):
                continue
            if type(tk.get('confirmedCandidateCount')) is int:
                complex_counts.add(tk['confirmedCandidateCount'])
            if type(tk.get('displayedCandidateCount')) is int:
                complex_counts.add(tk['displayedCandidateCount'])
            if type(tk.get('unresolvedRows')) is int:
                trade_item_counts.add(tk['unresolvedRows'])

    # 4) comparables & targetReferences
    comparables = comp.get('comparables') if isinstance(comp.get('comparables'), list) else []
    target_refs = comp.get('targetReferences') if isinstance(comp.get('targetReferences'), list) else []
    complex_counts.add(len(comparables))
    if target_refs:
        complex_counts.add(len(target_refs))

    totals_by_kind = {}
    has_small_sample = False
    for group in (comparables, target_refs):
        for item in group:
            if not isinstance(item, dict):
                continue
            add_ident(item.get('complexId'))
            add_ident(item.get('name'))
            add_ident(item.get('localityCode'))
            add_area(item.get('supplyAreaM2'))
            add_area(item.get('areaDifferenceM2'))
            if type(item.get('rank')) is int:
                ranks.add(item['rank'])
            dist = item.get('distance')
            if isinstance(dist, dict) and isinstance(dist.get('meters'), (int, float)):
                meters = Decimal(str(dist['meters']))
                distances_m.add(meters.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))
                distances_m.add(meters.quantize(Decimal('1'), rounding=ROUND_HALF_UP))
                distances_m.add((meters / Decimal('1000')).quantize(Decimal('0.01'), rounding=ROUND_HALF_UP) * Decimal('1000'))
            stats = item.get('tradeStats') if isinstance(item.get('tradeStats'), dict) else {}
            for kind, st in stats.items():
                if not isinstance(st, dict):
                    continue
                if st.get('smallSample') is True:
                    has_small_sample = True
                if type(st.get('count')) is int:
                    trade_item_counts.add(st['count'])
                    if group is comparables:
                        totals_by_kind[kind] = totals_by_kind.get(kind, 0) + st['count']
                for k in ('minWon', 'maxWon', 'medianWon'):
                    add_amount(st.get(k))
                for obs in st.get('observations') or []:
                    if not isinstance(obs, dict):
                        continue
                    add_date(obs.get('contractDate'))
                    add_amount(obs.get('won'))
                    add_area(obs.get('exclusiveAreaM2'))
                    if type(obs.get('page')) is int:
                        pages.add(obs['page'])
                    if isinstance(obs.get('floor'), str) and obs['floor'].isdigit():
                        floors.add(int(obs['floor']))
                    elif type(obs.get('floor')) is int:
                        floors.add(obs['floor'])
                    if isinstance(obs.get('buildYear'), str) and obs['buildYear'].isdigit():
                        identifiers.add(obs['buildYear'])
                    elif type(obs.get('buildYear')) is int:
                        identifiers.add(str(obs['buildYear']))

    for subtotal in totals_by_kind.values():
        trade_item_counts.add(subtotal)
    if totals_by_kind:
        trade_item_counts.add(sum(totals_by_kind.values()))

    # 5) holds, exclusions, collections, candidatePool
    holds = comp.get('holds') if isinstance(comp.get('holds'), list) else []
    exclusions = comp.get('exclusions') if isinstance(comp.get('exclusions'), list) else []
    trade_item_counts.add(len(holds))
    trade_item_counts.add(len(exclusions))
    trade_item_counts.add(len(holds) + len(exclusions))

    for col in comp.get('collections') or []:
        if not isinstance(col, dict):
            continue
        add_ident(col.get('requestRegionCode'))
        m = col.get('month')
        if isinstance(m, str) and re.fullmatch(r'[0-9]{4}-[0-9]{2}', m):
            months.add(m)
        for k in ('reportedTotalCount', 'rowsReceived'):
            if type(col.get(k)) is int:
                trade_item_counts.add(col[k])
        if type(col.get('pagesExpected')) is int:
            page_counts.add(col['pagesExpected'])
            pages.add(col['pagesExpected'])
        for mp in col.get('missingPages') or []:
            if type(mp) is int:
                pages.add(mp)

    for entry in comp.get('candidatePool') or []:
        if not isinstance(entry, dict):
            continue
        add_ident(entry.get('complexId'))
        add_ident(entry.get('name'))
        add_ident(entry.get('localityCode'))
        add_area(entry.get('supplyAreaM2'))
        add_area(entry.get('areaDifferenceM2'))

    # 6) conditionBounds, existingProposal, validated proposal
    pb = bounds.get('period') if isinstance(bounds.get('period'), dict) else None
    if pb:
        add_date(pb.get('start'))
        add_date(pb.get('end'))
        add_date(pb.get('asOf'))

    def add_proposal_values(prop):
        if not isinstance(prop, dict):
            return
        if prop.get('kind') == 'period' and isinstance(prop.get('period'), dict):
            add_date(prop['period'].get('start'))
            add_date(prop['period'].get('end'))
            add_period_span(prop['period'].get('start'), prop['period'].get('end'))
        elif 'start' in prop and 'end' in prop:
            add_date(prop.get('start'))
            add_date(prop.get('end'))
            add_period_span(prop.get('start'), prop.get('end'))
            add_date(prop.get('previousStart'))
            add_date(prop.get('previousEnd'))
        cond_patch = prop.get('conditions') if isinstance(prop.get('conditions'), dict) else prop.get('proposed')
        if isinstance(cond_patch, dict):
            if isinstance(cond_patch.get('period'), dict):
                add_date(cond_patch['period'].get('start'))
                add_date(cond_patch['period'].get('end'))
                add_period_span(cond_patch['period'].get('start'), cond_patch['period'].get('end'))
            if cond_patch.get('areaTolerancePercent') is not None:
                dec = _to_decimal(cond_patch['areaTolerancePercent'])
                if dec is not None:
                    percents.add(dec.normalize())
                    supply_m2 = _to_decimal(sa.get('m2')) if sa.get('status') == 'confirmed' else None
                    if supply_m2 is not None:
                        delta = supply_m2 * dec * Decimal('0.01')
                        add_area(supply_m2 - delta)
                        add_area(supply_m2 + delta)
            for rep in cond_patch.get('replacements') or []:
                if isinstance(rep, dict):
                    add_ident(rep.get('complexId'))
                    add_ident(rep.get('replaceComplexId'))

    add_proposal_values(existing)
    add_proposal_values(proposal)

    return {
        'dates': dates,
        'months': months,
        'monthDays': month_days,
        'amountsWon': amounts_won,
        'areasM2': areas_m2,
        'percents': percents,
        'distancesM': distances_m,
        'pages': pages,
        'floors': floors,
        'ranks': ranks,
        'complexCounts': complex_counts,
        'roomCounts': room_counts,
        'tradeItemCounts': trade_item_counts,
        'pageCounts': page_counts,
        'maxLimits': max_limits,
        'identifiers': identifiers,
        'durationsMonths': durations_months,
        'durationsDays': durations_days,
        'durationsYears': durations_years,
        'hasSmallSample': has_small_sample,
    }


def _check_answer_grounding(answer, grounded):
    """답변 안의 모든 날짜·금액·면적·퍼센트·거리·페이지·건수·숫자가 근거 집합과 일치하는지 검사한다."""
    remaining = answer
    checked = []
    ungrounded = []

    def consume(match):
        return ' ' * (match.end() - match.start())

    # 1) 완전한 날짜 (YYYY-MM-DD, YYYY.MM.DD, YYYY년 M월 D일)
    def check_full_date(match):
        y = int(match.group(1))
        m = int(match.group(2) or match.group(4) or match.group(6))
        d = int(match.group(3) or match.group(5) or match.group(7))
        try:
            iso = date(y, m, d).isoformat()
        except ValueError:
            ungrounded.append(('date', match.group(0)))
            return consume(match)
        checked.append(('date', iso))
        if iso not in grounded['dates']:
            ungrounded.append(('date', iso))
        return consume(match)

    remaining = re.sub(
        r'(?<!\d)(\d{4})(?:-(\d{1,2})-(\d{1,2})|\.(\d{1,2})\.(\d{1,2})\.?|년\s*(\d{1,2})월\s*(\d{1,2})일)(?!\d)',
        check_full_date,
        remaining,
    )

    # 2) 연-월 (YYYY-MM, YYYY.MM, YYYY년 M월)
    def check_ym(match):
        y = int(match.group(1))
        m = int(match.group(2) or match.group(3) or match.group(4))
        if not (1 <= m <= 12):
            ungrounded.append(('month', match.group(0)))
            return consume(match)
        ym = f'{y:04d}-{m:02d}'
        checked.append(('month', ym))
        if ym not in grounded['months']:
            ungrounded.append(('month', ym))
        return consume(match)

    remaining = re.sub(
        r'(?<!\d)(\d{4})(?:-(\d{1,2})|\.(\d{1,2})|년\s*(\d{1,2})월)(?!\d)',
        check_ym,
        remaining,
    )

    # 3) 월-일 (M월 D일)
    def check_md(match):
        m, d = int(match.group(1)), int(match.group(2))
        checked.append(('month_day', f'{m}-{d}'))
        if (m, d) not in grounded['monthDays']:
            ungrounded.append(('month_day', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(?<!\d)(\d{1,2})월\s*(\d{1,2})일', check_md, remaining)

    # 4) 금액: X억 Y천만 원 / X억 Y만 원 / X억 원 / Y천만 원 / Y만 원 / Z원
    def verify_amount(won_dec, raw):
        norm = won_dec.normalize()
        checked.append(('amount', raw))
        if norm not in grounded['amountsWon']:
            ungrounded.append(('amount', raw))

    def check_eok_cheonman(match):
        eok = _to_decimal(match.group(1))
        cm = _to_decimal(match.group(2))
        verify_amount(eok * _HUNDRED_MILLION + cm * _TEN_MILLION, match.group(0))
        return consume(match)

    remaining = re.sub(
        r'(\d+(?:,\d{3})*)\s*억\s*(\d+(?:,\d{3})*)\s*천\s*만\s*원',
        check_eok_cheonman,
        remaining,
    )

    def check_eok_man(match):
        eok = _to_decimal(match.group(1))
        man = _to_decimal(match.group(2))
        verify_amount(eok * _HUNDRED_MILLION + man * _TEN_THOUSAND, match.group(0))
        return consume(match)

    remaining = re.sub(
        r'(\d+(?:,\d{3})*)\s*억\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*만\s*원',
        check_eok_man,
        remaining,
    )

    def check_eok(match):
        eok = _to_decimal(match.group(1))
        verify_amount(eok * _HUNDRED_MILLION, match.group(0))
        return consume(match)

    remaining = re.sub(r'(\d+(?:,\d{3})*(?:\.\d+)?)\s*억\s*원', check_eok, remaining)

    def check_cheonman(match):
        cm = _to_decimal(match.group(1))
        verify_amount(cm * _TEN_MILLION, match.group(0))
        return consume(match)

    remaining = re.sub(r'(\d+(?:,\d{3})*)\s*천\s*만\s*원', check_cheonman, remaining)

    def check_man(match):
        man = _to_decimal(match.group(1))
        verify_amount(man * _TEN_THOUSAND, match.group(0))
        return consume(match)

    remaining = re.sub(r'(\d+(?:,\d{3})*(?:\.\d+)?)\s*만\s*원', check_man, remaining)

    def check_won(match):
        val = _to_decimal(match.group(1))
        verify_amount(val, match.group(0))
        return consume(match)

    remaining = re.sub(r'(\d+(?:,\d{3})*(?:\.\d+)?)\s*원', check_won, remaining)

    # 5) 문맥의 식별자(호실명, 주택형 코드, 공고번호 등)를 경계 일치로 소비한다.
    for ident in sorted(grounded['identifiers'], key=len, reverse=True):
        if re.search(r'\d', ident):
            ident_pattern = re.compile(r'(?<![0-9A-Za-z.,])' + re.escape(ident) + r'(?![0-9A-Za-z.,])')
            if ident_pattern.search(remaining):
                checked.append(('identifier', ident))
                remaining = ident_pattern.sub(consume, remaining)

    # 6) 면적 범위(A~B㎡) 및 단일 면적(A㎡)
    def check_area_range(match):
        a = _to_decimal(match.group(1))
        b = _to_decimal(match.group(2))
        for val, raw in ((a, match.group(1)), (b, match.group(2))):
            checked.append(('area', raw))
            if val is None or val.normalize() not in grounded['areasM2']:
                ungrounded.append(('area', raw))
        return consume(match)

    remaining = re.sub(
        r'(\d+(?:,\d{3})*(?:\.\d+)?)\s*[~–-]\s*(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:㎡|m²|m2|제곱미터)',
        check_area_range,
        remaining,
    )

    def check_area(match):
        val = _to_decimal(match.group(1))
        checked.append(('area', match.group(0)))
        if val is None or val.normalize() not in grounded['areasM2']:
            ungrounded.append(('area', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:㎡|m²|m2|제곱미터)', check_area, remaining)

    # 7) 퍼센트
    def check_percent(match):
        val = _to_decimal(match.group(1))
        checked.append(('percent', match.group(0)))
        if val is None or val.normalize() not in grounded['percents']:
            ungrounded.append(('percent', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(?:±|\+\/-)?\s*(\d+(?:\.\d+)?)\s*(?:%|퍼센트)', check_percent, remaining)

    # 8) 거리 (km / m)
    def check_distance(match):
        val = _to_decimal(match.group(1))
        unit = match.group(2).lower()
        checked.append(('distance', match.group(0)))
        if val is None:
            ungrounded.append(('distance', match.group(0)))
            return consume(match)
        meters = val * Decimal('1000') if unit == 'km' else val
        m2 = meters.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP)
        m0 = meters.quantize(Decimal('1'), rounding=ROUND_HALF_UP)
        if m2 not in grounded['distancesM'] and m0 not in grounded['distancesM']:
            ungrounded.append(('distance', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(\d+(?:,\d{3})*(?:\.\d+)?)\s*(km|m|미터)(?![²2A-Za-z])', check_distance, remaining, flags=re.IGNORECASE)

    # 9) 페이지 (p.4 / 4쪽 / 4페이지)
    def check_page(match):
        val = int(match.group(1) or match.group(2))
        checked.append(('page', match.group(0)))
        if val not in grounded['pages']:
            ungrounded.append(('page', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(?:p\.?\s*(\d+)|(\d+)\s*(?:쪽|페이지))', check_page, remaining, flags=re.IGNORECASE)

    # 10) 층·순위
    def check_floor(match):
        val = int(match.group(1))
        checked.append(('floor', match.group(0)))
        if val not in grounded['floors']:
            ungrounded.append(('floor', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(\d+)\s*층', check_floor, remaining)

    def check_rank(match):
        val = int(match.group(1))
        checked.append(('rank', match.group(0)))
        if val not in grounded['ranks']:
            ungrounded.append(('rank', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(\d+)\s*위', check_rank, remaining)

    # 11) 한도/규칙 표현 (최대 5단지, 1~2건 적은 표본)
    def check_max_limit(match):
        val = int(match.group(1) or match.group(2))
        checked.append(('max_limit', match.group(0)))
        if val not in grounded['maxLimits']:
            ungrounded.append(('max_limit', match.group(0)))
        return consume(match)

    remaining = re.sub(
        r'(?:최대\s*(\d+)\s*(?:개|곳|단지)|(\d+)\s*(?:개|곳|단지)\s*(?:이내|이하|상한))',
        check_max_limit,
        remaining,
    )

    def check_small_sample_rule(match):
        checked.append(('small_sample_rule', match.group(0)))
        if not grounded['hasSmallSample']:
            ungrounded.append(('small_sample_rule', match.group(0)))
        return consume(match)

    remaining = re.sub(r'1\s*[~–-]\s*2\s*건', check_small_sample_rule, remaining)

    # 12) 구분된 건수: 단지(곳/단지 및 "주변 단지 N개"), 호실, 거래/항목(건), 일반(개)
    def check_complex_count(match):
        val = int(match.group(1))
        checked.append(('complex_count', match.group(0)))
        if val not in grounded['complexCounts']:
            ungrounded.append(('complex_count', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(?:주변\s*(?:비교\s*)?단지|비교\s*단지|주변\s*후보|후보)(?:가|는|은|를|을)?\s*(?:정상\s*)?(\d+)\s*개', check_complex_count, remaining)
    remaining = re.sub(r'(\d+)\s*(?:곳|단지)', check_complex_count, remaining)

    def check_room_count(match):
        val = int(match.group(1))
        checked.append(('room_count', match.group(0)))
        if val not in grounded['roomCounts']:
            ungrounded.append(('room_count', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(\d+)\s*(?:개\s*)?호실', check_room_count, remaining)

    def check_trade_count(match):
        val = int(match.group(1))
        checked.append(('trade_count', match.group(0)))
        if val not in grounded['tradeItemCounts']:
            ungrounded.append(('trade_count', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(\d+)\s*건', check_trade_count, remaining)

    def check_generic_count(match):
        val = int(match.group(1))
        checked.append(('count', match.group(0)))
        allowed = grounded['complexCounts'] | grounded['roomCounts'] | grounded['tradeItemCounts'] | grounded['pageCounts']
        if val not in allowed:
            ungrounded.append(('count', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(\d+)\s*개', check_generic_count, remaining)

    # 13) 기간 길이 (N개월 / N일 / N년)
    def check_duration(match):
        val = int(match.group(1))
        unit = match.group(2)
        checked.append(('duration', match.group(0)))
        if unit in ('개월', '달') and val not in grounded['durationsMonths']:
            ungrounded.append(('duration', match.group(0)))
        elif unit == '일' and val not in grounded['durationsDays']:
            ungrounded.append(('duration', match.group(0)))
        elif unit == '년' and val not in grounded['durationsYears']:
            ungrounded.append(('duration', match.group(0)))
        return consume(match)

    remaining = re.sub(r'(\d+)\s*(개월|달|일|년)', check_duration, remaining)

    # 14) 소비되지 않은 나머지 단독 숫자 검사
    all_numeric = (
        {Decimal(n).normalize() for n in (
            grounded['complexCounts'] | grounded['roomCounts'] | grounded['tradeItemCounts']
            | grounded['pages'] | grounded['floors'] | grounded['ranks'] | grounded['maxLimits']
        )}
        | grounded['percents']
        | grounded['areasM2']
        | grounded['amountsWon']
    )
    for match in re.finditer(r'(?<![A-Za-z0-9_])(\d+(?:,\d{3})*(?:\.\d+)?)(?![A-Za-z0-9_])', remaining):
        raw = match.group(1)
        dec = _to_decimal(raw)
        checked.append(('number', raw))
        if dec is None or dec.normalize() not in all_numeric:
            ungrounded.append(('number', raw))

    return checked, ungrounded


def _check_status_consistency(answer, context):
    comp = context.get('comparison') if isinstance(context.get('comparison'), dict) else {}
    holds = comp.get('holds') if isinstance(comp.get('holds'), list) else []
    completeness = comp.get('completeness')
    ranking_complete = comp.get('rankingComplete')
    rd = comp.get('regionDecision') if isinstance(comp.get('regionDecision'), dict) else {}
    scope_name = comp.get('appliedScope')
    scope_obj = rd.get(scope_name) if isinstance(scope_name, str) and isinstance(rd.get(scope_name), dict) else {}
    unresolved = scope_obj.get('unresolvedRows') if isinstance(scope_obj, dict) else 0
    pri_conclusion = (rd.get('priority') or {}).get('conclusion') if isinstance(rd.get('priority'), dict) else None
    exp_conclusion = (rd.get('expansion') or {}).get('conclusion') if isinstance(rd.get('expansion'), dict) else None

    reasons = []
    # 정상 0개가 아닌데 '정상 0건/0개'로 단정하는 설명 차단
    has_any_normal_zero = (pri_conclusion == 'normal_zero' or exp_conclusion == 'normal_zero')
    if not has_any_normal_zero and (holds or completeness != 'complete' or (isinstance(unresolved, int) and unresolved > 0)):
        if re.search(r'정상\s*0\s*(?:건|개)(?!\s*(?:이|가)\s*아니|\s*(?:으로|로)\s*(?:확정|판정|처리)하지)', answer):
            reasons.append('status_false_normal_zero')

    if ranking_complete is False and re.search(r'완전한\s*(?:순위|목록)(?!\s*(?:이|가)\s*아니)', answer):
        reasons.append('status_false_complete_ranking')

    return reasons


def validate_turn_output(raw_output, context):
    """LLM 구조화 출력을 검증한다. 하나라도 실패하면 답변·제안을 버리고 rejected를 반환한다."""
    reasons = []
    forbidden_matches = []
    checked_numbers = []
    ungrounded_tokens = []

    if not isinstance(raw_output, dict):
        return False, {'intent': None, 'proposal': None, 'answer': None, 'citations': []}, {
            'status': 'rejected',
            'reasons': ['invalid_output_structure'],
            'checkedNumbers': [],
            'ungroundedTokens': [],
            'forbiddenMatches': [],
        }

    # 1) 의도 검증
    intent = raw_output.get('intent')
    if not isinstance(intent, str) or intent not in ALLOWED_INTENTS:
        reasons.append('invalid_intent')
        intent = None

    # 2) 답변 문자열 기본 검증
    answer = raw_output.get('answer')
    if (not isinstance(answer, str) or not answer.strip()
            or len(answer.strip()) > MAX_ANSWER_CHARS
            or re.search(r'[\x00-\x09\x0b-\x1f\x7f]', answer)):
        reasons.append('invalid_answer_text')
        answer_clean = ''
    else:
        answer_clean = answer.strip()

    # 3) 인용(citations) 형식 검증
    raw_citations = raw_output.get('citations')
    citations = []
    if not isinstance(raw_citations, list) or len(raw_citations) > 20:
        reasons.append('invalid_citations')
    else:
        for item in raw_citations:
            if (not isinstance(item, dict)
                    or item.get('kind') not in CITATION_KINDS
                    or not isinstance(item.get('reference'), str) or not item['reference'].strip() or len(item['reference']) > 120
                    or not isinstance(item.get('label'), str) or not item['label'].strip() or len(item['label']) > 120):
                reasons.append('invalid_citations')
                break
            citations.append({
                'kind': item['kind'],
                'reference': item['reference'].strip(),
                'label': item['label'].strip(),
            })

    # 4) 제안 형식·범위 검증
    normalized_proposal = None
    if intent is not None:
        normalized_proposal, prop_errors = _validate_and_normalize_proposal(intent, raw_output.get('proposal'), context)
        reasons.extend(prop_errors)

    # 5) 금지 표현 검증
    if answer_clean:
        for code, pattern in FORBIDDEN_RULES:
            match = pattern.search(answer_clean)
            if match:
                reasons.append(code)
                forbidden_matches.append({'code': code, 'text': match.group(0)})

    # 6) 보류/완료 상태 정합성 검증
    if answer_clean:
        reasons.extend(_check_status_consistency(answer_clean, context))

    # 7) 모든 숫자·날짜·건수·금액·면적의 근거 일치 검증 (A-58)
    if answer_clean:
        grounded = _collect_grounding_sets(context, normalized_proposal)
        checked_numbers, ungrounded_tokens = _check_answer_grounding(answer_clean, grounded)
        if ungrounded_tokens:
            categories = sorted({cat for cat, _ in ungrounded_tokens})
            for cat in categories:
                reasons.append('ungrounded_' + cat)

    # 중복 사유 제거(순서 보존)
    dedup_reasons = list(dict.fromkeys(reasons))
    validation = {
        'status': 'passed' if not dedup_reasons else 'rejected',
        'reasons': dedup_reasons,
        'checkedNumbers': [{'kind': k, 'value': v} for k, v in checked_numbers],
        'ungroundedTokens': [{'kind': k, 'value': v} for k, v in ungrounded_tokens],
        'forbiddenMatches': forbidden_matches,
    }
    if dedup_reasons:
        # 검증 실패 시 LLM 답변과 제안 초안을 모두 버린다.
        return False, {'intent': None, 'proposal': None, 'answer': None, 'citations': []}, validation
    return True, {
        'intent': intent,
        'proposal': normalized_proposal,
        'answer': answer_clean,
        'citations': citations,
    }, validation


def _prepare_context(context):
    if not isinstance(context, dict):
        raise ValueError('context는 딕셔너리여야 합니다.')
    raw_comparison = context.get('comparison') if isinstance(context.get('comparison'), dict) else {}
    # 이미 DB가 필터링해 llmSourcePolicy를 넣은 경우에도 방어적으로 뉴스·미허용 출처를 다시 점검한다.
    source_permissions = context.get('sourcePermissions')
    if source_permissions is not None or 'llmSourcePolicy' not in context:
        filtered_comparison, policy = filter_comparison_for_llm(raw_comparison, source_permissions)
    else:
        filtered_comparison, _ = filter_comparison_for_llm(raw_comparison, None)
        policy = context['llmSourcePolicy']

    prepared = {
        'comparison': filtered_comparison,
        'llmSourcePolicy': policy,
    }
    if isinstance(context.get('conditionBounds'), dict):
        prepared['conditionBounds'] = context['conditionBounds']
    if isinstance(context.get('existingProposal'), dict):
        prepared['existingProposal'] = context['existingProposal']
    if isinstance(context.get('existingIntent'), str):
        prepared['existingIntent'] = context['existingIntent']
    return prepared


def run_turn(message, context, provider, *, max_tool_rounds=3, max_output_tokens=1200):
    """한 대화 턴을 실행하고 검증 결과와 사용량을 포함한 구조화 딕셔너리를 반환한다."""
    if not _valid_message(message):
        raise ValueError('질문 메시지는 1~800자의 유효한 문자열이어야 합니다.')
    if type(max_tool_rounds) is not int or not 0 <= max_tool_rounds <= 6:
        raise ValueError('max_tool_rounds는 0~6 범위여야 합니다.')

    prepared_context = _prepare_context(context)
    input_items = build_user_input(message, prepared_context)
    tools = get_tool_schemas()
    usages = []
    tool_trace = []
    raw_parsed = None

    for round_idx in range(max_tool_rounds + 1):
        response = provider.generate(
            instructions=SYSTEM_PROMPT,
            input_items=input_items,
            response_schema=AGENT_TURN_OUTPUT_SCHEMA,
            schema_name='homecierge_agent_turn',
            tools=tools if round_idx < max_tool_rounds else None,
            max_output_tokens=max_output_tokens,
        )
        usages.append(response['usage'])
        tool_calls = response.get('toolCalls') or []
        if tool_calls and round_idx < max_tool_rounds:
            input_items = list(input_items) + list(response.get('outputItems') or [])
            for call in tool_calls:
                result = execute_tool(call['name'], call['arguments'], prepared_context)
                tool_trace.append({'name': call['name'], 'ok': bool(result.get('ok'))})
                input_items.append({
                    'type': 'function_call_output',
                    'call_id': call['call_id'],
                    'output': json.dumps(result, ensure_ascii=False, allow_nan=False),
                })
            continue
        raw_parsed = response.get('parsed')
        break

    if raw_parsed is None:
        raise LLMBadResponseError('llm_tool_loop_exhausted', '도구 호출 한도 안에 최종 응답을 받지 못했습니다.')

    passed, normalized, validation = validate_turn_output(raw_parsed, prepared_context)
    return {
        'intent': normalized['intent'],
        'proposal': normalized['proposal'],
        'answer': normalized['answer'],
        'citations': normalized['citations'],
        'toolCalls': tool_trace,
        'usage': merge_usage_records(usages),
        'validation': validation,
        'promptVersion': PROMPT_VERSION,
        'status': 'answered' if passed else 'rejected',
        'llmSourcePolicy': prepared_context['llmSourcePolicy'],
    }
