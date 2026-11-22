"""공식 첨부의 판본과 페이지별 점검 결과를 청약홈 공고·주택형에 연결한다."""
from decimal import Decimal

from notice_pdf_acquisition import acquire_notice_pdf, make_live_fetch
from notice_pdf_fields import inspect_notice_pdf, reported_notice_date


def item_key(record):
    return record['modelNo'], record['houseType'], record.get('room'), record['item']


def combine_reviews(reviews):
    """적용 우선순위를 모르는 복수 판본은 같은 항목끼리 대조한다.

    한 판에서 찾지 못한 값은 다른 판의 페이지가 증명하는 범위를 넘어선다.
    실제로 읽은 페이지만 인용하며, 읽지 못한 문서의 페이지를 만들어 넣지 않는다.
    """
    if not reviews:
        return {'evidence': [], 'issues': []}
    issues = [issue for review in reviews for issue in review['issues']]
    keys_per_version = [{item_key(row) for row in review['evidence']} for review in reviews]
    shared = set.intersection(*keys_per_version)
    incomplete = set.union(*keys_per_version) - shared
    evidence = []
    rows = [row for review in reviews for row in review['evidence']]
    confirmed_values = {}
    disputed = set()
    for row in rows:
        key = item_key(row)
        if row['check'] == 'conflict':
            disputed.add(key)
        elif key in incomplete and row['check'] == 'confirmed':
            value = Decimal(row['m2']) if row['item'] == 'supply_area' else row['won']
            if confirmed_values.setdefault(key, value) != value:
                disputed.add(key)
    unverified = incomplete - disputed
    for row in rows:
        if item_key(row) in unverified:
            amount = 'm2' if row['item'] == 'supply_area' else 'won'
            row = dict(row, check='unverified', **{amount: None})
            row.pop('raw', None)
        evidence.append(row)
    for model, kind, room, item in sorted(incomplete, key=lambda k: (k[0], k[1], k[2] or '', k[3])):
        issues.append({'code': 'document_revision_item_unverified', 'decisionId': 'D-04',
                       'modelNo': model, 'houseType': kind, 'room': room, 'item': item})
    return {'evidence': evidence, 'issues': issues}


def review_catalog_documents(target, catalog, *, official_index=None, read_upload=None,
                             fetch=None, inspect=inspect_notice_pdf):
    """서버가 조회한 상세 페이지에서 시작한다. 첨부와 업로드 바이트는 이 호출 안에서만 사용한다."""
    notice = catalog['notice']
    link = notice.get('link') or {}
    url = link.get('value') if link.get('kind') == 'notice_page' and link.get('status') == 'reported' else None
    if official_index is not None and not isinstance(official_index, (list, tuple)):
        raise ValueError('공식 출처 기록 목록이 필요합니다.')
    acquired = acquire_notice_pdf(target, url, fetch=fetch if fetch is not None else make_live_fetch(),
                                  upload=read_upload, official_index=official_index or (),
                                  notice_date=reported_notice_date(catalog))
    reviews = []
    version_rows = []
    inspected = {}
    next_actions = {item['action'] for item in acquired['next']}
    requires_set = False
    for doc in acquired['documents']:
        if not doc.get('version') or not isinstance(doc.get('content'), bytes):
            continue
        metadata = {key: doc[key] for key in ('id', 'version', 'source', 'originCheck',
                                              'houseManageNo', 'noticeNo', 'edition')}
        reasons = list(doc['reasons'])
        status = 'held'
        if doc['adoption'] in ('standalone', 'with_set') and doc['originCheck'] == 'confirmed':
            requires_set = requires_set or doc['adoption'] == 'with_set'
            try:
                parsed = inspect(doc['content'], target=target, catalog=catalog,
                                 document=dict(metadata, sha256=doc['sha256']))
            except (OSError, RuntimeError, ValueError, ArithmeticError):
                # 한 첨부의 판독 오류가 공고 API 결과와 다른 판본의 검수를 중단시키지 않게 한다.
                parsed = {'status': 'unreadable', 'evidence': [], 'issues': [
                    {'code': 'document_inspection_failed', 'document': doc['id'], 'version': doc['version']}]}
            inspected[(doc['id'], doc['version'])] = parsed['status']
            issues = parsed['issues']
            if not parsed['evidence']:
                reasons.extend(issue['code'] for issue in issues)
                if parsed['status'] == 'rejected':
                    status = 'rejected'
                    actions = ['check_notice_edition', 'review_original_document']
                elif parsed['status'] == 'parser_unavailable':
                    actions = ['retry']
                else:
                    actions = ['review_original_document']
                next_actions.update(actions)
                issues = [dict(issue, stage='document_inspection', nextActions=actions) for issue in issues]
            reviews.append({'evidence': parsed['evidence'], 'issues': issues})
        # 근거 행이 없는 파일도 판본 식별자가 파생 자료다. 저장 시 같은 출처·삭제 조건을 적용한다.
        version_rows.append(dict(metadata, status=status, records=0,
                                 reasons=list(dict.fromkeys(reasons)) or ['no_checked_document_fields']))
    relation = acquired['relation']
    if requires_set and (relation['kind'] != 'unresolved' or len(reviews) < 2
                         or relation.get('allDocumentsAvailable') is not True):
        # 일부 정정 파일을 읽지 못했다. 원본의 단독 확인값을 정정 후 값으로 사용할 수 없다.
        reviews.append({'evidence': [], 'issues': []})
    if relation['kind'] == 'unresolved':
        next_actions.add('check_correction_relation')
    checked = combine_reviews(reviews)
    checked['documentVersions'] = version_rows
    next_actions = sorted(next_actions)
    for reason in acquired['reasons']:
        checked['issues'].append({'code': reason, 'stage': 'document_acquisition', 'nextActions': next_actions})
    documents = []
    for doc in acquired['documents']:
        location = doc.get('acquisition') or {}
        entry = {key: doc[key] for key in ('id', 'version', 'sha256', 'source', 'originCheck', 'role', 'adoption',
                                          'houseManageNo', 'noticeNo', 'edition')}
        official = doc['source'] == 'official' and doc['originCheck'] == 'confirmed'
        entry.update(sourceUrl=location.get('url') if official else None,
                     originMatch=location.get('matchedBy'), officialAttachmentId=location.get('indexRecord'),
                     inspectionStatus=inspected.get((doc['id'], doc['version'])))
        documents.append(entry)
    checked['review'] = {
        'contractVersion': 'notice-document-review/v1', 'acquisitionStatus': acquired['status'],
        'observedAt': acquired['observedAt'], 'relation': relation, 'nextActions': next_actions,
        'references': [{key: reference[key] for key in ('id', 'url', 'reason')}
                       for reference in acquired.get('references', ())],
        'documents': documents,
    }
    return checked
