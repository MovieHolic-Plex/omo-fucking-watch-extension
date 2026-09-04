<p align="center">
  <img src="assets/banner.svg" width="920" alt="omo-fucking-watch-extension — stall watchdog for muse-spark">
</p>

<p align="center">
  <img src="assets/divider.svg" width="560" alt="">
</p>

<h1 align="center">👁 omo-fucking-watch-extension</h1>

<p align="center">
  <b>muse-spark 가 죽으면 끊고, todo 남기고 도망치면 다시 민다.</b>
</p>

<p align="center">
  <i>HTTP 에러가 없어도. 토큰이 끊겨도. ❯ 로 돌아와도.</i>
</p>

<p align="center">
  <a href="https://github.com/code-yeongyu/oh-my-openagent"><img src="https://img.shields.io/badge/OmO-Senpi-7C3AED?style=for-the-badge" alt="OmO Senpi"></a>
  <a href="https://dev.meta.ai/docs/coding-agents/"><img src="https://img.shields.io/badge/muse--spark-1.3-f5c15a?style=for-the-badge" alt="muse-spark 1.3"></a>
  <a href="https://github.com/MovieHolic-Plex/omo-fucking-watch-extension/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/MovieHolic-Plex/omo-fucking-watch-extension/check.yml?style=for-the-badge&label=check" alt="check"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DDC84?style=for-the-badge" alt="MIT"></a>
</p>

<p align="center">
  <a href="https://github.com/MovieHolic-Plex/omo-fucking-watch-extension/stargazers"><img src="https://img.shields.io/github/stars/MovieHolic-Plex/omo-fucking-watch-extension?style=for-the-badge&color=d4a24a" alt="stars"></a>
  <a href="https://github.com/MovieHolic-Plex/omo-fucking-watch-extension/commits/main"><img src="https://img.shields.io/github/last-commit/MovieHolic-Plex/omo-fucking-watch-extension?style=for-the-badge&color=7c3aed" alt="last commit"></a>
  <img src="https://img.shields.io/badge/Windows%20·%20macOS%20·%20Linux-111827?style=for-the-badge" alt="platforms">
</p>

<p align="center">
  <a href="#-설치">설치</a> ·
  <a href="#-무엇을-하나">무엇을 하나</a> ·
  <a href="#-무엇을-안-하나">안 하는 것</a> ·
  <a href="#-한-바퀴">한 바퀴</a> ·
  <a href="#-엔진이랑-같이">fallback</a> ·
  <a href="#-설정">설정</a>
</p>

```
              ·  ·  ·  WATCH  ·  ·  ·
                     ╱╲
                    ╱  ╲
                   │ ◉  │     muse-spark
                    ╲  ╱      silent hang
                     ╲╱       leftover todos
              ────────●────────
                 abort · continue
```

<p align="center">
  <code>40s</code> 무음 → abort · 열린 todo 남기고 턴 종료 → continue
</p>

<p align="center">
  <img src="assets/divider.svg" width="560" alt="">
</p>

## 왜 워치가 필요한가

`cliproxy/muse-spark-1.3-contributor-free` 는 싸다. 그리고 자주 멈춘다.

HTTP 4xx/5xx 는 OmO 엔진 retry 가 잡는다.  
문제는 **에러가 안 나오는 죽음**이다. 스트림이 끊기고, 툴도 없고, 루프만 살아 있다. 아니면 todo 열어 놓고 `❯` 로 돌아온다.

그 구멍을 이 익스텐션이 본다. 예전 이름은 `omo-free-muse-extension` 이었다. 지금은 **omo-fucking-watch-extension**.

## 설치

OmO Senpi (`omo` CLI) 가 필요하다.

```bash
omo install https://github.com/MovieHolic-Plex/omo-fucking-watch-extension --no-approve
```

또는 파일을 직접 둔다.

```bash
# Windows
copy muse-watch.js %USERPROFILE%\.omo\agent\extensions\

# macOS / Linux
cp muse-watch.js ~/.omo/agent/extensions/
```

파일을 바꾼 뒤에는 그 칸에서 `/reload` 한 번이면 된다. idle이어도 열린 todo를 폴링한다. `omo -r` 은 필요 없다. 토스트 `muse idle with N open todo(s)` 가 보이면 그 칸을 다시 돌린 것이다.

예전 레포 URL `MovieHolic-Plex/omo-free-muse-extension` 은 GitHub가 여기로 리다이렉트한다.

## 무엇을 하나

메인 세션에서 **지금 모델이 muse-spark** 일 때 두 가지를 잡는다.

**1. Silent hang** — 루프가 아직 도는데 스트림·툴이 40초 동안 없으면 abort 하고 이어서 돌린다.

**2. 조기 정지** — 턴이 끝났거나 이미 `❯` idle 인데 `pending` / `in_progress` todo 가 남아 있으면 follow-up 으로 같은 일을 계속한다. idle 은 약 8초 뒤에 폴링한다.

둘 다 토스트가 뜬다. hang 은 세션당 4번, 조기 정지는 6번까지.

Senpi 는 `ctx.model` 이다. omp 의 `ctx.models.current()` / `ctx.setTimeout` 만 보고 짜면 `/reload` 해도 안 돈다. 이 워치는 둘 다 받는다.

## 무엇을 안 하나

이 익스텐션은 **부모 세션의 메인 루프**만 본다. `ctx.isIdle()` 은 서브에이전트 개수가 아니다.

| 상황 | 담당 |
| --- | --- |
| 메인 칸 Muse 가 말없이 멈춤 | **이 익스텐션** (hang) |
| 메인 칸 Muse 가 todo 남기고 프롬프트로 복귀 | **이 익스텐션** (조기 정지) |
| HTTP 에러 / 첫 토큰 타임아웃 | `settings.json` `retry.fallbackChains` |
| `task` 로 띄운 백그라운드 Muse 워커 | `is_unstable_agent` + babysitter + category `models[]` |
| omo 프로세스 자체 사망 | 훅도 같이 죽음. Herdr 바깥 감시 |

`is_unstable_agent: true` 카테고리 워커는 부모가 idle 이라 워치독이 스킵한다. 그 구멍은 fallback 체인 몫이다.

## 한 바퀴

```
hang (every 5s)
  ├─ muse + not idle + 40s silent → abort → continue

조기 정지
  ├─ agent_end: muse + 열린 todo
  ├─ session_start /reload: muse + 열린 todo
  └─ idle poll: muse + ❯ + 열린 todo (8s 유예)
```

Senpi 는 `ctx.model` 이고 `ctx.setTimeout` 이 없다. omp 는 `ctx.models.current()` 와 contained timer 가 있다. Senpi 에서는 raw timer 를 try/catch 하고 `/reload` 의 `session_shutdown` 에서 지운다. 안 그러면 stale ctx 가 세션을 죽인다. idle 에서는 `deliverAs: followUp` 없이 바로 send 한다.

## 엔진이랑 같이

권장 짝:

`~/.omo/agent/settings.json`

```json
{
  "retry": {
    "enabled": true,
    "modelFallback": true,
    "maxRetries": 3,
    "fallbackChains": {
      "cliproxy/muse-spark-1.3-contributor-free": ["xai/grok-4.6:xhigh"]
    },
    "provider": {
      "streamStartTimeoutMs": 25000,
      "timeoutMs": 45000,
      "streamRetryTimeoutMs": 15000
    }
  }
}
```

`~/.omo/omo.jsonc` 의 Senpi 블록 (OpenCode 전용 `[opencode]` 만 있으면 standalone `omo` 는 안 읽는다):

```jsonc
"[senpi]": {
  "runtime_fallback": {
    "enabled": true,
    "retry_on_errors": [400, 401, 403, 404, 408, 429, 500, 502, 503, 504],
    "max_fallback_attempts": 5,
    "cooldown_seconds": 20,
    "timeout_seconds": 15,
    "notify_on_fallback": true,
    "restore_primary_after_cooldown": true
  }
}
```

```
Muse 턴
  ├─ 에러 / 25s 첫토큰 / 45s 전체     → retry → grok-4.6
  └─ 에러 없이 40s 무음                 → fucking-watch abort → continue
```

## 설정

| 환경변수 | 기본 | 의미 |
| --- | --- | --- |
| `OMO_MUSE_WATCH` | on | `0` / `false` / `off` 이면 비활성 |
| `OMO_MUSE_STALL_MS` | `40000` | 무음 판정. 최소 1000 |
| `OMO_MUSE_IDLE_TODO_MS` | `8000` | idle 에서 todo continue 하기 전 유예 |

의존성 없음. 파일 하나. `muse-watch.js`.

## 라이선스

MIT. Muse 는 공짜로 돌리고, 멈춤은 공짜로 자른다.
