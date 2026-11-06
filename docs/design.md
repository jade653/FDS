# 스테이블코인 동결·회수 및 이상거래 탐지 시스템 설계문서

Nov 6, 2026 · @Mustree · 검수 반영본 (2026-11-06)

## 0. Claude Code 작업 규칙

이 문서는 Claude Code가 구현할 때 따르는 단일 기준이다. 문서와 다르게 구현해야 할 이유가 생기면 구현하지 말고 먼저 사용자에게 묻는다.

1. **3장의 질문을 먼저 해결한다.** 특히 컴파일러 버전과 EVM 버전은 절대 추측하지 않는다. `foundry.toml`을 만들기 전에 사용자에게 묻는다.
2. **권한을 늘리는 변경은 금지한다.** 6장의 권한 표에 없는 역할을 추가하거나, 봇 키에 동결 외 권한을 주는 코드는 작성하지 않는다. 필요해 보이면 사용자에게 제안만 한다.
3. **비밀값은 저장소에 넣지 않는다.** 개인키, 니모닉, RPC 키는 `.env`(gitignore)나 KMS에서만 읽는다. 테스트용 키도 Anvil 기본 키만 쓴다.
4. **임계값과 주소는 코드에 박지 않는다.** 탐지 룰의 임계값, 감시 주소, 보호 주소는 설정 파일에서 읽고, 재시작 없이 다시 읽을 수 있어야 한다.
5. **단계마다 멈춘다.** 13장의 각 단계가 끝나면 완료 기준 충족 여부를 보고하고 다음 단계로 가기 전에 확인받는다.
6. **테스트 없이 완료라고 하지 않는다.** 컨트랙트 변경에는 단위 테스트와 해당 불변식 테스트가 함께 있어야 한다.
7. **배포는 사람이 한다.** Sepolia와 자체 체인 배포 스크립트는 작성하되, 실제 브로드캐스트(`--broadcast`)는 사용자의 명시적 지시가 있을 때만 실행한다.

## 1. 개요와 범위

법정화폐 담보 스테이블코인 컨트랙트와, 이를 감시하고 의심 주소를 자동으로 동결하는 오프체인 탐지 시스템을 만든다. 탈취가 확인되면 동결 → 소각 → 피해자 재발행으로 회수한다.

배포는 두 단계로 진행한다.

1. **실습**: 이더리움 Sepolia 테스트넷. 전체 기능과 탐지·대응 흐름을 검증한다.
2. **테스트 발행**: 자체 제작 EVM 체인. 정식 발행 전 단계이며, 실제 준비금 연동은 하지 않는다.

설계 기준은 Circle USDC(FiatToken)의 역할 분리 구조다. 여기에 Tether USDT의 `destroyBlackFunds`에 해당하는 회수 기능을 더하되, 별도 고위 권한과 지연 시간으로 묶는다.

## 2. 확정된 결정사항

| 항목 | 결정 | 정한 사람 |
| --- | --- | --- |
| 배포 체인 | Sepolia로 실습 → 자체 EVM 체인 테스트 발행 | 사용자 |
| 토큰 성격 | 법정화폐 담보 스테이블코인, 누구나 보유 가능 | 사용자 |
| 접근 통제 방식 | 블랙리스트(동결 목록) | 사용자 결정에서 도출 |
| 회수 방식 | 동결 → 소각 → 재발행. 강제이전 기능은 두지 않음 | 사용자 |
| 자동 대응 범위 | 봇은 개별 주소 동결만 자동 실행. 해제, 전체 정지, 소각, 발행은 사람이 승인 | 사용자 |
| 이상거래 대응 위치 | 오프체인 탐지 + 자동 동결. 컨트랙트에는 전송 한도나 서킷 브레이커를 두지 않음 | 사용자 |
| 블랙리스트 검사 대상 | spender(`msg.sender`), from, to 세 주소 모두 (USDC형) | Claude |
| 소수점 | 6 | Claude |
| 업그레이드 | Transparent Proxy, 업그레이드는 타임락 경유 | Claude |
| 컨트랙트 기반 | OpenZeppelin Contracts Upgradeable v5.4.0, solc 0.8.28, `evm_version = paris` (두 체인 동일 바이트코드) | Claude (0단계에서 확정) |
| 오프체인 스택 | TypeScript(Node 20+), viem, PostgreSQL, Redis | Claude |
| 회수 회계 | 사건별 소각액·재발행액을 컨트랙트가 기록하고 재발행이 소각을 넘지 못하게 강제 | Claude (검수 반영) |
| 핫월렛 자동 동결 | 점수가 아니라 R1·R6 발동 기준. 다른 룰은 사람 확인 | Claude (검수 반영) |
| 타임락 executor | 개방(`address(0)`) 기본, 3장에서 확인 | Claude (검수 반영) |

## 3. 작업 전 사용자에게 반드시 물어볼 것

아래 항목은 Claude Code가 임의로 정하지 않는다. 해당 단계에 들어가기 전에 사용자에게 묻고, 답을 `docs/decisions.md`에 기록한다.

**컴파일·체인 호환성 (1단계 시작 전, 최우선)**

이더리움과 자체 EVM 체인 사이에 컴파일 버전 문제가 있었다. 다음을 모두 확인하기 전에는 `foundry.toml`을 작성하지 않는다.

- 자체 체인에서 사용할 `solc` 버전과 `evm_version`. 예: Shanghai의 `PUSH0`, Cancun의 `MCOPY`·`TSTORE`를 지원하는지.
- 이전에 겪은 문제의 구체적 증상(배포 실패, invalid opcode 등)과 그때 쓴 해결책.
- Sepolia와 자체 체인에 같은 바이트코드를 쓸지, 체인별로 따로 빌드할지. 따로 빌드한다면 Foundry profile을 체인별로 나눈다.
- OpenZeppelin v5는 `solc` 0.8.20 이상이 필요하다. 답변에 따라 이 버전을 쓸 수 없으면 OpenZeppelin 버전을 낮출지 사용자와 정한다.
- 답변과 무관하게 `foundry.toml`의 모든 profile에 `solc_version`과 `evm_version`을 명시해 고정한다. Foundry 기본 EVM 버전은 릴리스마다 바뀌므로 기본값에 기대지 않는다.
- `openzeppelin-foundry-upgrades`가 요구하는 설정(`ffi = true`, `ast = true`, `build_info = true`, `extra_output = ["storageLayout"]`)을 함께 넣는다. 이 설정이 없으면 업그레이드 안전성 검사가 돌지 않는다.

**자체 체인 환경 (4단계 전)**

- chainId, RPC URL(HTTP·WebSocket), 블록 생성 주기, 익스플로러 유무.
- WebSocket으로 `pending` 트랜잭션 구독이 되는지. 탐지 지연 목표가 여기에 달려 있다.
- Safe 컨트랙트(싱글톤, 팩토리)가 배포되어 있는지. 없으면 직접 배포할지 정한다.
- EIP-7702(타입 0x04 트랜잭션)를 지원하는지. 지원하면 탐지 룰 R6을 켠다.
- 프라이빗 트랜잭션 제출 경로(시퀀서·빌더 직접 제출 등)가 있는지.

**토큰과 운영 주체 (1단계 중)**

- 토큰 이름과 심볼.
- 각 멀티시그의 서명자 주소와 정족수. 정하지 않으면 테스트넷 기본값(10장)을 쓴다.
- 타임락 executor를 개방(`address(0)`, 6장 기본값)할지 거버넌스 Safe로 제한할지. 제한하면 지연이 지난 뒤 실행에 서명 라운드가 한 번 더 필요하다.
- 봇 서명 키를 둘 곳(AWS KMS, GCP KMS, HSM 등). 정하지 않으면 Sepolia에서는 로컬 암호화 키스토어를 쓴다.
- 알림 채널(Slack, Telegram, 이메일 등)과 수신 대상.

## 4. 전체 아키텍처

시스템은 체인 위의 토큰 컨트랙트, 오프체인 탐지·대응 서비스, 사람이 쥔 멀티시그 세 부분으로 나뉜다. 자동으로 체인에 쓰는 경로는 Responder의 동결 트랜잭션 하나뿐이다.

&#91;embedded content: 전체 아키텍처 · 체인, 오프체인 탐지·대응, 멀티시그\]

강조된 선이 유일한 자동 경로다. 점수 50\~79는 Notifier가 운영 Safe에 승인을 요청하고, 해제·소각·재발행·업그레이드는 모두 오른쪽 멀티시그에서만 나간다.

## 5. 스마트 컨트랙트 설계

토큰 컨트랙트 하나(`StableToken`, 이름은 3장에서 확정)를 Transparent Proxy 뒤에 둔다. 전송 한도나 서킷 브레이커는 두지 않고, 동결·해제·소각·발행 같은 스위치만 둔다. 판단은 모두 오프체인에서 한다.

### 5.1 상속 구조와 저장소

- `Initializable`, `ERC20Upgradeable`, `ERC20PermitUpgradeable`, `AccessControlUpgradeable`, `PausableUpgradeable`.
- 생성자에서 `_disableInitializers()`를 호출한다. 초기화는 `initialize(...)` 한 번만 한다.
- 자체 상태는 ERC-7201 네임스페이스 저장소에 둔다. 업그레이드 시 저장소 충돌을 막기 위해서다.
- `decimals()`는 6을 반환한다.

자체 상태 변수:

| 변수 | 타입 | 용도 |
| --- | --- | --- |
| `frozenAt` | `mapping(address => uint64)` | 동결 시각. 0이면 동결되지 않음 |
| `minterAllowance` | `mapping(address => uint256)` | minter별 남은 발행 한도 |
| `isProtected` | `mapping(address => bool)` | 봇이 동결할 수 없는 주소 (금고, minter, 멀티시그, 타임락 등) |
| `minFreezeAge` | `uint64` | 동결 후 소각이 가능해지기까지의 최소 대기 시간 |
| `wipedByCase` | `mapping(bytes32 => uint256)` | 사건별 누적 소각액. `wipeFrozen`이 더한다 |
| `reissuedByCase` | `mapping(bytes32 => uint256)` | 사건별 누적 재발행액. `mintForRecovery`가 더하고, `wipedByCase`를 넘지 못한다 |

### 5.2 동결 검사 (가장 중요)

잔고가 움직이는 모든 경로에서 관련된 세 주소를 모두 검사한다.

- `_update(from, to, value)`를 override해 `whenNotPaused`와 `from`·`to`의 동결 여부를 검사한다. mint(`from = 0`)와 burn(`to = 0`)은 0 주소 쪽 검사를 건너뛴다.
- `transferFrom`을 override해 `_msgSender()`(spender)의 동결 여부도 검사한다.
- `_approve`를 override해 owner와 spender 중 하나라도 동결되어 있으면 실패하게 한다. `approve`와 `permit` 모두 이 경로를 탄다. USDC v2.2보다 엄격한 선택이다.
  - OpenZeppelin v5에서 virtual인 것은 4인자 `_approve(owner, spender, value, emitEvent)`다. 3인자 버전은 virtual이 아니므로 반드시 4인자 버전을 override한다.
  - `transferFrom`의 `_spendAllowance`도 이 4인자 `_approve`를 호출하므로, 동결된 owner나 spender의 `transferFrom`은 `_update`에 닿기 전에 여기서 먼저 실패한다. 의도한 이중 검사이며, 무한 allowance는 `_approve`를 거치지 않으므로 `_update`와 `transferFrom` override가 최종 방어선이다.
- 동결은 일시정지와 무관하게 언제나 실행할 수 있어야 한다. 일시정지 상태에서도 `freeze`, `unfreeze`, `wipeFrozen`, 역할 변경은 동작한다. 반면 minter의 `burn`과 `mint`, 모든 전송은 `_update`를 거치므로 일시정지 중에는 실패한다. 즉 일시정지를 우회하는 소각은 `wipeFrozen` 하나뿐이다.

```solidity
function _update(address from, address to, uint256 value) internal override whenNotPaused {
    if (from != address(0)) _requireNotFrozen(from);
    if (to   != address(0)) _requireNotFrozen(to);
    super._update(from, to, value);
}

function transferFrom(address from, address to, uint256 value) public override returns (bool) {
    _requireNotFrozen(_msgSender());
    return super.transferFrom(from, to, value);
}
```

### 5.3 함수 목록

| 함수 | 권한 | 동작 | 이벤트 |
| --- | --- | --- | --- |
| `freeze(address account, bytes32 reason)` | FREEZER | 동결하고 `frozenAt`을 기록. 이미 동결이면 아무것도 하지 않고 성공. 보호 주소는 GUARDIAN만 가능 | `Frozen(account, operator, reason)` |
| `freezeBatch(address[] accounts, bytes32 reason)` | FREEZER | 여러 주소를 한 트랜잭션에 동결. 최대 길이 제한(예: 50) | 주소마다 `Frozen` |
| `unfreeze(address account)` | UNFREEZER | 동결 해제, `frozenAt = 0` | `Unfrozen(account, operator)` |
| `wipeFrozen(address account, bytes32 caseId)` | WIPER | 동결된 지 `minFreezeAge`가 지난 주소의 잔고 전부를 소각. `wipedByCase[caseId]`에 더함 | `FrozenFundsWiped(caseId, account, amount)` |
| `configureMinter(address minter, uint256 allowance)` | MASTER\_MINTER | MINTER 역할 부여(`_grantRole`) 및 누적 한도 설정. 한도는 덮어쓴다 | `MinterConfigured` |
| `removeMinter(address minter)` | MASTER\_MINTER | MINTER 역할 회수, 한도 0 | `MinterRemoved` |
| `mint(address to, uint256 amount)` | MINTER | 한도 내 발행, 한도 차감 | `Mint`, `Transfer` |
| `mintForRecovery(address to, uint256 amount, bytes32 caseId)` | MINTER | 회수 재발행. `mint`와 같은 한도를 쓰고, `reissuedByCase[caseId] + amount <= wipedByCase[caseId]`를 검사한 뒤 더함 | `RecoveryReissued(caseId, to, amount)`, `Transfer` |
| `burn(uint256 amount)` | MINTER | 자기 잔고만 소각 (상환용). 일시정지 중에는 실패 | `Burn`, `Transfer` |
| `pause()` / `unpause()` | PAUSER | 전체 전송·발행·`burn` 정지와 재개. `wipeFrozen`은 영향 없음 | `Paused` / `Unpaused` |
| `setProtected(address account, bool on)` | DEFAULT\_ADMIN | 보호 주소 지정 | `ProtectedSet` |
| `setMinFreezeAge(uint64 secs)` | DEFAULT\_ADMIN | 소각 대기 시간 변경 | `MinFreezeAgeSet` |
| `rescueERC20(address token, address to, uint256 amount)` | RESCUER | 컨트랙트 주소에 잘못 들어온 토큰 반환 | `Rescued` |

### 5.4 회수 함수의 세부 규칙

- `wipeFrozen`은 `_update` override를 거치지 않고 부모의 `ERC20Upgradeable._update(account, address(0), balance)`를 직접 호출한다. 동결 검사와 일시정지를 우회해야 하기 때문이다. 이 우회 경로는 이 함수 하나에만 허용한다.
- `block.timestamp >= frozenAt[account] + minFreezeAge`를 검사한다. 동결 직후 실수로 소각하는 사고를 막는 장치다.
- 소각 후에도 동결 상태는 유지한다. 해제는 별도 절차로 한다.
- 재발행은 `mintForRecovery`로만 한다. 일반 `mint`와 같은 minter 한도를 쓰므로, 회수 경로가 발행 통제를 우회하지 않는다.
- **사건별 회계는 컨트랙트가 강제한다.** `wipeFrozen`은 `wipedByCase[caseId] += amount`, `mintForRecovery`는 `reissuedByCase[caseId] + amount <= wipedByCase[caseId]`를 요구한 뒤 더한다. 소각되지 않은 사건 번호로는 재발행할 수 없고, 한 사건의 재발행 합계는 소각 합계를 넘지 못한다. 오프체인 도구의 검사는 보조일 뿐이다.
- 강제이전 함수는 만들지 않는다. 다른 주소의 잔고를 임의 주소로 옮기는 코드는 어떤 형태로도 추가하지 않는다.

### 5.5 불변식 (테스트로 강제)

1. `totalSupply == 모든 잔고의 합`.
2. 동결된 주소의 잔고는 `wipeFrozen` 외에는 줄어들지도 늘어나지도 않는다.
3. FREEZER만 가진 주소는 해제, 소각, 발행, 정지, 역할 변경, 업그레이드를 할 수 없다.
4. minter의 누적 발행량은 그동안 설정된 한도의 합을 넘지 않는다.
5. 보호 주소는 GUARDIAN 없이 동결되지 않는다.
6. 일시정지 상태에서도 `freeze`는 성공한다.
7. 모든 `caseId`에 대해 `reissuedByCase[caseId] <= wipedByCase[caseId]`.

## 6. 권한과 키 관리

원칙은 하나다. 되돌릴 수 있는 조치는 빠른 키에, 되돌릴 수 없는 조치는 느리고 무거운 키에 둔다. 봇 키는 동결 하나만 할 수 있고, 탈취되면 운영 멀티시그가 즉시 회수한다.

| 역할 | 보유자 | 정족수 (테스트넷 / 운영 권장) | 이 역할의 admin | 성격 |
| --- | --- | --- | --- | --- |
| DEFAULT\_ADMIN | TimelockController | 지연 10분 / 48시간 | 자기 자신 | 역할 부여, 보호 주소, 파라미터 |
| ProxyAdmin 소유자 | TimelockController | 지연 10분 / 48시간 | – | 구현체 업그레이드 |
| Timelock proposer·canceller | 거버넌스 Safe | 2/3 / 3/5 | – | 타임락 작업의 제안과 취소 |
| Timelock executor | 개방 (`address(0)`) | – | – | 지연이 지난 작업은 누구나 실행 가능. 제안 없이는 아무것도 못 하므로 권한이 아님. 3장에서 확인 |
| Timelock admin | 없음 (생성자에 `address(0)`) | – | – | 타임락 역할 변경은 타임락 자신을 거쳐야 함 |
| GUARDIAN | 운영 Safe | 2/3 / 2/3 | DEFAULT\_ADMIN | FREEZER 역할의 admin. 보호 주소 동결 가능 |
| FREEZER | 탐지 봇 키(KMS), 운영 Safe | 봇 단일 키 | **GUARDIAN** | 동결만 가능 (되돌릴 수 있음) |
| UNFREEZER | 운영 Safe | 2/3 / 2/3 | DEFAULT\_ADMIN | 동결 해제 |
| PAUSER | 운영 Safe | 2/3 / 2/3 | DEFAULT\_ADMIN | 전체 정지·재개 |
| WIPER | 회수 Safe | 2/3 / 3/5 | DEFAULT\_ADMIN | 동결 잔고 소각 (되돌릴 수 없음) |
| MASTER\_MINTER | 금고 Safe | 2/3 / 3/5 | DEFAULT\_ADMIN | minter 등록과 한도 |
| MINTER | 발행 운영 주소 | Safe 1/2 / 2/3 | **MASTER\_MINTER** (`_setRoleAdmin`으로 지정) | 한도 내 발행, 자기 잔고 소각. 역할 부여·회수는 `configureMinter`·`removeMinter`로만 |
| RESCUER | 운영 Safe | 2/3 / 2/3 | DEFAULT\_ADMIN | 잘못 들어온 토큰 반환 |

세부 규칙:

- **FREEZER의 admin은 GUARDIAN이다.** 봇 키가 탈취됐다고 판단되면 운영 Safe가 타임락 없이 `revokeRole(FREEZER, bot)`을 실행한다. 다른 역할은 모두 타임락을 거쳐야 바뀐다.
- **봇 키가 탈취됐을 때의 최대 피해는 잘못된 동결이다.** 자금은 움직이지 않고, 운영 Safe가 해제할 수 있다. 봇 키에 동결 외 권한을 주면 이 전제가 무너지므로 금지한다.
- **EOA는 관리 권한을 갖지 않는다.** 봇 키를 제외한 모든 권한은 Safe나 타임락이 갖는다.
- **멀티시그끼리 서명자를 겹치지 않는다(운영 권장).** 특히 회수 Safe와 금고 Safe의 서명자가 같으면 소각과 재발행을 한 집단이 혼자 할 수 있게 된다. 테스트넷에서는 겹쳐도 되지만 `docs/decisions.md`에 기록한다.
- **봇 키는 KMS 안에서만 서명한다.** 키를 내보낼 수 없어야 한다. 가스용 ETH는 최소한(예: 동결 50건 분량)만 두고 별도 모니터링한다.
- **배포 직후 권한을 넘긴다.** 배포자 EOA는 초기화 후 토큰의 모든 역할을 포기(`renounceRole`)하고, 그 결과를 배포 스크립트가 온체인에서 검증한다. 검증 대상은 토큰 역할만이 아니다. `TimelockController` 생성자의 `admin` 인자는 `address(0)`으로 넘겨 배포자가 타임락 admin을 가진 적이 없게 하고, Transparent Proxy 생성자의 `initialOwner`(ProxyAdmin 소유자)가 타임락인지, 타임락의 proposer·canceller가 거버넌스 Safe뿐인지까지 스크립트가 확인한다.
- **운영 Safe의 FREEZER 외 역할은 즉시 회수할 수 없다.** UNFREEZER, PAUSER, GUARDIAN, RESCUER의 admin은 DEFAULT_ADMIN(타임락)이므로 운영 Safe가 탈취되면 회수에 타임락 지연(운영 48시간)이 걸린다. 그 사이 공격자는 동결 해제와 전체 정지를 할 수 있다. 이것이 서명자 분리와 운영 Safe 정족수를 엄격히 지켜야 하는 이유이며, `docs/decisions.md`에 잔여 위험으로 기록한다.

## 7. 오프체인 탐지 계층

탐지 계층은 블록과 멘풀을 실시간으로 읽고, 설정 파일의 룰로 주소별 위험 점수를 매긴다. 임계값을 넘으면 Responder(8장)에 동결을 요청한다. 룰과 임계값은 모두 설정 파일에 있으며, 재배포나 재시작 없이 바꿀 수 있다.

### 7.1 구성요소

| 구성요소 | 역할 | 구현 |
| --- | --- | --- |
| Ingestor | 새 블록, 토큰 이벤트, (지원 시) pending 트랜잭션 구독 | viem WebSocket. 끊기면 마지막 처리 블록부터 HTTP로 메움 |
| Enricher | 주소 첫 등장 시각, 누적 거래 수, 라벨(감시·보호·거래소·DEX·브리지) 부착. "신규 주소" 판정은 토큰 기준 첫 등장과 체인 nonce(`getTransactionCount`)를 함께 본다 | PostgreSQL `addresses` 테이블 + Redis 캐시. nonce는 첫 조회 시 RPC로 읽어 캐시 |
| Rule Engine | 이벤트마다 룰 평가, 주소별 점수 누적 (슬라이딩 윈도우) | Redis sorted set으로 윈도우 집계 |
| Decision | 점수와 정책으로 자동 동결, 사람 확인, 기록만 중 하나 결정 | 순수 함수. 테스트 용이하게 분리 |
| Case Store | 탐지 근거, 조치, 승인 이력을 사건 단위로 저장 | PostgreSQL `cases`, `actions` |
| Notifier | 알림 발송, 원클릭 동결 승인 링크 포함. 링크는 사건 번호·대상 주소를 담은 서명 토큰으로 만들고, 1회용이며 만료(기본 1시간)가 있다. 승인자는 인증된 운영자 계정이어야 하며, 누가 언제 승인했는지 Case Store에 남긴다 | 채널은 3장에서 확정. 승인 엔드포인트는 Responder 앞의 작은 HTTP 서비스로 두고 공개망에 직접 노출하지 않는다 |

### 7.2 탐지 룰

임계값 기본값은 10장에 있다. 모든 룰은 `rules.yaml`에서 켜고 끄며 점수와 임계값을 바꿀 수 있다.

| ID | 룰 | 조건 (요약) | 점수 | 비고 |
| --- | --- | --- | --- | --- |
| R1 | 감시 지갑 유출 속도 | 감시 지갑의 T분 유출량이 잔고의 X% 또는 N개 초과 | 60 | 대형 탈취의 1차 신호. `hot` 주소에는 점수와 무관하게 자동 동결 트리거(8.1) |
| R1b | 유출 수신 | R1이 발동한 유출을 받은 수신 주소 | 60 | R1의 점수를 수신 쪽에 전파. 핫월렛 하나만 털려도 R2(40)와 합쳐 공격자 주소가 80을 넘게 한다. 화이트 라벨 수신자는 제외 |
| R2 | 신규 주소로 대량 유입 | 신규 주소(토큰 첫 등장 24시간 미만이고 체인 nonce가 K 이하)가 한 번에 N개 이상 수신 | 40 | 거래소 등 화이트 라벨은 제외. 오래된 지갑의 첫 입금은 신규로 보지 않는다 |
| R3 | 분산 송금 | 한 주소가 T분 안에 K개 이상의 신규 주소로 송금 | 40 | 세탁 패턴 |
| R4 | 집중 유입 | K개 이상 감시 지갑에서 같은 주소로 T분 안에 유입 | 50 | 여러 핫월렛 동시 탈취 |
| R5 | 출구 접근 | 대량 수신 주소가 T분 안에 DEX 라우터, 브리지에 approve 또는 호출 | 40 | 동결 불가 자산으로 바꾸려는 시도. pending 단계에서 잡을수록 가치가 큼 |
| R6 | 위임·코드 변경 | 감시 EOA에 EIP-7702 위임(타입 0x04)이 설정되거나 코드가 생김 | 80 | 자체 체인 지원 여부는 3장에서 확인 |
| R7 | 관리 이벤트 | `RoleGranted`/`RoleRevoked`, `Upgraded`, `MinterConfigured`, `ProtectedSet`, `Paused`가 승인된 변경 목록에 없음 | 알림만 | 동결 대상이 아님. 즉시 최고 등급 알림. 승인 목록은 타임락의 `CallScheduled`·`CallExecuted` 이벤트에서 자동으로 만든다. 타임락을 거치지 않는 변경(운영 Safe의 `revokeRole(FREEZER)`, `pause`, `unfreeze`)은 `addresses.yaml`의 운영 Safe 주소가 보낸 것만 승인으로 본다 |
| R8 | 비승인 발행 | `Mint`가 승인된 발행 요청 기록과 맞지 않음 | 알림만 | 최고 등급 알림 |
| R9 | 외부 위험 목록 | 제재 목록, 파트너 공유 목록의 주소와 일치 | 80 | 목록은 파일로 주입 |
| R10 | 동결 주소 관련 시도 | 동결 주소가 관여한 실패·pending 트랜잭션, 동결 전 받아 둔 allowance 사용 시도 | 30 | 연관 주소 확산 추적용 |

### 7.3 점수와 결정

- 주소별 점수는 윈도우(기본 30분) 안의 룰 점수 합이다.
- 80점 이상이고 자동 동결 대상이면 Responder에 자동 동결을 요청한다.
- 50점 이상 80점 미만은 사람에게 알리고 원클릭 동결 승인을 기다린다.
- 50점 미만은 기록만 한다.
- **예외: `hot` 주소는 점수가 아니라 룰로 결정한다.** R1 또는 R6이 발동하면 점수와 무관하게 자동 동결을 요청한다(8.1). 다른 룰만으로는 점수가 80을 넘어도 사람에게 넘긴다. 자기 핫월렛을 잘못 묶으면 서비스가 멈추므로, 탈취의 직접 신호 두 가지에만 반응한다.
- 점수가 올라도 보호 주소와 화이트 라벨(거래소, 브리지 컨트랙트 등)은 자동 동결하지 않고 사람에게 넘긴다.
- 결정마다 근거(어떤 룰, 어떤 트랜잭션, 점수)를 Case Store에 남긴다.

### 7.4 신뢰성 요건

- **처리 지연**: 블록 도착부터 결정까지 1초 이내를 목표로 한다.
- **누락 방지**: 마지막 처리 블록을 DB에 기록한다. 재시작하면 그 블록부터 다시 처리한다. 같은 이벤트를 두 번 처리해도 결과가 같아야 한다(멱등).
- **재조직(reorg) 대응**: 자동 동결은 블록 포함 즉시 실행한다. 동결은 되돌릴 수 있으므로 확정을 기다리지 않는다. 재조직으로 근거 트랜잭션이 사라지면 사건을 자동으로 재검토 대상으로 표시한다.
- **자기 감시**: Ingestor가 최신 블록보다 N블록 이상 뒤처지거나 WebSocket이 끊기면 최고 등급 알림을 보낸다. 탐지 시스템이 멈춘 상태는 공격만큼 위험하다.
- **설정 핫리로드**: `rules.yaml`, `addresses.yaml` 변경을 감지해 다시 읽는다. 읽기에 실패하면 이전 설정을 유지하고 알림을 보낸다. 모든 설정 변경은 Git 커밋으로만 한다.

## 8. 자동 대응 (Responder)

Responder는 동결 트랜잭션 하나만 서명하고 보낸다. 해제, 정지, 소각, 발행 트랜잭션은 만들지 않으며, 그런 calldata를 서명하려는 요청은 코드 레벨에서 거부한다.

### 8.1 동결 대상 정책

| 주소 분류 (`addresses.yaml`) | 봇의 자동 동결 | 설명 |
| --- | --- | --- |
| `protected` (금고, minter, 멀티시그, 타임락, 토큰 컨트랙트) | 불가 | 컨트랙트에서도 막힘. 사람 판단으로 GUARDIAN이 실행 |
| `hot` (자사 핫월렛) | R1 또는 R6 발생 시 가능 (점수 무관). 그 외 룰은 점수가 높아도 사람 확인 | 탈취된 자기 핫월렛을 먼저 묶어 추가 유출을 멈춘다 |
| `whitelabel` (거래소 입금 주소, 브리지, DEX 풀) | 불가, 사람에게 알림 | 무고한 다수 사용자에게 피해가 가는 주소 |
| 그 외 | 점수 80 이상이면 가능 | 공격자 수신 주소 등 |

### 8.2 실행 흐름

1. Decision에서 동결 요청을 받는다. 요청에는 대상 주소들, 사건 번호, 근거가 들어 있다.
2. 대상별로 온체인 상태를 다시 읽는다. 이미 동결이면 건너뛴다(멱등).
3. 대상이 여러 개면 `freezeBatch`로 묶는다. 한 트랜잭션 최대 50개.
4. KMS로 서명한다. calldata의 함수 선택자가 `freeze` 또는 `freezeBatch`가 아니면 서명하지 않는다.
5. 제출 경로를 고른다. 제출 경로는 설정값이며 `private_first`, `public_only`, `both` 중 하나다. Sepolia의 프라이빗 RPC(Flashbots Protect 등)는 참여 빌더가 적어 포함이 공개 경로보다 늦을 수 있으므로, 6단계 실습에서 두 경로의 포함 지연을 측정해 기록한 뒤 기본값을 정한다. 측정 전 기본값은 `both`(프라이빗과 공개에 동시에 제출)다. 자체 체인은 3장 답변에 따른다.
6. 높은 priority fee를 준다(10장). 1블록 안에 포함되지 않으면 같은 nonce로 수수료를 올려 다시 보낸다(최대 3회).
7. 포함되면 `Frozen` 이벤트로 결과를 확인하고 사건에 기록한 뒤 알림을 보낸다.

### 8.3 안전장치

- **단일 작성자 nonce 관리**: Responder 인스턴스는 하나만 서명한다. 여러 개를 띄울 때는 리더 선출(Redis 락)로 한 곳만 보내게 한다.
- **자동 동결 속도 제한**: 시간당 자동 동결 수가 상한(기본 20개 주소)을 넘으면 자동 동결을 멈추고 사람 승인 모드로 바꾼다. 오탐 폭주나 봇 오작동을 막는다.
- **킬 스위치**: 환경 변수나 설정 하나로 자동 동결을 끄고 알림만 하는 모드로 즉시 전환한다.
- **섀도 모드**: 처음 배포하면 자동 동결을 끈 상태로 운영하며, "동결했을 것"이라는 기록만 남긴다. 오탐률을 확인한 뒤 사용자가 켠다.
- **오탐 처리**: 잘못 동결되면 운영 Safe가 `unfreeze`한다. 사건에 오탐으로 기록하고, 그 근거가 된 룰의 임계값을 조정한다. 해제 목표 시간은 1시간 이내.
- **봇 가스 감시**: 봇 주소의 가스 잔고가 동결 10건 분량 아래로 떨어지면 알림을 보낸다.

## 9. 회수 런북

회수는 사건 번호(`caseId`) 하나로 처음부터 끝까지 추적한다. 소각과 재발행은 서로 다른 Safe가 실행하고, 둘 다 같은 `caseId`를 온체인 이벤트에 남긴다. Claude Code는 이 절차를 실행하는 스크립트와 Safe 트랜잭션 생성 도구를 만들되, 서명과 제출은 사람이 한다.

1. **동결**: 봇 또는 운영 Safe가 `freeze`를 실행한다. 사건이 열리고 `caseId = keccak256(사건 문자열)`이 정해진다.
2. **확산 추적**: 동결 주소에서 이미 빠져나간 자금과 R10 신호를 따라 연관 주소를 추가 동결한다.
3. **조사와 판정**: 탈취가 맞는지, 피해자가 누구인지, 회수 금액이 얼마인지 사람이 판정한다. 오탐이면 `unfreeze`하고 사건을 닫는다.
4. **대기**: 동결 후 `minFreezeAge`(10장)가 지날 때까지 기다린다. 컨트랙트가 강제한다.
5. **소각**: 회수 Safe가 `wipeFrozen(account, caseId)`를 실행한다. 소각 금액을 사건에 기록한다.
6. **준비금 회계**: 소각된 금액만큼 준비금이 풀렸음을 회계 기록에 남긴다. 테스트 발행 단계에서는 오프체인 장부 기록만 한다.
7. **재발행**: 금고 Safe가 필요하면 minter 한도를 늘리고, minter가 `mintForRecovery(victim, amount, caseId)`를 실행한다. 같은 `caseId`의 재발행 합계가 소각 합계를 넘으면 컨트랙트가 거부한다(5.4). ops-cli는 제출 전에 `wipedByCase`와 `reissuedByCase`를 읽어 남은 재발행 가능액을 보여 준다.
8. **종결**: `FrozenFundsWiped`와 `RecoveryReissued`의 `caseId`, 금액이 맞는지 대조하고 사건을 닫는다. 동결 해제 여부는 별도로 판단한다.

## 10. 파라미터 기본값

테스트넷 값은 실습 중 빠르게 확인하기 위한 값이고, 운영 권장 값은 정식 발행 시 출발점이다. 토큰 수량은 모두 토큰 단위(소수점 6자리 적용 전)다. 운영 값은 실제 거래 패턴을 섀도 모드로 2주 이상 관찰한 뒤 조정한다.

| 구분 | 파라미터 | 테스트넷 | 운영 권장 |
| --- | --- | --- | --- |
| 컨트랙트 | 타임락 지연 | 10분 | 48시간 |
| 컨트랙트 | `minFreezeAge` (동결 후 소각 대기) | 10분 | 72시간 |
| 컨트랙트 | `freezeBatch` 최대 길이 | 50 | 50 |
| 컨트랙트 | minter 누적 한도 (`configureMinter`로 재설정할 때까지 차감) | 1,000,000 | 일일 예상 발행량의 1.5배 |
| 탐지 | 점수 윈도우 | 30분 | 30분 |
| 탐지 | 자동 동결 / 사람 확인 점수 | 80 / 50 | 80 / 50 |
| 탐지 | R1 유출 기준 | 10분에 잔고 30% 또는 100,000 | 10분에 잔고 20% |
| 탐지 | R2 대량 유입 기준 | 50,000 | 별도 산정 (일일 중위 거래액의 100배 등) |
| 탐지 | R2 신규 주소 nonce 상한 | 5 | 5 |
| 탐지 | 원클릭 승인 링크 만료 | 1시간 | 1시간 |
| 대응 | 제출 경로 | `both` (측정 후 조정) | 측정 결과로 결정 |
| 탐지 | R3 분산 송금 | 10분에 신규 주소 10개 | 10분에 신규 주소 10개 |
| 탐지 | R4 집중 유입 | 30분에 감시 지갑 2개 | 30분에 감시 지갑 2개 |
| 탐지 | Ingestor 지연 경보 | 5블록 | 3블록 |
| 대응 | 시간당 자동 동결 상한 | 20개 주소 | 20개 주소 |
| 대응 | 재전송 간격 / 최대 횟수 | 1블록 / 3회 | 1블록 / 3회 |
| 대응 | priority fee | 네트워크 중위값의 3배 | 네트워크 중위값의 3배, 상한 설정 |
| 대응 | 봇 가스 잔고 경보 | 동결 10건 분량 | 동결 10건 분량 |
| 대응 | 오탐 해제 목표 | 1시간 | 1시간 |

## 11. 저장소 구조와 기술 스택

하나의 모노레포에 컨트랙트와 오프체인 서비스를 둔다. 컨트랙트 ABI는 빌드 산출물에서 자동 생성해 오프체인 쪽이 가져다 쓴다.

```
/
├─ CLAUDE.md                 # 이 문서 요약 + 작업 규칙(0장)
├─ docs/
│  ├─ design.md              # 이 설계문서
│  ├─ decisions.md           # 3장 질문에 대한 답과 변경 결정 기록
│  └─ runbooks/              # 회수, 오탐 해제, 봇 키 교체 절차
├─ contracts/                # Foundry 프로젝트
│  ├─ src/StableToken.sol
│  ├─ script/                # 배포, 권한 이전, 검증 스크립트 (체인별 설정 분리)
│  └─ test/                  # unit, fuzz, invariant, fork
├─ offchain/                 # pnpm 워크스페이스
│  ├─ packages/abi/          # 컨트랙트 ABI와 타입 (자동 생성)
│  ├─ packages/detector/     # Ingestor, Enricher, Rule Engine, Decision
│  ├─ packages/responder/    # 동결 서명과 제출
│  ├─ packages/ops-cli/      # 회수 런북용 Safe 트랜잭션 생성 도구
│  └─ packages/notifier/
├─ config/
│  ├─ rules.yaml             # 룰, 점수, 임계값
│  ├─ addresses.sepolia.yaml # 감시·보호·화이트 라벨 주소
│  └─ addresses.<chain>.yaml
└─ infra/docker-compose.yml  # PostgreSQL, Redis, 로컬 Anvil
```

| 영역 | 선택 | 이유 |
| --- | --- | --- |
| 컨트랙트 빌드·테스트 | Foundry | 퍼즈·불변식 테스트 내장, 체인별 profile로 컴파일러 설정 분리 가능 |
| 컨트랙트 라이브러리 | OpenZeppelin Contracts Upgradeable **v5.4.0 고정** (0단계에서 확정, `docs/decisions.md` 1절) | 감사된 ERC-20, AccessControl, Pausable, 프록시. v5.5.0부터는 Cancun 전용 `mcopy`가 섞여 paris 빌드가 안 된다 |
| 업그레이드 검증 | openzeppelin-foundry-upgrades | 저장소 레이아웃 호환성 자동 검사 |
| 멀티시그 | Safe | 표준. 자체 체인 배포 여부는 3장에서 확인 |
| 오프체인 언어 | TypeScript, Node 20 이상 | viem의 타입 안전한 컨트랙트 호출 |
| 체인 클라이언트 | viem | WebSocket 구독, 타입 생성 |
| 저장소 | PostgreSQL 16, Redis 7 | 사건 기록은 영속, 윈도우 집계는 메모리 |
| 서명 | AWS KMS 등 (3장 확인), Sepolia는 암호화 키스토어 | 키를 내보낼 수 없는 서명 |

## 12. 테스트와 검증

완료 기준은 테스트 통과다. 컨트랙트는 라인 커버리지 95% 이상, 5.5의 불변식 7개는 모두 Foundry invariant 테스트로 강제한다.

**컨트랙트**

- 단위 테스트: 5.3의 모든 함수에 대해 권한이 있을 때 성공, 없을 때 실패, 경계값을 검사한다.
- 동결 검사 매트릭스: `transfer`, `transferFrom`, `approve`, `permit`, `mint`, `burn`에 대해 spender, from, to를 하나씩 동결한 모든 조합이 실패하는지 확인한다.
- 퍼즈 테스트: 임의 금액과 주소로 `mint` 한도, `wipeFrozen` 대기 시간, `freezeBatch` 길이, 그리고 임의의 `caseId`와 금액 조합에서 `mintForRecovery`가 소각 합계를 넘는 순간 실패하는지 검사한다.
- 일시정지 매트릭스: 일시정지 상태에서 `freeze`, `unfreeze`, `wipeFrozen`, 역할 변경은 성공하고 `transfer`, `transferFrom`, `mint`, `mintForRecovery`, `burn`은 실패하는지 확인한다.
- 업그레이드 테스트: V1 배포 → 상태 생성 → 가상의 V2로 업그레이드 → 잔고, 동결 상태, 역할이 그대로인지 확인한다. 저장소 레이아웃 검사를 CI에 넣는다.
- 배포 스크립트 테스트: 로컬 Anvil에서 배포 후, 배포자 EOA에 남은 권한이 없고 6장의 표와 실제 역할이 일치하는지 온체인으로 검증한다. 타임락의 admin 역할 보유자가 없고, ProxyAdmin 소유자가 타임락이며, MINTER 역할의 admin이 MASTER_MINTER인지도 포함한다.

**오프체인**

- 룰 단위 테스트: 각 룰에 대해 발동해야 하는 이벤트 열과 발동하면 안 되는 이벤트 열을 고정 데이터로 둔다.
- Decision 테스트: 주소 분류(보호, 핫, 화이트 라벨, 일반)와 점수의 모든 조합에서 결정이 8.1 표와 같은지 확인한다. `hot` 주소는 R1·R6 발동 시 점수와 무관하게 자동 동결이고, 다른 룰만으로 80을 넘으면 사람 확인인지 별도 케이스로 둔다.
- R1b 전파 테스트: 핫월렛 하나에서 신규 주소 하나로 대량 유출했을 때 수신 주소 점수가 R1b와 R2의 합으로 80 이상이 되는지, 수신자가 화이트 라벨이면 전파되지 않는지 확인한다.
- 승인 링크 테스트: 만료된 토큰, 이미 쓴 토큰, 서명이 깨진 토큰, 다른 사건의 토큰은 모두 거부되는지 확인한다.
- Responder 테스트: `freeze`/`freezeBatch` 외 calldata는 서명이 거부되는지, 같은 요청을 두 번 받아도 트랜잭션이 하나만 나가는지 확인한다.
- 장애 테스트: WebSocket 끊김, RPC 오류, DB 재시작 뒤에도 누락과 중복 없이 이어지는지 확인한다.

**종단 간 시나리오 (로컬 Anvil, 이후 Sepolia)**

1. 대형 탈취 재현: 핫월렛 3개에서 몇 블록 안에 공격자 주소로 대량 유출 → R1·R1b·R4 발동 → 핫월렛과 공격자 주소 자동 동결. 동결 전 유출량과 동결까지 걸린 블록 수를 기록한다.
1b. 단일 핫월렛 탈취: 핫월렛 1개에서 신규 주소 1개로 대량 유출 → R1(핫월렛)과 R1b·R2(수신 주소) 발동 → 둘 다 자동 동결.
2. 세탁 시도: 공격자가 신규 주소 20개로 분산 송금 → R3 발동 → 연관 주소 동결.
3. 출구 경쟁: 공격자가 DEX 스왑을 pending에 올림 → R5 발동 → 동결이 스왑보다 먼저 포함되는지 확인 (pending 구독 지원 시). Sepolia에서는 `private_first`, `public_only`, `both` 세 경로로 각각 실행해 포함 지연을 기록하고, 그 결과로 기본 제출 경로를 정한다.
4. 오탐: 거래소 입금 주소로 대량 송금 → 자동 동결되지 않고 사람 확인 알림만 나가는지 확인.
5. 봇 키 탈취: 봇 키로 무차별 동결 → 속도 제한 발동, 운영 Safe가 FREEZER 회수 후 해제.
6. 회수 완결: 9장 런북 전체를 실행해 `caseId`별 소각액과 재발행액이 일치하는지 확인.
7. 관리 이벤트: 승인 목록에 없는 `RoleGranted` 발생 → 최고 등급 알림.

## 13. 개발 단계와 완료 기준

각 단계가 끝나면 Claude Code는 완료 기준 충족 여부를 보고하고, 사용자 확인 뒤 다음 단계로 간다.

| 단계 | 산출물 | 완료 기준 |
| --- | --- | --- |
| 0. 준비 | `git init`과 `.gitignore`, 이 문서를 `docs/design.md`로 이동, `CLAUDE.md`, 3장 질문 답변, `docs/decisions.md`(15장의 잔여 위험 포함), 체인별 `foundry.toml` profile | 컴파일러·EVM 버전을 사용자가 확인함. 모든 profile에 `solc_version`·`evm_version`이 명시됨. 빈 컨트랙트가 두 체인 설정 모두에서 컴파일되고 `openzeppelin-foundry-upgrades` 검사가 동작함 |
| 1. 컨트랙트 | `StableToken`, 단위·퍼즈·불변식 테스트 | 12장 컨트랙트 테스트 전부 통과, 커버리지 95% 이상 |
| 2. 배포 스크립트 | 프록시·타임락·역할 배포와 권한 이전, 검증 스크립트 | 로컬 Anvil에서 배포 후 권한 검증 통과. Sepolia 배포는 사용자 지시로 실행 |
| 3. 탐지 | Ingestor, Enricher, Rule Engine, Decision, Case Store | 룰·Decision 테스트 통과. 로컬에서 시나리오 1·2·4의 탐지까지 확인 |
| 4. 대응 | Responder, Notifier, 킬 스위치, 섀도 모드 | Responder 테스트 통과. 로컬에서 시나리오 1\~7 전부 통과 |
| 5. 운영 도구 | ops-cli (회수 런북, 오탐 해제, 봇 키 교체), 런북 문서 | 시나리오 6을 ops-cli로 끝까지 실행 |
| 6. Sepolia 실습 | Sepolia 배포, 섀도 모드 운영, 제출 경로별 포함 지연 측정 | 섀도 모드로 실제 트래픽 관찰, 제출 경로 기본값을 측정 결과로 확정, 사용자가 자동 동결을 켬 |
| 7. 자체 체인 | 자체 체인 배포와 설정 | 3장 체인 항목 반영, 시나리오 1\~7을 자체 체인에서 재실행 |

## 14. 범위 외

- 실제 은행 준비금 연동과 법정화폐 입출금 처리.
- 크로스체인 브리지와 체인 간 블랙리스트 동기화.
- 컨트랙트 레벨 전송 한도, 서킷 브레이커 (사용자 결정으로 제외).
- 강제이전 기능 (사용자 결정으로 제외).
- 외부 감사(audit). 정식 발행 전에 반드시 별도로 받는다.

## 15. 알려진 한계와 잔여 위험

설계로 해결하지 않고 받아들이기로 한 위험이다. 0단계에서 `docs/decisions.md`에 그대로 옮겨 적고, 정식 발행 전 재검토 항목으로 둔다.

1. **한 트랜잭션 안에서 끝나는 공격은 막지 못한다.** 공격자가 수신과 DEX 스왑(또는 브리지 입금)을 하나의 트랜잭션으로 원자적으로 실행하면, 오프체인 탐지는 블록에 포함된 뒤에야 보게 되므로 동결이 개입할 틈이 없다. 컨트랙트에 전송 한도나 서킷 브레이커를 두지 않기로 한 결정(2장)의 직접적인 비용이다. 탐지 시스템이 잡는 것은 여러 블록에 걸친 패턴뿐이다.
2. **운영 Safe 탈취 시 FREEZER 외 역할 회수에 타임락 지연이 걸린다.** 그 사이 공격자는 `unfreeze`와 `pause`를 할 수 있다. 서명자 분리와 정족수로 막는다(6장).
3. **minter 키 탈취 시 한도까지 발행된다.** R8은 알림만 하고, 회수는 금고 Safe의 `removeMinter`로 사람이 한다. 피해 상한은 `minterAllowance`이므로 한도를 일일 필요량에 가깝게 유지한다(10장).
4. **pending 트랜잭션 가시성은 RPC 제공자에 달려 있다.** 공개 RPC는 멤풀 일부만 보여 주고, 해시만 주는 경우 본문 조회에 요율 제한이 걸린다. R5와 시나리오 3의 효과는 이 가시성에 비례한다.
5. **자체 체인의 프라이빗 제출 경로가 없으면 동결 트랜잭션이 멤풀에 노출된다.** 공격자가 이를 보고 더 높은 수수료로 앞지를 수 있다. 3장 답변에 따라 대응한다.
