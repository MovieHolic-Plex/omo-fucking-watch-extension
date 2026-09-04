<p align="center">
  <img src="assets/banner.svg" width="920" alt="omo-free-muse-extension — stall watchdog for muse-spark">
</p>

<p align="center">
  <img src="assets/divider.svg" width="560" alt="">
</p>

<h1 align="center">👁 omo-free-muse-extension</h1>

<p align="center">
  <b>muse-spark 가 말없이 멈추면, 턴을 끊고 같은 일을 이어 간다.</b>
</p>

<p align="center">
  <i>HTTP 에러가 안 나와도. 토큰이 끊겨도. 메인 칸은 죽지 않는다.</i>
</p>

<p align="center">
  <a href="https://github.com/code-yeongyu/oh-my-openagent"><img src="https://img.shields.io/badge/OmO-Senpi-7C3AED?style=for-the-badge" alt="OmO Senpi"></a>
  <a href="https://dev.meta.ai/docs/coding-agents/"><img src="https://img.shields.io/badge/muse--spark-1.3-f5c15a?style=for-the-badge" alt="muse-spark 1.3"></a>
  <a href="https://github.com/MovieHolic-Plex/omo-free-muse-extension/actions/workflows/check.yml"><img src="https://img.shields.io/github/actions/workflow/status/MovieHolic-Plex/omo-free-muse-extension/check.yml?style=for-the-badge&label=check" alt="check"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-3DDC84?style=for-the-badge" alt="MIT"></a>
</p>

<p align="center">
  <a href="https://github.com/MovieHolic-Plex/omo-free-muse-extension/stargazers"><img src="https://img.shields.io/github/stars/MovieHolic-Plex/omo-free-muse-extension?style=for-the-badge&color=d4a24a" alt="stars"></a>
  <a href="https://github.com/MovieHolic-Plex/omo-free-muse-extension/commits/main"><img src="https://img.shields.io/github/last-commit/MovieHolic-Plex/omo-free-muse-extension?style=for-the-badge&color=7c3aed" alt="last commit"></a>
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
              ·  ·  ·  SCAN  ·  ·  ·
                     ╱╲
                    ╱  ╲
                   │ ◉  │     muse-spark
                    ╲  ╱      silent hang
                     ╲╱
              ────────●────────
                 abort · continue
```

<p align="center">
  <code>40s</code> 무음 &nbsp;→&nbsp; <code>abort</code> &nbsp;→&nbsp; follow-up &nbsp;→&nbsp; Grok 체인이 받을 수 있게
</p>

<p align="center">
  <img src="assets/divider.svg" width="560" alt="">
</p>

## 왜 레이더가 필요한가

`cliproxy/muse-spark-1.3-contributor-free` 는 싸다. 그리고 자주 멈춘다.

HTTP 4xx/5xx 는 OmO 엔진 retry 가 잡는다.  
문제는 **에러가 안 나오는 죽음**이다. 스트림이 끊기고, 툴도 없고, 루프만 살아 있다.

그 구멍을 이 익스텐션이 본다.

## 설치

OmO Senpi (`omo` CLI) 가 필요하다.

```bash
omo install https://github.com/MovieHolic-Plex/omo-free-muse-extension --no-approve
```

또는 파일을 직접 둔다.

```bash
# Windows
copy muse-watch.js %USERPROFILE%\.omo\agent\extensions\

# macOS / Linux
cp muse-watch.js ~/.omo/agent/extensions/
```

**이미 켜져 있는 omo 칸은 재시작해야** 붙는다. 토스트 `muse stalled … abort 1/4` 가 보이면 살아있는 것이다.

## 무엇을 하나

메인 세션에서 **지금 모델이 muse-spark** 이고, 에이전트가 idle 이 아닌데, 스트림·툴·retry 이벤트가 **40초** 동안 없으면:

1. 토스트를 띄운다
2. 그 턴을 `abort` 한다
3. 1.2초 뒤 같은 세션에 follow-up 을 넣는다  
   *Previous model stalled… Continue the same task…*
4. 엔진 fallback 이 다음 턴을 잡으면 Grok 으로 이어질 수 있다

정상 응답이 한 번 끝나면 trip 카운트는 0으로 돌아간다.

## 무엇을 안 하나

이 익스텐션은 **부모 세션의 메인 루프**만 본다. `ctx.isIdle()` 은 서브에이전트 개수가 아니다.

| 상황 | 담당 |
| --- | --- |
| 메인 칸 Muse 가 말없이 멈춤 | **이 익스텐션** |
| HTTP 에러 / 첫 토큰 타임아웃 | `settings.json` `retry.fallbackChains` |
| `task` 로 띄운 백그라운드 Muse 워커 | `is_unstable_agent` + babysitter + category `models[]` |
| omo 프로세스 자체 사망 | 훅도 같이 죽음. Herdr 바깥 감시 |

`is_unstable_agent: true` 카테고리 워커는 부모가 idle 이라 워치독이 스킵한다. 그 구멍은 fallback 체인 몫이다.

## 한 바퀴

```
every 5s
  ├─ model ~= muse-spark ?
  ├─ parent not idle ?
  ├─ no stream / tool / retry for 40s ?
  └─ yes → abort → continue  (max 4 / session, 60s cooldown)
```

타이머는 반드시 `ctx.setInterval` / `ctx.setTimeout` 이다. 일반 `setInterval` 이 던지면 **세션 전체가 죽는다.**

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
  └─ 에러 없이 40s 무음                 → muse-watch abort → continue
```

## 설정

| 환경변수 | 기본 | 의미 |
| --- | --- | --- |
| `OMO_MUSE_WATCH` | on | `0` / `false` / `off` 이면 비활성 |
| `OMO_MUSE_STALL_MS` | `40000` | 무음 판정. 최소 1000 |

의존성 없음. 파일 하나.

## 라이선스

MIT. Muse 는 공짜로 돌리고, 멈춤은 공짜로 자른다.
