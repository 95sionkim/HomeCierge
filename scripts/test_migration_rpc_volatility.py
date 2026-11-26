"""공개 RPC의 변동성(volatility)과 행 잠금의 충돌을 마이그레이션에서 정적으로 찾는다.

PostgREST는 STABLE·IMMUTABLE 함수를 읽기 전용 트랜잭션에서 실행한다. 그 안에서 FOR SHARE·FOR UPDATE
같은 행 잠금에 닿으면 실제 Supabase에서 25006으로 실패한다. PGlite 검사는 SQL을 직접 실행해 이 차이를
드러내지 못하므로(2026-11-27 업로드 보완 문맥 조회 결함), 마이그레이션 전체를 읽어 마지막 정의 기준으로
공개 함수가 잠금 코드에 닿는지 확인한다. 네트워크·DB 없이 실행한다.
"""
import re
import unittest
from pathlib import Path

MIGRATIONS = Path(__file__).resolve().parents[1] / 'supabase' / 'migrations'
FUNCTION_START = re.compile(r'(?m)^create (?:or replace )?function ((?:public|private)\.[a-z_0-9]+)\(')
ALTER_VOLATILITY = re.compile(
    r'(?mi)^alter function ((?:public|private)\.[a-z_0-9]+)\([^)]*\)\s+(volatile|stable|immutable)\s*;')
ROW_LOCK = re.compile(r'\bfor\s+(share|update|no\s+key\s+update|key\s+share)\b', re.I)
CALL = re.compile(r'((?:public|private)\.[a-z_0-9]+)\(')


def _function_body(chunk):
    """함수 하나의 정의 본문을 돌려준다. $$ 본문과 SQL 표준 return 본문을 모두 다룬다."""
    dollar = chunk.find(' as $$')
    sql_return = chunk.find('\nreturn ')
    if dollar != -1 and (sql_return == -1 or dollar < sql_return):
        end = chunk.find('\n$$;', dollar)
        return chunk[:end + 4] if end != -1 else chunk
    match = re.search(r'\breturn\b.*?;', chunk, re.S)
    return chunk[:match.end()] if match else chunk


def _volatility(body):
    header = re.split(r'\bas \$\$|\nreturn\b', body, maxsplit=1)[0].lower()
    if re.search(r'\bimmutable\b', header):
        return 'immutable'
    if re.search(r'\bstable\b', header):
        return 'stable'
    return 'volatile'


def load_definitions(directory=MIGRATIONS):
    """마이그레이션 순서대로 읽어 함수별 마지막 본문과 마지막 변동성을 돌려준다."""
    bodies, volatility = {}, {}
    for path in sorted(directory.glob('*.sql')):
        text = path.read_text(encoding='utf-8')
        starts = list(FUNCTION_START.finditer(text))
        events = []
        for index, match in enumerate(starts):
            end = starts[index + 1].start() if index + 1 < len(starts) else len(text)
            events.append((match.start(), 'define', match.group(1), _function_body(text[match.start():end])))
        for match in ALTER_VOLATILITY.finditer(text):
            events.append((match.start(), 'alter', match.group(1), match.group(2).lower()))
        for _, kind, name, value in sorted(events, key=lambda event: event[0]):
            if kind == 'define':
                bodies[name] = value
                volatility[name] = _volatility(value)
            else:
                volatility[name] = value
    return bodies, volatility


def stable_rpcs_reaching_row_locks(directory=MIGRATIONS):
    bodies, volatility = load_definitions(directory)
    tainted = {name for name, body in bodies.items() if ROW_LOCK.search(body)}
    changed = True
    while changed:
        changed = False
        for name, body in bodies.items():
            if name not in tainted and (set(CALL.findall(body)) - {name}) & tainted:
                tainted.add(name)
                changed = True
    return sorted(name for name in bodies
                  if name.startswith('public.') and volatility.get(name) != 'volatile' and name in tainted)


class RpcVolatilityTests(unittest.TestCase):
    def test_no_stable_public_rpc_reaches_row_locks(self):
        self.assertEqual(stable_rpcs_reaching_row_locks(), [])

    def test_detects_stable_rpc_that_reaches_a_lock(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, '0001_synthetic.sql').write_text(
                "create function private.locker()\nreturns void language plpgsql as $$\nbegin\n"
                "  perform 1 from public.t for share;\nend;\n$$;\n\n"
                "create function public.reader()\nreturns jsonb language sql stable security invoker as $$\n"
                "  select private.locker();\n$$;\n", encoding='utf-8')
            self.assertEqual(stable_rpcs_reaching_row_locks(Path(tmp)), ['public.reader'])
            Path(tmp, '0002_fix.sql').write_text('alter function public.reader() volatile;\n', encoding='utf-8')
            self.assertEqual(stable_rpcs_reaching_row_locks(Path(tmp)), [])


if __name__ == '__main__':
    unittest.main()
