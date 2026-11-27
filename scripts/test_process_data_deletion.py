"""합성 삭제 작업에서 지정한 파일과 계정만 처리하고 실제 확인 전에는 완료하지 않는다."""
import io
import unittest
from unittest.mock import MagicMock
from urllib.error import HTTPError
from uuid import uuid4

from process_data_deletion import process_once
from worker_rpc import WorkerRpcError


class DeletionWorkerTests(unittest.TestCase):
    def setUp(self):
        self.owner, self.receipt = str(uuid4()), str(uuid4())
        self.path = '/'.join([self.owner, str(uuid4()), str(uuid4()) + '.pdf'])
        self.client = MagicMock(base='https://development.invalid/rest/v1/rpc/', headers={})
        self.client.opener.open.return_value.__enter__.return_value.status = 200
        self.job = dict(ownerId=self.owner, receiptId=self.receipt, scope='account', paths=[self.path], deleteAuth=False)
        self.progress = dict(receiptId=self.receipt, scope='account', status='processing')

    def test_file_then_auth_deletion_require_separate_db_confirmations(self):
        ready = dict(self.job, paths=[], deleteAuth=True)
        self.client.post.side_effect = [self.job,self.progress,ready,dict(self.progress,status='live_deleted')]
        self.assertEqual(process_once(self.client,self.receipt),'processing')
        self.assertEqual(process_once(self.client,self.receipt),'live_deleted')
        calls = [call.args[0] for call in self.client.opener.open.call_args_list]
        self.assertTrue(calls[0].full_url.endswith('/storage/v1/object/analysis-uploads'))
        self.assertIn(self.path.encode(),calls[0].data)
        self.assertTrue(calls[1].full_url.endswith('/auth/v1/admin/users/' + self.owner))
        self.assertTrue(all(call.method == 'DELETE' for call in calls))

    def test_wrong_receipt_path_or_scope_never_reaches_admin_api(self):
        for changes in [dict(receiptId=str(uuid4())),dict(paths=[self.path.replace(self.owner,str(uuid4()))]),
                        dict(paths=[self.path + '/..']),dict(paths=[self.path,self.path]),dict(deleteAuth=True),
                        dict(scope='fund',paths=[],deleteAuth=True)]:
            with self.subTest(changes=list(changes)):
                self.client.post.return_value = dict(self.job,**changes)
                with self.assertRaisesRegex(ValueError,'invalid_deletion_job'):
                    process_once(self.client,self.receipt)
        self.client.opener.open.assert_not_called()

    def test_unconfirmed_remote_operation_remains_retryable(self):
        self.client.post.return_value = self.job
        self.client.opener.open.side_effect = TimeoutError()
        with self.assertRaises(WorkerRpcError):
            process_once(self.client,self.receipt)
        self.assertEqual(self.client.post.call_count,1)
        self.client.opener.open.side_effect = HTTPError('https://synthetic.invalid',404,'',{},io.BytesIO())
        self.client.post.side_effect = [self.job,self.progress,None]
        self.assertEqual(process_once(self.client,self.receipt),'processing')
        self.assertEqual(process_once(self.client,self.receipt),'idle')

    def test_unrelated_storage_is_left_for_review_without_calls_to_storage_or_auth(self):
        self.client.post.side_effect = WorkerRpcError(409,'PT409')
        self.assertEqual(process_once(self.client,self.receipt),'storage_review_required')
        self.client.opener.open.assert_not_called()
