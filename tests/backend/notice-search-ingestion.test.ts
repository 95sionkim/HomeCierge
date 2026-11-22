// 합성 청약홈 목록과 문서의 정규화 결과를 실제 검색 판정기에 전달한다.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { evaluateNoticeSearch, parseNoticeSearchConditions } from '../../src/server/notice-search.js';

test('published search shape carries a confirmed room and preserves its neighbour with missing options', () => {
  const python = `
import json, sys, tempfile
from pathlib import Path
sys.path.insert(0, 'scripts')
from build_notice_search_index import build_notice_search_index, read_region_codes
from ingestion_pages import ReplayTransport
from test_build_notice_search_index import (APT, REMAINDER, START, END, REGION_TSV, OBSERVED, detail,
    endpoint_row, get_synthetic_documents, inspect_synthetic_pages, model, official_paths, page)
row = endpoint_row(PBLANC_URL=official_paths()[0])
pages = [page(APT, [row]), page(REMAINDER, []), *detail(row, [model()])]
with tempfile.TemporaryDirectory() as folder:
    path = Path(folder) / 'synthetic.tsv'
    path.write_text(REGION_TSV, encoding='utf8')
    index = build_notice_search_index(START, END, read_region_codes(path),
        ReplayTransport({'dataOrigin': 'synthetic', 'pages': pages}), page_size=10, observed_at=OBSERVED,
        max_detail_notices=1, document_fetch=get_synthetic_documents, document_inspect=inspect_synthetic_pages)
print(json.dumps(index))
`;
  const run = spawnSync('python3', ['-c', python], {
    encoding: 'utf8', cwd: new URL('../../', import.meta.url), env: { PATH: process.env.PATH, PYTHONUTF8: '1' },
  });
  assert.equal(run.status, 0, run.stderr);
  const index = JSON.parse(run.stdout);
  const input = { regionCodes: ['11991'], budgetMaxWon: '710000000',
    supplyArea: { min: '112.4', max: '112.4', unit: 'm2' }, moveIn: { start: '2028-12', end: '2029-01' } };
  const conditions = parseNoticeSearchConditions(input);
  assert.ok(conditions);
  const result = evaluateNoticeSearch(index, conditions, '2026-10-06');
  assert.equal(result.counts.matched, 1);
  const model = result.matched[0]!.models[0]!;
  assert.deepEqual(model.matchedRooms.map(room => [room.room, room.subtotalWon]), [['101동 101호', '710000000']]);
  assert.deepEqual(model.matchedRooms[0]!.priceEvidence.map(ref => ref.page), [2, 3]);
  assert.equal(model.needsReviewRooms[0]!.room, '101동 102호');
  const lower = parseNoticeSearchConditions({ ...input, budgetMaxWon: '709999999' });
  assert.ok(lower);
  const held = evaluateNoticeSearch(index, lower, '2026-10-06');
  assert.equal(held.counts.matched, 0);
  assert.equal(held.counts.needsReview, 1);
  assert.equal(held.zeroStatus, 'indeterminate');
});
