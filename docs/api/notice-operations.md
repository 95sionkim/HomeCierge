# 개발 Mac에서 청약 목록·분석·삭제·에이전트 작업 운영

개발 프로젝트 `homecierge-dev`(`jcaelooqogosbzrfyrhe`)와 운영 프로젝트 `homecierge-prod`(`rwomqnyhqpnejytdzwfn`)의 목록 갱신, 분석 실행, 삭제 정리, 에이전트 응답 작업자는 모두 **개발 Mac의 독립된 macOS 로그인 서비스**로 실행한다. `launchd`가 로그인 때 시작하고 프로세스가 종료되면 다시 띄운다. Mac이 켜져 있고 사용자가 로그인한 동안 동작하며, 잠들어 있으면 깨어난 뒤 처리를 재개한다. [Apple의 launchd 실행 안내](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)

개발 서비스와 운영 서비스는 `launchd` 라벨, 플리스트, 상태 파일, 작업자 키, 릴리스 경로가 완전히 분리되어 서로 덮어쓰지 않는다. 운영 작업자는 Vercel 함수 환경(`VERCEL_ENV`·`VERCEL_TARGET_ENV` 값이 있는 프로세스)에서 실행되지 않으며, `WorkerRpc`는 `APP_ENV=development`+(로컬 또는 개발 프로젝트 주소)와 `APP_ENV=production`+운영 프로젝트 주소(`https://rwomqnyhqpnejytdzwfn.supabase.co`, HTTPS 443) 두 조합만 허용하고 교차 조합은 거부한다. **실제 운영 서비스 설치와 운영 키 등록은 총괄이 수행한다.**

| 역할 (`--role`) | 개발 서비스 (`--environment development`, 기본) | 운영 서비스 (`--environment production`) | 처리 시점 및 동작 |
| --- | --- | --- | --- |
| `directory` | `kr.homecierge.development.notice-directory` | `kr.homecierge.production.notice-directory` | 매일 한국 시각 09:17부터 30초 안에 확인. 최근 90일의 두 공고 목록을 갱신한다. 해당 시각을 놓친 날은 깨어난 뒤 한 번 실행한다. 수집이 불완전하면 최근 정상 게시본을 유지한다. |
| `worker` | `kr.homecierge.development.notice-worker` | `kr.homecierge.production.notice-worker` | 대기열을 30초마다 조회. 새 분석을 한 건씩 임대한다. 완료 뒤 곧바로 다음 실행을 확인한다. 실행 상태와 결과는 소유자 API에서 조회한다. |
| `deletion` | `kr.homecierge.development.data-deletion` | `kr.homecierge.production.data-deletion` | 대기열을 30초마다 조회. 접수된 소유자 파일을 정리한다. 계정 전체 삭제는 파일 부재를 확인한 뒤 Auth 계정까지 정리한다. [삭제 처리](data-deletion.md) |
| `agent` | `kr.homecierge.development.agent-worker` | `kr.homecierge.production.agent-worker` | 대기열을 30초마다 조회. 비교 대화(`private.analysis_agent_replies`)와 채팅 홈(`private.chat_agent_replies`)의 비동기 에이전트 응답을 임대·실행·검증하고 만료 임대를 `expired`로 정리한다. [에이전트 코어](agent-core.md) |

## 설치와 자격 설정

HomeCierge 저장소에서 다음 명령을 실행한다. 모든 하위 명령(`install`, `set-key`, `status`, `uninstall`)은 `--environment {development,production}` 옵션을 받으며 기본값은 `development`다. 설치 시점의 커밋을 환경별 릴리스 폴더에 고정하므로 작업자 코드 변경을 적용할 때도 해당 환경으로 `install`을 다시 실행한다. PDF를 사용하는 실행은 이 Python 환경에 `requirements-pdf.txt`의 의존성이 필요하다.

### 개발 서비스(기본 `development`)

```sh
python3 scripts/manage_notice_services.py install --api-env /path/to/private/api.env
python3 scripts/manage_notice_services.py set-key
python3 scripts/manage_notice_services.py status
```

첫 명령은 지정한 파일의 `DATA_GO_KR_SERVICE_KEY`를 `.secrets/DATA_GO_KR_SERVICE_KEY.env`에 복사하며, 같은 파일에 `KAKAO_REST_API_KEY`가 있으면 `.secrets/KAKAO_REST_API_KEY.env`에도 함께 복사한다. 이미 등록했으면 `install`만 실행해도 된다. `KAKAO_REST_API_KEY`는 비교 작업자(`worker`)의 단지 대표 좌표 조회(Q-39)에 쓰는 **선택** 키다. 따로 등록하려면 `python3 scripts/store_api_key.py KAKAO_REST_API_KEY`를 사용한다. 키가 없어도 `worker`는 정상 기동하며 단지 대표 좌표만 미확인 상태로 둔다(`deletion`·`agent` 서비스에는 전달하지 않는다). `set-key`에는 Supabase Dashboard에서 같은 개발 프로젝트의 **secret key**를 터미널 숨김 입력으로 전달한다. 작업자 전용 읽기 RPC로 권한을 확인한 뒤 `.secrets/worker.env`에 저장한다. 자격 파일의 접근 권한은 모두 소유자 읽기·쓰기(`0600`)다. 기존 서비스가 다음 30초 주기에 자격을 읽는다. [Supabase 공식 API 키 안내](https://supabase.com/docs/guides/getting-started/api-keys) · [자동 비교 근거](auto-comparison-evidence.md)

기존 개발 작업자 자격으로 삭제 서비스만 설치·갱신할 때는 `python3 scripts/manage_notice_services.py install --role deletion`을 실행한다. 이 서비스에는 공공데이터 API 키가 필요 없다.

비교 대화·채팅 에이전트 작업자(`--role agent`)는 `SUPABASE_WORKER_KEY`와 `.secrets/OPENAI_API_KEY.env`의 `OPENAI_API_KEY`를 사용하며 공공데이터 API 키는 요구하지 않는다. OpenAI 키는 `python3 scripts/store_api_key.py OPENAI_API_KEY`로 숨김 입력해 저장한다.

### 운영 서비스(`--environment production`, 총괄이 설치)

운영 서비스는 개발 서비스를 건드리지 않고 개발 Mac에 따로 설치한다. 실제 운영 서비스 설치와 운영 키 등록은 총괄이 수행한다.

```sh
python3 scripts/manage_notice_services.py install --environment production
python3 scripts/manage_notice_services.py set-key --environment production
python3 scripts/manage_notice_services.py status --environment production
```

- **비밀 폴더와 권한**: 운영 비밀 폴더는 `.secrets/production/`(`0700`), 각 키 파일은 소유자 전용(`0600`)이다.
- **운영 작업자 키(`SUPABASE_WORKER_KEY`)**: `set-key --environment production`은 운영 프로젝트(`https://rwomqnyhqpnejytdzwfn.supabase.co`)로 `verify_worker` 권한 확인을 거친 뒤 `.secrets/production/worker.env`에 저장한다(터미널 숨김 입력). 운영 서비스는 `worker.env`를 `.secrets/production/worker.env`에서만 읽으며 개발 `.secrets/worker.env`로 대체하지 않는다.
- **외부 API 키 대체 규칙**: 데이터포털(`DATA_GO_KR_SERVICE_KEY`), 카카오(`KAKAO_REST_API_KEY`), OpenAI(`OPENAI_API_KEY`) 키는 `.secrets/production/<이름>.env`가 있으면 그것을 읽고, 파일이 없으면 `.secrets/<이름>.env`를 읽는다(같은 계정 키를 함께 쓰는 경우). 운영 전용 데이터포털·카카오 키를 따로 쓰려면 `install --environment production --api-env /path/to/private/prod-api.env`로 `.secrets/production/`에 저장한다(개발 `.secrets/` 파일을 덮어쓰지 않는다). 운영 전용 OpenAI 키를 따로 쓰려면 `.secrets/production/OPENAI_API_KEY.env`를 `0600`으로 둔다.
- **플리스트·상태·릴리스 분리**: 운영 플리스트는 `~/Library/LaunchAgents/kr.homecierge.production.*.plist`, 상태·잠금·릴리스는 `.secrets/production/notice-services/` 아래에 저장한다. 같은 환경 이름의 다른 체크아웃 서비스가 이미 있으면 설치·제거를 거부한다.

## 상태 확인과 재시작

`status`는 지정한 환경의 서비스 4개만 한 줄씩 JSON으로 출력한다(`--environment` 생략 시 개발, `--environment production` 지정 시 운영). `launchd`의 `running`은 프로세스가 실행 중임을 뜻한다. 최근 실행 내용은 `status`와 `checkedAt`으로 확인한다.

| 상태 | 확인할 내용 |
| --- | --- |
| `waiting_for_worker_key`, `waiting_for_provider_key`, `waiting_for_llm_key` | 해당 자격을 등록하면 자동으로 재개한다. |
| `worker_key_rejected`, `rpc_unavailable` | 해당 환경 프로젝트의 작업자 권한과 네트워크 연결을 점검한다. |
| `idle` | 작업자가 해당 환경 DB에 연결해 대기 작업이 없음을 확인했다. 직전에 처리한 실행의 상태는 `lastJobStatus`에 남는다. |
| `scheduled`, `refreshing` | 갱신 시각을 기다리거나 당일 갱신을 실행 중이다. |
| `published` | `publishedAt`과 `noticeCount`로 최근 정상 게시 시점과 공고 수를 확인한다. |
| `kept_previous`, `publication_unconfirmed` | 수집이 불완전하거나 게시 응답을 확인할 수 없었다. 마지막 정상 게시 시점과 공고 수를 확인한다. |
| `processing`, `live_deleted`, `storage_review_required` | 삭제를 처리 중이거나 해당 요청의 서비스 삭제를 완료했다. 마지막 상태는 자동으로 정리할 수 없는 파일의 소유관계를 운영자가 확인해야 함을 뜻한다. |

갱신 시도 일자는 개발 Mac의 환경별 상태 파일에 먼저 기록한다. 프로세스가 수집 중 중단되면 자동 재시작 때 `publication_unconfirmed`로 기록하고 다음 날 정기 갱신을 기다린다. 같은 날 즉시 재게시가 필요하면 해당 환경 권한과 최근 게시 시각을 확인한 뒤 [수동 갱신 명령](notice-directory.md)을 사용한다.

## 서비스 제거

GitHub Actions로 목록 예약을 옮기거나 특정 서비스만 중지할 때는 `--role`과 `--environment`를 지정해 해제할 수 있다.

```sh
# 개발 목록 갱신 서비스만 해제
python3 scripts/manage_notice_services.py uninstall --role directory

# 운영 서비스 전체 해제(개발 서비스는 유지)
python3 scripts/manage_notice_services.py uninstall --environment production

# 운영 목록 갱신 서비스만 해제
python3 scripts/manage_notice_services.py uninstall --environment production --role directory
```

`--role`을 생략하면 지정한 환경에 등록된 네 서비스(`worker`, `directory`, `deletion`, `agent`)를 함께 해제한다. 개발·운영은 서로의 플리스트·상태·자격 파일을 건드리지 않는다. 마지막 상태와 자격 파일은 체크아웃의 `.secrets/`(개발)와 `.secrets/production/`(운영)에서 소유자가 관리한다.
