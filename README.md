# omo-fucking-watch-extension

Muse Spark 세션의 정지 징후를 알리고, 사용자가 명시적으로 요청한 재개를 보호하는 OmO/Senpi 확장이다.

**자동 abort와 자동 continue는 하지 않는다.** 현재 엔진은 백그라운드 작업의 완료 알림이
아직 전달 대기 중인지 확장에 알려주지 않는다. idle이나 열린 todo만 보고 작업을
재개하던 구버전 동작을 제거했다. 모델 API의 HTTP 오류와 retry는 엔진이 처리한다.

## 설치

OmO Senpi CLI가 필요하다. 패키지 설치와 수동 파일 설치 중 하나만 사용한다.

```bash
omo install https://github.com/MovieHolic-Plex/omo-fucking-watch-extension --no-approve
```

수동 설치:

```bash
# Linux / macOS
cp muse-watch.js ~/.omo/agent/extensions/

# Windows
copy muse-watch.js %USERPROFILE%\.omo\agent\extensions\
```

파일 교체 후 이미 열린 세션에서는 `/reload`를 실행한다. 새 프로세스에는 자동 적용된다.

## 명령

| 명령 | 동작 |
| --- | --- |
| `/muse-watch` 또는 `/muse-watch status` | 현재 모델, pause, todo, 입력·대기 상태와 차단 이유 표시 |
| `/muse-watch pause` | 사용자 중단 상태를 세션에 기록 |
| `/muse-watch resume` | 유효한 pause 상태만 해제. 자동 재개를 활성화하지 않음 |
| `/muse-watch continue` | 완료 알림 대기 상태를 확인할 수 없음을 안내. 전송하지 않음 |
| `/muse-watch continue-confirmed` | 그 불확실성을 사용자가 명시적으로 수락하고 수동 재개 한 번 요청 |

새 세션은 paused로 시작한다. 사용자 abort는 pause로 기록되며 reload, 모델의 자동
실행, 확장이 만든 입력으로 해제되지 않는다. 새 사용자 입력이 실제로 수락되거나
명시적으로 `resume`을 실행해야 해제된다. `resume`은 미처리 입력이나 기존 재개
시도 기록을 지우지 않는다.

### 수동 재개의 조건

`continue-confirmed`도 다음 조건을 모두 충족해야 전송한다.

- 현재 모델이 아래 지원 모델 중 하나이고, 유효한 열린 todo가 있다.
- pause가 해제되어 있고 에이전트가 idle이며 도구·retry·compaction 실행 중이 아니다.
- **TUI 입력칸이 정확히 빈 문자열**이다. 공백이나 작성 중인 내용도 입력으로 보호한다.
- 예약 메시지, 아직 수락 여부가 정해지지 않은 직접 입력, 알려진 활성 백그라운드 작업이나 continuation hold가 없다.
- 세션 ID와 상태가 유효하고 재개 시도를 저장할 수 있는 파일 기반 세션이다.
- 현재 사용자 턴에 이미 재개를 시도하지 않았다.

RPC, app-server, print 등에서는 실제 클라이언트 입력칸을 읽을 수 없으므로 수동
재개도 차단한다. `hasUI`나 RPC의 빈 editor stub을 안전 근거로 쓰지 않는다.
메모리 전용 세션과 아직 첫 assistant 기록이 없는 세션도 재개 시도를 허용하지 않는다.

알려진 백그라운드 작업 수가 0으로 바뀌어도 완료 알림이 모두 전달됐다는 뜻은 아니다.
`continue-confirmed`는 **그 미확인 상태만 명시적으로 수락**한다. 나머지 차단 조건을
무시하는 강제 실행 명령이 아니다.

## 중복 재개와 상태 보존

내부 확장만 재개 요청을 보낼 수 있다. 같은 프로세스에서 중복 로드된 확장은 세션별
소유자를 하나만 둔다. `muse-watch.state` custom entry에 정확한 session ID,
pause, 현재 사용자 메시지 entry ID별 재개 시도를 기록한다.

시도 기록을 먼저 저장한 뒤 `muse-watch.continue` custom message를 한 번 제출한다.
전송 결과가 불명확해도 시도 기록을 유지하고 자동 재시도하지 않는다. todo 편집,
assistant 응답, resume, reload로 같은 사용자 턴의 재개 권한이 다시 생기지 않는다.

이것은 **한 프로세스 안에서의 최대 한 번 호출** 계약이지, 저장과 모델 실행을 묶는
트랜잭션이나 정확히 한 번 전달 보장이 아니다. 같은 세션 파일을 여러 OmO 프로세스에서
동시에 여는 경우의 프로세스 간 배타 실행을 제공하지 않는다.

## 모델·완료 판정

지원하는 현재 provider/model ID 조합:

- `muse/muse-spark-1.3-contributor-free`
- `cliproxy/muse-spark-1.3-contributor-free`

현재 모델 getter만 읽는다. 모델 표시 이름, 화면에 인용된 Muse 이름, 이전 모델 이력으로
현재 모델을 추측하지 않는다. 실제 설치에 등록된 모델은 `omo --list-models muse`로 확인한다.
Astra 등 다른 모델의 `supportedModel=false`는 정상이다.

미완료 작업은 현재 branch의 구조화된 `senpi.todo-state` 또는 todo/todowrite tool-result
snapshot에서만 읽는다. `pending`과 `in_progress`가 열린 작업이며,
`completed`, `abandoned`, legacy `cancelled`는 종료 상태다.
잘못된 최신 snapshot 때문에 이전 작업을 다시 열지 않는다.

`I'll stop when` 문장, PR 단어, 과거 PR 링크, legacy `muse-watch.contract`는
완료 판정에 사용하지 않는다. todo가 없으면 영어 종료 선언만으로 작업을 만들지 않는다.

## 정지 알림

pause가 해제된 지원 모델에서 도구·retry·입력·예약 메시지·알려진 백그라운드 작업 등
차단 요인이 없고, 비-idle 상태에서 스트림·도구 활동이 3분간 없으면 경고한다.
한 세션 시작 주기에서 최대 4회 알리며, 경고는 abort나 재개를 실행하지 않는다.
실제 중단은 사용자가 Escape로 수행한다.

| 환경변수 | 기본 | 의미 |
| --- | --- | --- |
| `OMO_MUSE_WATCH` | on | `0`, `false`, `off`, `no`이면 확장 비활성 |
| `OMO_MUSE_STALL_MS` | `180000` | 무활동 경고 기준. 최소 1000ms |
| `OMO_MUSE_AUTOKICK` | on | `0`, `false`, `off`, `no`이면 자동 재개 비활성 (경고는 그대로 동작) |
| `OMO_MUSE_AUTOKICK_MAX` | `3` | 세션당 자동 재개 최대 횟수. 최소 1 |
| `OMO_IDLE_TODO_KICK` | on | 외부 읽기 전용 진단. 비활성 값이면 snapshot도 조회하지 않음 |

기존 idle 유예·외부 polling·cooldown·kick 횟수 환경변수는 자동 재개 제거로 사용하지 않는다.

## 자동 재개 (opt-out, 기본 켜짐)

네 번째 경고(3분 무활동)에도 pause 해제·지원 모델·draft 비어있음·큐 비어있음·
compacting 아님·백그라운드 작업 없음 등 수동 재개와 동일한 차단 조건이 전부
통과하면, 멈춘 턴을 `ctx.abort("muse-watch-autokick")`로 중단시키고 그 턴이
완전히 정착(`agent_settled`)한 뒤 수동 `continue-confirmed`와 같은 at-most-once
claim 경로로 continuation을 한 번 전송한다. 세션당 `OMO_MUSE_AUTOKICK_MAX`
(기본 3)회까지만 시도하며, 사용자가 abort하면(`abortSource !== "muse-watch-autokick"`)
autokick은 즉시 취소되고 pause로 기록된다. `ctx.abort`가 없는 실행 환경에서는
전혀 동작하지 않는다. `OMO_MUSE_AUTOKICK=0`으로 언제든 끌 수 있으며, 그 경우
기존 경고-전용 동작으로 완전히 되돌아간다.

## 외부 자동 감시기에서 이관

이전 Python 키커의 화면 읽기, 자동 입력·전송, 데몬, 세션 파일 추측을 제거했다.
예전에 systemd 서비스를 설치했다면 중지하고 제거한다.

```bash
systemctl --user disable --now omo-idle-todo-kick.service
rm ~/.config/systemd/user/omo-idle-todo-kick.service
systemctl --user daemon-reload
```

직접 `--daemon`으로 실행한 구버전 프로세스도 종료한다. 파일 교체만으로 실행 중인
구버전 프로세스가 바뀌지는 않는다. 서비스 파일은 더 이상 배포하지 않는다.

외부 스크립트에서 지원하는 유일한 실행은 읽기 전용 snapshot 진단이다.

```bash
python3 idle-todo-kick.py --dry-run
```

`herdr api snapshot`을 한 번 호출하며 10초 제한을 둔다. 존재하는 pane/session 식별자와
agent status만 JSON으로 보여준다. 모델·입력·완료 여부를 추론하거나 어떤 칸에도 입력하지 않는다.
인자 없는 실행, `--once`, `--daemon`, 알 수 없는 인자와 혼합 인자는 종료 코드 2로 거절한다.

## 검증

`npm run check`는 JavaScript 구문 검사와 Node/Python 회귀 테스트를 실행한다.
가상 시간 테스트는 자동 전송 금지, 중단·입력·대기 보호, 재개 시도 기록을 검사한다.
Python CLI 테스트는 가짜 Herdr 실행 파일을 통해 snapshot 외 호출이 없는지 확인한다.
모델 API는 호출하지 않는다.

Linux에서 설치된 OmO와 util-linux `script`가 있으면 저장소에서
`npm run test:runtime`으로 실제 로더·RPC·PTY/TUI 통합 검증을 실행한다.
필요하면 `OMO_BIN`으로 다른 OmO 실행 파일을 지정한다. 별도 임시 HOME과 세션,
localhost 가짜 공급자를 사용하며 실제 자격 증명이나 외부 모델 API를 쓰지 않는다.
명시적 재개 한 번만 HTTP 요청을 만들고, 반복 명령이 두 번째 요청을 만들지 않는지 검사한다.
중단 상태의 reload·프로세스 재시작 보존, 취소된 세션 전환, 중복 명령 별칭도 검사한다.
필수 실행 환경이 없으면 성공으로 건너뛰지 않고 실패한다.

실측 환경은 OmO `5.0.0-0.beta.43` / Senpi `2026.9.5`다. 이미지·클립보드 첨부 편집과
사람이 동시에 타이핑하는 상황은 통합 하네스에서 검증하지 않는다.

## 라이선스

MIT. 이전 저장소 이름은 `omo-free-muse-extension`이다.
