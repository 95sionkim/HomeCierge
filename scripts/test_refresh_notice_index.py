"""정기 공고 갱신은 합성 청약홈 응답과 전송 대역으로 검수한다."""
import hashlib
import io
import json
import os
import tempfile
import unittest
import zipfile
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime
from pathlib import Path
from unittest.mock import Mock, patch
from urllib.parse import parse_qs

import refresh_notice_index as refresh
from build_notice_search_index import build_notice_search_index, read_region_codes_bytes
from ingestion_pages import ReplayTransport
from test_build_notice_search_index import APT, REMAINDER, detail, endpoint_row, model, page
from worker_rpc import WorkerRpcError

OBSERVED = datetime.fromisoformat('2026-10-31T15:01:00+00:00')
WINDOW = {'start': '2026-08-04', 'end': '2026-11-01'}
SCOPE = {'cond[RCRIT_PBLANC_DE::GTE]': '2026-08-04', 'cond[RCRIT_PBLANC_DE::LTE]': '2026-11-01'}
REGION_TSV = '법정동코드\t법정동명\t폐지여부\n1199100000\t서울특별시 합성구\t존재\n'.encode('cp949')
DEV_ENV = {
    'APP_ENV': 'development',
    'SUPABASE_URL': 'https://jcaelooqogosbzrfyrhe.supabase.co', 'SUPABASE_WORKER_KEY': 'sb_secret_' + 'synthetic',
}


def listing(source, rows=(), *, size=100, **kwargs):
    return page(source, list(rows), scope=SCOPE, size=size, **kwargs)


def region_archive():
    data = io.BytesIO()
    with zipfile.ZipFile(data, 'w') as archive:
        archive.writestr('법정동코드 전체자료.txt', REGION_TSV)
    return data.getvalue()


class NoticeRefreshTests(unittest.TestCase):
    def setUp(self):
        self.regions = read_region_codes_bytes(REGION_TSV)

    def execute(self, entries, *, env=DEV_ENV, rpc_effect=None, transport=None, times=None):
        replay = ReplayTransport({'dataOrigin': 'synthetic', 'pages': entries})
        with (patch.dict(os.environ, env, clear=True), patch.object(refresh, 'datetime', wraps=datetime) as clock,
              patch.object(refresh, 'load_regions', return_value=self.regions) as load,
              patch.object(refresh, 'live_api_transport', return_value=transport or replay) as api,
              patch.object(refresh, 'sleep') as wait,
              patch('worker_rpc.WorkerRpc.post', return_value=None, side_effect=rpc_effect) as rpc,
              redirect_stdout(io.StringIO()) as out):
            clock.now.return_value = OBSERVED
            clock.now.side_effect = times
            exit_code = refresh.main(['--live', '--publish'])
        return exit_code, json.loads(out.getvalue()), rpc, replay, load, api, wait

    def test_korean_today_fixed_includes_previous_month_and_prioritizes_open_then_upcoming(self):
        opened = endpoint_row(RCRIT_PBLANC_DE='2026-10-29', RCEPT_BGNDE='2026-11-01', RCEPT_ENDDE='2026-11-02')
        upcoming = endpoint_row(REMAINDER, PBLANC_NO='9900000043', RCRIT_PBLANC_DE='2026-10-30',
                                SUBSCRPT_RCEPT_BGNDE='2026-11-03', SUBSCRPT_RCEPT_ENDDE='2026-11-03')
        unknown = endpoint_row(PBLANC_NO='9900000041', RCRIT_PBLANC_DE='2026-10-31', RCEPT_BGNDE=None)
        closed = endpoint_row(PBLANC_NO='9900000040')
        entries = [listing(APT, [closed, unknown, opened]), listing(REMAINDER, [upcoming]),
                   *detail(opened, [model()], size=100),
                   *detail(upcoming, [model(PBLANC_NO='9900000043')], source=REMAINDER, size=100)]
        with patch.object(refresh, 'DETAIL_NOTICE_LIMIT', 2), patch('build_notice_search_index.review_catalog_documents') as pdf:
            status, report, rpc, replay, *_ = self.execute(entries)
        self.assertEqual(status, 0)
        self.assertEqual(report['publicationWindow'], WINDOW)
        self.assertEqual(report['status'], 'published')
        self.assertEqual(report['budget']['pdfGets'], 0)
        pdf.assert_not_called()
        rpc.assert_called_once()
        rpc_name, arguments = rpc.call_args.args
        self.assertEqual(rpc_name, 'publish_notice_directory')
        self.assertEqual(arguments['p_regions'], {'11991': '서울특별시 합성구'})
        rows = {item['noticeNo']: item for item in arguments['p_index']['notices']}
        self.assertEqual(rows['9900000042']['models'], [{'modelNo': '01', 'houseType': '084.0000A',
                                                        'supplyAreaM2': None, 'areaEvidence': [], 'rooms': []}])
        self.assertEqual(rows['9900000043']['sourceIds'], [REMAINDER, REMAINDER + '_model'])
        self.assertEqual(rows['9900000042']['edition'], '2026-10-29')
        for notice in ('9900000040', '9900000041'):
            self.assertEqual(rows[notice]['models'], [])
            self.assertIn('detail_budget_exhausted', rows[notice]['reasonCodes'])
        self.assertEqual([json.loads(item)[0] for item in replay.requests],
                         [APT, REMAINDER, APT, APT + '_model', REMAINDER, REMAINDER + '_model'])
        public_log = json.dumps(report, ensure_ascii=False)
        for value in ('가람 아파트', '9900000042', '084.0000A', '750000000', 'synthetic'):
            self.assertNotIn(value, public_log)

    def test_missing_feed_and_list_page_cap_leave_previous_publication_untouched(self):
        row = endpoint_row()
        cases = (
            ([listing(APT, [row], size=1)], REMAINDER, 'replay_response_not_provided'),
            ([listing(APT, [row], size=1, count=2), listing(REMAINDER, size=1)], APT, 'page_limit_reached'),
        )
        with patch.object(refresh, 'LIST_PAGE_LIMIT', 1), patch.object(refresh, 'PAGE_SIZE', 1):
            for entries, source, reason in cases:
                with self.subTest(reason=reason):
                    status, report, rpc, replay, *_ = self.execute(entries)
                    self.assertEqual(status, 2)
                    self.assertEqual(report['status'], 'kept_previous')
                    self.assertIn(reason, report['listDiagnostics'][source]['reasonCodes'])
                    self.assertEqual(len(replay.requests), 2)  # 두 목록만 읽고 상세 호출은 생략한다.
                    rpc.assert_not_called()

    def test_missing_model_is_an_unverified_detail_without_model_source(self):
        row = endpoint_row(RCEPT_BGNDE='2026-11-01', RCEPT_ENDDE='2026-11-02')
        entries = [listing(APT, [row]), listing(REMAINDER), *detail(row, [], size=100)]
        status, report, rpc, *_ = self.execute(entries)
        self.assertEqual(status, 0)
        (notice,) = rpc.call_args.args[1]['p_index']['notices']
        self.assertEqual(notice['models'], [])
        self.assertEqual(notice['sourceIds'], [APT])
        self.assertIn('model_unverified', notice['reasonCodes'])
        self.assertEqual(report['reasonCounts']['model_unverified'], 1)

    def test_nonpublic_model_label_is_unverified_for_the_directory(self):
        row = endpoint_row(RCEPT_BGNDE='2026-11-01', RCEPT_ENDDE='2026-11-02')
        entries = [listing(APT, [row]), listing(REMAINDER), *detail(row, [model(HOUSE_TY='합성@표기')], size=100)]
        status, _, rpc, *_ = self.execute(entries)
        self.assertEqual(status, 0)
        (notice,) = rpc.call_args.args[1]['p_index']['notices']
        self.assertIsNone(notice['models'][0]['houseType'])
        self.assertIn('model_unverified', notice['reasonCodes'])

    def test_model_page_limit_marks_retained_model_list_incomplete(self):
        row = endpoint_row(RCEPT_BGNDE='2026-11-01', RCEPT_ENDDE='2026-11-02')
        notice_page, model_page = detail(row, [model()], size=1)
        model_page['body']['matchCount'] = 2
        entries = [listing(APT, [row], size=1), listing(REMAINDER, size=1), notice_page, model_page]
        with patch.object(refresh, 'PAGE_SIZE', 1), patch.object(refresh, 'DETAIL_PAGE_LIMIT', 1):
            status, report, rpc, *_ = self.execute(entries)
        self.assertEqual(status, 0)
        (notice,) = rpc.call_args.args[1]['p_index']['notices']
        self.assertEqual([entry['modelNo'] for entry in notice['models']], ['01'])
        self.assertIn('model_unverified', notice['reasonCodes'])
        self.assertEqual(report['reasonCounts']['detail_page_limit_reached'], 1)

    def test_persistent_feed_timeout_never_replaces_previous_publication(self):
        def fetch(source, scope, number, size):
            response = listing(source, size=size)
            if source == REMAINDER:
                return dict(response, httpStatus=None, transportError='timeout', body=None)
            return response

        status, report, rpc, *_ = self.execute([], transport=fetch)
        self.assertEqual(status, 2)
        self.assertEqual(report['status'], 'kept_previous')
        self.assertEqual(report['apiAttempts'], {APT: 1, REMAINDER: 3})
        self.assertIn('upstream_timeout', report['listDiagnostics'][REMAINDER]['reasonCodes'])
        rpc.assert_not_called()

    def test_transient_http_is_retried_and_unknown_commit_reuses_the_same_payload(self):
        attempts = []

        def fetch(source, scope, number, size):
            attempts.append(source)
            response = listing(source, size=size)
            return dict(response, httpStatus=503, body='합성 실패 원문') if len(attempts) == 1 else response

        status, report, rpc, *_, wait = self.execute([], rpc_effect=[WorkerRpcError(), None], transport=fetch)
        self.assertEqual(status, 0)
        self.assertEqual(attempts, [APT, APT, REMAINDER])
        self.assertEqual(report['apiAttempts'], {APT: 2, REMAINDER: 1})
        self.assertEqual(len(rpc.call_args_list), 2)
        self.assertEqual(rpc.call_args_list[0], rpc.call_args_list[1])
        self.assertEqual(wait.call_count, 2)
        self.assertNotIn('합성 실패 원문', json.dumps(report, ensure_ascii=False))

    def test_exhausted_rpc_timeout_reports_commit_unknown(self):
        status, report, rpc, *_ = self.execute([listing(APT), listing(REMAINDER)],
                                              rpc_effect=[WorkerRpcError()] * 3)
        self.assertEqual(status, 2)
        self.assertEqual(report['status'], 'publication_unconfirmed')
        self.assertEqual(rpc.call_count, 3)

    def test_missing_credentials_and_production_configuration_are_refused(self):
        for env in ({}, dict(DEV_ENV, APP_ENV='production'), dict(DEV_ENV, VERCEL_ENV='production'),
                    dict(DEV_ENV, SUPABASE_WORKER_KEY='sb_publishable_' + 'synthetic')):
            with self.subTest(mode=env.get('APP_ENV')):
                status, report, rpc, _, load, api, _ = self.execute([], env=env)
                self.assertEqual(status, 2)
                self.assertEqual(report['status'], 'refused')
                load.assert_not_called()
                api.assert_not_called()
                rpc.assert_not_called()

    def test_flags_and_region_file_pin_are_checked_before_loading_sources(self):
        for args in ([], ['--live'], ['--publish'], ['--live', '--publish', '--fixture', 'synthetic.json'],
                     ['--live', '--publish', '--region-codes', 'synthetic.txt'],
                     ['--live', '--publish', '--region-codes-sha256', '0' * 64]):
            with (self.subTest(args=args), patch.object(refresh, 'live_api_transport') as api,
                  patch.object(refresh, 'load_regions') as load, redirect_stderr(io.StringIO()),
                  redirect_stdout(io.StringIO()), patch.dict(os.environ, DEV_ENV, clear=True),
                  self.assertRaises(SystemExit) as exit_):
                refresh.main(args)
            self.assertEqual(exit_.exception.code, 2)
            api.assert_not_called()
            load.assert_not_called()

    def test_collection_started_on_the_previous_korean_day_is_not_published(self):
        next_day = datetime.fromisoformat('2026-11-01T15:00:00+00:00')
        status, report, rpc, *_ = self.execute([listing(APT), listing(REMAINDER)], times=[OBSERVED, next_day])
        self.assertEqual(status, 2)
        self.assertEqual(report['status'], 'kept_previous')
        self.assertEqual(report['publicationWindow'], WINDOW)
        rpc.assert_not_called()

    def test_collected_publication_refuses_synthetic_index(self):
        replay = ReplayTransport({'dataOrigin': 'synthetic', 'pages': [listing(APT), listing(REMAINDER)]})
        index = build_notice_search_index(WINDOW['start'], WINDOW['end'], self.regions, replay)
        client = Mock()
        with self.assertRaises(ValueError):
            refresh.publish_directory(index, self.regions.names(), client, {})
        client.post.assert_not_called()

    def test_default_region_source_requests_the_official_zip_with_a_form_post(self):
        with patch('refresh_notice_index.request.build_opener') as opener:
            stream = io.BytesIO(region_archive())
            stream.status = 200
            opener.return_value.open.return_value = stream
            self.assertEqual(refresh.load_regions().names(), {'11991': '서울특별시 합성구'})
        (call,) = opener.return_value.open.call_args.args
        self.assertEqual(call.full_url, 'https://www.code.go.kr/etc/codeFullDown.do')
        self.assertEqual(call.get_method(), 'POST')
        self.assertEqual(call.get_header('Referer'), 'https://www.code.go.kr/stdcode/regCodeL.do')
        self.assertEqual(call.get_header('Content-type'), 'application/x-www-form-urlencoded')
        self.assertEqual(parse_qs(call.data.decode('ascii')), {'codeseId': ['법정동코드']})

    def test_local_region_input_accepts_pinned_zip_or_txt_without_downloading(self):
        with tempfile.TemporaryDirectory() as directory, patch('refresh_notice_index.request.build_opener') as opener:
            file = Path(directory) / 'synthetic-region-codes'
            for data in (REGION_TSV, region_archive()):
                file.write_bytes(data)
                with self.assertRaises(ValueError):
                    refresh.load_regions(file, '0' * 64)
                self.assertEqual(refresh.load_regions(file, hashlib.sha256(data).hexdigest()).names(),
                                 {'11991': '서울특별시 합성구'})
        opener.assert_not_called()
