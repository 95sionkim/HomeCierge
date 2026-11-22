"""호실별 납부 일정 검수. 모든 공고·금액·날짜는 합성 자료다."""
import hashlib
import json
import unittest
from functools import partial
from unittest.mock import patch

from ingestion_pages import ReplayTransport
from notice_document_review import combine_reviews, review_catalog_documents
from notice_pdf_fields import inspect_notice_pdf
from replay_ingestion import collect_notice_catalog, ingest
from test_notice_pdf_fields import (
    FIXTURE, HAS_FITZ, _catalog, _cells, _room, _run, _table, build_synthetic_notice_pdf,
    synthetic_document, synthetic_notice_spec,
)


def _schedule(result, item='sale_price', room='101동 101호'):
    rows = [row for row in result.get('paymentSchedules', ()) if (row['item'], row['room']) == (item, room)]
    if len(rows) != 1:
        raise AssertionError(f'호실별 납부 일정은 항목당 하나여야 합니다. {item}, {room}, {len(rows)}건')
    return rows[0]


def _timing(stage, trigger, date_status, date=None):
    return stage, trigger, date_status, date


def _installment_timings(schedule):
    return [(i['stage'], i['timing']['trigger'], i['timing']['dateStatus'], i['timing']['date'])
            for i in schedule['installments']]


def _contract_date(spec, full_date='2026.10.27.(화)'):
    spec['tables']['signing'] = _table(40, 180, [60, 100, 100, 100], [14, 16], [
        ['구분', '당첨자발표', '서류접수', '계약체결'], ['일정', '2026.10.20.(화)', '2026.10.22.(목)', full_date],
    ], [])
    spec['pages'][0]['tables'].append('signing')


class PaymentScheduleLayoutTests(unittest.TestCase):
    def test_checked_price_and_required_option_installments_have_independent_pages(self):
        result, _ = _run()
        sale, option = _schedule(result), _schedule(result, 'required_options')
        for row, page, total, payments in ((sale, 2, '700000000', ['70000000', '630000000']),
                                            (option, 3, '10000000', ['1000000', '9000000'])):
            self.assertEqual((row['modelNo'], row['houseType'], row['status']), ('01', '084.0000A', 'confirmed'))
            self.assertEqual(row['totalWon'], total)
            self.assertEqual([i['won'] for i in row['installments']], payments)
            self.assertEqual(row['evidence'], [{'document': 'synthetic-notice-pdf', 'version': 'synthetic-v1', 'page': page}])
            self.assertEqual(_installment_timings(row), [_timing('deposit', 'contract_signing', 'relative'),
                                                         _timing('balance', 'move_in', 'relative')])
        self.assertEqual(_schedule(result, room='101동 102호')['totalWon'], '720000000')

    def test_exact_date_from_its_contract_cell_and_deadline_from_price_header(self):
        spec = synthetic_notice_spec()
        _contract_date(spec)
        _cells(spec, 'price')[1][7:9] = ['계약 시 (‘26.10.27.)', '입주지정기간 종료일 (2026.12.07.)까지']
        result, _ = _run(spec)
        sale = _schedule(result)
        self.assertEqual(_installment_timings(sale), [_timing('deposit', 'contract_signing', 'exact', '2026-10-27'),
                                                      _timing('balance', 'deadline', 'exact', '2026-12-07')])
        self.assertEqual([e['page'] for e in sale['installments'][0]['timing']['evidence']], [1, 2])
        self.assertEqual(_installment_timings(_schedule(result, 'required_options')),
                         [_timing('deposit', 'contract_signing', 'relative'), _timing('balance', 'move_in', 'relative')])

    def test_date_range_relative_and_uncorroborated_date_do_not_become_single_dates(self):
        spec = synthetic_notice_spec()
        for deposit, balance, states in (
            ('계약 시 (26.10.27.)', '입주 시 (2026.12.01.~2026.12.07.)', ('unverified', 'range')),
            ('계약일로부터 10일 이내', '입주지정기간 내', ('relative', 'relative')),
            ('계약일부터 10일까지', '2026년 12월 1일부터 2026년 12월 7일까지', ('relative', 'range')),
            ('', '추후 안내', ('missing', 'unverified')),
            ('2026.10.27.(수)', '2026.12.07. 예정', ('unverified', 'unverified')),
        ):
            with self.subTest(deposit=deposit, balance=balance):
                _cells(spec, 'price')[1][7:9] = [deposit, balance]
                row = _schedule(_run(spec)[0])
                self.assertEqual(row['status'], 'confirmed')
                for item, status, text in zip(row['installments'], states, (deposit, balance)):
                    self.assertEqual((item['timing']['dateStatus'], item['timing']['date'], item['timing']['text']),
                                     (status, None, text or None))

    def test_split_interim_columns_preserve_each_explicit_installment(self):
        spec = synthetic_notice_spec()
        price = spec['tables']['price']
        price['widths'][7:] = [70, 65, 65, 70]
        price['cells'][0][7:] = ['계약금', '중도금', None, '잔금']
        price['spans'].append([0, 8, 1, 2])
        price['cells'][1][7:] = ['계약 시', '1차 2027.02.15.', '2차 2027.03.15.', '입주 시']
        price['cells'][2][7:] = ['70000000', '100000000', '200000000', '330000000']
        price['cells'][3][7:] = ['72000000', '110000000', '200000000', '338000000']
        installments = _schedule(_run(spec)[0])['installments']
        self.assertEqual([(i['stage'], i['won'], i['timing']['date']) for i in installments], [
            ('deposit', '70000000', None), ('interim', '100000000', '2027-02-15'),
            ('interim', '200000000', '2027-03-15'), ('balance', '330000000', None),
        ])

    def test_options_aggregate_merged_and_per_item_installments_once(self):
        spec = synthetic_notice_spec()
        options = spec['tables']['options']
        options['cells'][2][5] = '6,000,000'
        options['cells'][3][2:6] = ['유상', '합성 기기', '합성 종류', '4,000,000']
        merged = _schedule(_run(spec)[0], 'required_options')
        self.assertEqual([i['won'] for i in merged['installments']], ['1000000', '9000000'])
        options['spans'] = [span for span in options['spans'] if span[:2] not in ([2, 6], [2, 7])]
        options['cells'][2][6:] = ['2,000,000', '4,000,000']
        options['cells'][3][6:] = ['1,000,000', '3,000,000']
        separate = _schedule(_run(spec)[0], 'required_options')
        self.assertEqual([i['won'] for i in separate['installments']], ['3000000', '7000000'])
        options['cells'][2][6], options['cells'][3][6] = options['cells'][3][6], options['cells'][2][6]
        mismatched = _schedule(_run(spec)[0], 'required_options')
        self.assertEqual((mismatched['status'], mismatched['installments']), ('conflict', []))
        self.assertIn('payment_amount_mismatch', mismatched['reasons'])

    def test_separate_free_option_blanks_do_not_hide_paid_installments(self):
        spec = synthetic_notice_spec()
        options = spec['tables']['options']
        options['spans'] = [span for span in options['spans'] if span[:2] not in ([2, 6], [2, 7])]
        options['cells'][3][6:] = ['-', '-']
        option = _schedule(_run(spec)[0], 'required_options')
        self.assertEqual((option['status'], option['totalWon']), ('confirmed', '10000000'))
        self.assertEqual([i['won'] for i in option['installments']], ['1000000', '9000000'])

    def test_stated_thousand_won_unit_applies_to_each_installment(self):
        spec = synthetic_notice_spec()
        spec['pages'][1]['texts'][5] = (690, 188, '[단위: 세대, 천원]')
        for row in _cells(spec, 'price')[2:]:
            row[4:] = [value[:-4] for value in row[4:]]
        sale = _schedule(_run(spec)[0])
        self.assertEqual((sale['status'], sale['totalWon']), ('confirmed', '700000000'))
        self.assertEqual([i['won'] for i in sale['installments']], ['70000000', '630000000'])

    def test_missing_amount_and_missing_evidence_have_different_reasons(self):
        spec = synthetic_notice_spec()
        _cells(spec, 'price')[2][7] = '-'
        spec['pages'][2]['tables'].remove('options')
        result, catalog = _run(spec)
        sale, options = _schedule(result), _schedule(result, 'required_options')
        self.assertIn('payment_amount_missing', sale['reasons'])
        self.assertTrue(sale['evidence'])
        self.assertEqual((_room(catalog, '101동 101호')['salePrice']['won'], sale['totalWon']), ('700000000', None))
        self.assertIn('payment_evidence_missing', options['reasons'])
        self.assertEqual((options['evidence'], options['installments'], options['totalWon']), ([], [], None))

    def test_explicit_free_options_have_zero_total_with_no_installments(self):
        spec = synthetic_notice_spec()
        _cells(spec, 'options')[4][2:6] = ['무상', '합성 기본품목', '합성 종류', '-']
        row = _schedule(_run(spec)[0], 'required_options', '101동 102호')
        self.assertEqual((row['status'], row['totalWon'], row['installments']), ('confirmed', '0', []))

    def test_unbounded_header_is_held_without_returning_its_text(self):
        spec = synthetic_notice_spec()
        _cells(spec, 'options')[1][6] = '무관한 합성문장 ' + ('가' * 180)
        option = _schedule(_run(spec)[0], 'required_options')
        self.assertEqual(option['status'], 'confirmed')
        self.assertEqual(option['installments'][0]['timing']['dateStatus'], 'unverified')
        self.assertIsNone(option['installments'][0]['timing']['text'])

    def test_payment_amount_spanning_two_rooms_is_not_assigned_to_either_room(self):
        spec = synthetic_notice_spec()
        price = spec['tables']['price']
        price['spans'] += [[2, 7, 2, 1], [2, 8, 2, 1]]
        price['cells'][3][4:] = price['cells'][2][4:7] + [None, None]
        result, _ = _run(spec)
        for room in ('101동 101호', '101동 102호'):
            row = _schedule(result, room=room)
            self.assertEqual((row['status'], row['totalWon'], row['installments']), ('unverified', None, []))
            self.assertIn('payment_scope_unverified', row['reasons'])

    def test_shared_sale_price_cell_cannot_prove_each_rooms_payment_total(self):
        spec = synthetic_notice_spec()
        price = spec['tables']['price']
        price['spans'].append([2, 6, 2, 1])
        price['cells'][3][4:] = price['cells'][2][4:6] + [None] + price['cells'][2][7:]
        parsed, _ = _run(spec)
        for room in ('101동 101호', '101동 102호'):
            sale = _schedule(parsed, room=room)
            self.assertEqual((sale['status'], sale['installments']), ('unverified', []))
            self.assertIn('payment_scope_unverified', sale['reasons'])

    def test_same_revision_totals_with_different_installments_report_conflict(self):
        original = _run()[0]
        spec = synthetic_notice_spec()
        _cells(spec, 'price')[2][7:] = ['80,000,000', '620,000,000']
        correction = _run(spec, document=synthetic_document(id='synthetic-correction', version='synthetic-v2'))[0]
        unreadable = {'evidence': [], 'issues': []}
        merged = combine_reviews([original, correction, unreadable])
        sale = _schedule(merged)
        self.assertEqual((sale['status'], sale['totalWon'], sale['installments']), ('conflict', None, []))
        self.assertCountEqual([ref['version'] for ref in sale['evidence']], ['synthetic-v1', 'synthetic-v2'])

    def test_agreeing_revisions_count_payments_once_and_missing_schedule_holds_only_its_item(self):
        original = _run()[0]
        version = synthetic_document(id='synthetic-correction', version='synthetic-v2')
        correction = _run(document=version)[0]
        sale = _schedule(combine_reviews([original, correction]))
        self.assertEqual((sale['status'], sale['totalWon'], len(sale['installments'])), ('confirmed', '700000000', 2))
        self.assertCountEqual([e['version'] for e in sale['evidence']], ['synthetic-v1', 'synthetic-v2'])

        spec = synthetic_notice_spec()
        spec['pages'][2]['tables'].remove('options')
        merged = combine_reviews([original, _run(spec, document=version)[0]])
        self.assertEqual(_schedule(merged)['status'], 'confirmed')
        options = _schedule(merged, 'required_options')
        self.assertEqual((options['status'], options['totalWon'], options['installments']), ('unverified', None, []))
        self.assertEqual([e['version'] for e in options['evidence']], ['synthetic-v1'])

    def test_conflicting_timing_is_held_instead_of_taking_date_from_one_version(self):
        spec = synthetic_notice_spec()
        _cells(spec, 'price')[1][7] = '계약 시 (2026.10.27.)'
        original = _run(spec)[0]
        _cells(spec, 'price')[1][7] = '계약 시 (2026.10.28.)'
        correction = _run(spec, document=synthetic_document(id='synthetic-correction', version='synthetic-v2'))[0]
        sale = _schedule(combine_reviews([original, correction]))
        self.assertEqual((sale['status'], sale['totalWon'], sale['installments']), ('conflict', None, []))


@unittest.skipUnless(HAS_FITZ, 'PyMuPDF를 설치한 문서 작업자에서 실행')
class PaymentScheduleReceiptTests(unittest.TestCase):
    def test_real_synthetic_pdf_returns_dates_ranges_and_bounded_receipt(self):
        spec = synthetic_notice_spec()
        _contract_date(spec)
        _cells(spec, 'price')[1][7:9] = ['계약 시 (‘26.10.27.)', '2026.12.01.~2026.12.07.']
        _cells(spec, 'options')[1][6] = '추후 안내'
        pdf = build_synthetic_notice_pdf(spec)
        target, _, _, catalog = _catalog()
        parsed = inspect_notice_pdf(pdf, target=target, catalog=catalog, document=synthetic_document())
        self.assertEqual(_schedule(parsed)['installments'][0]['timing']['date'], '2026-10-27')
        self.assertEqual(_schedule(parsed)['installments'][1]['timing']['dateStatus'], 'range')

        metadata = dict(synthetic_document(), role='notice', adoption='standalone', originCheck='confirmed',
                        sha256=hashlib.sha256(pdf).hexdigest(), reasons=[], content=pdf)
        packet = self._packet([metadata], 'sole')
        bundle = json.loads(FIXTURE.read_text(encoding='utf-8'))
        inputs = bundle['request']
        with patch('notice_document_review.acquire_notice_pdf', return_value=packet):
            checked, _, receipt = collect_notice_catalog(inputs['noticeSource'], target, ReplayTransport(bundle),
                                                         page_size=2, review_documents=review_catalog_documents)
            saved = ingest(inputs, ReplayTransport(bundle), data_origin='synthetic',
                           review_documents=review_catalog_documents)
        self.assertNotIn('paymentSchedules', checked)
        self.assertNotIn('paymentSchedules', json.dumps(saved))
        installments = _schedule(receipt)['installments']
        self.assertEqual(installments[1]['timing']['text'], '2026.12.01.~2026.12.07.')
        option_timing = _schedule(receipt, 'required_options')['installments'][0]['timing']
        self.assertEqual((option_timing['dateStatus'], option_timing['date'], option_timing['text']),
                         ('unverified', None, '추후 안내'))
        encoded = json.dumps(receipt, ensure_ascii=False)
        for excluded in ('계좌번호', '000-00-000', 'cell_bboxes', 'content', 'raw'):
            self.assertNotIn(excluded, encoded)

    @staticmethod
    def _packet(documents, kind, available=True):
        return {'status': 'acquired' if kind != 'unresolved' else 'partial', 'documents': documents, 'reasons': [],
                'relation': {'kind': kind, 'allDocumentsAvailable': available},
                'observedAt': '2026-10-05T00:00:00+00:00', 'next': []}

    def test_unreadable_or_missing_applicable_revision_holds_original_schedule(self):
        pdf = build_synthetic_notice_pdf()
        original = dict(synthetic_document(), role='notice', adoption='with_set', originCheck='confirmed',
                        sha256=hashlib.sha256(pdf).hexdigest(), reasons=[], content=pdf)
        unreadable = b'%PDF-1.4\nsynthetic\n%%EOF\n'
        correction = dict(original, id='synthetic-correction', version='synthetic-v2', role='correction',
                          sha256=hashlib.sha256(unreadable).hexdigest(), content=unreadable)
        target, _, _, catalog = _catalog()
        review = partial(review_catalog_documents, fetch=lambda *_: self.fail('오프라인 합성 검수입니다.'))
        for documents, available in (([original, correction], True), ([original], False)):
            with self.subTest(available=available):
                with patch('notice_document_review.acquire_notice_pdf', return_value=self._packet(documents, 'unresolved', available)):
                    receipt = review(target, catalog)['review']
                row = _schedule(receipt)
                self.assertEqual((row['status'], row['totalWon'], row['installments']), ('unverified', None, []))
                self.assertEqual([ref['document'] for ref in row['evidence']], [original['id']])

    def test_full_replacement_uses_only_replacement_amounts_and_pages(self):
        original_pdf = build_synthetic_notice_pdf()
        original = dict(synthetic_document(), role='notice', adoption='not_adoptable', originCheck='confirmed',
                        sha256=hashlib.sha256(original_pdf).hexdigest(), reasons=[], content=original_pdf)
        spec = synthetic_notice_spec()
        spec['pages'][2]['tables'].remove('options')
        _cells(spec, 'price')[2][7:9] = ['80,000,000', '620,000,000']
        replacement_pdf = build_synthetic_notice_pdf(spec)
        replacement = dict(original, id='synthetic-replacement', version='synthetic-v2', role='correction',
                           adoption='standalone', content=replacement_pdf,
                           sha256=hashlib.sha256(replacement_pdf).hexdigest())
        target, _, _, catalog = _catalog()
        with patch('notice_document_review.acquire_notice_pdf',
                   return_value=self._packet([original, replacement], 'full_replacement')):
            receipt = review_catalog_documents(target, catalog)['review']
        row = _schedule(receipt)
        self.assertEqual([i['won'] for i in row['installments']], ['80000000', '620000000'])
        self.assertEqual([ref['document'] for ref in row['evidence']], [replacement['id']])
        options = _schedule(receipt, 'required_options')
        self.assertEqual((options['status'], options['installments'], options['evidence']), ('unverified', [], []))
