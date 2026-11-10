# 결정 기록

`docs/design.md` 3장의 질문에 대한 답과, 설계를 바꾸는 결정을 날짜순으로 쌓는다. 답이 없는 항목은 "미답"으로 남겨 두고, 해당 단계에 들어가기 전에 반드시 채운다.

## 1. 컴파일·체인 호환성 (0단계, 1단계 시작 전 필수)

| 항목 | 답 | 날짜 |
| --- | --- | --- |
| 자체 체인 `solc` 버전 | 과거에 0.8.19로 컴파일해 배포한 전적 있음. 0.8.20 이상은 시도한 적 없음 | 2026-11-06 |
| 자체 체인 `evm_version` (PUSH0, MCOPY/TSTORE 지원 여부) | **Paris 이하. PUSH0 미지원.** MCOPY·TSTORE도 당연히 미지원 | 2026-11-06 |
| 이전에 겪은 문제의 증상과 해결책 | 배포 시 `invalid opcode`. 0.8.19로 낮춰 컴파일해 해결 | 2026-11-06 |
| Sepolia와 자체 체인에 같은 바이트코드를 쓸지, profile을 나눌지 | **같은 바이트코드.** 두 체인 모두 `evm_version = "paris"`로 빌드한다. 체인별 profile은 RPC·검증 설정만 다르고 컴파일 설정은 공유한다 | 2026-11-06 (Claude 제안, 사용자 확인 필요) |
| OpenZeppelin v5(solc ≥ 0.8.20) 사용 가능 여부 | **가능.** 문제의 원인은 컴파일러 버전이 아니라 EVM 타깃이다. solc 0.8.20부터 기본 타깃이 Shanghai가 되어 PUSH0을 내보냈고, 0.8.19는 기본이 Paris라 통과했다. 0.8.20 이상이라도 `evm_version = "paris"`를 명시하면 PUSH0을 내보내지 않는다. 0단계 완료 기준(빈 컨트랙트 컴파일)에서 산출 바이트코드에 PUSH0(`0x5f`) 명령이 없는지 검사해 이 가설을 검증한다 | 2026-11-06 (Claude 제안, 사용자 확인 필요) |

확정 사항 (답변과 무관):

- 모든 Foundry profile에 `solc_version`과 `evm_version`을 명시 고정한다.
- `openzeppelin-foundry-upgrades` 필수 설정(`ffi`, `ast`, `build_info`, `extra_output = ["storageLayout"]`)을 넣는다.

0단계 검증 결과 (2026-11-06):

| 항목 | 값 | 비고 |
| --- | --- | --- |
| Foundry | 1.9.0 | **WSL Ubuntu에서 실행.** Windows Smart App Control이 서명되지 않은 `forge.exe`를 차단함(os error 4551). 보안 설정은 건드리지 않고 WSL을 쓴다. `wsl -d Ubuntu -- bash -lc 'export PATH=$HOME/.foundry/bin:$PATH; cd /mnt/c/Users/mustree/projects/stablecoin/contracts && forge ...'` |
| solc | 0.8.28 고정 | `evm_version = "paris"`와 함께 PUSH0 없이 빌드됨을 확인 |
| OpenZeppelin Contracts / Upgradeable | **v5.4.0 고정** | v5.5.0부터 `Strings.sol`이 `Bytes.sol`(Cancun 전용 `mcopy`)을 import해 `ERC20Permit → EIP712 → Strings` 경로로 paris 빌드가 깨진다. v5.4.0이 paris로 컴파일되는 마지막 v5 릴리스. 업그레이드 시 같은 검증을 다시 한다 |
| openzeppelin-foundry-upgrades | v0.4.4 | |
| forge-std | v1.17.0 | |
| PUSH0 검사 | `contracts/script/check-push0.mjs` | `StableToken`, `TransparentUpgradeableProxy`, `ProxyAdmin` 산출물에 PUSH0 없음. 같은 소스를 shanghai로 빌드하면 검사가 실패하는 것도 확인(검사기 유효성) |
| pnpm | 12.18.0 | Windows에 설치. 오프체인은 Windows Node 26으로 실행 |

1단계 구현 메모 (2026-11-06):

| 항목 | 내용 |
| --- | --- |
| `initialize` 서명 | `initialize(name, symbol, admin, minFreezeAge)`. 배포자가 `setMinFreezeAge`를 따로 부르지 않아도 되도록 대기 시간을 초기화 인자로 받는다. DEFAULT_ADMIN은 타임락이라 배포 후 즉시 바꾸기 어렵기 때문이다 |
| MINTER 역할 관리 | `grantRole`·`revokeRole`에 `MINTER_ROLE`을 넘기면 `UseMinterFunctions()`로 거부한다. `renounceRole(MINTER_ROLE)`은 허용하되 한도를 0으로 만든다 |
| `freeze`의 발신자 검사 | 보호 주소는 FREEZER **와** GUARDIAN을 둘 다 가져야 동결된다. 운영 Safe가 둘 다 갖는 구성(6장)을 전제한다 |
| `mint`·`mintForRecovery`·`burn`의 발신자 동결 검사 | minter 자신이 동결되면 발행·소각도 실패한다(USDC와 동일). 12장 매트릭스의 "spender" 축 |
| `wipeFrozen` 경계 | 동결되지 않았거나 잔고가 0이면 실패한다(`AccountNotFrozen`, `NothingToWipe`). `block.timestamp >= frozenAt + minFreezeAge` 는 등호 포함 |
| `forge test` 전 `forge clean` | openzeppelin-foundry-upgrades는 `out/build-info`에 같은 컨트랙트가 두 번 있으면 `Found multiple contracts` 로 실패한다. 소스를 바꾼 뒤에는 `forge clean && forge test`로 돌린다 |
| `forge coverage`와 업그레이드 테스트 | coverage 모드는 플러그인이 읽는 `out/` 아티팩트를 만들지 않아 `Upgrade.t.sol`만 실패한다. 커버리지 수치는 나머지 스위트로 계산되며 `forge test`에서는 업그레이드 테스트도 통과한다 |
| V2 목의 `missing-initializer` | 이미 초기화된 프록시의 V2는 reinitializer만 쓰므로 `test/mocks/StableTokenV2.sol`에만 `@custom:oz-upgrades-unsafe-allow missing-initializer`를 단다. 실제 V2를 만들 때 다시 판단한다 |

2~5단계 구현 메모 (2026-11-06):

| 항목 | 내용 |
| --- | --- |
| 배포 입력·출력 분리 | 입력은 `config/deploy.<chain>.toml`(forge가 TOML을 직접 읽는다), 출력은 `deployments/<chain>.json`(Deploy.s.sol이 씀). 탐지 쪽 `config/addresses.<chain>.yaml`은 deployment 파일을 참조하고 라벨(hot·watched·whitelabel·exits·추가 protected)만 둔다. 같은 사실을 두 곳에 적지 않기 위함이다 |
| 배포 중 임시 역할 | FREEZER의 admin은 GUARDIAN, MINTER의 admin은 MASTER_MINTER라서 DEFAULT_ADMIN만으로는 봇에 FREEZER를 주거나 minter를 설정할 수 없다. 배포자가 같은 스크립트 실행 안에서 GUARDIAN·MASTER_MINTER를 잠시 받아 부여하고 곧바로 포기한다. 새 역할을 만든 것이 아니며, 배포 직후 `DeploymentChecks`가 배포자에게 남은 역할이 없음을 온체인에서 검증한다 |
| 보유자 분리 강제 | 스크립트는 거버넌스·운영·회수·금고 Safe, minter, 봇이 모두 서로 다른 주소이고 배포자와도 다를 때만 배포한다. `require_contract_holders = true`(Sepolia·자체 체인)면 봇을 뺀 보유자는 코드가 있는 주소(Safe)여야 한다 |
| 역할 전수 검사 | Solidity 검증은 "알려진 주체 × 9개 역할" 행렬만 볼 수 있다(AccessControl은 열거 불가). 모르는 주소가 역할을 가진 경우는 `pnpm ops verify-roles`가 RoleGranted/RoleRevoked를 훑어 잡는다 |
| 점수 합산 | 윈도우 안에서 같은 룰이 여러 번 발동해도 한 번만 센다(룰별 최신 발동 하나). 7.3 "룰 점수 합"을 이렇게 해석했다. 같은 이벤트를 다시 처리해도 결과가 같다 |
| R1 "초과" | 엄격한 초과(`>`)로 구현. 정확히 30%나 100,000은 발동하지 않는다 |
| R7 승인 기준 | (1) 같은 트랜잭션에 타임락 `CallExecuted`가 있음, (2) 이벤트의 sender가 운영 Safe, (3) 배포자가 토큰 DEFAULT_ADMIN을 포기하기 전까지 배포자 발신. 금고 Safe의 `MinterConfigured`(9장 7단계 한도 증액)는 설계대로 알림이 나간다 |
| 봇 동결 속도 감시 | 시나리오 5를 위해 Detector가 봇 operator의 `Frozen`을 세어 시간당 상한(`monitor.bot_freezes_per_hour_alert`, 20)을 넘으면 최고 등급 알림을 보낸다. 룰 점수와 무관한 감시이며 봇 키로 Responder를 거치지 않고 직접 동결하는 경우를 잡는다 |
| 킬 스위치와 모드 | 킬 스위치 또는 `RESPONDER_MODE=off`: 사람이 승인한 동결도 포함해 아무것도 서명하지 않는다(사람은 운영 Safe로 직접 동결). 섀도 모드: 자동 요청은 기록만, 사람 승인 동결은 실행 |
| 자동 동결 상한 | 시간당 상한을 넘으면 남은 한도만큼만 동결하고 나머지는 사람 승인으로 넘긴 뒤 사람 승인 모드로 고정(래치)한다. 운영자가 원인을 확인하고 되돌린다 |
| 승인 서버 인증 | 운영자 토큰의 SHA-256만 환경 변수(`APPROVAL_OPERATORS`)에 둔다. 127.0.0.1에만 바인딩한다. 운영에서는 SSO 프록시 뒤에 둔다 |
| 패키지 추가 | 11장 목록 외에 `common`(설정·타입), `service`(감시탑 조립), `e2e`(로컬 Anvil 시나리오)를 두었다 |
| 로컬 Safe | Anvil에는 Safe가 없어 Anvil 기본 계정이 Safe 자리를 대신한다(`config/deploy.anvil.toml`). ops-cli `--execute-local`은 chainId 31337에서만 그 계정으로 실행한다 |

검증 범위와 한계 (2026-11-06):

| 항목 | 상태 |
| --- | --- |
| PostgreSQL·Redis 구현 | `PgStore`는 pg-mem, `RedisWindowStore`는 ioredis-mock으로 메모리 구현과 같은 계약 테스트를 통과. **실제 PostgreSQL 16·Redis 7 서버에서는 돌려 보지 않았다.** 이 머신에 Docker·PostgreSQL·Redis가 없다. `infra/docker-compose.yml`도 실행해 보지 않았다 |
| E2E 저장소 | 로컬 Anvil E2E(시나리오 1~7)는 메모리 저장소로 돈다 |
| 처리 지연 | `Ingestor.latencies`는 블록을 가져온 뒤 Detector 처리가 끝날 때까지만 잰다. 블록 생성부터의 지연(폴링 간격·WebSocket 지연 포함)은 6단계 Sepolia에서 잰다 |
| KMS 서명자 | 3절 미답이라 구현하지 않았다. `kmsSigner()`는 명확한 오류를 던진다. Sepolia는 v3 키스토어 서명자를 쓴다 |
| 제출 경로 | 로컬에서는 공개 경로만 의미가 있다. 프라이빗 경로는 가짜 RPC로 경로 선택 로직만 검증했다. 기본값 확정은 6단계 측정 뒤 |

## 2. 자체 체인 환경 (4단계 전)

| 항목 | 답 | 날짜 |
| --- | --- | --- |
| chainId | 미답 | |
| RPC URL (HTTP, WebSocket) | 미답 | |
| 블록 생성 주기 | 미답 | |
| 익스플로러 유무 | 미답 | |
| WebSocket `pending` 구독 지원 | 미답 | |
| Safe 싱글톤·팩토리 배포 여부 | 미답 | |
| EIP-7702 지원 (R6 활성화 여부) | 미답 | |
| 프라이빗 트랜잭션 제출 경로 | 미답 | |

## 3. 토큰과 운영 주체 (1단계 중)

| 항목 | 답 | 날짜 |
| --- | --- | --- |
| 토큰 이름 / 심볼 | **Stable Token / STB** | 2026-11-06 |
| 멀티시그 서명자와 정족수 (거버넌스, 운영, 회수, 금고, 발행) | **테스트넷 기본값 사용** (design.md 6장·10장: 거버넌스 2/3, 운영 2/3, 회수 2/3, 금고 2/3, 발행 1/2). 서명자 주소는 2단계 배포 시 정한다 | 2026-11-06 |
| 타임락 executor 개방 여부 | **개방 (`address(0)`)**. 제안 없이는 아무것도 실행할 수 없으므로 권한이 아니다 | 2026-11-06 |
| 봇 서명 키 위치 (KMS/HSM) | 미답 (기본: Sepolia는 로컬 암호화 키스토어) | |
| 알림 채널과 수신 대상 | 미답 | |
| 테스트넷에서 멀티시그 서명자 겹침 허용 여부 | **테스트넷 한정 허용.** Sepolia Safe 5개가 서명자 3명을 공유한다. 운영에서는 나눈다(design.md 6장) | 2026-11-09 |
| Sepolia Safe 주소 (거버넌스·운영·회수·금고·발행), 봇 주소 | **확정.** `deployments/safes-sepolia.json`, `config/deploy.sepolia.toml`. 봇 `0xd154…Ae1A` | 2026-11-09 |

## 4. 변경 결정 이력

| 날짜 | 결정 | 근거 |
| --- | --- | --- |
| 2026-11-09 | **6단계 Sepolia 시연 결과 (1회차).** 발행 Safe가 시연 지갑에 700,000 STB 발행. 시나리오 4(섀도 모드): 파트너→거래소 150,000에 R1 사람 확인 알림만, 동결 없음. 사용자가 자동 모드 전환("설계 계속 진행해"). 시나리오 1b: 핫월렛→공격자 150,000, 유출 +1블록(21초)에 핫월렛·공격자 동시 동결(tx `0x12be…46df`). 시나리오 2: 피해자→공격자 100,000 후 20건 분산 송금, 첫 분산 송금 +1블록에 공격자 동결(tx `0xe6f8…a9cb2`), 16건 성공·4건 실패, 80,000 유출·20,000 동결, 수신 주소 16개는 승인 링크로 올라옴. 발견: (1) 시연 스크립트의 송금 가스 고정값(100k)이 Sepolia에서 부족(약 155k) → 추정값으로 수정. (2) publicnode WebSocket이 약 3분 만에 끊김 → 설계대로 HTTP 폴링으로 계속 처리하고 최고 등급 알림. 한계: 실트래픽이 없어 섀도 관찰은 탐지 동작 확인 수준. 제출 경로 측정과 시나리오 3은 보류 | 실행 결과 |
| 2026-11-09 | Sepolia 시연 도구 추가 (`ops-cli/src/demo.ts`, `demo-main.ts`). 시나리오 1b·2·4를 실제 체인에서 재현하고 동결까지 걸린 블록 수를 잰다. 시연 지갑은 `DEMO_MNEMONIC`(.env) 파생, 회차 3개. 발행은 발행 Safe가 Transaction Builder 배치로 한다. 감시탑에 `WATCH_FROM`(커서 없을 때 시작 블록) 추가. 새 패키지 대신 ops-cli에 넣은 이유는 `pnpm.exe`가 Smart App Control에 막혀 `pnpm install`을 못 하기 때문 | 사용자 지시("시나리오 스크립트는 네가 적어") |
| 2026-11-09 | Sepolia 토큰 배포 완료 (블록 12095789~12095849, 트랜잭션 25건 성공, 0.0148 ETH). StableToken 프록시 `0x36C8CDC1E48E47f9d55C45af8d5DF168e094B3A3`, 타임락 `0xcbF9…21A1`, ProxyAdmin `0x82aC…76ef`. `VerifyDeployment.s.sol`(fresh)과 `ops verify-roles` 모두 통과. 전체 주소는 `deployments/sepolia.json` | 사용자 지시("배포해") |
| 2026-11-09 | Sepolia Safe 5개 생성 완료 (블록 12095670, 배포자 `0x2305…8486`, 트랜잭션 5건 성공). 거버넌스·운영·회수·금고 2/3, 발행 1/2. 테스트넷이라 5개 Safe가 서명자 3명을 공유한다(3절 "서명자 겹침" 항목을 테스트넷 한정 허용으로 답함). 서명자 3명은 MetaMask 스마트 계정(EIP-7702 위임 `0x63c0…e32b`) 상태다. 주소는 `deployments/safes-sepolia.json`과 `config/deploy.sepolia.toml`에 있다. `CreateSafes.s.sol`·`Deploy.s.sol`은 시뮬레이션에서는 기록 파일을 쓰지 않는다 | 사용자 지시 |
| 2026-11-09 | 6단계 Sepolia RPC는 publicnode(`ethereum-sepolia-rpc.publicnode.com`, HTTP·WS)로 연결. 시나리오 3(출구 경쟁)과 제출 경로별 포함 지연 측정은 뒤로 미룬다. 측정 전까지 `PRIVATE_RPC_URL`을 비워 두면 Responder는 `submit_route`와 상관없이 공개 경로로만 제출한다. 따라서 6단계 완료 기준 중 "제출 경로 기본값을 측정 결과로 확정"은 보류 상태다 | 사용자 지시 |
| 2026-11-09 | Sepolia Safe 5개는 `CreateSafes.s.sol`로 정식 Safe v1.4.1(SafeL2, SafeProxyFactory)에서 만든다. 생성 트랜잭션은 배포자 EOA가 보내고 사용자가 터미널에서 키스토어 비밀번호를 직접 입력한다 | 사용자 지시("Safe 만들어서 넣어") |
| 2026-11-06 | 2~5단계 구현: 배포·검증 스크립트, 탐지(Ingestor·Enricher·Rule Engine·Decision·Case Store), Responder·Notifier·승인 서버, ops-cli와 런북. 사용자 지시("막히는 것 없으면 끝까지")로 단계별 확인 없이 진행. 6·7단계는 아래 미답 항목과 브로드캐스트 지시가 필요해 멈춤 | 사용자 지시 |
| 2026-11-06 | 설계문서 검수 반영. 사건별 온체인 회수 회계(`wipedByCase`/`reissuedByCase`, 불변식 7), R1b 유출 수신 점수 전파 룰, `hot` 주소는 점수가 아니라 R1·R6 발동 기준, 타임락 admin `address(0)`과 executor 개방 기본값, MINTER admin = MASTER_MINTER, R7 승인 목록을 타임락 이벤트에서 자동 생성, 제출 경로 설정값(`both` 기본)과 Sepolia 측정, R2 nonce 상한, 승인 링크 인증 요건 | 검수에서 발견한 7.3/8.1 모순, 단일 핫월렛 탈취 미동결, 배포 검증 누락을 바로잡기 위함 |
| 2026-11-06 | 1단계 시작. 토큰 이름 Stable Token / STB, 타임락 executor 개방, 테스트넷 멀티시그 기본값 확정 | design.md 3장 "토큰과 운영 주체" 질문에 대한 사용자 답변 |
| 2026-11-06 | 저장소 초기화. `Architect.md`를 `docs/design.md`로 이동, `CLAUDE.md` 작성 | design.md 11장 구조 |

## 4.1 사용자 확인이 필요한 해석 (2~5단계에서 생김)

설계문서만으로 하나로 정해지지 않아 아래처럼 구현했다. 다르게 원하면 알려 달라.

1. **시나리오 2의 "연관 주소 동결"**: R3이 발동하면 송금 주체는 점수(예: R2 40 + R3 40 = 80)로 자동 동결되고, 분산 송금 수신 주소들은 사건에 "연관"으로 붙어 원클릭 승인 링크와 함께 사람에게 간다. 수신 주소들을 자동 동결하려면 8.1 표에 없는 자동 동결 경로가 생기므로 넣지 않았다.
2. **시나리오 4와 핫월렛**: 감시 지갑(hot 아님)이 거래소로 대량 송금하면 R1(60)으로 사람 확인 알림만 나간다. 그러나 **핫월렛이 거래소로 대량 송금(재조정)하면 R1으로 핫월렛이 자동 동결된다**(8.1 표 그대로). 핫월렛의 화이트 라벨 수신 유출을 R1 집계에서 뺄지 정해야 한다.
3. **금고 Safe의 `MinterConfigured`**: R7 승인 기준(타임락 경유 또는 운영 Safe)에 해당하지 않아 회수 7단계의 한도 증액도 최고 등급 알림이 된다. 금고 Safe를 승인 발신자로 추가할지 정해야 한다.

## 5. 잔여 위험 (design.md 15장, 정식 발행 전 재검토)

받아들이기로 한 위험이다. 정식 발행 전 외부 감사와 함께 다시 본다.

1. **한 트랜잭션 안에서 끝나는 공격은 막지 못한다.** 수신과 DEX 스왑·브리지 입금을 원자적으로 실행하면 오프체인 탐지가 개입할 틈이 없다. 컨트랙트에 전송 한도·서킷 브레이커를 두지 않기로 한 결정의 비용이다.
2. **운영 Safe 탈취 시 FREEZER 외 역할 회수에 타임락 지연(운영 48시간)이 걸린다.** 그 사이 `unfreeze`와 `pause`가 가능하다. 서명자 분리와 정족수로 막는다.
3. **minter 키 탈취 시 `minterAllowance`까지 발행된다.** R8은 알림만 하고 회수는 금고 Safe의 `removeMinter`로 사람이 한다. 한도를 일일 필요량에 가깝게 유지한다.
4. **pending 트랜잭션 가시성은 RPC 제공자에 달려 있다.** R5와 출구 경쟁 시나리오의 효과는 이 가시성에 비례한다.
5. **자체 체인에 프라이빗 제출 경로가 없으면 동결 트랜잭션이 멤풀에 노출된다.** 공격자가 더 높은 수수료로 앞지를 수 있다. 2절 답변에 따라 대응한다.
