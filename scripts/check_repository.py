#!/usr/bin/env python3
"""공개 개발 자료의 파일 구성·JSON·내부 문서 링크를 오프라인 검사한다."""
import json
import re
import subprocess
import sys
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
BLOCKED_PARTS = {'.secrets', 'api-evidence', 'pdf-evidence', 'private-data', 'private-notes'}
BLOCKED_SUFFIXES = {'.pdf', '.hwp', '.hwpx', '.pem', '.key'}


def files_to_check():
    # Git 체크아웃에서는 실제 추적 파일만, 인계용 폴더에서는 공개 파일만 검사한다.
    try:
        top = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', '--show-toplevel'], stderr=subprocess.DEVNULL).decode().strip()
        if Path(top).resolve() == ROOT:
            paths = subprocess.check_output(['git', '-C', str(ROOT), 'ls-files', '-z']).decode().split('\0')
            return [ROOT / p for p in paths if p]
    except (OSError, subprocess.CalledProcessError):
        pass
    return [p for p in ROOT.rglob('*') if p.is_file()
            and not any(part in {'.git', '__pycache__', '.venv'} for part in p.relative_to(ROOT).parts)]


def main():
    problems = []
    files = files_to_check()
    for path in files:
        rel = path.relative_to(ROOT)
        if (set(rel.parts) & BLOCKED_PARTS or path.suffix in BLOCKED_SUFFIXES
                or (path.name.startswith('.env') and path.name != '.env.example')):
            problems.append(str(rel) + ': private/generated source must not be tracked')
            continue
        if path.is_symlink():
            problems.append(str(rel) + ': symlink requires explicit review')
            continue
        if path.suffix == '.json':
            try:
                json.loads(path.read_text(encoding='utf-8'))
            except (ValueError, UnicodeError) as exc:
                problems.append(str(rel) + ': invalid JSON: ' + type(exc).__name__)
        if path.name == '.env.example':
            for line in path.read_text().splitlines():
                if line.strip() and not line.lstrip().startswith('#') and '=' in line:
                    if line.partition('=')[2].strip():
                        problems.append(str(rel) + ': credential template must be empty')
        if path.suffix != '.md':
            continue
        text = path.read_text(encoding='utf-8')
        if '[[' in text:
            problems.append(str(rel) + ': use portable Markdown links')
        for target in re.findall(r'\[[^\]\n]+\]\(([^)\s]+)\)', text):
            parsed = urlsplit(target)
            if parsed.scheme or target.startswith('#'):
                continue
            resolved = (path.parent / unquote(parsed.path)).resolve()
            if not resolved.is_relative_to(ROOT) or not resolved.exists():
                problems.append(str(rel) + ': unresolved local link: ' + target)
    if problems:
        print('\n'.join(problems))
        return 1
    print('Repository checks passed: %d files; JSON, internal file links, and publication paths.' % len(files))
    print('This check does not replace a review for secrets or third-party data rights.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
