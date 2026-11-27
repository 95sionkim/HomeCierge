#!/usr/bin/env python3
"""공식 공고 PDF 확보 커넥터의 출처·식별·형식·관계·업로드 경계를 오프라인으로 검사한다.

모든 공고 번호·페이지·PDF·업로드는 합성 자료다. 네트워크·인증값을 쓰지 않으며 fetch와 opener는 테스트 대역이다.
"""
import email.message
import hashlib
import html
import json
import socket
import unittest
import urllib.error

import notice_pdf_acquisition as acq
from notice_pdf_acquisition import MAX_PDF_BYTES, acquire_notice_pdf, make_live_fetch, without_content

HOUSE, NOTICE, EDITION = '9900000001', '9900000042', 'synthetic-edition-1'
TARGET = {'houseManageNo': HOUSE, 'noticeNo': NOTICE, 'edition': EDITION}
DETAIL = ('https://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=%s&pblancNo=%s'
          % (HOUSE, NOTICE))
REMAINDER = DETAIL.replace('selectAPTLttotPblancDetail.do', 'selectAPTRemndrLttotPblancDetailView.do')
PDF = b'%PDF-1.4\n%synthetic notice\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'
PDF_B = b'%PDF-1.7\n%synthetic correction\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'
PDF_C = b'%PDF-1.4\n%synthetic other version\n%%EOF\n'
NOTICE_LABEL, CORRECTION_LABEL = '모집공고문 보기', '정정공고문 보기'
FULL_LABEL = '정정공고문(기존 모집공고 전체를 본 정정공고로 대체합니다)'


def attachment(seq, sn=1, house=HOUSE, notice=NOTICE, origin='https://static.applyhome.co.kr'):
    return ('%s/ai/aia/getAtchmnfl.do?houseManageNo=%s&pblancNo=%s&atchmnflSeqNo=%s&atchmnflSn=%s'
            % (origin, house, notice, seq, sn))


def doc_id(seq, sn=1, house=HOUSE, notice=NOTICE):
    return 'applyhome:%s:%s:%s:%s' % (house, notice, seq, sn)


def page(links, *, numbers=(HOUSE,), date='2026-10-05', extra=''):
    anchors = ''.join('<dd><a href="%s" class="radius_btn">%s</a></dd>' % (html.escape(u), label) for u, label in links)
    rows = ''.join('<tr><td>084.0000A</td><td>112.4000</td><td>%s(01)</td></tr>' % n for n in numbers)
    date_row = '<tr><th scope="row">모집공고일</th><td colspan="3">\n  %s\n  </td></tr>' % date if date else ''
    return ('<!DOCTYPE html><html><head><script>var x = "<a href=\'%s\'>숨김</a>";</script></head><body>'
            '<dl class="pop_btn_txt"><dt><p>합성 안내</p></dt>%s</dl><table>%s</table>'
            '<table><thead><tr><th>주택관리번호(모델번호)</th></tr></thead><tbody>%s</tbody></table>%s</body></html>'
            % (attachment(999), anchors, date_row, rows, extra)).encode('utf-8')


def html_ok(body, status=200, ctype='text/html;charset=UTF-8'):
    return {'status': status, 'headers': {'Content-Type': ctype}, 'body': body}


def pdf_ok(body=PDF, ctype='application/octet-stream;charset=UTF-8', length=None):
    return {'status': 200, 'headers': {'Content-Type': ctype,
                                        'Content-Length': str(len(body)) if length is None else length}, 'body': body}


def redirect(location, status=302):
    return {'status': status, 'headers': {'Location': location}, 'body': b''}


class FakeFetch:
    def __init__(self, routes):
        self.routes, self.calls = routes, []

    def __call__(self, url, *, max_bytes, timeout):
        self.calls.append({'url': url, 'max_bytes': max_bytes, 'timeout': timeout})
        value = self.routes.get(url, {'error': 'connection'})
        return value(url) if callable(value) else value

    def urls(self):
        return [c['url'] for c in self.calls]


def run(routes, url=DETAIL, **kwargs):
    fetch = FakeFetch(routes)
    return acquire_notice_pdf(dict(TARGET), url, fetch=fetch, **kwargs), fetch


def by_id(result):
    return {d['id']: d for d in result['documents']}


def record(seq, body, *, sn=1, role='notice', **overrides):
    base = {'id': doc_id(seq, sn), 'houseManageNo': HOUSE, 'noticeNo': NOTICE, 'edition': EDITION,
            'sha256': hashlib.sha256(body).hexdigest(), 'role': role, 'source': 'official', 'originCheck': 'confirmed'}
    base.update(overrides)
    return base


class SoleNoticeTest(unittest.TestCase):
    def test_same_notice_pdf_is_acquired_with_identity_and_hash(self):
        result, fetch = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL)])), attachment(11): pdf_ok()},
                            notice_date='2026-10-05')
        self.assertEqual(result['contract'], 'notice-pdf-acquisition/v0')
        self.assertEqual(result['status'], 'acquired')
        self.assertEqual(result['reasons'], [])
        self.assertEqual(result['next'], [])
        [document] = result['documents']
        digest = hashlib.sha256(PDF).hexdigest()
        self.assertEqual(document['id'], doc_id(11))
        self.assertEqual((document['version'], document['sha256'], document['bytes']), ('sha256:' + digest, digest,
                                                                                         len(PDF)))
        self.assertIs(document['content'], PDF)
        self.assertEqual((document['source'], document['originCheck'], document['role'], document['adoption']),
                         ('official', 'confirmed', 'notice', 'standalone'))
        self.assertEqual((document['houseManageNo'], document['noticeNo'], document['edition']), (HOUSE, NOTICE, EDITION))
        self.assertEqual(result['detail']['identity'], {'status': 'confirmed', 'numbers': [HOUSE]})
        self.assertEqual(result['detail']['noticeDate'], {'status': 'confirmed', 'page': ['2026-10-05']})
        relation = result['relation']
        self.assertEqual((relation['kind'], relation['basis'], relation['setKnown'], relation['allDocumentsAvailable']),
                         ('sole', 'detail_page', True, True))
        self.assertEqual(relation['documents'], [doc_id(11)])
        self.assertEqual(relation['missing'], [])
        self.assertEqual(fetch.urls(), [DETAIL, attachment(11)])  # 스크립트 안의 링크는 따라가지 않는다
        self.assertEqual(fetch.calls[0]['max_bytes'], acq.MAX_HTML_BYTES)
        self.assertEqual(fetch.calls[1]['max_bytes'], MAX_PDF_BYTES)

    def test_remainder_detail_path_and_application_pdf_type_are_supported(self):
        result, _ = run({REMAINDER: html_ok(page([(attachment(12), NOTICE_LABEL)])),
                         attachment(12): pdf_ok(ctype='application/pdf')}, url=REMAINDER)
        self.assertEqual(result['status'], 'acquired')

    def test_shared_byte_cap_matches_storage_limit(self):
        self.assertEqual(MAX_PDF_BYTES, 50 * 1024 * 1024)

    def test_unshown_identity_and_date_are_recorded_not_invented(self):
        result, _ = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL)], numbers=(), date=None)),
                         attachment(11): pdf_ok()}, notice_date='2026-10-05')
        self.assertEqual(result['status'], 'acquired')
        self.assertEqual(result['detail']['identity']['status'], 'not_shown')
        self.assertEqual(result['detail']['noticeDate']['status'], 'not_shown')


class DetailPolicyTest(unittest.TestCase):
    def assert_held_without_fetch(self, url, reason):
        result, fetch = run({}, url=url)
        self.assertEqual(result['status'], 'held')
        self.assertEqual(result['reasons'][0], reason)
        self.assertEqual(fetch.calls, [])
        self.assertEqual(result['documents'], [])
        upload = result['next'][-1]
        self.assertEqual(upload, {'action': 'upload', 'target': TARGET, 'accept': 'application/pdf',
                                  'maxBytes': MAX_PDF_BYTES, 'reason': reason, 'equivalence': 'sha256_matches_official'})
        self.assertIsNone(result['detail']['url'])
        return result

    def test_missing_detail_url_requests_upload(self):
        self.assert_held_without_fetch(None, 'detail_url_missing')

    def test_disallowed_detail_urls_are_never_requested(self):
        other = DETAIL.replace('pblancNo=' + NOTICE, 'pblancNo=9900000043')
        for url in (DETAIL.replace('https:', 'http:'), DETAIL.replace('www.applyhome.co.kr', 'applyhome.example'),
                    DETAIL + '&extra=1', other, DETAIL.replace('https://', 'https://user@'),
                    DETAIL.replace('applyhome.co.kr', 'applyhome.co.kr:8443'),
                    DETAIL.replace('selectAPTLttotPblancDetail.do', 'guess.do'),
                    DETAIL + '&houseManageNo=' + HOUSE, DETAIL.replace(HOUSE, 'A' + HOUSE[1:])):
            with self.subTest(url=url):
                result = self.assert_held_without_fetch(url, 'detail_url_not_allowed')
                if url.startswith('https://applyhome.example'):
                    self.assertEqual(result['detail']['rejectedOrigin'], 'https://applyhome.example')

    def test_detail_redirect_is_rechecked_each_hop(self):
        same = DETAIL.replace('selectAPTLttotPblancDetail.do', 'selectAPTRemndrLttotPblancDetailView.do')
        routes = {DETAIL: redirect(same), same: html_ok(page([(attachment(11), NOTICE_LABEL)])), attachment(11): pdf_ok()}
        result, fetch = run(routes)
        self.assertEqual(result['status'], 'acquired')
        self.assertEqual(result['detail']['redirects'], 1)
        self.assertEqual(result['detail']['finalUrl'], same)
        for location in ('http://www.applyhome.co.kr/ai/aia/selectAPTLttotPblancDetail.do?houseManageNo=%s&pblancNo=%s'
                         % (HOUSE, NOTICE), 'https://login.example/session', '/ai/aia/login.do', '//[bad'):
            with self.subTest(location=location):
                result, fetch = run({DETAIL: redirect(location)})
                self.assertEqual((result['status'], result['reasons'][0]), ('held', 'redirect_not_allowed'))
                self.assertEqual(fetch.urls(), [DETAIL])

    def test_redirect_limit(self):
        result, fetch = run({DETAIL: redirect(DETAIL)}, limits={'redirects': 2})
        self.assertEqual(result['reasons'][0], 'redirect_limit')
        self.assertEqual(len(fetch.calls), 3)

    def test_access_restriction_is_not_bypassed(self):
        for status, reason, outcome in ((403, 'access_restricted', 'held'), (401, 'access_restricted', 'held'),
                                        (404, 'detail_not_found', 'held'), (503, 'upstream_unavailable', 'failed'),
                                        (429, 'upstream_unavailable', 'failed')):
            with self.subTest(status=status):
                result, fetch = run({DETAIL: html_ok(b'', status=status)})
                self.assertEqual((result['status'], result['reasons'][0]), (outcome, reason))
                self.assertEqual(len(fetch.calls), 1)
                actions = [a['action'] for a in result['next']]
                self.assertEqual(actions, ['retry', 'upload'] if outcome == 'failed' else ['upload'])

    def test_transport_errors_are_retryable_failures(self):
        for response in ({'error': 'timeout'}, {'error': 'connection'}, {'error': 'tls'}, {'error': 'other'},
                         {'status': 200, 'headers': {}, 'body': 'text'}, None, {'status': True, 'headers': {}, 'body': b''}):
            with self.subTest(response=response):
                result, _ = run({DETAIL: response})
                self.assertEqual(result['status'], 'failed')
                self.assertEqual(result['next'][0], {'action': 'retry'})

    def test_raising_transport_does_not_leak_message(self):
        def broken(url, **_):
            raise RuntimeError('secret-header-value ' + url)
        result = acquire_notice_pdf(dict(TARGET), DETAIL, fetch=broken)
        self.assertEqual(result['reasons'][0], 'transport_malformed')
        self.assertNotIn('secret-header-value', json.dumps(without_content(result), ensure_ascii=False))

    def test_oversized_and_non_html_pages_are_held(self):
        result, _ = run({DETAIL: html_ok(b'x' * (acq.MAX_HTML_BYTES + 1))})
        self.assertEqual(result['reasons'][0], 'too_large')
        result, _ = run({DETAIL: html_ok(b'{}', ctype='application/json')})
        self.assertEqual(result['reasons'][0], 'detail_page_not_html')
        result, _ = run({DETAIL: html_ok(b'\xff\xfe\xfa', ctype='text/html; charset=utf-8')})
        self.assertEqual(result['reasons'][0], 'detail_page_malformed')

    def test_page_showing_other_notice_number_or_date_is_held(self):
        result, fetch = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL)], numbers=(HOUSE, '9900000777')))})
        self.assertEqual((result['status'], result['reasons'][0]), ('held', 'detail_identity_conflict'))
        self.assertEqual(fetch.urls(), [DETAIL])
        result, fetch = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL)], date='2026-06-12'))},
                            notice_date='2026-10-05')
        self.assertEqual(result['reasons'][0], 'detail_notice_date_conflict')
        self.assertEqual(fetch.urls(), [DETAIL])
        result, _ = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL)], date='2026-06-12 / 2026-10-05'))},
                        notice_date='2026-10-05')
        self.assertEqual(result['reasons'][0], 'detail_notice_date_ambiguous')

    def test_deadline_stops_further_requests(self):
        ticks = iter([0, 0, 95, 95])
        result, fetch = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL)])), attachment(11): pdf_ok()},
                            monotonic=lambda: next(ticks))
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['documents'][0]['reasons'], ['deadline_exceeded'])
        self.assertEqual(fetch.urls(), [DETAIL])


class AttachmentSelectionTest(unittest.TestCase):
    def test_other_round_attachment_is_kept_as_reference_and_not_downloaded(self):
        other = attachment(21, house='9900000002', notice='9900000002')
        result, fetch = run({DETAIL: html_ok(page([(other, NOTICE_LABEL)])), other: pdf_ok()})
        self.assertEqual((result['status'], result['reasons'][0]), ('held', 'attachment_not_found'))
        self.assertEqual(result['references'], [{'id': doc_id(21, house='9900000002', notice='9900000002'),
                                                 'url': other, 'origin': 'https://static.applyhome.co.kr',
                                                 'markers': acq._markers(NOTICE_LABEL),
                                                 'reason': 'other_notice_attachment'}])
        self.assertEqual(fetch.urls(), [DETAIL])

    def test_marked_reference_is_excluded_from_relation(self):
        result, fetch = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL),
                                                   (attachment(12), '(참고) 최초 입주자모집공고문')])),
                             attachment(11): pdf_ok(), attachment(12): pdf_ok(PDF_B)})
        self.assertEqual(result['status'], 'acquired')
        self.assertEqual(result['relation']['kind'], 'sole')
        self.assertEqual([r['id'] for r in result['references']], [doc_id(12)])
        self.assertEqual(result['references'][0]['reason'], 'marked_reference')
        self.assertNotIn(attachment(12), fetch.urls())

    def test_unrelated_documents_on_disallowed_origins_are_candidates_without_urls(self):
        links = [(attachment(11), NOTICE_LABEL), ('https://cdn.example/stamp-duty.pdf?token=1', '인지세 납부 안내'),
                 ('http://static.applyhome.co.kr/x.pdf', '입주 안내'), ('https://[broken/guide.pdf', '안내'),
                 ('tel:000', '문의'), ('/ai/aia/selectAPTLttotPblancListView.do', '모집공고'),
                 ('https://www.applyhome.co.kr/co/coa/selectMainView.do', '청약홈')]
        result, fetch = run({DETAIL: html_ok(page(links)), attachment(11): pdf_ok()})
        self.assertEqual((result['status'], result['relation']['kind']), ('acquired', 'sole'))  # 사이트 메뉴는 제외
        self.assertEqual([(c['origin'], c['url'], c['reason']) for c in result['candidates']], [
            ('https://cdn.example', None, 'attachment_origin_not_allowed'),
            (None, None, 'attachment_url_unparseable'), (None, None, 'attachment_url_unparseable')])
        self.assertEqual(fetch.urls(), [DETAIL, attachment(11)])

    def test_unsupported_correction_link_blocks_adopting_original_alone(self):
        for href, error in (('https://cdn.example/correction.pdf', 'attachment_url_not_supported'),
                            (attachment(12, origin='https://www.applyhome.co.kr'), 'attachment_url_not_supported'),
                            ('javascript:fnDownload(12)', 'attachment_link_without_url'), ('#', 'attachment_link_without_url'),
                            ('https://[broken/correction.pdf', 'attachment_url_unparseable')):
            with self.subTest(href=href):
                result, fetch = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL), (href, CORRECTION_LABEL)])),
                                     attachment(11): pdf_ok()})
                docs = by_id(result)
                self.assertEqual(result['status'], 'partial')
                self.assertEqual(docs[doc_id(11)]['adoption'], 'with_set')
                self.assertEqual(docs[doc_id(11)]['reasons'], ['correction_scope_unverified', 'correction_document_missing'])
                self.assertEqual(result['relation']['missing'], [{'id': 'unsupported:1', 'role': 'correction',
                                                                  'reason': error}])
                self.assertFalse(result['relation']['allDocumentsAvailable'])
                self.assertEqual(fetch.urls(), [DETAIL, attachment(11)])
                self.assertEqual(result['next'][0]['reason'], 'correction_document_missing')

    def test_anchor_without_href_marked_as_notice_document_counts_as_missing(self):
        body = page([(attachment(11), NOTICE_LABEL)]).replace(b'</dl>', '<dd><a onclick="open()">정정공고문</a></dd></dl>'
                                                                .encode('utf-8'))
        result, _ = run({DETAIL: html_ok(body), attachment(11): pdf_ok()})
        self.assertEqual(result['relation']['missing'][0]['reason'], 'attachment_link_without_url')
        self.assertEqual(result['status'], 'partial')

    def test_repeated_unsupported_link_is_one_missing_document(self):
        links = [(attachment(11), NOTICE_LABEL), ('https://cdn.example/c.pdf', CORRECTION_LABEL),
                 ('https://cdn.example/c.pdf', CORRECTION_LABEL)]
        result, _ = run({DETAIL: html_ok(page(links)), attachment(11): pdf_ok()})
        self.assertEqual(result['relation']['reasons'], ['correction_scope_unverified', 'correction_document_missing'])
        self.assertEqual(len(result['relation']['missing']), 1)

    def test_primary_reason_comes_first_with_invalid_index_rows(self):
        result, _ = run({}, url=None, official_index=['bad-row'])
        self.assertEqual(result['reasons'], ['detail_url_missing', 'official_index_record_invalid'])
        self.assertEqual(result['next'][-1]['reason'], 'detail_url_missing')

    def test_only_unsupported_notice_link_is_held(self):
        result, fetch = run({DETAIL: html_ok(page([('https://cdn.example/notice.pdf', NOTICE_LABEL)]))})
        self.assertEqual((result['status'], result['reasons'][0]), ('held', 'attachment_url_not_supported'))
        self.assertEqual(fetch.urls(), [DETAIL])
    def test_fragments_are_dropped_from_requests_and_output(self):
        routes = {DETAIL: html_ok(page([(attachment(11) + '#page=3', NOTICE_LABEL)])), attachment(11): pdf_ok()}
        result, fetch = run(routes, url=DETAIL + '#top')
        self.assertEqual(result['status'], 'acquired')
        self.assertEqual(fetch.urls(), [DETAIL, attachment(11)])
        self.assertEqual((result['detail']['url'], result['detail']['finalUrl']), (DETAIL, DETAIL))
        self.assertEqual(result['documents'][0]['acquisition']['url'], attachment(11))
        self.assertNotIn('#', json.dumps(without_content(result)))
        moved = REMAINDER + '#frag'
        result, fetch = run({DETAIL: redirect(moved), REMAINDER: html_ok(page([(attachment(11), NOTICE_LABEL)])),
                             attachment(11): pdf_ok()})
        self.assertEqual(fetch.urls(), [DETAIL, REMAINDER, attachment(11)])

    def test_relative_and_entity_encoded_links_resolve_against_final_page(self):
        relative = attachment(11).replace('https://static.applyhome.co.kr', '//static.applyhome.co.kr')
        body = ('<a href="%s">모집공고문 보기</a><td>%s(01)</td>' % (relative.replace('&', '&amp;'), HOUSE)).encode()
        result, fetch = run({DETAIL: html_ok(body), attachment(11): pdf_ok()})
        self.assertEqual(result['status'], 'acquired')
        self.assertEqual(fetch.urls()[1], attachment(11))

    def test_attachment_redirect_must_keep_same_attachment(self):
        moved = attachment(11).replace('atchmnflSn=1', 'atchmnflSn=2')
        result, fetch = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL)])), attachment(11): redirect(moved),
                             moved: pdf_ok()})
        self.assertEqual(result['documents'][0]['reasons'], ['redirect_not_allowed'])
        self.assertNotIn(moved, fetch.urls())
        self.assertEqual(result['status'], 'held')

    def test_attachment_limit_holds_whole_set(self):
        links = [(attachment(i), NOTICE_LABEL if i == 1 else CORRECTION_LABEL) for i in range(1, 4)]
        result, fetch = run({DETAIL: html_ok(page(links))}, limits={'attachments': 2})
        self.assertEqual((result['status'], result['reasons'][0]), ('held', 'attachment_limit_exceeded'))
        self.assertEqual(fetch.urls(), [DETAIL])
        self.assertFalse(result['relation']['setKnown'])

    def test_reference_wording_must_be_explicit(self):
        result, fetch = run({DETAIL: html_ok(page([(attachment(11), '모집공고문(참고사항 포함)')])),
                             attachment(11): pdf_ok()})
        self.assertEqual((result['status'], result['relation']['kind'], result['references']), ('acquired', 'sole', []))
        for label in ('[참고] 최초 입주자모집공고문', '최초 모집공고문(참고용)', '이전 회차 모집공고문', '참고자료'):
            with self.subTest(label=label):
                result, fetch = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL), (attachment(12), label)])),
                                     attachment(11): pdf_ok()})
                self.assertEqual((result['status'], result['relation']['kind']), ('acquired', 'sole'))
                self.assertEqual([r['reason'] for r in result['references']], ['marked_reference'])
                self.assertNotIn(attachment(12), fetch.urls())

    def test_reference_then_notice_label_for_same_attachment_is_order_independent(self):
        for labels in (('(참고) 모집공고문', NOTICE_LABEL), (NOTICE_LABEL, '(참고) 모집공고문')):
            with self.subTest(labels=labels):
                result, _ = run({DETAIL: html_ok(page([(attachment(11), labels[0]), (attachment(11), labels[1])])),
                                 attachment(11): pdf_ok()})
                self.assertEqual(result['references'], [])
                self.assertEqual([(d['id'], d['role'], d['adoption']) for d in result['documents']],
                                 [(doc_id(11), 'unclassified', 'with_set')])
                self.assertEqual(result['relation']['reasons'], ['attachment_role_unclassified'])

    def test_duplicate_link_with_conflicting_roles_is_unclassified(self):
        result, _ = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL), (attachment(11), CORRECTION_LABEL)])),
                         attachment(11): pdf_ok()})
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['documents'][0]['role'], 'unclassified')
        self.assertEqual(result['relation']['reasons'], ['attachment_role_unclassified'])


class PdfFormatTest(unittest.TestCase):
    def outcome(self, response):
        result, _ = run({DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL)])), attachment(11): response})
        return result

    def test_real_pdf_shape_is_required(self):
        cases = {
            'not_pdf': pdf_ok(b'<html>error</html>'),
            'pdf_truncated': pdf_ok(b'%PDF-1.4\nno trailer'),
            'attachment_type_not_pdf': pdf_ok(ctype='text/html'),
            'attachment_length_mismatch': pdf_ok(length='9' * 400),
            'too_large': {'status': 200, 'headers': {}, 'body': b'%PDF-1.4\n' + b'0' * MAX_PDF_BYTES},
            'attachment_not_found': {'status': 404, 'headers': {}, 'body': b''},
        }
        for reason, response in cases.items():
            with self.subTest(reason=reason):
                result = self.outcome(response)
                self.assertEqual((result['status'], result['reasons'][0]), ('held', reason))
                self.assertIsNone(result['documents'][0]['content'])
                self.assertEqual(result['documents'][0]['adoption'], 'not_adoptable')
                self.assertEqual(result['relation']['missing'], [{'id': doc_id(11), 'role': 'notice', 'reason': reason}])
                self.assertFalse(result['relation']['allDocumentsAvailable'])

    def test_missing_content_length_relies_on_magic(self):
        result = self.outcome({'status': 200, 'headers': {}, 'body': PDF})
        self.assertEqual(result['status'], 'acquired')


class RelationTest(unittest.TestCase):
    def outcome(self, links, bodies):
        routes = {DETAIL: html_ok(page(links))}
        routes.update(bodies)
        result, _ = run(routes)
        return result

    def test_explicit_full_replacement_supersedes_original(self):
        result = self.outcome([(attachment(11), NOTICE_LABEL), (attachment(12), FULL_LABEL)],
                              {attachment(11): pdf_ok(), attachment(12): pdf_ok(PDF_B)})
        docs = by_id(result)
        self.assertEqual(result['status'], 'acquired')
        self.assertEqual((result['relation']['kind'], result['relation']['documents'], result['relation']['superseded']),
                         ('full_replacement', [doc_id(12)], [doc_id(11)]))
        self.assertEqual(docs[doc_id(12)]['adoption'], 'standalone')
        self.assertEqual(docs[doc_id(11)]['adoption'], 'not_adoptable')
        self.assertEqual(docs[doc_id(11)]['reasons'], ['superseded_by_full_replacement'])
        self.assertTrue(docs[doc_id(12)]['acquisition']['markers']['fullReplacementStatement'])

    def test_full_replacement_still_resolves_when_superseded_original_is_missing(self):
        result = self.outcome([(attachment(11), NOTICE_LABEL), (attachment(12), FULL_LABEL)],
                              {attachment(12): pdf_ok(PDF_B)})
        self.assertEqual((result['status'], result['relation']['kind']), ('acquired', 'full_replacement'))
        self.assertFalse(result['relation']['allDocumentsAvailable'])
        self.assertEqual([m['id'] for m in result['relation']['missing']], [doc_id(11)])
        self.assertEqual(result['next'], [])

    def test_keyword_overlap_or_negation_is_not_full_replacement(self):
        for label in ('정정 공고 전문 보기', '정정공고(일부 대체)', '정정공고(전체 공고를 대체하지 않음)',
                      '정정공고문(기존 모집공고 전체를 본 공고로 대체하지 않습니다)',
                      '정정공고문(기존 모집공고 전체를 본 공고로 대체합니다. 단, 일부 조건 제외)', '정정 대체 전체',
                      FULL_LABEL + ' ' + '합성 안내 문구' * 8):
            with self.subTest(label=label):
                result = self.outcome([(attachment(11), NOTICE_LABEL), (attachment(12), label)],
                                      {attachment(11): pdf_ok(), attachment(12): pdf_ok(PDF_B)})
                self.assertEqual((result['status'], result['relation']['kind']), ('partial', 'unresolved'))
                self.assertEqual(result['relation']['reasons'], ['correction_scope_unverified'])
                self.assertEqual({d['adoption'] for d in result['documents']}, {'with_set'})
                self.assertTrue(result['relation']['allDocumentsAvailable'])
                self.assertEqual(result['next'], [])

    def test_missing_correction_blocks_adopting_original_alone(self):
        result = self.outcome([(attachment(11), NOTICE_LABEL), (attachment(12), CORRECTION_LABEL)],
                              {attachment(11): pdf_ok(), attachment(12): {'error': 'timeout'}})
        docs = by_id(result)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(docs[doc_id(11)]['adoption'], 'with_set')
        self.assertEqual(docs[doc_id(11)]['reasons'], ['correction_scope_unverified', 'correction_document_missing'])
        self.assertEqual(result['relation']['missing'], [{'id': doc_id(12), 'role': 'correction', 'reason': 'timeout'}])
        self.assertFalse(result['relation']['allDocumentsAvailable'])
        self.assertEqual(result['next'][0]['reason'], 'correction_document_missing')

    def test_two_notice_versions_are_not_picked_by_title_or_order(self):
        result = self.outcome([(attachment(11), NOTICE_LABEL), (attachment(12), '최신 모집공고문 보기')],
                              {attachment(11): pdf_ok(), attachment(12): pdf_ok(PDF_C)})
        self.assertEqual((result['status'], result['relation']['reasons']), ('partial', ['multiple_notice_documents']))
        self.assertEqual({d['adoption'] for d in result['documents']}, {'with_set'})
        self.assertEqual([d['content'] for d in result['documents']], [PDF, PDF_C])  # 각각 필드 점검기로 넘긴다

    def test_multiple_full_corrections_remain_unresolved(self):
        result = self.outcome([(attachment(11), NOTICE_LABEL), (attachment(12), FULL_LABEL), (attachment(13), FULL_LABEL)],
                              {attachment(11): pdf_ok(), attachment(12): pdf_ok(PDF_B), attachment(13): pdf_ok(PDF_C)})
        self.assertEqual(result['relation']['reasons'], ['multiple_correction_documents'])

    def test_correction_without_original_and_unclassified_attachments(self):
        result = self.outcome([(attachment(12), CORRECTION_LABEL)], {attachment(12): pdf_ok(PDF_B)})
        self.assertEqual(result['relation']['reasons'], ['correction_scope_unverified', 'original_document_missing'])
        self.assertFalse(result['relation']['allDocumentsAvailable'])
        self.assertIn({'id': None, 'role': 'notice', 'reason': 'original_document_missing'}, result['relation']['missing'])
        result = self.outcome([(attachment(11), NOTICE_LABEL), (attachment(13), '설계변경 안내')],
                              {attachment(11): pdf_ok(), attachment(13): pdf_ok(PDF_C)})
        self.assertEqual((result['status'], result['relation']['reasons']), ('partial', ['attachment_role_unclassified']))


class UploadTest(unittest.TestCase):
    LINKS = [(attachment(11), NOTICE_LABEL)]

    def failed_routes(self):
        return {DETAIL: html_ok(page(self.LINKS)), attachment(11): {'status': 503, 'headers': {}, 'body': b''}}

    def test_index_matched_upload_fills_failed_official_slot(self):
        upload = {'id': 'synthetic-upload-1', 'content': PDF}
        result, _ = run(self.failed_routes(), upload=upload, official_index=[record(11, PDF)])
        [document] = result['documents']
        self.assertEqual(result['status'], 'acquired')
        self.assertEqual((document['id'], document['source'], document['originCheck'], document['adoption']),
                         ('upload:synthetic-upload-1', 'upload', 'confirmed', 'standalone'))
        self.assertEqual(document['acquisition']['indexRecord'], doc_id(11))
        self.assertEqual((result['relation']['kind'], result['relation']['basis']), ('sole', 'detail_page+official_index'))
        self.assertTrue(result['relation']['allDocumentsAvailable'])

    def test_callable_upload_is_called_once_only_when_data_is_missing(self):
        calls = []

        def read():
            calls.append(1)
            return {'id': 'synthetic-upload-2', 'content': PDF}
        result, _ = run({DETAIL: html_ok(page(self.LINKS)), attachment(11): pdf_ok()}, upload=read)
        self.assertEqual((result['status'], calls, result['upload']), ('acquired', [], {'provided': False,
                                                                                         'called': False}))
        result, _ = run(self.failed_routes(), upload=read, official_index=[record(11, PDF)])
        self.assertEqual((result['status'], calls, result['upload']), ('acquired', [1], {'provided': True,
                                                                                          'called': True}))

    def test_upload_cannot_resolve_multiple_official_versions(self):
        calls = []
        routes = {DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL), (attachment(12), CORRECTION_LABEL)])),
                  attachment(11): pdf_ok(), attachment(12): pdf_ok(PDF_B)}
        result, _ = run(routes, upload=lambda: calls.append(1))
        self.assertEqual((result['status'], calls), ('partial', []))
        result, _ = run(routes, upload={'id': 'synthetic-upload-3', 'content': PDF_B})
        docs = by_id(result)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(docs['upload:synthetic-upload-3']['reasons'], ['upload_duplicates_official'])
        self.assertEqual(docs['upload:synthetic-upload-3']['adoption'], 'not_adoptable')

    def test_upload_into_missing_correction_slot_keeps_scope_unresolved(self):
        routes = {DETAIL: html_ok(page([(attachment(11), NOTICE_LABEL), (attachment(12), CORRECTION_LABEL)])),
                  attachment(11): pdf_ok(), attachment(12): {'error': 'connection'}}
        result, _ = run(routes, upload={'id': 'synthetic-upload-4', 'content': PDF_B},
                        official_index=[record(12, PDF_B, role='correction')])
        self.assertEqual((result['status'], result['relation']['reasons']), ('partial', ['correction_scope_unverified']))
        self.assertTrue(result['relation']['allDocumentsAvailable'])

    def test_unverified_or_foreign_uploads_are_held(self):
        cases = [
            ({}, [], 'unverified', 'upload_origin_unverified'),
            ({}, [record(11, PDF, edition='synthetic-edition-0')], 'conflict', 'upload_matches_other_notice'),
            ({}, [record(11, PDF, source='upload')], 'unverified', 'upload_origin_unverified'),
            ({}, [record(11, PDF, originCheck='unverified')], 'unverified', 'upload_origin_unverified'),
            ({}, [record(11, PDF, id='upload:synthetic-upload-0')], 'unverified', 'upload_origin_unverified'),
            ({}, [record(11, PDF, id=doc_id(11, house='9900000009'))], 'unverified', 'upload_origin_unverified'),
            ({}, [record(77, PDF)], 'confirmed', 'upload_not_in_current_attachments'),
        ]
        for _, index, origin, reason in cases:
            with self.subTest(reason=reason, index=index):
                result, _ = run(self.failed_routes(), upload={'id': 'synthetic-upload-5', 'content': PDF},
                                official_index=index)
                upload = by_id(result)['upload:synthetic-upload-5']
                self.assertEqual((upload['originCheck'], upload['adoption'], upload['reasons']),
                                 (origin, 'not_adoptable', [reason]))
                self.assertEqual(result['status'], 'failed')
                self.assertIn(reason, result['reasons'])
                self.assertEqual(result['next'][-1]['action'], 'upload')

    def test_upload_differing_from_acquired_official_is_not_adopted(self):
        result, _ = run({DETAIL: html_ok(page(self.LINKS)), attachment(11): pdf_ok()},
                        upload={'id': 'synthetic-upload-6', 'content': PDF_C})
        self.assertEqual(result['status'], 'acquired')
        self.assertEqual(by_id(result)['upload:synthetic-upload-6']['reasons'], ['upload_differs_from_official'])

    def test_upload_against_unknown_attachment_set_needs_set_review(self):
        result, _ = run({DETAIL: {'error': 'timeout'}}, upload={'id': 'synthetic-upload-7', 'content': PDF},
                        official_index=[record(11, PDF)])
        [document] = result['documents']
        self.assertEqual((result['status'], document['adoption'], document['reasons']),
                         ('partial', 'with_set', ['attachment_set_unverified']))
        self.assertEqual((result['relation']['kind'], result['relation']['basis'], result['relation']['setKnown']),
                         ('unresolved', 'official_index', False))

    def test_invalid_upload_inputs(self):
        result, _ = run(self.failed_routes(), upload={'id': 'synthetic-upload-8', 'content': b'not a pdf'})
        self.assertEqual(by_id(result)['upload:synthetic-upload-8']['reasons'], ['upload_not_pdf'])
        for upload in ({'id': '', 'content': PDF}, {'id': 'x', 'content': 'text'}, {'content': PDF},
                       {'id': 'x\n', 'content': PDF}, {'id': 'x', 'content': PDF, 'name': 'title.pdf'}):
            with self.subTest(upload=upload):
                with self.assertRaises(ValueError):
                    run(self.failed_routes(), upload=upload)
        with self.assertRaises(TypeError):
            run(self.failed_routes(), upload=b'%PDF-1.4')

    def test_failing_upload_reader_is_recorded(self):
        def read():
            raise OSError('/private/path token')
        result, _ = run(self.failed_routes(), upload=read)
        self.assertIn('upload_read_failed', result['reasons'])
        self.assertNotIn('/private/path', json.dumps(without_content(result), ensure_ascii=False))

    def test_invalid_index_rows_are_reported(self):
        result, _ = run(self.failed_routes(), official_index=[{'id': doc_id(11)}, 'row'])
        self.assertIn('official_index_record_invalid', result['reasons'])
        with self.assertRaises(TypeError):
            run(self.failed_routes(), official_index={'id': doc_id(11)})


class BusinessEntityTest(unittest.TestCase):
    POLICY = {'detailOrigins': ['https://builder.example'], 'attachmentOrigins': ['https://cdn.builder.example']}

    def test_identifier_less_pdf_links_are_held_without_download(self):
        detail = 'https://builder.example/complex/notice'
        links = [('https://cdn.builder.example/file/합성 재공급 모집공고.pdf', '재공급 모집공고'),
                 ('https://elsewhere.example/notice.pdf', '모집공고'), ('/complex/notice_list', '보도자료')]
        fetch = FakeFetch({detail: html_ok(page(links, numbers=()))})
        result = acquire_notice_pdf(dict(TARGET), detail, fetch=fetch, source='business_entity',
                                    business_policy=self.POLICY)
        self.assertEqual((result['status'], result['reasons'][0]), ('held', 'attachment_identity_unverified'))
        self.assertEqual(fetch.urls(), [detail])
        self.assertEqual([(c['url'], c['reason']) for c in result['candidates']], [
            ('https://cdn.builder.example/file/%ED%95%A9%EC%84%B1%20%EC%9E%AC%EA%B3%B5%EA%B8%89%20'
             '%EB%AA%A8%EC%A7%91%EA%B3%B5%EA%B3%A0.pdf', 'attachment_identity_unverified'),
            (None, 'attachment_origin_not_allowed')])
        self.assertEqual(result['next'][-1]['action'], 'upload')

    def test_business_policy_is_required_and_validated(self):
        for policy in (None, {'detailOrigins': ['http://builder.example'], 'attachmentOrigins': ['https://a.example']},
                       {'detailOrigins': ['https://builder.example/path'], 'attachmentOrigins': ['https://a.example']},
                       {'detailOrigins': []}):
            with self.subTest(policy=policy):
                with self.assertRaises(ValueError):
                    acquire_notice_pdf(dict(TARGET), 'https://builder.example/', fetch=FakeFetch({}),
                                       source='business_entity', business_policy=policy)
        result = acquire_notice_pdf(dict(TARGET), 'https://other.example/', fetch=FakeFetch({}),
                                    source='business_entity', business_policy=self.POLICY)
        self.assertEqual(result['reasons'][0], 'detail_url_not_allowed')


class InputAndOutputTest(unittest.TestCase):
    def test_programming_errors_raise(self):
        fetch = FakeFetch({})
        for target in (None, {}, dict(TARGET, edition=' '), {'houseManageNo': HOUSE, 'noticeNo': NOTICE}):
            with self.subTest(target=target):
                with self.assertRaises(ValueError):
                    acquire_notice_pdf(target, DETAIL, fetch=fetch)
        with self.assertRaises(ValueError):
            acquire_notice_pdf(dict(TARGET, houseManageNo='A1'), DETAIL, fetch=fetch)
        with self.assertRaises(TypeError):
            acquire_notice_pdf(dict(TARGET), DETAIL, fetch=None)
        with self.assertRaises(TypeError):
            acquire_notice_pdf(dict(TARGET), 42, fetch=fetch)
        for kwargs in ({'source': 'mirror'}, {'notice_date': '20261005'}, {'limits': {'redirects': 0}},
                       {'limits': {'retries': 1}}, {'business_policy': BusinessEntityTest.POLICY}):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    acquire_notice_pdf(dict(TARGET), DETAIL, fetch=fetch, **kwargs)

    def test_output_without_content_is_json_and_omits_raw_text(self):
        secret_label = '모집공고문 보기 합성-원문-문구-77'
        links = [(attachment(11), secret_label), ('https://cdn.example/private.pdf?token=abc', '공고문')]
        result, _ = run({DETAIL: html_ok(page(links)), attachment(11): pdf_ok()},
                        url=DETAIL, now=lambda: acq.datetime(2026, 11, 21, 9, 0, tzinfo=acq.timezone.utc))
        dumped = json.dumps(without_content(result), ensure_ascii=False, allow_nan=False)
        self.assertNotIn('합성-원문-문구-77', dumped)
        self.assertNotIn('token=abc', dumped)
        self.assertNotIn('private.pdf', dumped)
        self.assertIsNone(without_content(result)['documents'][0]['content'])
        self.assertIs(result['documents'][0]['content'], PDF)  # 원 결과는 그대로
        self.assertEqual(result['observedAt'], '2026-11-21T09:00:00+00:00')
        held, _ = run({}, url='https://evil.example/path?key=abc')
        self.assertNotIn('key=abc', json.dumps(without_content(held)))


class FakeResponse:
    def __init__(self, status, headers, body):
        self.status, self.headers, self._body = status, headers, body
        self.reads = 0

    def read(self, size):
        self.reads += 1
        part, self._body = self._body[:size], self._body[size:]
        return part

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def message(**headers):
    result = email.message.Message()
    for name, value in headers.items():
        result[name.replace('_', '-')] = value
    return result


class FakeOpener:
    def __init__(self, outcome):
        self.outcome, self.requests = outcome, []

    def open(self, request, timeout):
        self.requests.append((request, timeout))
        if isinstance(self.outcome, BaseException):
            raise self.outcome
        return self.outcome


class LiveFetchTest(unittest.TestCase):
    def test_reads_in_chunks_and_keeps_only_needed_headers(self):
        opener = FakeOpener(FakeResponse(200, message(Content_Type='application/pdf', Set_Cookie='SESSION=x',
                                                      Content_Length=str(len(PDF))), PDF))
        response = make_live_fetch(opener, chunk=8)('https://static.applyhome.co.kr/a', max_bytes=1000, timeout=5)
        self.assertEqual(response, {'status': 200, 'headers': {'content-type': 'application/pdf',
                                                               'content-length': str(len(PDF))}, 'body': PDF})
        request, timeout = opener.requests[0]
        self.assertEqual((request.get_method(), timeout), ('GET', 5))
        self.assertEqual({k.lower() for k, _ in request.header_items()}, {'user-agent', 'accept'})

    def test_size_and_time_limits(self):
        oversized = FakeOpener(FakeResponse(200, message(Content_Length='9' * 40), b''))
        self.assertEqual(make_live_fetch(oversized)('https://x.example/', max_bytes=10, timeout=5), {'error': 'too_large'})
        streamed = FakeOpener(FakeResponse(200, message(), b'0' * 50))
        self.assertEqual(make_live_fetch(streamed, chunk=8)('https://x.example/', max_bytes=20, timeout=5),
                         {'error': 'too_large'})
        ticks = iter([0, 1, 9])
        slow = FakeOpener(FakeResponse(200, message(), b'0' * 50))
        self.assertEqual(make_live_fetch(slow, clock=lambda: next(ticks), chunk=8)('https://x.example/', max_bytes=100,
                                                                                   timeout=5), {'error': 'timeout'})

    def test_redirect_and_errors_are_envelopes(self):
        error = urllib.error.HTTPError('https://x.example/', 302, 'Found',
                                       message(Location='https://y.example/', Set_Cookie='a=b'), None)
        self.assertEqual(make_live_fetch(FakeOpener(error))('https://x.example/', max_bytes=10, timeout=5),
                         {'status': 302, 'headers': {'location': 'https://y.example/'}, 'body': b''})
        for exc, code in ((socket.timeout(), 'timeout'), (urllib.error.URLError(socket.timeout()), 'timeout'),
                          (urllib.error.URLError(acq.ssl.SSLError()), 'tls'), (ConnectionResetError(), 'connection'),
                          (urllib.error.URLError('refused'), 'connection')):
            with self.subTest(exc=exc):
                self.assertEqual(make_live_fetch(FakeOpener(exc))('https://x.example/', max_bytes=10, timeout=5),
                                 {'error': code})

    def test_default_opener_does_not_follow_redirects(self):
        self.assertIsNone(acq._NoRedirect().redirect_request(None, None, 302, 'Found', {}, 'https://y.example/'))


class PriorRevisionTests(unittest.TestCase):
    """같은 공고·회차의 공식 색인에 다른 해시가 있으면 최신 선택 없이 두 판본을 보류·대조한다(A-59b, 합성)."""

    LINKS = [(attachment(11), NOTICE_LABEL)]

    def test_hash_change_without_prior_bytes_demotes_live_document_and_holds_relation(self):
        routes = {DETAIL: html_ok(page(self.LINKS)), attachment(11): pdf_ok(PDF_B)}
        prior = [record(11, PDF)]
        result = acquire_notice_pdf(dict(TARGET), DETAIL, fetch=FakeFetch(routes), prior_revisions=prior)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['relation']['kind'], 'unresolved')
        self.assertFalse(result['relation']['allDocumentsAvailable'])
        self.assertIn('official_document_hash_changed', result['reasons'])
        self.assertIn('correction_relation_unverified', result['relation']['reasons'])
        self.assertEqual(result['documents'][0]['adoption'], 'with_set')
        self.assertIn('official_document_hash_changed', result['documents'][0]['reasons'])
        self.assertEqual(result['relation']['missing'][0]['reason'], 'prior_official_revision_unavailable')
        self.assertEqual(result['next'][-1]['action'], 'upload')

    def test_hash_change_with_prior_upload_bytes_promotes_both_revisions_for_comparison(self):
        routes = {DETAIL: html_ok(page(self.LINKS)), attachment(11): pdf_ok(PDF_B)}
        prior = [record(11, PDF)]
        result = acquire_notice_pdf(
            dict(TARGET), DETAIL, fetch=FakeFetch(routes), prior_revisions=prior,
            upload={'id': 'synthetic-prior-1', 'content': PDF},
        )
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['relation']['kind'], 'unresolved')
        self.assertTrue(result['relation']['allDocumentsAvailable'])
        self.assertEqual(result['relation']['missing'], [])
        docs = by_id(result)
        self.assertEqual(docs[doc_id(11)]['adoption'], 'with_set')
        self.assertEqual(docs['upload:synthetic-prior-1']['adoption'], 'with_set')
        self.assertEqual(docs['upload:synthetic-prior-1']['originCheck'], 'confirmed')
        self.assertEqual(docs['upload:synthetic-prior-1']['acquisition']['indexRecord'], doc_id(11))

    def test_matching_prior_hash_keeps_normal_acquired_state(self):
        routes = {DETAIL: html_ok(page(self.LINKS)), attachment(11): pdf_ok(PDF)}
        prior = [record(11, PDF)]
        result = acquire_notice_pdf(dict(TARGET), DETAIL, fetch=FakeFetch(routes), prior_revisions=prior)
        self.assertEqual(result['status'], 'acquired')
        self.assertEqual(result['documents'][0]['adoption'], 'standalone')


if __name__ == '__main__':
    unittest.main()
