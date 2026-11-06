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
| 토큰 이름 / 심볼 | 미답 | |
| 멀티시그 서명자와 정족수 (거버넌스, 운영, 회수, 금고, 발행) | 미답 (기본: 테스트넷 값, design.md 6장·10장) | |
| 타임락 executor 개방 여부 | 미답 (기본: `address(0)` 개방) | |
| 봇 서명 키 위치 (KMS/HSM) | 미답 (기본: Sepolia는 로컬 암호화 키스토어) | |
| 알림 채널과 수신 대상 | 미답 | |
| 테스트넷에서 멀티시그 서명자 겹침 허용 여부 | 미답 | |

## 4. 변경 결정 이력

| 날짜 | 결정 | 근거 |
| --- | --- | --- |
| 2026-11-06 | 설계문서 검수 반영. 사건별 온체인 회수 회계(`wipedByCase`/`reissuedByCase`, 불변식 7), R1b 유출 수신 점수 전파 룰, `hot` 주소는 점수가 아니라 R1·R6 발동 기준, 타임락 admin `address(0)`과 executor 개방 기본값, MINTER admin = MASTER_MINTER, R7 승인 목록을 타임락 이벤트에서 자동 생성, 제출 경로 설정값(`both` 기본)과 Sepolia 측정, R2 nonce 상한, 승인 링크 인증 요건 | 검수에서 발견한 7.3/8.1 모순, 단일 핫월렛 탈취 미동결, 배포 검증 누락을 바로잡기 위함 |
| 2026-11-06 | 저장소 초기화. `Architect.md`를 `docs/design.md`로 이동, `CLAUDE.md` 작성 | design.md 11장 구조 |

## 5. 잔여 위험 (design.md 15장, 정식 발행 전 재검토)

받아들이기로 한 위험이다. 정식 발행 전 외부 감사와 함께 다시 본다.

1. **한 트랜잭션 안에서 끝나는 공격은 막지 못한다.** 수신과 DEX 스왑·브리지 입금을 원자적으로 실행하면 오프체인 탐지가 개입할 틈이 없다. 컨트랙트에 전송 한도·서킷 브레이커를 두지 않기로 한 결정의 비용이다.
2. **운영 Safe 탈취 시 FREEZER 외 역할 회수에 타임락 지연(운영 48시간)이 걸린다.** 그 사이 `unfreeze`와 `pause`가 가능하다. 서명자 분리와 정족수로 막는다.
3. **minter 키 탈취 시 `minterAllowance`까지 발행된다.** R8은 알림만 하고 회수는 금고 Safe의 `removeMinter`로 사람이 한다. 한도를 일일 필요량에 가깝게 유지한다.
4. **pending 트랜잭션 가시성은 RPC 제공자에 달려 있다.** R5와 출구 경쟁 시나리오의 효과는 이 가시성에 비례한다.
5. **자체 체인에 프라이빗 제출 경로가 없으면 동결 트랜잭션이 멤풀에 노출된다.** 공격자가 더 높은 수수료로 앞지를 수 있다. 2절 답변에 따라 대응한다.
