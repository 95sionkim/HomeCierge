#!/usr/bin/env python3
"""확보한 API와 검수한 공고 PDF의 근거·일치 여부·금액을 검증하고 결합한다."""
import hashlib
import json
import re
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
API = ROOT / 'api-evidence' / '20261106_live'
PDF = ROOT / 'pdf-evidence'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def compact(value):
    return re.sub(r'\s+', '', value or '')


def identity_match(api_detail, extracted):
    """현재 공고 식별 문장이 불명확하면 병합하지 않는다. 단지명은 키로 쓰지 않는다."""
    identity = extracted.get('identity')
    if not identity:
        return {'accepted': False, 'reasons': ['unresolved_pdf_identity']}
    pairs = [('house_manage_no', str(api_detail['HOUSE_MANAGE_NO']), identity['house_manage_no']),
             ('notice_date', api_detail['RCRIT_PBLANC_DE'], identity['notice_date'])]
    reasons = [{'field': key, 'api': api, 'pdf': pdf} for key, api, pdf in pairs if api != pdf]
    return {'accepted': not reasons, 'reasons': reasons}


def verify_field(field, extracted):
    """표 셀 또는 원문 존재를 검증한다. 의미 해석은 사전 검수에 의존한다."""
    evidence_ok, value_ok = True, True
    for source in field['evidence']:
        page = extracted['pages'][source['page'] - 1]
        if 'table_id' in source:
            table = next(t for t in page['tables'] if t['id'] == source['table_id'])
            raw = table['rows'][source['row']][source['column']]
            evidence_ok &= raw == source['raw']
            evidence_ok &= table['cell_bboxes'][source['row']][source['column']] == source['bbox']
            norm = field['normalizer']
            if norm == 'integer':
                value_ok &= int(raw.replace(',', '')) == field['value']
            elif norm == 'decimal':
                value_ok &= Decimal(raw) == Decimal(field['value'])
            elif norm == 'string':
                value_ok &= raw == field['value']
            elif norm != 'reviewed_interpretation':
                raise ValueError('지원하지 않는 정규화 방법: ' + norm)
        else:
            evidence_ok &= compact(source['quote']) in compact(page['text'])
    return bool(evidence_ok and value_ok)


def main():
    if not (PDF / '2026930040/reviewed-facts.json').exists():
        raise SystemExit('역사적 실응답 증거는 별도 로컬 자료입니다. docs/api/README.md의 재현 범위를 확인하세요.')
    case = PDF / '2026930040'
    extracted, reviewed, source = (read(case / name) for name in ['extracted.json', 'reviewed-facts.json', 'source.json'])
    detail = read(API / 'case_detail/parsed.json')['data'][0]
    model = read(API / 'case_model/parsed.json')['data'][0]
    checks = []

    def check(name, result, detail=None):
        checks.append({'check': name, 'passed': bool(result), 'detail': detail})

    actual_hash = hashlib.sha256((case / 'notice.pdf').read_bytes()).hexdigest()
    check('source: pdf_hash', actual_hash == source['sha256'] == extracted['source_sha256'] == reviewed['source_sha256'])
    check('source: reviewed_extraction_hash', hashlib.sha256((case / 'extracted.json').read_bytes()).hexdigest() == reviewed['extracted_json_sha256'])
    check('source: all_pages_available', extracted['page_count'] == len(extracted['pages']) == source['pages'] == 12)
    check('source: no_scanned_pages_in_this_case', not extracted['pages_needing_ocr_review'])
    matched = identity_match(detail, extracted)
    check('identity: current_notice_matches', matched['accepted'], matched)
    check('identity: api_detail_model_join', all(str(detail[key]) == str(model[key]) for key in ['HOUSE_MANAGE_NO', 'PBLANC_NO']))
    fields = reviewed['fields']
    for name, field in fields.items():
        try:
            ok = verify_field(field, extracted)
        except (KeyError, IndexError, ValueError, StopIteration, TypeError):
            ok = False
        check('evidence: ' + name, ok)
    values = {key: field['value'] for key, field in fields.items()}
    check('identity: reviewed_identity_matches', values['house_manage_no'] == extracted['identity']['house_manage_no'] == reviewed['house_manage_no'])
    check('identity: reviewed_date_matches', values['notice_date'] == extracted['identity']['notice_date'])
    check('api_pdf: model_and_type', model['MODEL_NO'] == values['model_no'] and model['HOUSE_TY'] == values['house_type'])
    check('api_pdf: supply_area', Decimal(model['SUPLY_AR']) == Decimal(values['supply_area_m2']))
    check('api_pdf: single_general_unit', values['general_units'] == model['SUPLY_HSHLDCO'] == detail['TOT_SUPLY_HSHLDCO'] == 1 and model['SPSPLY_HSHLDCO'] == 0)
    check('api_pdf: single_unit_price_matches_model_max', int(Decimal(model['LTTOT_TOP_AMOUNT']) * 10000) == values['base_price_krw'])
    check('area: exclusive_plus_common', Decimal(values['exclusive_area_m2']) + Decimal(values['common_area_m2']) == Decimal(values['supply_area_m2']))
    check('area: contract_area', Decimal(values['supply_area_m2']) + Decimal(values['other_common_area_m2']) == Decimal(values['contract_area_m2']))
    check('cost: land_plus_building', values['land_price_krw'] + values['building_price_krw'] == values['base_price_krw'])
    check('cost: base_payment_sum', values['base_deposit_krw'] + values['base_balance_krw'] == values['base_price_krw'])
    check('cost: balcony_payment_sum', values['balcony_deposit_krw'] + values['balcony_balance_krw'] == values['balcony_price_krw'])
    check('cost: deposit_ten_percent', all(values[prefix + '_deposit_krw'] * 10 == values[prefix + '_price_krw'] for prefix in ['base', 'balcony']))
    check('cost: option_belongs_to_this_unit', values['balcony_unit'] == values['unit'])
    check('cost: mandatory_inherited_balcony', values['balcony_required_in_this_resupply'] is True)
    check('cost: no_interim_payment', values['interim_payment_krw'] == 0)
    check('date: contract_matches_api', values['base_deposit_date'] == detail['CNTRCT_CNCLS_BGNDE'])
    check('date: move_in_month_matches_api', values['move_in_window']['end'].replace('-', '')[:6] == detail['MVN_PREARNGE_YM'])
    check('date: payment_order', date.fromisoformat(values['base_deposit_date']) <= date.fromisoformat(values['base_balance_due']))

    # 같은 단지의 사업주체 공식 사이트에 있는 PDF라도 다른 회차는 거부한다.
    old_path = PDF / '2026930019'
    old = read(old_path / 'extracted.json')
    check('negative_fixture: source_hash', hashlib.sha256((old_path / 'notice.pdf').read_bytes()).hexdigest() == old['source_sha256'] == read(old_path / 'source.json')['sha256'])
    rejected = identity_match(detail, old)
    check('negative_fixture: wrong_round_rejected', not rejected['accepted'] and {r['field'] for r in rejected['reasons']} == {'house_manage_no', 'notice_date'}, rejected)

    all_passed = all(c['passed'] for c in checks)
    derived = {}
    if all_passed:
        for name, inputs in {
            'base_plus_required_balcony_krw': ['base_price_krw', 'balcony_price_krw'],
            'contract_deposit_total_krw': ['base_deposit_krw', 'balcony_deposit_krw'],
            'balance_total_krw': ['base_balance_krw', 'balcony_balance_krw'],
        }.items():
            derived[name] = {'value': sum(values[k] for k in inputs), 'unit': 'KRW', 'operation': 'sum', 'inputs': inputs}
    combined = {
        'schema_version': 2, 'status': 'validated_case_supplement' if all_passed else 'blocked_validation_failed',
        'scope': '공고 1건의 검수 데이터. 모든 공고 형식의 자동 추출·사용자 적격 판정 미검증.',
        'case_key': {'house_manage_no': detail['HOUSE_MANAGE_NO'], 'announcement_no': detail['PBLANC_NO'], 'model_no': model['MODEL_NO']},
        'api_original': {'announcement': detail, 'model': model},
        'pdf_source': source,
        'pdf_supplement': fields if all_passed else None,
        'derived': derived,
        'cashflow_note': '주택 계약금은 2026-10-23, 주택 잔금은 2026-11-30까지. 발코니 계약금은 계약시, 잔금은 입주시로 별도 표기됨.',
        'not_in_subtotal': ['취득세 등 제세공과금', '소유권이전등기비용', '매수인 부담 인지세', '금융비용'],
        'unresolved': reviewed['unresolved'], 'eligibility_decision': None,
        'excluded_features': ['asking_prices'],
        'total_acquisition_cost_krw': None,
        'negative_fixture_rejection': rejected,
    }
    dump(case / 'combined.json', combined)
    summary = {'validated_at': datetime.now(timezone.utc).isoformat(),
               'scope': '공식 PDF 1건과 API의 병합 검증, 같은 단지 다른 회차 PDF 1건의 거부 검증',
               'facts_reviewed': len(fields), 'checks_passed': sum(c['passed'] for c in checks),
               'checks_total': len(checks), 'all_passed': all_passed,
               'failed_checks': [c for c in checks if not c['passed']], 'checks': checks}
    dump(case / 'validation.json', summary)
    print(json.dumps({k: v for k, v in summary.items() if k != 'checks'}, ensure_ascii=False))
    return 0 if all_passed else 1


if __name__ == '__main__':
    raise SystemExit(main())
