"""수집 작업자와 DB 사이에 전달되는 내용·권한·응답을 네트워크 없이 확인한다."""
import io
import json
from pathlib import Path
from unittest import TestCase
from unittest.mock import Mock
from urllib.error import HTTPError
from uuid import uuid4

from ingestion_pages import loads_source_json
from replay_ingestion import replay
from store_ingestion import save_snapshot


class SnapshotWriterTests(TestCase):
    def setUp(self):
        fixture = Path(__file__).resolve().parents[1] / 'tests/fixtures/ingestion-v0.json'
        self.bundle = loads_source_json(fixture.read_text())
        self.result = replay(self.bundle)
        self.env = {'SUPABASE_URL': 'http://127.0.0.1:54321', 'SUPABASE_WORKER_KEY': 'sb_secret_synthetic'}
        self.ids = [uuid4() for _ in range(3)]
        self.opener = Mock()

    def save(self):
        return save_snapshot(*self.ids, self.bundle['request'], self.result, env=self.env, opener=self.opener)

    def test_only_normalized_data_and_selected_conditions_reach_rpc(self):
        stored_id = str(uuid4())
        self.opener.open.return_value = io.BytesIO(json.dumps(stored_id).encode())
        self.bundle['request']['rawResponse'] = 'synthetic-extra'
        self.bundle['request']['target']['upload'] = 'synthetic-extra'
        self.assertEqual(self.save(), stored_id)
        req = self.opener.open.call_args.args[0]
        self.assertEqual(req.full_url, self.env['SUPABASE_URL'] + '/rest/v1/rpc/save_ingestion_snapshot')
        self.assertEqual(req.get_method(), 'POST')
        self.assertEqual(req.get_header('Apikey'), self.env['SUPABASE_WORKER_KEY'])
        self.assertIsNone(req.get_header('Authorization'))
        payload = json.loads(req.data)
        self.assertEqual(payload['p_result'], self.result)
        self.assertEqual(payload['p_capture_key'], str(self.ids[2]))
        self.assertNotIn('pages', payload)
        self.assertNotIn('synthetic-extra', req.data.decode())

    def test_wrong_destination_or_key_stops_before_transport(self):
        for url in ('https://other.invalid', 'http://jcaelooqogosbzrfyrhe.supabase.co',
                    'https://jcaelooqogosbzrfyrhe.supabase.co:444', 'http://other@localhost',
                    'http://localhost/unexpected', 'http://localhost?unexpected=true'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.env['SUPABASE_URL'] = url
                self.save()
        self.env.update(SUPABASE_URL='http://localhost', SUPABASE_WORKER_KEY='sb_publishable_synthetic')
        with self.assertRaises(ValueError):
            self.save()
        self.opener.open.assert_not_called()

    def test_live_capture_retries_uncertain_acknowledgement_with_identical_payload(self):
        saved_id = str(uuid4())
        self.opener.open.side_effect = [TimeoutError(), io.BytesIO(json.dumps(saved_id).encode())]
        actual = save_snapshot(*self.ids, self.bundle['request'], self.result, env=self.env,
                               opener=self.opener, retry_uncertain=True)
        self.assertEqual(actual, saved_id)
        first, second = self.opener.open.call_args_list
        self.assertEqual(first.args[0].data, second.args[0].data)

    def test_conflict_and_unconfirmed_writes_return_bounded_diagnostics(self):
        self.opener.open.side_effect = HTTPError('http://localhost', 409, 'synthetic-detail', {},
                                                 io.BytesIO(b'synthetic-detail'))
        with self.assertRaisesRegex(RuntimeError, '^저장 RPC 실패 \\(HTTP 409\\)$'):
            self.save()
        self.opener.open.side_effect = TimeoutError('synthetic-detail')
        with self.assertRaisesRegex(RuntimeError, '같은 수집 키로'):
            self.save()
        self.opener.open.side_effect = None
        self.opener.open.return_value = io.BytesIO(json.dumps(str(uuid4())).encode() + b' ' * 128 + b'other')
        with self.assertRaisesRegex(RuntimeError, '같은 수집 키로'):
            self.save()
