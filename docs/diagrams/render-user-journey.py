#!/usr/bin/env python3
"""HomeCierge 사용자 흐름을 하나의 편집 가능한 SVG 플로우차트로 생성한다."""
from pathlib import Path
import html
import json
import unicodedata
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
OUT = ROOT / 'user-journey-flowchart.svg'
W, H = 2290, 6240
nodes = {}
edges = []

def node(key, x, y, w, h, kind, title, *body):
    nodes[key] = dict(id=key, x=x, y=y, w=w, h=h, kind=kind, title=title, body=list(body))

def port(key, side):
    n = nodes[key]
    return {'N': (n['x']+n['w']/2, n['y']), 'S': (n['x']+n['w']/2, n['y']+n['h']),
            'W': (n['x'], n['y']+n['h']/2), 'E': (n['x']+n['w'], n['y']+n['h']/2)}[side]

def edge(a, b, start='S', end='N', via=None, label='', at=None, dashed=False, both=False):
    p, q = port(a, start), port(b, end)
    if via is None:
        if p[0] == q[0] or p[1] == q[1]:
            via = []
        elif start in ('N', 'S') and end in ('N', 'S'):
            via = [(p[0], (p[1]+q[1])/2), (q[0], (p[1]+q[1])/2)]
        else:
            via = [((p[0]+q[0])/2, p[1]), ((p[0]+q[0])/2, q[1])]
    edges.append(dict(a=a, b=b, points=[p, *via, q], label=label, at=at, dashed=dashed, both=both))

# 공통 준비는 제품 기능과 독립적인 설계 제안이다.
node('prep-api',70,260,430,142,'api','0  공고·주택형 수집','청약홈 공고 API → 주택형 API','신규·변경·누락 자료의 필요한 범위')
node('prep-pdf',610,260,430,142,'api','공식 문서 확보','공식 상세 페이지 → 첨부 PDF','개별 호실 가격·필수 옵션 근거')
node('prep-check',1150,260,430,142,'process','정규화·자동 점검','공고·회차·주택형 연결','단위·원문 페이지·적용 대상 대조')
node('prep-db',1690,260,430,142,'db','공고 카탈로그','확인된 값 + 미확인 사유','출처·문서 버전·수집 시점')
edge('prep-api','prep-pdf','E','W')
edge('prep-pdf','prep-check','E','W')
edge('prep-check','prep-db','E','W')

# 1. 로그인과 조건 입력.
node('login',660,560,460,145,'stage','1  로그인·조건 입력','필수: 희망 시·군·구 + 예산','선택: 공급면적 범위 + 입주 월 범위')
node('auth',1300,560,430,145,'auth','Supabase Auth','로그인·세션·사용자 권한 확인','인증 전 탐색·분석은 실행하지 않음')
node('profile',1810,560,330,145,'db','자기 계정 복원','대화·확인한 프로필','기존 분석·승인 상태')
node('input-ok',710,790,360,156,'decision','로그인·필수 조건','충족?')
node('need-input',70,795,430,142,'hold','입력·로그인 보완','누락 조건을 사용자에게 안내','미승인 변경은 공유 프로필에 미반영')
edge('login','auth','E','W',label='인증',at=(1210,613),both=True)
edge('auth','profile','E','W',label='성공 시',at=(1770,613))
edge('login','input-ok')
edge('input-ok','need-input','W','E',label='아니요',at=(595,846))
edge('need-input','login','N','W',via=[(285,755),(550,755),(550,632.5)],label='입력 후',at=(552,733))

# 2. 카탈로그 조회와 부족한 자료의 조건부 보완.
node('search',660,1050,460,142,'stage','2  공고 탐색','입력 조건으로 공고 카탈로그 조회','요청 지역·유형의 수집 범위 확인')
node('catalog',1300,1050,430,142,'db','공고·가격·문서 근거','접수일·입주 시점·공급면적','호실별 분양가 + 필수 옵션')
node('catalog-ok',710,1260,360,156,'decision','필요 자료·근거가','충분한가?')
node('catalog-fetch',1300,1250,430,168,'api','필요한 항목만 보완 조회','청약홈 공고·주택형 API','공식 PDF 확보·추출·자동 점검','누락·갱신 필요 시에만 실행 [제안]')
node('filter',660,1500,460,142,'process','같은 주택형·호실에서 판정','예산·면적·입주 등 적용 조건을 함께 검사','필수 옵션 미확인을 0원으로 채우지 않음')
node('lists',70,1490,430,168,'result','공고 목록 제공','충족 목록 / 확인 필요 목록 분리','확인된 미충족은 충족 목록에서 제외','접수 중 마감일순 → 예정 시작일순')
edge('input-ok','search',label='예',at=(925,1000))
edge('prep-db','catalog','E','E',via=[(2190,331),(2190,1121)],label='같은 카탈로그',at=(2030,1014))
edge('search','catalog','E','W',label='DB 조회',at=(1210,1100),both=True)
edge('search','catalog-ok')
edge('catalog-ok','catalog-fetch','E','W',label='부족·갱신 필요',at=(1180,1318))
edge('catalog-fetch','catalog','N','S',label='점검 후 저장',at=(1645,1228),dashed=True)
edge('catalog-ok','filter',label='충분',at=(928,1460))
edge('catalog-fetch','filter','S','E',via=[(1515,1571)],label='점검·수집 상태 반영',at=(1310,1533))
edge('filter','lists','W','E',label='판정 결과',at=(575,1549))

# 3. 문서 보완과 분석 입력 고정.
node('detail',660,1760,460,142,'stage','3  공고·주택형 선택','한 공고·한 주택형, 호실은 선택','가격 범위·공급면적·원문 근거 확인')
node('detail-db',1300,1760,430,142,'db','선택 공고의 상세 자료','공고·회차·주택형·호실·문서 버전','값별 점검 상태와 페이지 근거')
node('detail-ok',710,1970,360,156,'decision','핵심 값의 근거가','확인됐나?')
node('pdf-fetch',1300,1960,430,142,'api','공식 PDF 자동 확보','공식 상세 페이지·첨부 문서','PDF 전용 API가 있는 것으로 가정 안 함')
node('upload',1810,1960,330,142,'stage','사용자 PDF 업로드','자동 확보 실패 시 보완','계정 소유 문서로 관리')
node('pdf-check',1300,2180,430,168,'process','문서 확보·자동 점검 결과','공고·회차·페이지·단위·옵션 대조','점검값·근거·상태를 소유 범위에 저장','미제공·회차·정정 충돌·불명확 값 보류')
node('fixed-input',660,2380,460,142,'process','분석 조건·확인된 입력 고정','확인된 호실 소계 범위 또는 선택 호실 가격','독립적으로 확인한 값만 해당 계산에 사용')
node('detail-hold',70,2370,430,168,'hold','미확인 값·의존 계산 보류','다른 회차·정정 적용 미확인·값 충돌','해당 항목의 사유와 보완 행동 표시','독립적인 기본 정보·결과는 제공')
edge('lists','detail','S','W',via=[(285,1831)],label='공고 선택',at=(480,1804))
edge('detail','detail-db','E','W',label='DB 조회',at=(1210,1809),both=True)
edge('detail','detail-ok')
edge('detail-ok','pdf-fetch','E','W',label='미확인',at=(1180,2020))
edge('pdf-fetch','upload','E','W',label='실패',at=(1770,2006))
edge('pdf-fetch','pdf-check',label='확보 성공',at=(1570,2145))
edge('upload','pdf-check','S','E',via=[(1975,2264)],label='업로드 / 미제공',at=(1938,2222))
edge('detail-ok','fixed-input',label='확인됨',at=(943,2275))
edge('pdf-check','fixed-input','S','E',via=[(1515,2451)],label='점검 결과',at=(1314,2418))
edge('fixed-input','detail-hold','W','E',label='해당 항목만',at=(575,2427),dashed=True)

# 4. 실거래 수집과 정상 0개 판정. 자체 거래는 주변 모집단에서 제외한다.
node('analysis',660,2690,460,168,'stage','4  실거래 비교 실행','기본: 조회일까지 최근 1년 (당월 포함)','실행 ID·기간·종류·면적·기준 시점 고정','진행·재시도·취소 상태를 별도로 관리')
node('trade-db',1300,2690,430,142,'db','거래·단지·면적 근거','필요한 지역·월·페이지의 수집 상태','출처 허용·자료 버전·최신성 조건')
node('reuse',710,2900,360,156,'decision','필요 자료를','재사용할 수 있나?')
node('trade-api',1300,2890,430,194,'api','부족한 범위만 조회·보완','매매 API / 권리 API: 지역·월·페이지','카카오 주소 / K-apt 목록·기본정보','건축물대장: 식별·특성 근거','공급면적 대응은 별도 공식 근거 필요')
node('mapping-note',1810,2890,330,194,'pending','자료 경로 미정','공식 공급면적 대응','미확인 거래는 보류','대장 표제부만으로','세대 공급면적을 확정 안 함')
node('eligibility',660,3150,460,168,'process','수집 완전성·비교 자격 판별','기간·해제·거래 종류·지역을 확인','단지 식별·공급면적 대응을 검증','확인된 제외와 미확인·실패를 구분')
node('local-state',710,3410,360,176,'decision','같은 동·읍·면의','주변 후보 상태는?')
node('local-hold',70,3415,430,168,'hold','지역 확대 보류','확인 후보 0개 + 미확인·부분 수집·오류','정상 0개로 처리하지 않음','사유·재시도·공식 근거 확보 필요 표시')
node('expand',1300,3395,430,194,'api','같은 구 또는 구 없는 시·군','우선 지역의 전체 정상 0개일 때만 확대','자료가 있으면 기존 스냅샷에서 재판정','자료가 부족하면 필요한 요청만 추가','공통 지역 범위는 거래 종류 전체에 적용')
node('expanded-state',1335,3680,360,156,'decision','확대 지역에','확인 후보가 있나?')
node('expanded-empty',1810,3680,330,168,'hold','없음·보류를 구분','정상 0개: 비교 자료 부족','미확인·실패: 판정 보류','인접 지역으로 자동 확대 안 함')
node('stats',660,3740,460,194,'process','단지 선정·종류별 통계','공급면적 ±5% 안의 단지별 최근접 면적','면적 차이순 → 확인 좌표의 직선거리순','전체 고유 주변 최대 5단지','매매·분양권·입주권의 가격·건수 분리')
node('rules-note',70,3740,430,194,'note','유지할 비교 규칙','후보 1~4개이면 상위 지역에서 보충 안 함','자체 거래는 주변 수·정상 0개에서 제외','유효 거래 1건 이상 포함, 1~2건 안내','미확인이 남으면 완전한 순위로 표시 안 함')
node('comparison-result',660,4100,460,142,'result','비교 결과·근거·보류 제공','자체 단지 거래는 별도 참고','작업 진행 상태와 자료 완전성을 구분')
edge('fixed-input','analysis')
edge('analysis','trade-db','E','W',label='DB 조회',at=(1210,2740),both=True)
edge('analysis','reuse')
edge('reuse','trade-api','E','W',label='아니요',at=(1180,2955))
edge('trade-api','trade-db','N','S',label='정규화·상태 저장',at=(1645,2872),dashed=True)
edge('mapping-note','trade-api','W','E',label='',dashed=True)
edge('reuse','eligibility',label='예',at=(925,3115))
edge('trade-api','eligibility','S','E',via=[(1515,3234)],label='정규화·상태 기록',at=(1315,3200))
edge('eligibility','local-state')
edge('local-state','local-hold','W','E',label='확인 0 + 미확인 등',at=(586,3472))
edge('local-state','expand','E','W',label='전체 정상 0개',at=(1180,3470))
edge('local-state','stats',label='확인 후보 1개 이상: 현재 지역 유지',at=(897,3654))
edge('expand','expanded-state')
edge('expanded-state','stats','W','E',via=[(1225,3758),(1225,3837)],label='확인됨',at=(1230,3728))
edge('expanded-state','expanded-empty','E','W',label='없음·보류',at=(1752,3726))
edge('stats','comparison-result')
edge('local-hold','comparison-result','S','W',via=[(285,3630),(550,3630),(550,4171)])
edge('expanded-empty','comparison-result','S','E',via=[(1975,4171)],label='상태·사유',at=(1580,4136))

# 5. 보조 기능은 관련 조건을 얻은 뒤 비교와 병행할 수 있다.
node('extras',660,4410,460,142,'stage','5  보조 정보 확인','공고 조건·지역·적용 시점 확인','사용자가 입력한 목적지·자금 조건 연결')
node('extra-input',70,4410,430,142,'stage','필요한 입력을 보완','목적지·수단·시간 조건 / 분석별 자금','입력이 없어도 공고·비교 결과는 유지')
node('news',70,4650,460,168,'api','지역 뉴스','NAVER API HUB 뉴스 검색','지역·검색 조건 확보 후 병행 [제안]','제목·발췌·링크·게시시각, 지역성 미확인 구분')
node('law',610,4650,460,168,'api','법령 근거','국가법령정보 검색 → 시행 버전 본문','공고 조건·적용 기준시점 확보 후 병행','개인 청약 자격을 자동 확정하지 않음')
node('routes',1150,4650,460,168,'api','출퇴근 경로','ODsay: 대중교통·연결 도보','자동차: 제공자 미선정','목적지·수단 등 확보 + 조회 요청 시 [제안]')
node('funding',1690,4650,460,168,'process','기초 자금표','확인된 납부 일정 + 분석별 자금','확정·예상 구분, 시점별 부족분 계산','외부 금융 API 호출 없음')
edge('comparison-result','extras')
edge('extra-input','extras','E','W')
edge('fixed-input','extras','S','E',via=[(890,2595),(2235,2595),(2235,4481)],dashed=True)
for key in ['news','law','routes','funding']:
    p=port(key,'N');edge('extras',key,via=[(890,4598),(p[0],4598)])

# 6. 동일한 결과 버전을 저장·복원한다.
node('report',660,5000,460,142,'stage','6  저장·다시 열기·PDF','조건·값·조회 시점·출처·미확인 고정','기능별 성공·입력 필요·실패를 함께 보존')
node('report-db',1300,5000,430,142,'db','계정별 보고서·비공개 파일','결과 스냅샷·동일 버전 PDF','출처별 보관·내보내기 조건 적용')
node('llm',1810,5000,330,142,'pending','LLM 설명 보조 [제안]','허용된 구조화 결과만 사용','모델·호스팅 미정')
node('display',70,5000,430,142,'result','화면·대화·PDF 일치','단순 저장·복원은 외부 자료 재조회 없음','새 자료로 과거 보고서를 덮어쓰지 않음')
for key in ['news','law','routes','funding']:
    p=port(key,'S');edge(key,'report',via=[(p[0],4900),(890,4900)])
edge('report','report-db','E','W',label='저장·복원',at=(1208,5048),both=True)
edge('report-db','llm','E','W',label='',dashed=True,both=True)
edge('report','display','W','E')
node('next',710,5260,360,160,'decision','다음 행동은?')
node('keep',70,5275,430,130,'result','저장한 결과 유지','다시 열면 같은 보고서 버전 복원','필요할 때 다른 공고의 새 분석 시작')
node('change',1300,5255,430,168,'stage','7  조건 변경·재분석','변경 내용을 확인한 뒤 적용','프로필 변경과 이번 분석 변경을 구분','미응답·거절·취소이면 기존 값 유지')
node('profile-update',1300,5500,370,168,'db','공유 프로필 변경 승인','승인 버전 확인 후 해당 값만 갱신','기존 분석·보고서는 유지','승인 자체로 부동산 API 조회 없음')
node('rerun',1770,5500,370,168,'process','분석 변경·최신 자료 요청','기존 자료가 충족하면 재계산','부족·갱신 필요 범위만 재조회','A 탐색 / B 비교 / C 보조 정보')
edge('report','next')
edge('next','keep','W','E',label='유지·다시 열기',at=(584,5314))
edge('next','change','E','W',label='변경 요청',at=(1180,5314))
edge('change','profile-update',via=[(1515,5460),(1485,5460)],label='공유 프로필',at=(1395,5465))
edge('change','rerun','S','N',via=[(1515,5460),(1955,5460)],label='해당 분석',at=(1835,5430))

# 8. 삭제는 보고서 확인 뒤 선택하는 분기이며 필수 후속 단계가 아니다.
node('delete',660,5520,460,142,'stage','8  개별 자료·계정 삭제','소유권·삭제 범위·연관 영향을 확인','삭제 요청·처리 중·완료를 구분')
node('delete-work',660,5750,460,142,'process','관련 작업 차단 후 정리','진행 작업의 쓰기·재개를 먼저 차단','DB·파일 정리, 계정 삭제 시 Auth 처리')
node('delete-db',1300,5750,430,142,'db','DB·Storage·Auth 관리','백업·파생 자료의 처리 범위는 D-06','삭제한 입력의 복원·재생성 방지')
node('deleted',660,5985,460,112,'result','삭제 처리 상태 안내','삭제 완료 범위와 남은 처리 사항 표시')
edge('next','delete',label='삭제 요청',at=(945,5480))
edge('delete','delete-work')
edge('delete-work','delete-db','E','W',label='서버에서 처리',at=(1207,5797),both=True)
edge('delete-work','deleted')

palette = {
    'stage':('#eef4ff','#7197db','사용자 단계'),
    'process':('#ffffff','#c5d0dd','서비스 처리'),
    'api':('#eef8f5','#6fa898','외부 조회 · 조건부 호출'),
    'db':('#f0f1fc','#969bd2','DB · 저장소'),
    'auth':('#f0f1fc','#969bd2','인증 · 플랫폼 API'),
    'decision':('#fff8e8','#d3ae5f','조건 판단'),
    'hold':('#fff4e9','#d5a36c','보완 · 보류'),
    'result':('#f3f6fa','#a4b4c6','사용자에게 제공'),
    'pending':('#fafbfc','#aab5c2','제안 · 미정'),
    'note':('#fafbfc','#aab5c2','확정 비교 규칙'),
}
parts=[]
def add(s):parts.append(s)
def tx(x,y,text,size=19,fill='#26374b',anchor='middle',weight=400,extra=''):
    add(f'<text x="{x:g}" y="{y:g}" text-anchor="{anchor}" font-size="{size}" font-weight="{weight}" fill="{fill}" {extra}>{html.escape(text)}</text>')

add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="chart-title chart-desc">')
add('<title id="chart-title">HomeCierge 사용자 단계별 통합 서비스 플로우차트</title>')
add('<desc id="chart-desc">공고 사전 준비, 로그인, 공고 탐색, 문서 보완, 실거래 비교, 보조 기능, 저장, 조건 변경과 삭제를 한 장으로 연결한 목표 동작 설계. API 호출 시점은 제안이며 공급면적 대응 경로와 자동차 제공자는 미정이다.</desc>')
add('<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="8.5" refY="5" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9 Z" fill="#6f8297"/></marker></defs>')
add('<style>text{font-family:"Apple SD Gothic Neo","Noto Sans KR","Malgun Gothic",sans-serif} .edge{fill:none;stroke:#6f8297;stroke-width:2.5;stroke-linejoin:round;stroke-linecap:round} .node-title{font-weight:650} </style>')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')
tx(70,65,'HOMECIERGE  /  SERVICE FLOW',19,'#5c7289','start',700, 'letter-spacing="2"')
tx(70,120,'사용자 단계별 통합 플로우차트',42,'#152c44','start',700)
tx(70,159,'입력 → DB 확인 → 필요한 API 조회 → 판정·계산 → 결과 저장·복원',23,'#50667c','start')
tx(W-70,70,'2026.11.11 · PRD v1.0 기준',18,'#5c7289','end')
tx(W-70,103,'목표 동작 설계 · 구현 완료 표시 아님',18,'#5c7289','end')
for x,k,label in [(70,'stage','사용자 단계'),(350,'process','서비스 처리'),(635,'decision','조건 판단'),(900,'api','외부 API·문서'),(1260,'db','DB·인증·저장소'),(1650,'hold','보완·보류')]:
    f,s,_=palette[k];add(f'<rect x="{x}" y="190" width="22" height="22" rx="5" fill="{f}" stroke="{s}" stroke-width="2"/>');tx(x+33,208,label,18,'#50667c','start')
add('<path d="M1915 201 H1965" stroke="#6f8297" stroke-width="2.5" stroke-dasharray="9 7"/>')
tx(1978,208,'제안·보완·저장 연결',18,'#50667c','start')
add('<rect x="40" y="235" width="2135" height="205" rx="20" fill="none" stroke="#72a493" stroke-width="2" stroke-dasharray="8 7"/>')
tx(70,475,'0단계는 공통 데이터 준비 제안 · 수집 주기·최신성 기준·실행 런타임은 미정',20,'#53786a','start',500)
tx(70,514,'처리: Vercel 자체 API·작업 접수 / 수집 실행기 위치 미정     플랫폼: Supabase Auth·DB·Storage',18,'#5c7289','start')

# 화살표는 노드 아래에 그려 노드와 라벨의 편집 가능성을 유지한다.
for e in edges:
    pts=' '.join(f'{x:g},{y:g}' for x,y in e['points'])
    dash=' stroke-dasharray="9 7"' if e['dashed'] else ''
    begin=' marker-start="url(#arrow)"' if e['both'] else ''
    add(f'<polyline class="edge" points="{pts}" marker-end="url(#arrow)"{begin}{dash} data-from="{e["a"]}" data-to="{e["b"]}"/>')

for key,n in nodes.items():
    x,y,w,h=n['x'],n['y'],n['w'],n['h'];fill,stroke,tag=palette[n['kind']]
    add(f'<g id="{key}" data-kind="{n["kind"]}">')
    add(f'<title>{html.escape(n["title"])}</title>')
    dashed=' stroke-dasharray="8 6"' if n['kind']=='pending' else ''
    if n['kind']=='decision':
        add(f'<path d="M{x+w/2:g} {y:g} L{x+w:g} {y+h/2:g} L{x+w/2:g} {y+h:g} L{x:g} {y+h/2:g} Z" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
        lines=[n['title'],*n['body']];start=y+h/2-(len(lines)-1)*15+8
        for i,line in enumerate(lines):tx(x+w/2,start+i*30,line,22,'#5a482c','middle',650)
    elif n['kind']=='db':
        eh=17
        add(f'<path d="M{x} {y+eh} C{x} {y-6} {x+w} {y-6} {x+w} {y+eh} L{x+w} {y+h-eh} C{x+w} {y+h+6} {x} {y+h+6} {x} {y+h-eh} Z" fill="{fill}" stroke="{stroke}" stroke-width="2"/>')
        add(f'<path d="M{x} {y+eh} C{x} {y+eh*2+6} {x+w} {y+eh*2+6} {x+w} {y+eh}" fill="none" stroke="{stroke}" stroke-width="1.5"/>')
        tx(x+w/2,y+56,n['title'],23,'#303c6c','middle',650)
        for i,line in enumerate(n['body']):tx(x+w/2,y+87+i*26,line,18.5,'#4c5875')
    else:
        rx=24 if n['kind']=='result' else 16
        add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="2"{dashed}/>')
        tx(x+w/2,y+25,tag,13,'#6c7e90','middle',600,'letter-spacing="1"')
        tx(x+w/2,y+59,n['title'],23,'#233b55','middle',650)
        for i,line in enumerate(n['body']):tx(x+w/2,y+91+i*26,line,18.5,'#50647a')
    add('</g>')

for e in edges:
    if not e['label'] or not e['at']:continue
    x,y=e['at'];label=e['label']
    width=max(40,sum(18 if unicodedata.east_asian_width(c) in 'WF' else (6 if c.isspace() else 10) for c in label)+18)
    add(f'<rect x="{x-width/2:g}" y="{y-21:g}" width="{width:g}" height="31" rx="5" fill="#ffffff" opacity="0.97"/>')
    tx(x,y,label,18,'#576e86','middle',550)

# 긴 회귀선을 대신하는 표준 연결자. SVG 안에서도 각 목적지로 이동할 수 있다.
for key,letter,side in [('search','A','W'),('analysis','B','W'),('extras','C','N')]:
    n=nodes[key]
    if side=='W':cx,cy=n['x']-65,n['y']+n['h']/2;end=port(key,'W');pts=[(cx+22,cy),end]
    else:cx,cy=n['x']+n['w']/2,n['y']-62;end=port(key,'N');pts=[(cx,cy+22),end]
    add(f'<polyline class="edge" points="{" ".join(f"{x:g},{y:g}" for x,y in pts)}" marker-end="url(#arrow)"/>')
    add(f'<circle cx="{cx}" cy="{cy}" r="22" fill="#ffffff" stroke="#7197db" stroke-width="2"/>');tx(cx,cy+7,letter,20,'#426cb6','middle',700)
for cx,letter,target in [(1840,'A','search'),(1955,'B','analysis'),(2070,'C','extras')]:
    add(f'<a href="#{target}"><circle cx="{cx}" cy="5713" r="22" fill="#eef4ff" stroke="#7197db" stroke-width="2"/>');tx(cx,5720,letter,20,'#426cb6','middle',700);add('</a>')
    add(f'<path class="edge" d="M{cx} 5668 V5691" marker-end="url(#arrow)"/>')
tx(1955,5771,'확인한 변경의 해당 단계로 새 실행',17,'#53739c')
tx(2259,3480,'공고 근거 확보 후 보조 기능을 병행할 수 있음 [제안]',18,'#6c8197','middle',500,'transform="rotate(90 2259 3480)"')
tx(1340,4942,'기능별 확인된 결과와 입력 필요·실패 상태를 함께 병합',18,'#5c7289','start')
add('<line x1="70" y1="6140" x2="2220" y2="6140" stroke="#dce3eb" stroke-width="2"/>')
tx(70,6178,'확정 요구는 PRD를 따릅니다. API 호출 시점·사전 처리·재사용은 제안이며, 미정 자료를 확인된 값으로 사용하지 않습니다.',18,'#5c7289','start')
tx(70,6210,'근거: docs/service-flow.md · docs/prd/01-product-prd.md · docs/development-plan.md   |   A/B/C: 조건 변경 후 해당 단계로 연결',17,'#6f8194','start')
add('</svg>')
svg='\n'.join(parts)+'\n'
ET.fromstring(svg)
OUT.write_text(svg,encoding='utf-8')
(ROOT/'user-journey-flowchart.layout.json').write_text(json.dumps({'width':W,'height':H,'nodes':nodes,'edges':edges},ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(f'Saved {OUT.name}: {len(nodes)} nodes, {len(edges)} edges; {W} × {H}')
