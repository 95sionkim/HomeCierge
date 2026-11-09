#!/usr/bin/env python3
"""터미널의 숨김 입력으로 API 키를 저장한다. 키는 인자·출력·명령 이력에 넣지 않는다."""
import argparse
import getpass
import os
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ALLOWED = {'DATA_GO_KR_SERVICE_KEY', 'KAKAO_REST_API_KEY', 'LAW_OC',
           'NAVER_API_CLIENT_ID', 'NAVER_API_CLIENT_SECRET', 'ODSAY_API_KEY'}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name', choices=sorted(ALLOWED))
    args = parser.parse_args()
    if not sys.stdin.isatty():
        parser.error('키를 숨겨 입력할 수 있는 터미널에서 실행하세요.')
    value = getpass.getpass('API key (hidden): ').strip()
    if not value or not re.fullmatch(r'[A-Za-z0-9+/%=_@.\-]+', value):
        parser.error('허용된 인증키 형식이 아닙니다. 저장하지 않았습니다.')
    directory = ROOT / '.secrets'
    directory.mkdir(mode=0o700, exist_ok=True)
    directory.chmod(0o700)
    # 열려 있는 공통 설정 파일의 자동 저장과 충돌하지 않도록 키별 파일을 쓴다.
    destination = directory / (args.name + '.env')
    lines = destination.read_text().splitlines() if destination.exists() else []
    updated = False
    for index, line in enumerate(lines):
        if line.partition('=')[0].strip() == args.name:
            lines[index] = args.name + '=' + value
            updated = True
    if not updated:
        lines.append(args.name + '=' + value)
    fd, temporary = tempfile.mkstemp(prefix='api-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as stream:
            stream.write('\n'.join(lines) + '\n')
        os.chmod(temporary, 0o600)
        os.replace(temporary, destination)
    finally:
        Path(temporary).unlink(missing_ok=True)
    print('Saved ' + args.name + ' (value hidden).')

if __name__ == '__main__':
    main()
