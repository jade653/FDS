# 설계 비교·검수 요청서

작성일 2026-11-10. 이 요청서를 받는 검수자를 **모델 B**라고 부른다. 모델 B는 [docs/task-brief.md](task-brief.md)를 읽고 자기 설계를 이미 작성했다. 이 저장소에 구현된 설계와 코드는 **모델 A**다(`stage-2-6` 브랜치).

## 0. 요청 내용

목적은 두 가지다.

1. 모델 A와 모델 B의 설계를 같은 축으로 비교한다.
2. 모델 B의 관점에서 모델 A의 설계와 구현을 검수한다.

**판단 기준**

- 기준은 [docs/task-brief.md](task-brief.md)의 과제·범위·조건이다. 모델 A의 설계문서([docs/design.md](design.md))는 비교 대상이지 기준이 아니다.
- 모델 A의 설계 결정과 그 근거는 design.md와 [docs/decisions.md](decisions.md)에 있다. A의 선택을 평가할 때는 기록된 근거를 먼저 읽고, 그 근거가 왜 틀렸거나 부족한지를 적는다.

**공정성 규칙**

- 각 비교 축마다 모델 A가 더 나은 점이 있으면 반드시 적는다. 없으면 "A가 나은 점 없음"이라고 명시한다.
- 아래 셋을 구분해 표시한다.
  - **결함**: 과제 목적이나 안전성을 해치는 것
  - **트레이드오프**: 둘 다 타당하고 조건에 따라 갈리는 것
  - **취향**: 결과에 차이가 없는 것
- 모델 B의 설계가 아직 구현·검증되지 않았다는 점을 감안한다. A의 "검증된 동작"과 B의 "설계상 의도"를 같은 무게로 비교하지 않는다.

**산출물 (이 순서로)**

1. **모델 B 설계 요약** (1페이지 이내): 2장의 비교 축 순서에 맞춘다.
2. **비교표**: 2장의 축마다 아래를 적는다.
   - A의 선택, B의 선택
   - 판정(A 우세 / B 우세 / 동등 / 조건부)
   - 구분(결함 / 트레이드오프 / 취향)과 근거
3. **모델 A 결함 목록**. 항목마다 다음을 적는다.
   - 심각도: 치명 / 높음 / 중간 / 낮음 / 개선 제안
   - 위치: `파일:줄`
   - 실패 시나리오: 어떤 입력이나 상태에서 무엇이 잘못되는지
   - 고치는 방향
4. **3장 질문에 대한 답**. 답할 수 없으면 왜 못 하는지 적는다.
5. **권고**: 아래 셋으로 나눈다. 각 항목에 바꾸는 비용(작업량, 이미 Sepolia에 배포된 것과의 관계)을 함께 적는다.
   - A를 그대로 유지할 것
   - B 방식으로 바꿀 것
   - 둘 다 아닌 제3안

---

## 1. 구현 지도

### 1.1 문서

| 파일 | 내용 |
|---|---|
| [docs/design.md](design.md) | 설계 기준. 주요 장은 아래와 같다. |
| [docs/decisions.md](decisions.md) | 1절 툴체인·버전, 2절 자체 체인 질문(미답), 3절 운영 주체 답변, 4절 변경 결정 이력(최신이 위), 4.1절 미확정 해석, 5절 잔여 위험 |
| [docs/runbooks/](runbooks/) | `recovery.md`(회수), `false-positive.md`(오탐 해제), `bot-key-rotation.md`(봇 키 교체·회수) |
| [CLAUDE.md](../CLAUDE.md) | 작업 규칙 요약, 툴체인 명령, 현재 단계 |

design.md의 주요 장:
- 5장: 컨트랙트(동결 검사 5.2, 불변식 5.5)
- 6장: 권한 표
- 7장: 탐지 룰·점수
- 8장: 대응 정책·안전장치
- 9장: 회수 런북
- 10장: 파라미터
- 12장: 테스트·시나리오
- 13장: 단계별 완료 기준
- 15장: 잔여 위험

### 1.2 컨트랙트 (`contracts/`, Foundry, solc 0.8.28, EVM paris, OZ Upgradeable v5.4.0)

| 파일 | 내용 |
|---|---|
| `src/StableToken.sol` (381줄) | ERC20 + Permit + Pausable + AccessControl, Transparent Proxy, ERC-7201 저장소. 주요 함수와 검사 위치는 아래와 같다. |
| `test/*.t.sol` | 단위 테스트: Freeze, FreezeMatrix, PauseMatrix, Minting, Recovery, Admin, Initialize, Upgrade, Fuzz |
| `test/invariant/` | 불변식 테스트 (design.md 5.5) |
| `test/Deploy.t.sol` | 배포 스크립트 테스트 32개. 배포 후 권한 행렬과 음성 사례를 다룬다. |
| `test/CreateSafes.t.sol` | Safe 생성 테스트 19개. Sepolia 포크가 필요하다(`SEPOLIA_RPC_URL`). |
| `script/Deploy.s.sol` | 타임락 → 구현체 → 프록시 → 역할 분배 → 배포자 권한 포기 → 온체인 검증 |
| `script/lib/DeploymentChecks.sol` | 배포 검증 (`verify`). 기대 행렬은 10주체 × 9역할이고, 역할 admin, 보호 주소, 타임락 구성, ProxyAdmin 소유자도 본다. |
| `script/lib/DeployConfig.sol` | `config/deploy.<chain>.toml` 로드와 검증 |
| `script/VerifyDeployment.s.sol` | 배포 후 재검증 |
| `script/CreateSafes.s.sol` | Safe v1.4.1 5개를 CREATE2로 생성하고 검증. 정족수 하한을 강제하고, 배포자와 봇은 서명자가 될 수 없다. |
| `script/anvil-deploy.sh` | 로컬 Anvil 배포. chainId 31337만 허용한다. |
| `script/check-push0.mjs` | 아티팩트에 PUSH0이 없는지 검사 |

StableToken의 주요 함수:
- 동결: `freeze`, `freezeBatch`, `unfreeze`
- 회수: `wipeFrozen`, `mintForRecovery`
- 발행: `configureMinter`, `removeMinter`, `mint`, `burn`
- 운영: `pause`, `unpause`, `setProtected`, `setMinFreezeAge`, `rescueERC20`

동결 검사는 세 곳에 있다.
- `_update` (from, to): 359줄
- `transferFrom` (spender): 366줄
- 4인자 `_approve` (owner, spender): 372줄

### 1.3 오프체인 (`offchain/`, pnpm 워크스페이스, TypeScript, viem)

실행 흐름:

```
Ingestor ──블록·로그·pending──▶ Detector(Enricher → RuleEngine → decide) ──▶ CaseStore
                                        │
                     auto_freeze ───────┼──▶ Responder ──(FreezeOnlySigner)──▶ freeze/freezeBatch
                     human_review/related ─▶ Notifier ──▶ 승인 링크 ──▶ ApprovalServer ──▶ Responder
```

| 패키지 | 주요 파일 | 내용 |
|---|---|---|
| `abi` | `src/generated.ts`, `scripts/gen-abi.mjs` | forge 아티팩트에서 생성한 ABI |
| `common` | `src/config.ts` | 설정 스키마(zod), `AddressBook`(분류 우선순위 protected > whitelabel > hot > normal), `ConfigStore`(핫 리로드, 실패 시 이전 설정 유지) |
| `detector` | `src/ingestor.ts` | HTTP 폴링과 WS 깨우기, 재편성(reorg) 탐지, 지연·WS 끊김 알림 |
| | `src/events.ts` | 로그 디코딩 (토큰·타임락·ProxyAdmin) |
| | `src/enricher.ts` | 신규 주소 판정 (firstSeen + nonce) |
| | `src/rules.ts` | R1~R10 (R7·R8은 `detector.ts`) |
| | `src/decision.ts` | 분류·점수 → 결정 (순수 함수) |
| | `src/detector.ts` | 블록 처리, 사건 키, R7 승인 판정, R8 발행 요청 대조, 봇 동결 속도 감시 |
| | `src/stores/` | memory, redis, postgres(`sql/001_init.sql`) |
| `responder` | `src/signer.ts` | `FreezeOnlySigner`: 토큰 주소, freeze/freezeBatch 선택자, value 0, authorizationList 없음만 서명한다. 키스토어 서명자 포함. KMS 서명자는 미구현이다. |
| | `src/responder.ts` | kill switch → shadow → 대상 필터 → 시간당 상한 → 리더 락 → 배치 전송. 같은 nonce로 수수료를 올려 재전송하고, 제출 경로는 3종이다. |
| | `src/lock.ts` | 메모리·Redis 리더 락 |
| `notifier` | `src/approval.ts` | HMAC 승인 토큰 {v,c,a,exp,jti}, 운영자 토큰 SHA-256 해시 |
| | `src/server.ts` | 승인 서버 (127.0.0.1, GET 확인 화면 → POST) |
| | `src/notifier.ts` | 콘솔·Slack·Webhook·Telegram 채널 |
| `service` | `src/watchtower.ts`, `src/main.ts` | 구성 연결. 환경 변수: `STORE`, `RESPONDER_MODE`, `WATCH_FROM`. 서명자 주소와 설정의 봇 주소가 다르면 시작하지 않는다. |
| `ops-cli` | `src/ops.ts`, `src/main.ts` | 회수·해제·봇 회수/교체·권한 전수 검사. Safe Transaction Builder JSON을 만들고, `--execute-local`은 31337 전용이다. |
| | `src/demo.ts`, `src/demo-main.ts` | 실제 체인 시연 (시나리오 1b·2·4) |
| `e2e` | `test/harness.ts`, `test/scenarios.test.ts`, `test/demo.test.ts` | 실제 Anvil + 실제 `Deploy.s.sol`로 돌리는 E2E. 시나리오 1~7과 시연 코드 검증 |

### 1.4 설정과 배포 기록

| 파일 | 내용 |
|---|---|
| `config/rules.yaml` | 룰 점수·임계값, ingestor·responder·approval·notifier 설정. 핫 리로드된다. |
| `config/addresses.<chain>.yaml` | hot / watched / protected / whitelabel / exits 분류. Sepolia 파일은 시연 지갑으로 채워져 있다. |
| `config/deploy.<chain>.toml` | 배포 입력. anvil, sepolia(채워짐), custom(chainId 0이라 거부) |
| `config/safes.sepolia.toml` | Safe 서명자와 정족수 |
| `deployments/sepolia.json`, `deployments/safes-sepolia.json` | Sepolia 배포 결과. 토큰 `0x36C8CDC1E48E47f9d55C45af8d5DF168e094B3A3` |
| `.env.example` | 환경 변수 목록. 실제 `.env`는 gitignore 대상이다. |

### 1.5 설계 포인트 → 코드 대응

| 설계 포인트 | 구현 위치 | 테스트 |
|---|---|---|
| 동결 검사 3곳, 일시정지 중에도 동결·해제·소각·역할 변경 가능 | `StableToken.sol` 359~380 | `FreezeMatrix.t.sol`, `PauseMatrix.t.sol` |
| `wipeFrozen`만 `ERC20Upgradeable._update` 직접 호출 | `StableToken.sol` 220 | `Recovery.t.sol`, invariant |
| `reissuedByCase ≤ wipedByCase` | `StableToken.sol` 263 | `Recovery.t.sol`, invariant |
| FREEZER admin = GUARDIAN, MINTER admin = MASTER_MINTER | `initialize`, `Deploy.s.sol` | `Admin.t.sol`, `Deploy.t.sol` |
| 배포자 무권한, 타임락 admin 없음, executor 개방 | `Deploy.s.sol`, `DeploymentChecks.sol` | `Deploy.t.sol`, `ops verify-roles` |
| hot은 R1·R6 기준, protected·whitelabel은 자동 동결 안 함 | `detector/src/decision.ts` | `decision.test.ts`, E2E 4 |
| Responder는 freeze 선택자만 서명 | `responder/src/signer.ts` | `responder.test.ts` |
| 임계값·주소 핫 리로드 | `common/src/config.ts` `ConfigStore` | `common/test` |

### 1.6 테스트 실행

```
# 컨트랙트 (WSL)
cd contracts && forge clean && SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test
# 오프체인 (Windows. pnpm.exe가 막혀 node로 직접 실행)
cd offchain && node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/vitest/vitest.mjs run --project unit
node node_modules/vitest/vitest.mjs run --project e2e   # WSL Anvil을 띄운다
```

2026-11-09 기준 결과:
- forge: 225개 통과 (`StableToken.sol` 라인·브랜치 커버리지 100%)
- 단위: 112개 통과
- E2E: 15개 통과

Sepolia 시연 결과는 decisions.md 4절 2026-11-09 항목에 있다. 1b·2는 유출 1블록(약 21초) 뒤 자동 동결, 4는 동결 없이 알림만 나갔다.

---

## 2. 비교 축

| # | 축 | 모델 A의 선택 (자세한 내용은 1장 지도) |
|---|---|---|
| 1 | 범위·복잡도 | 컨트랙트 1개와 배포·Safe 스크립트, 오프체인 패키지 8개, 저장소 3종(memory/Redis/Postgres), 승인 서버, ops-cli, 런북 3개 |
| 2 | 토큰 컨트랙트 | ERC-20 + Permit + Pausable + AccessControl, Transparent Proxy + 타임락. 동결 검사 3곳 |
| 3 | 동결·블랙리스트 방식 | 블랙리스트를 별도 목록으로 두지 않고 `freeze`(동결 시각·사유 기록)로 통일. 오프체인 제재 목록은 R9 |
| 4 | 회수 경로 | 동결 → 대기(`minFreezeAge`) → `wipeFrozen` 소각 → `mintForRecovery` 재발행. 사건별 온체인 회계, 강제이전 없음 |
| 5 | 권한 구조 | 역할 9개를 Safe 5개와 타임락에 분산. 봇은 FREEZER만, FREEZER의 admin은 운영 Safe(타임락 없이 회수) |
| 6 | 탐지 | 룰 R1~R10, 창(window) 안 룰별 최근 1회 점수 합산, 80 자동 / 50 사람. 주소 분류(hot·watched·protected·whitelabel)에 따른 결정 |
| 7 | 자동 대응 범위 | 자동: 점수 80 이상, hot의 R1·R6. 사람 승인: 50~79, 분산 송금 수신 주소. 자동 동결 안 함: protected·whitelabel |
| 8 | 대응 안전장치 | freeze 선택자만 서명, 섀도 모드, 킬 스위치, 시간당 20건 상한, 리더 락, 수수료 인상 재전송 |
| 9 | 실시간성 | HTTP 폴링 + WS 깨우기, pending 구독(R5), 재편성 처리 |
| 10 | 운영 절차 | Safe Transaction Builder JSON을 만들어 사람이 서명. 회수·오탐 해제·봇 키 교체 런북 |
| 11 | 검증 | 컨트랙트 단위·퍼즈·불변식·업그레이드 테스트, 실제 Anvil E2E 시나리오 1~7, Sepolia 시연 1b·2·4 |
| 12 | 자체 체인 이전 | solc 0.8.28 + `evm_version = paris`, OZ v5.4.0 고정, PUSH0 검사 스크립트. 자체 체인에서 0.8.20 이상을 배포해 본 적은 없다(task-brief). 체인 사양 질문은 decisions.md 2절(미답) |

비교에 필요하면 축을 더해도 된다. 더한 축은 표 끝에 적는다.

---

## 3. 질문 목록

우선순위 순이다. 모델 B의 설계와 비교해 답할 수 있는 질문은 비교 결과를 함께 적는다.

### 3.1 적정성 (가장 궁금한 것)

1. 시험용 개발 과제에 비해 과한 부분, 부족한 부분은 무엇인가? 기준은 탐지 → 자동 동결·블랙리스트, USDT·USDC 레퍼런스, Sepolia ERC-20이다. 빼도 과제 목적을 해치지 않는 구성요소와, 빠져서 과제 목적에 못 미치는 부분을 구체적으로 꼽아 달라.
2. USDT·USDC의 실제 구조와 비교해 모델 A의 구조가 레퍼런스로서 정확한가? 비교 대상은 아래와 같다. 다르게 설명하면 오해를 부를 지점이 있는가?
   - USDC: blacklist, masterMinter, pause
   - USDT: destroyBlackFunds

### 3.2 컨트랙트 보안

3. 동결된 주소가 자금을 움직이거나 권한을 넘길 수 있는 경로가 있는가?
   - 직접 경로: `permit`, `transferFrom`, `burn`, `rescueERC20`
   - 업그레이드 후 경로
   - 동결 검사 세 곳으로 모든 경로가 막히는지 확인해 달라.
4. `wipeFrozen`·`mintForRecovery`의 회계와 접근 제어에 우회나 이중 처리 여지가 있는가? 대기 시간(`minFreezeAge`) 우회도 포함한다.
5. 업그레이드 안전성을 봐 달라. ERC-7201 저장소, 초기화 잠금, 타임락 → ProxyAdmin 경로가 대상이다.

### 3.3 권한·배포

6. 실제 배포 결과가 design.md 6장 권한 표와 정확히 일치하는가? 또 `DeploymentChecks.sol`이 놓치는 권한 상승 경로가 있는가?
7. `CreateSafes.s.sol`과 Safe 구성(서명자 3명 공유, 서명자가 EIP-7702 위임 상태)에 테스트넷 수준을 넘는 문제가 있는가?

### 3.4 탐지 로직

8. 공격자가 룰을 피하는 방법과 그 비용은? 예시:
   - 임계값 바로 아래로 쪼개 보내기
   - 시간을 늘려 천천히 빼기
   - nonce를 미리 올린 주소 쓰기
   - 화이트라벨 주소 경유
9. 점수 합산 방식은 적절한가? 방식은 창(window) 안에서 룰마다 최근 1회만 더한다. 임계값(80/50)과 룰 점수 조합에 구조적 허점이 있는가?
10. 재편성(reorg)·중복 처리·재시작 시 같은 이벤트로 두 번 동결하거나, 이벤트를 놓치는 경로가 있는가? 대상 파일은 `ingestor.ts`, `detector.ts`, `stores/`다.

### 3.5 대응·승인

11. Responder에 경합이 있는가? 대상은 리더 락, 진행 중 중복 제거, 같은 nonce 재전송, 시간당 상한 래치다. 봇 키 탈취 시 피해가 "잘못된 동결"로 한정된다는 주장이 코드상 성립하는가?
12. 승인 링크와 서버를 우회하거나 재사용할 수 있는가? 대상은 HMAC 토큰, 1회용 jti, 운영자 토큰, 127.0.0.1 바인딩이다.

### 3.6 결정이 필요한 해석 (decisions.md 4.1)

13. 아래 세 가지에 대해 권장안과 이유를 달라.
    - (1) 분산 송금 수신 주소를 사람 승인으로 넘긴 것
    - (2) 핫월렛 → 화이트라벨 대량 송금이 R1 자동 동결되는 것
    - (3) 금고 Safe의 `MinterConfigured`가 R7 알림이 되는 것

### 3.7 테스트와 문서

14. 테스트가 주장을 실제로 검증하는가? 통과는 하지만 검증력이 약한 테스트를 지적해 달라. 예: 기대값이 느슨함, mock이 실제와 다름.
15. design.md, decisions.md, 런북, 코드 사이에 서로 어긋나는 곳이 있는가?

---

## 4. 알려진 한계

모델 A 쪽에서 이미 알고 있는 것이다. 결함 목록에 다시 올릴 필요는 없다. 다만 모델 B의 설계가 이 한계를 피한다면 비교표에 적고, 평가가 다르면 적어 달라.

### 4.1 설계상 받아들인 위험 (decisions.md 5절)

- 한 트랜잭션 안에서 끝나는 공격(수신 + 스왑 원자 실행)은 오프체인 탐지로 막을 수 없다. 컨트랙트에 전송 한도·서킷 브레이커가 없다.
- 운영 Safe가 탈취되면 FREEZER 외 역할을 회수하는 데 타임락 지연이 걸린다. 그 사이 `unfreeze`·`pause`가 가능하다.
- minter 키가 탈취되면 `minterAllowance`까지 발행된다. R8은 알림만 한다.
- pending 가시성과 프라이빗 제출 경로는 RPC 제공자에 달려 있다.

### 4.2 검증하지 못한 것

- PostgreSQL·Redis 저장소는 pg-mem·ioredis-mock으로만 테스트했다. 실제 서버와 `infra/docker-compose.yml`은 실행하지 않았다(Docker 없음).
- KMS 서명자는 미구현이다(KMS 미정). Sepolia는 암호화 키스토어를 쓴다.
- 시나리오 3(출구 경쟁)과 제출 경로별 포함 지연 측정은 Sepolia에서 보류했다. Anvil에서만 검증했다.
- Sepolia 섀도 관찰은 실트래픽이 없어 탐지가 동작하는지 확인한 수준이다. 오탐률은 측정하지 못했다.
- 처리 지연 p95 4ms는 블록을 받은 뒤 판정까지만 잰 값이다. 종단 지연은 Sepolia 시연의 "유출 후 1블록(약 21초)"이 유일한 실측이다.
- 시나리오 1·5·6·7은 Anvil에서만 실행했다.

### 4.3 운영 환경 관련

- Sepolia 감시탑은 메모리 저장소로 돌았다. 재시작하면 상태가 사라지고, R8 발행 요청 기록(DB 필요)을 쓸 수 없다.
- publicnode WebSocket이 약 3분 만에 끊겼다. 감시탑은 HTTP 폴링으로 계속 처리하지만, 끊길 때마다 최고 등급 알림이 뜬다.
- Sepolia Safe 5개가 서명자 3명을 공유한다(테스트넷 한정 허용). 서명자는 MetaMask 스마트 계정(EIP-7702) 상태다.
- Windows Smart App Control이 `forge.exe`와 `pnpm.exe`를 막는다. Foundry는 WSL에서, 오프체인 명령은 node로 직접 실행한다. 문서의 `pnpm ...` 명령은 이 환경에서는 그대로 돌지 않는다.
- 시연 스크립트에 송금 가스를 고정한 버그가 있었고 수정했다. 다른 곳에 같은 종류의 고정값이 남아 있을 수 있다. 예: E2E harness의 `transfer`는 100k 고정, `rules.yaml`의 `freeze_gas_estimate`.

### 4.4 미결 사항

- 7단계(자체 체인): decisions.md 2절 질문이 미답이다.
- decisions.md 3절 미답: 봇 키 KMS, 알림 채널.
- decisions.md 4.1절 해석 3개: 사용자 확인 전이다.
- 검수 기준 커밋은 `stage-2-6` 브랜치의 `1fc36eb`(2~6단계)다. 이 브랜치는 아직 main에 병합하거나 push하지 않았다.
