"""합성 청약홈 응답으로 문서 작업자의 법령 조회 시점과 독립적인 실패 처리를 검사한다."""
import io
import json
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from ingestion_pages import ReplayTransport, loads_source_json
from replay_ingestion import replay
from review_notice_documents import main, review_law_for_notice


class NoticeLawFlowTests(unittest.TestCase):
    def setUp(self):
        fixture = Path(__file__).resolve().parents[1] / 'tests/fixtures/ingestion-v0.json'
        self.bundle = loads_source_json(fixture.read_text(encoding='utf-8'))

    def test_saved_notice_passes_only_its_publication_date_and_keeps_the_snapshot_if_law_fails(self):
        snapshot_id = '10000000-0000-4000-8000-000000000005'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'request.json'
            path.write_text(json.dumps(self.bundle['request']), encoding='utf-8')
            args = ['review', '--live', '--with-law', '--request', str(path), '--save',
                    '--owner-id', '10000000-0000-4000-8000-000000000001',
                    '--analysis-id', '10000000-0000-4000-8000-000000000002',
                    '--capture-key', '10000000-0000-4000-8000-000000000003']
            output = io.StringIO()
            with patch.object(sys, 'argv', args), redirect_stdout(output), \
                    patch('review_notice_documents.live_api_transport', return_value=ReplayTransport(self.bundle)), \
                    patch('notice_document_review.review_catalog_documents',
                          return_value={'evidence': [], 'issues': [], 'review': {'paymentSchedules': []}}), \
                    patch('review_notice_documents.save_snapshot', return_value=snapshot_id) as save, \
                    patch('collect_law_evidence.collect_live_reference', side_effect=OSError('synthetic')) as lookup:
                self.assertEqual(main(), 0)
        save.assert_called_once()
        lookup.assert_called_once_with('2026-10-05', publish=True)
        self.assertEqual(json.loads(output.getvalue()), {'snapshotId': snapshot_id, 'lawReview': {
            'status': 'held', 'reasonCodes': ['law_lookup_unavailable'], 'reference': None}})

    def test_partial_or_unverified_date_does_not_trigger_external_lookup(self):
        cases = [('date', '2026-02-30'), ('status', 'partial'), ('declaredStatus', 'partial'), ('evidence', [])]
        with patch('collect_law_evidence.collect_live_reference') as lookup:
            for field, value in cases:
                with self.subTest(field=field):
                    catalog = replay(self.bundle)['catalog']
                    if field == 'date':
                        catalog['notice']['fields']['RCRIT_PBLANC_DE']['value'] = value
                    elif field == 'evidence':
                        catalog['notice'][field] = value
                    else:
                        catalog['collections']['notice'][field] = value
                    self.assertEqual(review_law_for_notice(catalog, publish=False)['reasonCodes'], ['notice_date_unverified'])
        lookup.assert_not_called()

    def test_review_without_save_only_reads_the_verified_public_date(self):
        catalog = replay(self.bundle)['catalog']
        catalog['notice']['fields']['RCRIT_PBLANC_DE']['value'] = '2026.10.05'
        receipt = {'status': 'verified', 'reasonCodes': [], 'reference': {'asOf': '2026-10-05'}}
        with patch('collect_law_evidence.collect_live_reference', return_value=receipt) as lookup:
            self.assertEqual(review_law_for_notice(catalog, publish=False), receipt)
        lookup.assert_called_once_with('2026-10-05', publish=False)
