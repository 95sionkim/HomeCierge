#!/usr/bin/env python3
"""업로드 보완 작업자 경로(A-01·A-30·A-31·A-32·A-59)를 합성 PDF와 모의 전송으로 오프라인 검사한다.

실제 청약홈·공공데이터·Supabase 네트워크 호출은 하지 않으며 모든 공고·해시·PDF 바이트는 합성 자료다.
"""
import hashlib
import importlib.util
import io
import json
import unittest
from copy import deepcopy
from unittest.mock import Mock
from uuid import uuid4

from ingestion_pages import loads_source_json
from notice_pdf_fields import inspect_notice_pdf
from notice_run_capture import NoticeTransports, read_worker_storage_upload
from run_analysis_worker import EVIDENCE_FIXTURE, FIXTURE, run_once
from test_notice_pdf_acquisition import CORRECTION_LABEL, DETAIL, NOTICE_LABEL, PDF_B, attachment, doc_id, html_ok, page, pdf_ok
from worker_rpc import WorkerRpc, WorkerRpcError

HAS_FITZ = importlib.util.find_spec('fitz') is not None


class UploadSupplementWorkerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bundle = loads_source_json(FIXTURE.read_text(encoding='utf-8'))
        cls.fixture_rows = {p['source']: p['body']['data'] for p in bundle['pages']
                            if p['source'].startswith('applyhome')}
        cls.trade_page = bundle['pages'][2]['body']
        cls.evidence_fixture = loads_source_json(EVIDENCE_FIXTURE.read_text(encoding='utf-8'))

    def setUp(self):
        self.owner_id = str(uuid4())
        self.analysis_id = str(uuid4())
        self.base_run_id = str(uuid4())
        self.base_snapshot_id = str(uuid4())
        self.upload_id = str(uuid4())
        self.object_path = f'{self.owner_id}/{self.analysis_id}/{self.upload_id}.pdf'
        self.target = {'houseManageNo': '9900000001', 'noticeNo': '9900000042', 'edition': '2026-10-05'}
        self.selection = dict(
            self.target,
            kind='upload_supplement',
            baseRunId=self.base_run_id,
            uploadId=self.upload_id,
            noticeSource='applyhome_apt',
            modelNo='01',
        )
        self.work = {
            'conditions': {
                'ingestion_target': dict(self.target, noticeSource='applyhome_apt'),
                'comparison': {'modelNo': '01', 'room': '101동 101호'},
            },
            'upload': {'uploadId': self.upload_id, 'objectPath': self.object_path},
            'baseRunId': self.base_run_id,
            'baseSnapshotId': self.base_snapshot_id,
            'evidence': None,
            'officialIndex': [],
            'useSyntheticFixture': False,
            'selectionBindingIssue': None,
            'noticeCapture': {
                'asOf': '2026-11-10',
                'requestRegionCodes': ['99999'],
                'allowOfficialPdf': True,
            },
        }
        self.lookup_rows = []
        self.job = {'runId': str(uuid4()), 'generation': 1, 'leaseToken': str(uuid4()), 'input': self.selection}
        self.finished = {'status': 'finished', 'runId': self.job['runId'], 'snapshotId': str(uuid4())}
        self.rows = deepcopy(self.fixture_rows)
        self.rows['applyhome_apt'][0]['PBLANC_URL'] = DETAIL
        self.att11 = attachment(11)
        self.att12 = attachment(12)
        self.client = Mock(spec=WorkerRpc)
        self.client.post.side_effect = self.rpc
        self.events = []
        self.seconds = 0

    def rpc(self, name, params, **kwargs):
        self.events.append((name, params))
        if name == 'claim_analysis_run':
            return self.job
        if name == 'read_upload_supplement_work':
            return self.work
        if name == 'lookup_official_notice_document_index':
            return [r for r in self.lookup_rows if r.get('sha256') == params['p_sha256']]
        if name == 'renew_analysis_run':
            return {'runId': self.job['runId'], 'status': 'running', 'attempt': self.job['generation']}
        if name in ('finish_notice_with_funding', 'finish_analysis_comparison'):
            return self.finished
        if name == 'fail_notice_analysis_run':
            return {'status': 'retry_wait' if params['p_retryable'] else 'failed', 'runId': self.job['runId']}
        if name == 'fail_analysis_run':
            return {'status': 'failed', 'runId': self.job['runId']}
        self.fail(f'예상하지 않은 RPC {name}')

    def api(self, source, scope, number, size):
        self.events.append(('api', (source, scope, number, size)))
        if source in self.rows:
            rows = self.rows[source]
            body = {'page': 1, 'perPage': size, 'matchCount': len(rows), 'currentCount': len(rows), 'data': rows}
        elif source == 'apt_trade' and scope.get('DEAL_YMD') == '202610':
            body = deepcopy(self.trade_page)
            inner = body['response']['body']
            inner['numOfRows'] = size
            inner['totalCount'] = len(inner['items']['item'])
        else:
            body = {'response': {'header': {'resultCode': '000'}, 'body': {
                'numOfRows': size, 'pageNo': 1, 'totalCount': 0, 'items': {}}}}
        return {'source': source, 'scope': scope, 'page': number, 'pageSize': size, 'httpStatus': 200,
                'observedAt': '2026-11-12T00:00:00+00:00', 'body': body}

    def calls(self, name):
        return [value for event, value in self.events if event == name]

    def run_worker(self, *, pdf, upload_bytes, inspect=None):
        def read_upload(uid, path):
            self.events.append(('upload', (uid, path)))
            self.assertEqual((uid, path), (self.upload_id, self.object_path))
            if upload_bytes is None:
                return None
            return {'id': uid, 'content': upload_bytes}

        transports = NoticeTransports(
            self.api, pdf,
            clock=lambda: self.seconds,
            sleep=lambda sec: setattr(self, 'seconds', self.seconds + sec),
            inspect=inspect,
            upload=read_upload,
        )
        return run_once(self.client, notice=transports)

    @unittest.skipUnless(HAS_FITZ, 'PyMuPDF 미설치')
    def test_official_hash_matched_upload_saves_provenance_schedules_and_recomputes_comparison(self):
        from test_notice_pdf_fields import build_synthetic_notice_pdf
        pdf_bytes = build_synthetic_notice_pdf()
        digest = hashlib.sha256(pdf_bytes).hexdigest()
        self.work['officialIndex'] = [{
            'id': doc_id(11), **self.target, 'sha256': digest,
            'role': 'notice', 'source': 'official', 'originCheck': 'confirmed',
        }]
        self.work['evidence'] = deepcopy(self.evidence_fixture)
        self.work['evidence']['dataOrigin'] = 'collected'
        self.work['evidence']['target'].update(self.target)

        def pdf_fetch(url, **kw):
            self.events.append(('pdf', url))
            if url == DETAIL:
                return html_ok(page([(self.att11, NOTICE_LABEL)]))
            # 공식 PDF 내려받기 503 실패 -> 업로드가 같은 첨부 슬롯을 보완한다.
            return {'status': 503, 'headers': {}, 'body': b''}

        result = self.run_worker(pdf=pdf_fetch, upload_bytes=pdf_bytes, inspect=inspect_notice_pdf)
        self.assertEqual(result, self.finished)
        self.assertEqual(self.calls('read_comparison_work'), [])  # read_comparison_work를 건드리지 않는다.

        finish, = self.calls('finish_notice_with_funding')
        capture = finish['p_result']
        comparison = finish['p_comparison']
        schedules = finish['p_schedules']

        doc, = capture['catalog']['documents']
        self.assertEqual(doc['id'], 'upload:' + self.upload_id)
        self.assertEqual(doc['version'], 'sha256:' + digest)
        self.assertEqual((doc['source'], doc['originCheck'], doc['status']), ('upload', 'confirmed', 'accepted'))
        self.assertNotIn('%PDF', json.dumps(finish))

        # 공급면적·호실 가격·납부 일정 모두 사용자 업로드 파일 ID·해시·쪽을 출처로 기록한다.
        area_ev = capture['catalog']['housingTypes'][0]['checkedSupplyArea']['evidence']
        self.assertEqual(area_ev[0]['document'], 'upload:' + self.upload_id)
        self.assertEqual(area_ev[0]['version'], 'sha256:' + digest)
        self.assertGreaterEqual(area_ev[0]['page'], 1)
        self.assertEqual(comparison['target']['supplyArea']['status'], 'confirmed')
        self.assertEqual(comparison['noticePrice']['status'], 'confirmed')
        self.assertEqual(comparison['noticePrice']['won'], '710000000')
        # 등록 비교 근거가 있으면 주변 단지 비교도 다시 계산된다.
        self.assertEqual(comparison['appliedScope'], 'priority')
        self.assertGreaterEqual(len(comparison['comparables']), 1)
        selected_schedules = [s for s in schedules if s['room'] == '101동 101호']
        self.assertEqual({s['item']: s['totalWon'] for s in selected_schedules},
                         {'sale_price': '700000000', 'required_options': '10000000'})
        self.assertTrue(all(ref['document'] == 'upload:' + self.upload_id and ref['version'] == 'sha256:' + digest
                            for s in selected_schedules for ref in s['evidence']))

    @unittest.skipUnless(HAS_FITZ, 'PyMuPDF 미설치')
    def test_other_edition_and_cross_notice_uploads_are_rejected_while_keeping_basic_info(self):
        from test_notice_pdf_fields import build_synthetic_notice_pdf
        pdf_bytes = build_synthetic_notice_pdf()
        digest = hashlib.sha256(pdf_bytes).hexdigest()
        # lookup_official_notice_document_index가 다른 회차/다른 공고의 공식 해시 일치를 돌려준다.
        self.lookup_rows = [{
            'id': doc_id(11, house='9900000009', notice='9900000099'),
            'houseManageNo': '9900000009', 'noticeNo': '9900000099', 'edition': '2026-09-01',
            'sha256': digest, 'role': 'notice', 'source': 'official', 'originCheck': 'confirmed',
        }]

        def pdf_fetch(url, **kw):
            return html_ok(page([(self.att11, NOTICE_LABEL)])) if url == DETAIL else {'status': 404, 'headers': {}, 'body': b''}

        self.assertEqual(self.run_worker(pdf=pdf_fetch, upload_bytes=pdf_bytes, inspect=inspect_notice_pdf), self.finished)
        finish, = self.calls('finish_notice_with_funding')
        capture, comparison = finish['p_result'], finish['p_comparison']
        doc, = capture['catalog']['documents']
        self.assertEqual((doc['source'], doc['originCheck'], doc['status']), ('upload', 'conflict', 'rejected'))
        self.assertIn('upload_matches_other_notice', doc['reasons'])
        # 독립 확인된 기본 공고 정보는 유지되고 PDF 파생 값은 보류된다(A-01·A-31).
        self.assertTrue(capture['catalog']['notice']['fields']['HOUSE_NM']['value'])
        self.assertEqual(comparison['target']['supplyArea']['status'], 'held')
        self.assertEqual(comparison['noticePrice']['status'], 'held')
        self.assertEqual(finish['p_schedules'], [])

    @unittest.skipUnless(HAS_FITZ, 'PyMuPDF 미설치')
    def test_unverified_origin_upload_is_held_and_never_merged(self):
        from test_notice_pdf_fields import build_synthetic_notice_pdf
        pdf_bytes = build_synthetic_notice_pdf()
        # 공식 해시 색인이 비어 있어 출처를 확인할 수 없다.
        self.work['officialIndex'] = []

        def pdf_fetch(url, **kw):
            return html_ok(page([(self.att11, NOTICE_LABEL)])) if url == DETAIL else {'status': 503, 'headers': {}, 'body': b''}

        self.assertEqual(self.run_worker(pdf=pdf_fetch, upload_bytes=pdf_bytes, inspect=inspect_notice_pdf), self.finished)
        finish, = self.calls('finish_notice_with_funding')
        doc, = finish['p_result']['catalog']['documents']
        self.assertEqual((doc['source'], doc['originCheck'], doc['status']), ('upload', 'unverified', 'held'))
        self.assertIn('upload_origin_unverified', doc['reasons'])
        self.assertEqual(finish['p_comparison']['noticePrice']['status'], 'held')
        self.assertEqual(finish['p_schedules'], [])

    @unittest.skipUnless(HAS_FITZ, 'PyMuPDF 미설치')
    def test_unknown_attachment_set_and_missing_correction_hold_values_for_a59(self):
        from test_notice_pdf_fields import build_synthetic_notice_pdf
        pdf_bytes = build_synthetic_notice_pdf()
        digest = hashlib.sha256(pdf_bytes).hexdigest()
        self.work['officialIndex'] = [{
            'id': doc_id(11), **self.target, 'sha256': digest,
            'role': 'notice', 'source': 'official', 'originCheck': 'confirmed',
        }]

        # 1) 상세 페이지를 읽지 못해 현재 첨부 집합을 알 수 없으면 단독 채택 불가
        self.assertEqual(
            self.run_worker(pdf=lambda url, **kw: {'error': 'timeout'}, upload_bytes=pdf_bytes, inspect=inspect_notice_pdf),
            self.finished,
        )
        finish1, = self.calls('finish_notice_with_funding')
        self.assertIn('attachment_set_unverified', [i['code'] for i in finish1['p_result']['catalog']['issues']])
        self.assertEqual(finish1['p_comparison']['target']['supplyArea']['status'], 'held')
        # 판본 관계를 확인하지 못한 일정은 금액 없이 보류 사유만 남긴다(확정 병합 금지).
        self.assertTrue(all(s['status'] != 'confirmed' and s['totalWon'] is None and s['installments'] == []
                            and 'payment_schedule_revision_unverified' in s['reasons']
                            for s in finish1['p_schedules']))

        # 2) 정정공고문이 누락된 상태에서는 원본 업로드 단독 채택 불가
        self.events.clear()
        def missing_correction_fetch(url, **kw):
            if url == DETAIL:
                return html_ok(page([(self.att11, NOTICE_LABEL), (self.att12, CORRECTION_LABEL)]))
            return {'status': 503, 'headers': {}, 'body': b''}

        self.assertEqual(
            self.run_worker(pdf=missing_correction_fetch, upload_bytes=pdf_bytes, inspect=inspect_notice_pdf),
            self.finished,
        )
        finish2, = self.calls('finish_notice_with_funding')
        issue_codes = [i['code'] for i in finish2['p_result']['catalog']['issues']]
        self.assertIn('correction_document_missing', issue_codes)
        self.assertEqual(finish2['p_comparison']['noticePrice']['status'], 'held')

    @unittest.skipUnless(HAS_FITZ, 'PyMuPDF 미설치')
    def test_detail_only_mode_verifies_upload_when_official_pdf_permission_is_off(self):
        from test_notice_pdf_fields import build_synthetic_notice_pdf
        pdf_bytes = build_synthetic_notice_pdf()
        digest = hashlib.sha256(pdf_bytes).hexdigest()
        self.work['noticeCapture']['allowOfficialPdf'] = False
        self.work['officialIndex'] = [{
            'id': doc_id(11), **self.target, 'sha256': digest,
            'role': 'notice', 'source': 'official', 'originCheck': 'confirmed',
        }]

        def pdf_fetch(url, **kw):
            self.events.append(('pdf', url))
            if url == DETAIL:
                return html_ok(page([(self.att11, NOTICE_LABEL)]))
            self.fail('allowOfficialPdf=False에서는 공식 첨부 URL을 내려받지 않아야 합니다.')

        self.assertEqual(self.run_worker(pdf=pdf_fetch, upload_bytes=pdf_bytes, inspect=inspect_notice_pdf), self.finished)
        self.assertEqual(self.calls('pdf'), [DETAIL])
        finish, = self.calls('finish_notice_with_funding')
        doc, = finish['p_result']['catalog']['documents']
        self.assertEqual((doc['source'], doc['status']), ('upload', 'accepted'))

    def test_missing_or_invalid_upload_and_storage_helper_boundaries(self):
        # Storage 객체 누락 시 upload_unavailable로 실패 기록
        result = self.run_worker(pdf=lambda url, **kw: {'status': 503, 'headers': {}, 'body': b''}, upload_bytes=None)
        self.assertEqual(result['status'], 'failed')
        failure, = self.calls('fail_notice_analysis_run')
        self.assertEqual((failure['p_error_code'], failure['p_retryable']), ('upload_unavailable', False))

        # 비PDF 바이트는 upload_not_pdf 사유로 보류하며 기본 공고 정보 유지
        self.events.clear()
        self.assertEqual(
            self.run_worker(
                pdf=lambda url, **kw: html_ok(page([(self.att11, NOTICE_LABEL)])) if url == DETAIL else {'status': 503, 'headers': {}, 'body': b''},
                upload_bytes=b'<html>not-a-pdf</html>',
            ),
            self.finished,
        )
        finish, = self.calls('finish_notice_with_funding')
        self.assertIn('upload_not_pdf', [i['code'] for i in finish['p_result']['catalog']['issues']])
        self.assertEqual(finish['p_result']['catalog']['documents'], [])

        # read_worker_storage_upload 경로 검증 및 정상 읽기
        env = {'APP_ENV': 'development', 'SUPABASE_URL': 'http://127.0.0.1:54321',
               'SUPABASE_WORKER_KEY': 'sb_secret_synthetic_test_key'}
        resp = io.BytesIO(PDF_B)
        resp.status = 200
        opener = Mock()
        opener.open.return_value = resp
        loaded = read_worker_storage_upload(env, self.upload_id, self.object_path, opener=opener)
        self.assertEqual(loaded, {'id': self.upload_id, 'content': PDF_B})
        req = opener.open.call_args.args[0]
        self.assertEqual(req.full_url, f'http://127.0.0.1:54321/storage/v1/object/analysis-uploads/{self.object_path}')
        # 잘못된 경로(경로 탐색·타 업로드 ID)는 호출하지 않는다.
        opener.reset_mock()
        self.assertIsNone(read_worker_storage_upload(env, self.upload_id, '../escape.pdf', opener=opener))
        opener.open.assert_not_called()

        # review_notice_documents.read_owned_upload는 대문자 UUID도 정규 소문자로 정규화한다.
        from review_notice_documents import read_owned_upload
        upper_uid = self.upload_id.upper()
        api_resp = io.BytesIO(PDF_B)
        api_resp.status = 200
        api_resp.headers = Mock()
        api_resp.headers.get_content_type.return_value = 'application/pdf'
        api_opener = Mock()
        api_opener.open.return_value = api_resp
        owned = read_owned_upload(self.analysis_id.upper(), upper_uid, 'synthetic-jwt', opener=api_opener)
        self.assertEqual(owned, {'id': self.upload_id.lower(), 'content': PDF_B})


if __name__ == '__main__':
    unittest.main()
