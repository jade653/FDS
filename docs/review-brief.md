# 검수 배경 자료: 감시탑 실행 환경 장애

관점과 결과 형식은 `docs/review-lens.md`에 있다. 이 문서는 그 검수에 필요한 **배경 사실**만 담는다.
2026-11-10 작성. 해결책과 검수 방법은 일부러 적지 않았다.

표시: **[사실]** 측정·관측·코드로 확인함 · **[추측]** 이전 작업자의 판단, 검증 안 됨 · **[미측정]** 재지 않음

---

## 1. 실행 환경과 수치

### 체인과 RPC

| 항목 | 값 | 근거 |
| --- | --- | --- |
| 체인 | Ethereum Sepolia (chainId 11155111) | [사실] |
| 블록 간격 | 약 12초 | [사실] Sepolia 사양. 시연 중 블록 번호 증가로도 맞음 |
| HTTP RPC | `https://ethereum-sepolia-rpc.publicnode.com` (무료 공개) | [사실] `.env` |
| WebSocket | `wss://ethereum-sepolia-rpc.publicnode.com` | [사실] |
| 비공개 제출 RPC (`PRIVATE_RPC_URL`) | 없음. Responder는 `submit_route: both`여도 공개 경로로만 제출 | [사실] `.env` 비어 있음, `responder.ts` 277~282행 |
| 과거 상태 보관 | head−5 블록 `eth_getCode`는 성공, head−150 블록 `eth_getCode`·`eth_getTransactionCount`는 "historical state is not available" 오류 | [사실] 2026-11-10 측정 |
| 과거 상태 보관 범위의 정확한 경계 | — | [미측정] |
| 요청 제한(rate limit) 수치 | — | [미측정]. 문서 확인 안 함 |
| WebSocket 끊김 | 2026-11-09 시작 약 3분 뒤 1회. 2026-11-10 시작 약 32분 뒤(07:02) 1회, 3분 뒤(07:05) 1회 더 | [사실] 감시탑 로그 |
| 끊긴 뒤 viem WebSocket 구독이 다시 붙는지 | — | [미측정] |
| Sepolia 공개 멤풀 대기 거래 유입량 | "초당 수십 건"은 관점 문서의 표현이고, 직접 세지 않음 | [미측정] |

### RPC 왕복 시간 (2026-11-10, 개발 PC → publicnode, 1회씩 측정)

| 호출 | 시간 | 결과 |
| --- | --- | --- |
| `getBlock(head−150, includeTransactions)` | 120ms | 성공 |
| `getLogs(token, 1블록)` | 50ms | 성공 |
| `getCode(addr, head−150)` | 50ms | 오류 (과거 상태 없음) |
| `getCode(addr, latest)` | 50ms | 성공 |
| `getTransactionCount(addr, head−150)` | 57ms | 오류 (과거 상태 없음) |
| `getBlock(head, includeTransactions)` | 59ms | 성공 |
| `getCode(addr, head−5)` | 93ms | 성공 |

[사실] 단발 측정이라 분산·꼬리 지연은 [미측정].

### 감시 대상 규모 (`config/addresses.sepolia.yaml`)

| 분류 | 수 |
| --- | --- |
| hot | 9 (시연 3회차 × 핫월렛 3개) |
| watched | 3 |
| R6 코드 감시 대상 (hot ∪ watched) | 12 |
| whitelabel | 3 |
| exits | 3 |

[사실] 모두 시연 지갑이다. 실제 운영 규모는 [미측정]·미정.

### 블록 하나당 RPC 요청 수 (코드 기준)

[사실] `packages/detector/src/ingestor.ts` `processBlockNumber`와 룰 코드에서 센 것이다. 실측 카운트가 아니다.

| 호출 | 횟수 |
| --- | --- |
| `getBlock(n, includeTransactions: true)` | 1 |
| `getLogs` (token, timelock, proxyAdmin) | 1 |
| R6 `getCode(감시 주소, n)` | 감시 주소 수(현재 12). 과거 상태 오류가 나면 주소마다 `getCode(latest)` 1회 추가 → 최대 24 |
| R2 `getTransactionCount(수신자, n)` | 그 블록의 토큰 Transfer 수신자 중 처음 보는 (주소, 블록) 조합마다 1. 오류 나면 최신 값으로 1회 추가 |
| R1 `balanceOf(감시 지갑, n)` | 감시 지갑의 유출 Transfer마다 1 (오류 시 최신 값) |
| 폴링 `getBlockNumber` | 1초마다 1 (블록과 무관) |
| pending `getTransaction(hash)` | 블록과 무관. 초당 최대 `pending_fetch_per_sec`(5), 동시 최대 8 |

토큰 거래가 없는 블록 기준 최소 약 14회(1 + 1 + 12)이고, 과거 블록을 따라잡을 때는 약 26회다.

Responder가 동결 한 번에 쓰는 호출: 주소별 `isFrozen`, `getFeeHistory`, `getBlock(latest)`, `getTransactionCount(pending)`, `estimateGas`, `sendRawTransaction`, 영수증 폴링(250ms 간격, 최대 120초), `getBlockNumber`. [사실] `responder.ts` 145~325행

### 측정·관측한 처리 속도

| 상황 | 값 | 근거 |
| --- | --- | --- |
| 블록 하나 처리 시간 (Sepolia, 현재 코드) | — | [미측정]. 로그에 남기지 않음 |
| 처리 지연 p95 (로컬 Anvil, 블록 수신 뒤 판정까지, 블록 가져오는 시간 제외) | 4ms | [사실] E2E 측정 |
| 따라잡기 속도 — 수정 전 코드 (pending이 처리 줄에 섞임) | 약 38분에 약 150블록. 블록 간격(12초)보다 느려 계속 뒤처짐 | [사실] 로그의 시각과 블록 번호로 계산 |
| 따라잡기 속도 — pending을 줄 밖으로 뺀 뒤, 초당 상한 넣기 전 | 약 6분에 약 205블록 (블록당 약 1.8초) | [사실] 로그의 시각과 블록 번호로 계산 |
| 따라잡기 속도 — 현재 코드 | — | [미측정]. 현재 코드는 `WATCH_FROM=latest`로만 띄웠다 |
| 탐지 → 동결 포함 (Sepolia, 현재 코드) | 시나리오 1·2·3: 공격 거래 다음 블록. 1b: 다음 블록, 유출 제출부터 둘 다 동결 확인까지 21초 | [사실] `docs/decisions.md` 4절 |
| 동결 거래 수수료 팁 | 2 gwei (`min_priority_fee_gwei`), 모두 1회 시도로 포함 | [사실] 감시탑 로그. 수수료 올려 재전송 경로는 실제 체인에서 쓰이지 않았다 |

### 시연 때 실행 형태

- [사실] 감시탑: Windows Node + `tsx`로 `packages/service/src/main.ts` 실행.
  - 설정: `STORE=memory`, `WATCH_FROM=latest`(또는 블록 번호), `RESPONDER_MODE=auto`
  - 프로세스 하나이고, Postgres·Redis는 쓰지 않음
- [사실] 메모리 저장소라 재시작하면 사건 기록이 사라진다. 시연 중 회수 알림에 "Case Store에 없는 사건"이 찍혔다.
- [사실] 봇 서명은 암호화 키스토어(`BOT_KEYSTORE_PATH`)다. KMS 서명자는 구현돼 있지 않다(`kmsSigner`가 예외를 던짐).
- 다음 대상(자체 EVM 체인, 블록 약 2초)의 RPC·규모: [미측정]·미정 (`docs/decisions.md` 2절 미답)

---

## 2. 지금까지 찾은 버그와 고친 방법

오늘(2026-11-10) Sepolia 2부 시연에서 찾은 것이 대부분이다. 모두 커밋 `6d047d3`에 들어 있다.

| # | 버그 | 발견 경위 | 고친 방법 | 파일 | 추가·변경한 테스트 |
| --- | --- | --- | --- | --- | --- |
| 1 | R2 "새 주소" 판정이 송금이 일어난 블록이 아니라 **처리 시점의 최신 nonce**를 읽었다. 공격자가 돈을 받자마자 거래를 연달아 내면, 감시탑이 그 블록을 처리할 때는 nonce가 5를 넘어 R2를 놓친다 | [사실] 로컬 Anvil 시연 테스트(시나리오 2)에서 R3 40점만 남아 자동 동결이 안 됨. 디버그 출력으로 R2 누락 확인 | 이벤트 블록 시점 nonce를 읽는다. (주소, 블록) 단위 캐시. 노드가 그 블록 상태를 못 주면 최신 값으로 대신 | `detector/src/enricher.ts` `isNew`, `detector/src/chain.ts` `getTransactionCount`, `detector/src/rules.ts` 88행 | `detector/test/rules.test.ts` "발동: 감시탑이 늦게 처리해 최신 nonce가 커졌어도, 유입 블록 시점 nonce로 판정한다". `FakeChain.noncesAt` 추가(`test/helpers.ts`) |
| 2 | pending 거래 해시마다 `getTransaction` 조회를 **블록 처리와 같은 직렬 줄**에 세웠다. Sepolia 공개 멤풀의 해시가 줄을 끝없이 늘려 블록 처리가 밀렸다 | [사실] Sepolia에서 감시탑이 약 35분 동안 알림 없음. 뒤늦게 R7 알림이 찍힌 것으로 멈춤이 아니라 느린 진행임을 확인. [사실] 전날 시연은 WebSocket이 3분 만에 끊겨 pending 구독도 끊긴 덕에 드러나지 않았다 | 조회를 줄 밖에서 동시 최대 8개(`MAX_PENDING_INFLIGHT`)만 하고 넘치면 버림. 토큰·출구로 가는 거래만 줄에 넣음 | `detector/src/ingestor.ts` `onPendingHash`, `fetchPending` | `detector/test/ingestor.test.ts` "pending 폭주: 조회는 줄 밖에서 동시 상한까지만, 블록 처리는 막히지 않는다", "pending: 토큰으로 가는 거래만 Detector로 넘긴다" |
| 3 | 지연 경보가 같은 직렬 줄 안의 `syncTo`에서만 계산돼, 처리가 막히면 **경보도 함께 멈췄다** | [사실] 위 35분 동안 지연 경보 없음 | 폴링 타이머가 `pollOnce`에서 커서와 head로 지연을 따로 재고, 앞선 처리가 끝나지 않았으면 새 처리를 줄에 더 넣지 않음 | `detector/src/ingestor.ts` `pollOnce`, `checkLag` | "처리가 RPC에서 멈춰도 폴링이 지연 경보를 보낸다" |
| 4 | 무료 RPC가 과거 블록 상태를 보관하지 않아 R6의 `getCode(addr, n)`가 오류를 냈고, 그 오류가 위로 전파됐다 | [사실] `WATCH_FROM`을 192블록 전으로 주고 재시작하자 오류 | 그 블록 시점 조회가 실패하면 최신 코드로 대신 | `detector/src/ingestor.ts` `codeAt` | "과거 상태가 없는 노드: R6 코드 조회는 최신 값으로 대신하고 처리를 계속한다". `FakeRpc.prunedBelow` 추가 |
| 5 | 시작 직후 첫 처리(`start()`의 첫 `tick`)가 실패하면 **프로세스 전체가 종료**됐다 | [사실] 4번 오류로 감시탑 프로세스 종료 | 첫 처리 실패는 기록만 하고 폴링으로 이어감 | `detector/src/ingestor.ts` `start` | "시작할 때 첫 처리가 실패해도 프로세스를 죽이지 않고 다음 폴링에서 이어간다" |
| 6 | 2번 수정 뒤에도 pending 조회에 **초당 상한이 없어** 공개 RPC 요청 한도를 계속 쓴다 (판단) | [사실] 2번 수정 직후 실행을 볼 때, 터미널 출력이 늦게 갱신돼 멈춘 것으로 잘못 봤다. 나중에 로그로 계산하니 블록당 약 1.8초로 진행 중이었다(측정 왕복 합은 약 1.4초). [추측] 상한이 없으면 공개 RPC 요청 한도를 소모한다고 판단해 넣었다. 한도 초과(429) 응답은 확인하지 않았다 | 토큰 버킷으로 초당 `ingestor.pending_fetch_per_sec`(기본 5, 설정 파일)까지만 조회. 따라잡는 동안 20블록마다 진행 로그 | `detector/src/ingestor.ts` `takePendingToken`, `common/src/config.ts`, `config/rules.yaml` | "pending 폭주" 테스트 기대값을 초당 상한 기준(500건 중 5건 조회)으로 변경 |
| 7 | 시연 도구가 토큰 송금·approve 가스 한도를 **100,000으로 고정**했다. Anvil에서는 충분했지만 Sepolia에서는 송금(새 수신자)에 약 155,000이 들어 거래가 실패했다 | [사실] Sepolia에서 송금·approve가 status 0 | 가스 추정값 ×1.5 사용. 봇의 동결 거래는 원래 추정값 ×1.2를 써서 영향 없음 | `ops-cli/src/demo.ts`, `ops-cli/src/demo-extra.ts` (감시탑 밖) | 없음. Anvil 테스트로는 이 차이가 드러나지 않는다 |

[사실] 이 수정들로 테스트가 늘었다. 단위 113 → 118개, E2E 21개, 모두 통과(커밋 `6d047d3` 기준).

[사실] 2~5단계 구현 중에 고친 버그도 있다(`docs/decisions.md` 1절 "2~5단계 구현 메모", 대화 기록). 다만 실행 환경 장애가 아니라 테스트·도구 문제였다.
- 예: 테스트용 FakeChain이 첫 영수증 뒤 채굴을 멈춘 것
- 예: pg-mem에서 `ON CONFLICT DO NOTHING`의 반환값이 불안정한 것

---

## 3. 남은 응급처치와 알려진 한계

| 항목 | 내용 | 근거 |
| --- | --- | --- |
| pending 조회 상한 | 동시 8개, 초당 5개. 넘치는 해시는 **조용히 버린다**. 버린 수는 `pendingDropped` 카운터에만 쌓이고, 로그나 알림으로 나가지 않는다 | [사실] `ingestor.ts` |
| pending 감지 실패 | 시나리오 3에서 공격자의 대기 중 approve를 잡지 못했다. 동결은 approve가 포함된 **다음 블록**에 됐고, 라우터의 `transferFrom`은 `AccountFrozen`으로 실패하는 것을 시뮬레이션으로 확인했다 | [사실] Sepolia 실행 |
| 시나리오 3 로컬 통과 이유 | Anvil 테스트는 automine을 끄고, 봇 동결이 txpool에 들어온 걸 확인한 뒤 채굴한다. 실제 체인의 블록 생성·멤풀 규모와 다르다 | [사실] `e2e/test/scenarios.test.ts`, `e2e/test/demo.test.ts` |
| 과거 상태 대체값 | R2 nonce, R1 잔고, R6 코드는 그 블록 상태를 못 읽으면 **최신 값**으로 대신한다. 오래된 블록을 따라잡거나 재처리할 때는 1번 버그와 같은 시점 문제가 다시 생긴다 | [사실] `chain.ts`, `ingestor.ts` `codeAt` |
| 무료 공개 RPC 의존 | 요청 제한, WebSocket 끊김, 과거 상태 없음. 감시탑은 WebSocket이 끊기면 1초 HTTP 폴링으로 계속한다 | [사실] |
| WebSocket 끊김 알림 | 끊길 때마다 최고 등급 알림 1회(같은 연결 동안은 1회). 재연결 여부는 확인 안 함 | [사실] 코드 / [미측정] 재연결 |
| R6 비용 | 블록마다 감시 주소 수만큼 `getCode`를 **순차로** 부른다. 감시 주소 수에 비례 | [사실] `ingestor.ts` |
| Responder 대기 | 동결 거래 영수증을 250ms 간격으로 최대 120초 폴링 | [사실] `responder.ts` 294·318행 |
| 저장소 | 시연은 메모리 저장소. Postgres·Redis 구현은 pg-mem·ioredis-mock으로만 테스트. 실제 서버에서는 지연·장애를 테스트하지 않았다 | [사실] |
| 리더 잠금 | 프로세스 하나로만 돌렸다. Redis 잠금으로 여러 인스턴스를 띄운 적 없음 | [사실] |
| 비공개 제출 경로 | 설정 안 됨. 경로별 포함 지연 측정 보류 | [사실] `docs/decisions.md` 4절 |
| 승인 서버 | `127.0.0.1:8787`에 바인드. 링크 60분 유효, 1회용 | [사실] |
| R7 발신자 판정 | `MinterConfigured` 이벤트는 발신자를 알 수 없어(`sender ?`) 어느 Safe가 보내도 R7로 잡힌다. 금고 Safe의 정상 작업도 최고 등급 알림이 난다 | [사실] 감시탑 로그. 설계 해석은 `docs/decisions.md` 4.1 |
| 수수료 올려 재전송, 속도 제한 래치, 킬 스위치 | 단위 테스트만 했다. Sepolia에서는 이 경로가 실행되지 않았다 | [사실] |

---

## 4. 아직 모르는 것, 열린 질문

- [미측정] Sepolia에서 현재 코드의 블록 하나 처리 시간과 분포. 블록 간격 대비 여유가 얼마인지
- [미측정] publicnode의 요청 제한 수치와 한도 초과 시 응답(429 여부, viem 재시도 횟수·지연)
  - [추측] 6번 조치(초당 상한)는 요청 한도를 소모한다는 판단에서 넣었지만, 실제로 한도에 걸린 적이 있는지는 확인하지 않았다
- [미측정] publicnode가 과거 상태를 몇 블록까지 보관하는지
- [미측정] WebSocket이 끊긴 뒤 viem의 `watchBlockNumber`·`watchPendingTransactions` 구독이 다시 살아나는지
- [미측정] Sepolia 공개 멤풀의 대기 거래 유입량과, 초당 5건 상한일 때 실제로 버려지는 비율
- [사실·원인 미확인] 2026-11-10 06:45 무렵 감시탑 로그에 "설정 다시 읽음"이 두 번 찍혔다
  - 같은 시각 작업자가 설정 파일을 고친 기억은 없다
  - 같은 저장소에 다른 세션이 만든 `offchain/dashboard/` 서버가 돌고 있었다. 그 서버가 설정 파일을 건드리는지는 확인하지 않았다
- [사실·원인 미확인] 같은 토큰 송금의 가스가 Anvil에서는 10만 미만, Sepolia(새 수신자)에서는 약 15.5만이다
  - [추측] 하드포크별 가스 규칙 차이
  - Anvil 테스트가 실제 가스를 대표하지 못한다는 뜻이기도 하다
- [미측정] 블록 약 2초인 자체 체인에서 블록당 RPC 수(최소 약 14)와 왕복 시간으로 처리 시간이 블록 간격 안에 드는지
  - 자체 체인 RPC의 위치와 성능은 미정
- [미측정] Sepolia에서 재조직(reorg) 경로가 실제로 실행된 적이 있는지. 로그에 재조직 기록은 없다
- [미측정] 감시탑이 오래 밀렸다가 따라잡는 동안의 오탐·누락 여부. 과거 상태 대체값이 쓰이는 구간
- [미측정] 메모리 사용량. 윈도우 저장소, 주소 캐시, `nonceAt` 캐시(1만 개 넘으면 비움), 지연 측정 배열(1,000개)의 장시간 증가
- [미측정] 감시 주소를 수십~수백 개로 늘렸을 때 R6 순차 `getCode` 비용

---

## 5. 검수 기준 커밋

- 브랜치: `stage-2-6`
- 감시탑 코드 기준 커밋: **`6d047d38bbd90a7ec9abb0d9c290614be2eb405e`** (`6d047d3`, "6단계: Sepolia 시연 2부(시나리오 1·3·5·6·7)와 감시탑 결함 수정")
- [사실] 이 커밋은 원격 `origin/stage-2-6`에 푸시돼 있다.
- [사실] 이 문서(`docs/review-brief.md`)와 `docs/review-lens.md`는 `6d047d3` 바로 다음 커밋에 들어 있다. 그 커밋은 문서만 추가했고, 감시탑 코드는 `6d047d3`과 같다.
