#!/usr/bin/env python3
"""법령 근거 수집의 오프라인 검사. 응답·인증 설정·RPC는 합성 자료만 사용한다."""
import copy
import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime
from pathlib import Path
from unittest.mock import MagicMock, Mock, patch
from urllib.error import URLError
from urllib.parse import parse_qs, urlsplit

from collect_law_evidence import (LawEvidenceHold, collect_law_reference, collect_live_reference,
                                  live_transport, main)
from worker_rpc import WorkerRpcError, WorkerRpcResponseTooLarge


FIXTURE = json.loads((Path(__file__).resolve().parents[1]
                      / 'tests/fixtures/law-evidence-synthetic.json').read_text(encoding='utf-8'))
AS_OF = FIXTURE['asOf']
OBSERVED_AT = datetime.fromisoformat(FIXTURE['observedAt'])
TITLE = '주택공급에 관한 규칙'
EXPECTED = {
    'contractVersion': 'law-reference/v1', 'dataOrigin': 'synthetic', 'asOf': AS_OF,
    'observedAt': FIXTURE['observedAt'], 'title': TITLE, 'mst': '900001', 'lawId': '090001',
    'promulgatedOn': '2026-04-07', 'effectiveOn': '2026-05-12',
    'articles': [
        {'number': '12', 'branch': None, 'heading': '합성 모집 공고 예시'},
        {'number': '25', 'branch': '3', 'heading': '합성 재공급 예시'},
    ],
}


def page(rows, number=1, total=None):
    metadata = dict(FIXTURE['search']['LawSearch'], page=str(number), numOfRows=len(rows),
                    totalCnt=len(rows) if total is None else str(total), law=rows)
    return {'LawSearch': metadata}


class LawEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.search = copy.deepcopy(FIXTURE['search'])
        self.rows = self.search['LawSearch']['law']
        self.body = copy.deepcopy(FIXTURE['body'])
        self.basic = self.body['법령']['기본정보']
        self.articles = self.body['법령']['조문']['조문단위']

    def fetch(self, name, params):
        if name == 'law_search' and params == {'page': 1}:
            return self.search
        self.assertEqual((name, params), ('law_body', {'MST': '900001', 'efYd': '20260512'}))
        return self.body

    def collect(self, fetch=None, **kwargs):
        options = {'observed_at': OBSERVED_AT, 'data_origin': 'synthetic', **kwargs}
        return collect_law_reference(AS_OF, fetch or self.fetch, **options)

    def assert_held(self, reason, fetch=None):
        with self.assertRaises(LawEvidenceHold) as attempt:
            self.collect(fetch)
        self.assertEqual(attempt.exception.reason, reason)

    def test_project_only_reference_metadata_with_observed_offset(self):
        self.assertEqual(self.collect(), EXPECTED)

    def test_read_all_pages_before_picking_latest_exact_version(self):
        future = dict(self.rows[0], 법령일련번호='900003', 공포일자='20260513', 시행일자='20260512')
        prior = dict(self.rows[1], 법령일련번호='900004', 시행일자='20260511')
        unrelated = [dict(self.rows[1], 법령명한글=TITLE + ' 시행규정', 법령일련번호=str(910000 + i))
                     for i in range(96)]
        first = page([self.rows[0], future, prior, dict(self.rows[0], 시행일자='20260701')]
                     + unrelated, total=101)
        last = page([self.rows[1]], number=2, total=101)
        # 실제 API는 한 건짜리 컨테이너를 객체로도 표현한다.
        last['LawSearch']['law'] = self.rows[1]
        fetch = Mock(side_effect=[first, last, self.body])
        self.assertEqual(self.collect(fetch), EXPECTED)
        self.assertEqual([call.args for call in fetch.call_args_list], [
            ('law_search', {'page': 1}), ('law_search', {'page': 2}),
            ('law_body', {'MST': '900001', 'efYd': '20260512'}),
        ])

    def test_wrong_page_or_count_metadata_holds_before_body(self):
        for field, value in [('page', '2'), ('totalCnt', '3'), ('numOfRows', '3'),
                             ('totalCnt', True)]:
            with self.subTest(field=field, value=value):
                response = {'LawSearch': dict(self.search['LawSearch'], **{field: value})}
                fetch = Mock(return_value=response)
                self.assert_held('law_search_incomplete', fetch)
                fetch.assert_called_once_with('law_search', {'page': 1})

    def test_moving_total_and_repeated_version_hold_even_with_enough_rows(self):
        first_rows = [dict(self.rows[1], 법령일련번호=str(910000 + i)) for i in range(100)]
        first = page(first_rows, total=101)
        for last in [page([self.rows[1]], 2, 102), page(first_rows[:1], 2, 101)]:
            with self.subTest(last=last['LawSearch']['totalCnt']):
                fetch = Mock(side_effect=[first, last])
                self.assert_held('law_search_incomplete', fetch)
                self.assertEqual(fetch.call_count, 2)

    def test_search_is_bounded_and_api_error_does_not_look_empty(self):
        self.assert_held('law_search_limit', Mock(return_value=page(self.rows, total=501)))
        invalid = {'LawSearch': dict(self.search['LawSearch'], resultCode='99')}
        self.assert_held('law_search_unverified', Mock(return_value=invalid))
        self.assert_held('law_search_unverified', Mock(return_value={'error': '합성 비공개 값'}))

    def test_no_candidate_is_held_and_never_queries_current_body(self):
        for rows in [[], self.rows[:1], [dict(self.rows[1], 법령명한글=TITLE + ' 시행규정')]]:
            with self.subTest(count=len(rows)):
                fetch = Mock(return_value=page(rows))
                self.assert_held('law_version_not_found', fetch)
                fetch.assert_called_once()

    def test_same_effective_day_with_different_mst_is_ambiguous(self):
        other = dict(self.rows[1], 법령일련번호='900004', 공포일자='20260408', 공포번호='09004')
        self.assert_held('law_version_ambiguous', Mock(return_value=page([self.rows[1], other])))

    def test_missing_and_invalid_identity_metadata_are_held(self):
        for field, value in [('법령ID', ''), ('공포일자', '20260431'), ('공포번호', None),
                             ('시행일자', '2026-05-12')]:
            with self.subTest(field=field):
                response = page([dict(self.rows[1], **{field: value})])
                self.assert_held('law_search_incomplete' if field == '시행일자' else 'law_version_unverified',
                                 Mock(return_value=response))

    def test_body_metadata_and_any_echoed_mst_must_match(self):
        for field, value in [('법령명_한글', TITLE + ' 시행규정'), ('법령ID', '090010'),
                             ('시행일자', '20260511'), ('공포일자', '20260406'), ('공포번호', '09099'),
                             ('법령일련번호', '900004'), ('시행일자', None)]:
            with self.subTest(field=field, value=value):
                body = {'법령': dict(self.body['법령'], 기본정보=dict(self.basic, **{field: value}))}
                self.assert_held('law_body_unverified', Mock(side_effect=[self.search, body]))

    def test_body_numeric_metadata_can_have_different_zero_padding(self):
        self.basic.update(법령ID=90001, 공포번호=9001, MST=900001)
        self.assertEqual(self.collect(), EXPECTED)

    def test_article_number_branch_and_title_are_validated(self):
        for field, value in [('조문번호', '0'), ('조문번호', '12.5'), ('조문가지번호', '-3'),
                             ('조문제목', '합성 공고\n본문'), ('조문제목', '합성 공고 <b>markup</b>'),
                             ('조문시행일자', ''), ('조문여부', '미확인')]:
            with self.subTest(field=field):
                articles = [dict(self.articles[2], **{field: value})]
                self.body['법령']['조문']['조문단위'] = articles
                self.assert_held('law_articles_unverified')
        self.body['법령']['조문']['조문단위'] = [self.articles[2], dict(self.articles[2], 조문번호='12')]
        self.assert_held('law_articles_unverified')

    def test_future_articles_are_not_presented_as_navigation(self):
        self.articles[1]['조문시행일자'] = '20260513'
        self.assertEqual(self.collect()['articles'], EXPECTED['articles'][:1])

    def test_contract_and_eligibility_are_heading_matches_only(self):
        row = self.articles[2]
        self.body['법령']['조문']['조문단위'] = [
            dict(row, 조문제목='합성 주택의 공급 계약', 조문가지번호='00'),
            dict(row, 조문번호='14', 조문제목='합성 입주대상자 자격 확인'),
            dict(row, 조문번호='15', 조문제목='합성 연습', 조문내용='합성 공급자격·재공급 조문 내용'),
        ]
        self.assertEqual(self.collect()['articles'], [
            {'number': '12', 'branch': None, 'heading': '합성 주택의 공급 계약'},
            {'number': '14', 'branch': None, 'heading': '합성 입주대상자 자격 확인'},
        ])

    def test_empty_nonarticle_and_nonmatching_headings_do_not_confirm_provisions(self):
        for units in (None, [], [self.articles[0], self.articles[3]],
                      [dict(self.articles[2], 조문제목='')]):
            with self.subTest(units=units):
                self.body['법령']['조문']['조문단위'] = units
                self.assert_held('law_articles_not_found')

    def test_bad_date_and_future_as_of_do_not_call_source(self):
        fetch = Mock()
        for as_of, reason in [('20260512', 'invalid_date'), ('2026-02-30', 'invalid_date'),
                              ('2026-05-14', 'notice_date_future')]:
            with self.subTest(as_of=as_of), self.assertRaises(LawEvidenceHold) as attempt:
                collect_law_reference(as_of, fetch, observed_at=OBSERVED_AT, data_origin='synthetic')
            self.assertEqual(attempt.exception.reason, reason)
        fetch.assert_not_called()

    def test_live_transport_passes_only_fixed_probe_parameters_and_bounds_read(self):
        opener = MagicMock()
        response = opener.open.return_value.__enter__.return_value
        response.status = 200
        response.read.side_effect = [json.dumps(self.search).encode(), json.dumps(self.body).encode()]
        fetch = live_transport('synthetic-law-credential', opener=opener)
        self.assertEqual(self.collect(fetch), EXPECTED)
        for call, expected_path, expected_query in zip(opener.open.call_args_list, [
                '/DRF/lawSearch.do', '/DRF/lawService.do'], [
                {'query': [TITLE], 'display': ['100'], 'nw': ['1,2,3'], 'page': ['1']},
                {'MST': ['900001'], 'efYd': ['20260512']},
        ]):
            address = urlsplit(call.args[0].full_url)
            self.assertEqual((address.scheme, address.netloc, address.path),
                             ('https', 'www.law.go.kr', expected_path))
            self.assertEqual(parse_qs(address.query), dict(expected_query, target=['eflaw'], type=['JSON'],
                                                            OC=['synthetic-law-credential']))
            self.assertGreater(call.kwargs['timeout'], 0)
        self.assertTrue(all(0 < call.args[0] <= 4_194_305 for call in response.read.call_args_list))

    def test_invalid_transport_output_or_exception_does_not_expose_source(self):
        for failed in (URLError('synthetic-sensitive-upstream-reason'),
                       b'{"error":"synthetic-sensitive-upstream-reason","error":"dup"}',
                       b'X' * 4_194_306):
            with self.subTest(failure=type(failed).__name__):
                opener = MagicMock()
                response = opener.open.return_value.__enter__.return_value
                response.status = 200
                if isinstance(failed, Exception):
                    opener.open.side_effect = failed
                else:
                    response.read.return_value = failed
                with self.assertRaises(LawEvidenceHold) as attempt:
                    self.collect(live_transport('synthetic-law-credential', opener=opener))
                self.assertNotIn('synthetic-sensitive-upstream-reason', str(attempt.exception))


class LawEvidenceCliTests(unittest.TestCase):
    def run_main(self, args):
        output, errors = io.StringIO(), io.StringIO()
        with redirect_stdout(output), redirect_stderr(errors):
            status = main(args)
        self.assertEqual(errors.getvalue(), '')
        return status, json.loads(output.getvalue())

    def test_default_cli_has_no_credentials_no_network_and_no_raw_body(self):
        with patch('collect_law_evidence.read_keys') as keys, patch('collect_law_evidence.live_transport') as live:
            self.assertEqual(self.run_main([]), (0, {'status': 'verified', 'reasonCodes': [], 'reference': EXPECTED}))
        keys.assert_not_called()
        live.assert_not_called()

    def test_cli_rejects_nonlive_publish_and_live_without_date(self):
        for args in (['--publish'], ['--live']):
            with self.subTest(args=args), redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as attempt:
                main(args)
            self.assertEqual(attempt.exception.code, 2)

    @patch('collect_law_evidence.collect_live_reference')
    def test_live_cli_uses_the_public_collector_and_returns_hold_exit_code(self, collect):
        collect.return_value = {'status': 'held', 'reasonCodes': ['law_publish_forbidden'], 'reference': None}
        self.assertEqual(self.run_main(['--live', '--date', AS_OF, '--publish']), (2, collect.return_value))
        collect.assert_called_once_with(AS_OF, publish=True)

    @patch('collect_law_evidence.WorkerRpc')
    @patch('collect_law_evidence.live_transport')
    @patch('collect_law_evidence.read_keys', return_value={'LAW_OC': 'synthetic-law-credential'})
    def test_live_publish_only_sends_verified_contract(self, keys, transport, rpc):
        transport.return_value = Mock(side_effect=[FIXTURE['search'], FIXTURE['body']])
        rpc.return_value.post.return_value = None
        code, output = self.run_main(['--live', '--date', AS_OF, '--publish'])
        self.assertEqual((code, output['status'], output['reasonCodes']), (0, 'published', []))
        reference = output['reference']
        self.assertIsNotNone(datetime.fromisoformat(reference['observedAt']).tzinfo)
        self.assertEqual(reference, dict(EXPECTED, dataOrigin='collected', observedAt=reference['observedAt']))
        rpc.return_value.post.assert_called_once_with('publish_law_reference', {'p_reference': reference},
                                                      allow_no_content=True)

    @patch('collect_law_evidence.WorkerRpc')
    @patch('collect_law_evidence.live_transport')
    @patch('collect_law_evidence.read_keys', return_value={'LAW_OC': 'synthetic-law-credential'})
    def test_failed_verification_prevents_publication(self, keys, transport, rpc):
        body = {'법령': dict(FIXTURE['body']['법령'], 조문={})}
        transport.return_value = Mock(side_effect=[FIXTURE['search'], body])
        self.assertEqual(self.run_main(['--live', '--date', AS_OF, '--publish']),
                         (2, {'status': 'held', 'reasonCodes': ['law_articles_not_found'], 'reference': None}))
        rpc.return_value.post.assert_not_called()

    @patch('collect_law_evidence.WorkerRpc')
    @patch('collect_law_evidence.live_transport')
    @patch('collect_law_evidence.read_keys', return_value={'LAW_OC': 'synthetic-law-credential'})
    def test_reflected_credential_in_heading_is_held_and_never_output(self, keys, transport, rpc):
        body = copy.deepcopy(FIXTURE['body'])
        body['법령']['조문']['조문단위'][2]['조문제목'] = '합성 공고 synthetic-law-credential'
        transport.return_value = Mock(side_effect=[FIXTURE['search'], body])
        self.assertEqual(self.run_main(['--live', '--date', AS_OF, '--publish']),
                         (2, {'status': 'held', 'reasonCodes': ['law_articles_unverified'], 'reference': None}))
        rpc.return_value.post.assert_not_called()

    @patch('collect_law_evidence.WorkerRpc')
    @patch('collect_law_evidence.live_transport')
    @patch('collect_law_evidence.read_keys', return_value={'LAW_OC': 'synthetic-law-credential'})
    def test_live_module_can_read_without_publishing(self, keys, transport, rpc):
        transport.return_value = Mock(side_effect=[FIXTURE['search'], FIXTURE['body']])
        out = io.StringIO()
        with redirect_stdout(out):
            result = collect_live_reference(AS_OF)
        self.assertEqual(out.getvalue(), '')
        self.assertEqual(result['status'], 'verified')
        self.assertEqual(result['reference']['lawId'], EXPECTED['lawId'])
        rpc.assert_not_called()

    @patch('collect_law_evidence.WorkerRpc')
    @patch('collect_law_evidence.live_transport')
    @patch('collect_law_evidence.read_keys', return_value={'LAW_OC': 'synthetic-law-credential'})
    def test_publication_failure_holds_without_returning_a_reference(self, keys, transport, rpc):
        publish = rpc.return_value.post
        for error, reason in (
                (WorkerRpcError(401), 'law_publish_forbidden'),
                (WorkerRpcError(403, '42501'), 'law_publish_forbidden'),
                (WorkerRpcError(400, '22023'), 'law_publish_invalid_reference'),
                (WorkerRpcError(409, 'PT409'), 'law_publish_conflict'),
                (WorkerRpcResponseTooLarge(), 'law_publish_response_invalid'),
                (WorkerRpcError(404), 'law_publish_failed')):
            with self.subTest(reason=reason, http=error.status):
                transport.return_value = Mock(side_effect=[FIXTURE['search'], FIXTURE['body']])
                publish.reset_mock()
                publish.side_effect = error
                self.assertEqual(collect_live_reference(AS_OF, publish=True),
                                 {'status': 'held', 'reasonCodes': [reason], 'reference': None})
                publish.assert_called_once()

    @patch('collect_law_evidence.WorkerRpc')
    @patch('collect_law_evidence.live_transport')
    @patch('collect_law_evidence.read_keys', return_value={'LAW_OC': 'synthetic-law-credential'})
    def test_unexpected_rpc_acknowledgement_is_not_a_publication(self, keys, transport, rpc):
        transport.return_value = Mock(side_effect=[FIXTURE['search'], FIXTURE['body']])
        rpc.return_value.post.return_value = {'message': '합성 서버 응답'}
        self.assertEqual(collect_live_reference(AS_OF, publish=True),
                         {'status': 'held', 'reasonCodes': ['law_publish_response_invalid'], 'reference': None})

    @patch('collect_law_evidence.WorkerRpc')
    @patch('collect_law_evidence.live_transport')
    @patch('collect_law_evidence.read_keys', return_value={'LAW_OC': 'synthetic-law-credential'})
    def test_lost_acknowledgement_retries_the_same_verified_observation_once(self, keys, transport, rpc):
        transport.return_value = Mock(side_effect=[FIXTURE['search'], FIXTURE['body']])
        publish = rpc.return_value.post
        publish.side_effect = [WorkerRpcError(), None]
        result = collect_live_reference(AS_OF, publish=True)
        self.assertEqual((result['status'], result['reasonCodes']), ('published', []))
        self.assertEqual(publish.call_count, 2)
        self.assertEqual(publish.call_args_list[0], publish.call_args_list[1])
        self.assertEqual(publish.call_args.args[1], {'p_reference': result['reference']})
        self.assertEqual(transport.return_value.call_count, 2)

    @patch('collect_law_evidence.WorkerRpc')
    @patch('collect_law_evidence.live_transport')
    @patch('collect_law_evidence.read_keys', return_value={'LAW_OC': 'synthetic-law-credential'})
    def test_unknown_publication_outcome_holds_without_reference(self, keys, transport, rpc):
        publish = rpc.return_value.post
        transport.return_value = Mock(side_effect=[FIXTURE['search'], FIXTURE['body']])
        publish.side_effect = [WorkerRpcError(504), WorkerRpcError()]
        self.assertEqual(self.run_main(['--live', '--date', AS_OF, '--publish']),
                         (2, {'status': 'held', 'reasonCodes': ['law_publish_unconfirmed'], 'reference': None}))
        self.assertEqual(publish.call_count, 2)


if __name__ == '__main__':
    unittest.main()
