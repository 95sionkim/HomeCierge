"""공고 문서 작업자가 원천 페이지와 점검 결과를 같은 수집본에 묶는지 합성 자료로 검사한다."""
import io
import copy
import hashlib
import importlib.util
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from email.message import Message
from functools import partial
from pathlib import Path
from unittest.mock import Mock, patch
from uuid import uuid4

from ingestion_pages import ReplayTransport, loads_source_json
from replay_ingestion import collect_notice_catalog, ingest, replay
from review_notice_documents import read_owned_upload

FIXTURE = Path(__file__).resolve().parents[1] / 'tests/fixtures/ingestion-v0.json'


class DocumentFlowTests(unittest.TestCase):
    def setUp(self):
        self.bundle = loads_source_json(FIXTURE.read_text(encoding='utf-8'))
        self.inputs = self.bundle['request']
        self.api = Mock(wraps=ReplayTransport(self.bundle))

    def test_checked_evidence_uses_same_catalog_and_feeds_snapshot(self):
        def review(target, catalog):
            self.assertEqual(target, self.inputs['target'])
            self.assertEqual(catalog['rooms'], [])
            self.assertEqual(self.api.call_count, 2)
            return {'evidence': self.bundle['evidence'], 'issues': []}

        full = ingest(self.inputs, self.api, data_origin='synthetic', review_documents=review)
        self.assertEqual(full, replay(self.bundle))

    def test_catalog_review_keeps_basic_info_and_hold_without_querying_trades(self):
        issue = {'code': 'document_unavailable', 'nextAction': 'upload_notice_pdf'}
        catalog, collections, _ = collect_notice_catalog(
            self.inputs['noticeSource'], self.inputs['target'], self.api, page_size=2,
            review_documents=lambda *_: {'evidence': [], 'issues': [issue]})
        self.assertTrue(catalog['notice']['fields']['HOUSE_NM']['value'])
        self.assertEqual(catalog['rooms'], [])
        self.assertEqual([m['checkedSupplyArea']['m2'] for m in catalog['housingTypes']], [None])
        self.assertIn(issue, catalog['issues'])
        self.assertEqual([c['source'] for c in collections], ['applyhome_apt', 'applyhome_apt_model'])
        self.assertEqual(self.api.call_count, 2)

    def test_prechecked_rows_cannot_be_mixed_with_automatic_review(self):
        with self.assertRaises(ValueError):
            ingest(self.inputs, self.api, data_origin='synthetic', evidence=self.bundle['evidence'],
                   review_documents=lambda *_: self.fail('검수 입력이 섞임'))
        self.api.assert_not_called()

    def test_downloaded_wrong_edition_or_unreadable_pdf_preserves_catalog_and_action(self):
        from notice_document_review import review_catalog_documents
        numbers = 'houseManageNo=9900000001&pblancNo=9900000042'
        detail = 'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?' + numbers
        attachment = ('https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do?' + numbers
                      + '&atchmnflSeqNo=5555&atchmnflSn=1')
        self.bundle['pages'][0]['body']['data'][0]['PBLANC_URL'] = detail
        html = f'<a href="{attachment.replace("&", "&amp;")}">모집공고문 보기</a>'
        responses = {detail: ('text/html; charset=utf-8', html.encode()),
                     attachment: ('application/pdf', b'%PDF-1.4\nsynthetic\n%%EOF\n')}

        def fetch(url, *, max_bytes, timeout):
            mime, body = responses[url]
            return {'status': 200, 'headers': {'content-type': mime}, 'body': body}

        def reject_edition(content, *, target, catalog, document):
            return {'status': 'rejected', 'evidence': [], 'issues': [
                {'code': 'pdf_notice_mismatch', 'document': document['id'], 'version': document['version']}]}

        unreadable = Mock(side_effect=RuntimeError('synthetic parser diagnostic'))
        for check, code, actions, status in [
                (reject_edition, 'pdf_notice_mismatch', ['check_notice_edition', 'review_original_document'], 'rejected'),
                (unreadable, 'document_inspection_failed', ['review_original_document'], 'held')]:
            with self.subTest(code=code):
                read_upload = Mock()
                review = partial(review_catalog_documents, fetch=fetch, inspect=check, read_upload=read_upload)
                catalog, _, receipt = collect_notice_catalog(
                    self.inputs['noticeSource'], self.inputs['target'], ReplayTransport(self.bundle),
                    page_size=2, review_documents=review)
                self.assertEqual(receipt['acquisitionStatus'], 'acquired')
                self.assertEqual(receipt['nextActions'], actions)
                self.assertEqual(catalog['documents'][0]['status'], status)
                self.assertEqual(next(i['nextActions'] for i in catalog['issues'] if i['code'] == code), actions)
                self.assertTrue(catalog['notice']['fields']['HOUSE_NM']['value'])
                self.assertEqual(catalog['housingTypes'][0]['checkedSupplyArea']['status'], 'unverified')
                self.assertEqual(catalog['rooms'], [])
                self.assertNotIn('synthetic parser diagnostic', json.dumps([receipt, catalog]))
                read_upload.assert_not_called()

    def test_two_disagreeing_prices_remain_conflicting_when_a_third_version_has_no_price(self):
        from notice_document_review import combine_reviews
        first = self.bundle['evidence'][0]
        other = dict(first, won='780000000', document=dict(first['document'], version='corrected-synthetic-2'))
        checked = combine_reviews([{'evidence': items, 'issues': []} for items in ([first], [other], [])])
        result = ingest(self.inputs, self.api, data_origin='synthetic', review_documents=lambda *_: checked)
        price = result['catalog']['rooms'][0]['salePrice']
        self.assertEqual(price['status'], 'conflict')
        self.assertCountEqual(price['values'], [first['won'], other['won']])

    def test_held_upload_keeps_its_source_for_database_retention_checks(self):
        from notice_document_review import review_catalog_documents
        metadata = dict(self.inputs['target'], id='upload:' + str(uuid4()), version='sha256:' + 'a' * 64,
                        sha256='a' * 64, source='upload', originCheck='unverified', role='unclassified',
                        adoption='not_adoptable', reasons=['upload_origin_unverified'], content=b'synthetic-file')
        packet = {'status': 'held', 'documents': [metadata], 'reasons': ['upload_origin_unverified'],
                  'relation': {'kind': 'none'}, 'observedAt': '2026-10-05T00:00:00+00:00',
                  'next': [{'action': 'upload'}]}
        with patch('notice_document_review.acquire_notice_pdf', return_value=packet):
            result = ingest(self.inputs, self.api, data_origin='synthetic', review_documents=review_catalog_documents)
        self.assertEqual(result['catalog']['rooms'], [])
        doc, = result['catalog']['documents']
        self.assertEqual((doc['source'], doc['records'], doc['status']), ('upload', 0, 'held'))
        self.assertNotIn('content', doc)

    def test_unresolved_correction_holds_only_the_uncovered_item(self):
        from notice_document_review import combine_reviews
        rows = self.bundle['evidence']
        original = [r for r in rows if r['item'] == 'supply_area' or r.get('room') == '101동 101호']
        correction = copy.deepcopy([r for r in original if r['item'] != 'required_options'])
        for row in correction:
            row['document']['version'] = 'synthetic-correction-v2'
        review = combine_reviews([{'evidence': original, 'issues': []}, {'evidence': correction, 'issues': []}])
        result = ingest(self.inputs, self.api, data_origin='synthetic', review_documents=lambda *_: review)
        room = result['catalog']['rooms'][0]
        self.assertEqual(room['salePrice']['status'], 'confirmed')
        self.assertIsNone(room['requiredOptions']['won'])
        self.assertIsNone(room['subtotal']['won'])
        self.assertEqual(result['catalog']['housingTypes'][0]['checkedSupplyArea']['status'], 'confirmed')
        self.assertTrue(any(i.get('item') == 'required_options' and i['code'] == 'document_revision_item_unverified'
                            for i in result['catalog']['issues']))

    def test_owned_pdf_is_read_from_registered_user_api(self):
        analysis_id, upload_id = str(uuid4()), str(uuid4())
        response = io.BytesIO(b'%PDF-1.7 synthetic')
        response.status = 200
        response.headers = Message()
        response.headers['Content-Type'] = 'application/pdf'
        opener = Mock()
        opener.open.return_value = response
        result = read_owned_upload(analysis_id, upload_id, 'synthetic-user-session', opener=opener)
        self.assertEqual(result, {'id': upload_id, 'content': b'%PDF-1.7 synthetic'})
        outgoing = opener.open.call_args.args[0]
        self.assertEqual(outgoing.full_url, f'http://127.0.0.1:3001/api/v1/analyses/{analysis_id}/uploads/{upload_id}/content')
        self.assertEqual(outgoing.get_header('Authorization'), 'Bearer synthetic-user-session')
        opener.open.side_effect = OSError()
        self.assertIsNone(read_owned_upload(analysis_id, upload_id, 'synthetic-user-session', opener=opener))

    @unittest.skipUnless(importlib.util.find_spec('fitz'), 'PyMuPDF를 설치한 문서 작업자에서 실행')
    def test_worker_reads_official_html_pdf_and_returns_checked_room_and_area(self):
        from notice_document_review import review_catalog_documents
        from review_notice_documents import main
        from test_notice_pdf_fields import build_synthetic_notice_pdf
        content = build_synthetic_notice_pdf()
        numbers = 'houseManageNo=9900000001&pblancNo=9900000042'
        detail = 'https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?' + numbers
        attachment = ('https://static.applyhome.co.kr/ai/aia/getAtchmnfl.do?' + numbers
                      + '&atchmnflSeqNo=5555&atchmnflSn=1')
        self.bundle['pages'][0]['body']['data'][0]['PBLANC_URL'] = detail
        html = f'<a class="radius_btn" href="{attachment.replace("&", "&amp;")}">모집공고문 보기</a>'
        def fetch(url, *, max_bytes, timeout):
            if url == detail:
                return {'status': 200, 'headers': {'content-type': 'text/html; charset=utf-8'}, 'body': html.encode()}
            self.assertEqual(url, attachment)
            return {'status': 200, 'headers': {'content-type': 'application/octet-stream'}, 'body': content}

        # CLI 계약에는 사전 점검한 fixture.evidence를 주지 않는다. 검수값은 PDF에서 나와야 한다.
        with tempfile.TemporaryDirectory() as directory:
            inputs = Path(directory) / 'request.json'
            inputs.write_text(json.dumps(self.inputs), encoding='utf-8')
            buffer = io.StringIO()
            with patch('sys.argv', ['worker', '--live', '--request', str(inputs)]), redirect_stdout(buffer), \
                    patch('review_notice_documents.live_api_transport', return_value=ReplayTransport(self.bundle)), \
                    patch('notice_document_review.review_catalog_documents', partial(review_catalog_documents, fetch=fetch)):
                self.assertEqual(main(), 0)
        output = json.loads(buffer.getvalue())
        catalog = output['catalog']
        self.assertEqual(output['documentReview']['acquisitionStatus'], 'acquired')
        self.assertEqual(catalog['documents'][0]['version'], 'sha256:' + hashlib.sha256(content).hexdigest())
        self.assertEqual([(r['room'], r['subtotal']['won']) for r in catalog['rooms']],
                         [('101동 101호', '710000000'), ('101동 102호', None)])
        self.assertEqual(catalog['housingTypes'][0]['checkedSupplyArea']['status'], 'confirmed')
        for amount in ('salePrice', 'requiredOptions'):
            self.assertGreaterEqual(catalog['rooms'][0][amount]['evidence'][0]['page'], 1)
        self.assertNotIn('%PDF', buffer.getvalue())
        from compare_trades import compare_snapshot
        snapshot = ingest(self.inputs, ReplayTransport(self.bundle), data_origin='synthetic',
                          review_documents=partial(review_catalog_documents, fetch=fetch))
        complex_evidence = loads_source_json(FIXTURE.with_name('comparison-evidence-v1.json').read_text(encoding='utf-8'))
        selected = compare_snapshot(snapshot, {'modelNo': '01', 'room': '101동 101호'}, complex_evidence)
        self.assertEqual(selected['noticePrice']['won'], '710000000')
