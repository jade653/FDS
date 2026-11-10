# 스테이블코인 동결·회수 및 이상거래 탐지 시스템

설계문서는 `docs/design.md`가 단일 기준이다. 이 파일은 그 요약과 작업 규칙만 담는다. 두 문서가 다르면 `docs/design.md`가 우선한다. 결정 기록은 `docs/decisions.md`에 쌓는다.

## 무엇을 만드는가

- 법정화폐 담보 스테이블코인 `StableToken` (ERC-20, 소수점 6, Transparent Proxy + 타임락, OpenZeppelin Upgradeable v5).
- 동결(freeze) → 소각(wipeFrozen) → 피해자 재발행(mintForRecovery) 회수 경로. 강제이전은 없다.
- 오프체인 탐지(Ingestor → Enricher → Rule Engine → Decision → Case Store)와 자동 동결 Responder, Notifier.
- 배포: Sepolia 실습 → 자체 EVM 체인 테스트 발행.

## 작업 규칙 (design.md 0장과 동일)

1. **3장의 질문을 먼저 해결한다.** 컴파일러 버전과 EVM 버전은 절대 추측하지 않는다. `foundry.toml`을 만들기 전에 사용자에게 묻는다.
2. **권한을 늘리는 변경은 금지한다.** 6장 권한 표에 없는 역할을 추가하거나 봇 키에 동결 외 권한을 주는 코드는 쓰지 않는다. 필요하면 제안만 한다.
3. **비밀값은 저장소에 넣지 않는다.** 개인키, 니모닉, RPC 키는 `.env`(gitignore)나 KMS에서만 읽는다. 테스트 키는 Anvil 기본 키만 쓴다.
4. **임계값과 주소는 코드에 박지 않는다.** `config/rules.yaml`, `config/addresses.<chain>.yaml`에서 읽고 재시작 없이 다시 읽을 수 있어야 한다.
5. **단계마다 멈춘다.** 13장의 각 단계가 끝나면 완료 기준 충족 여부를 보고하고 확인받은 뒤 다음 단계로 간다.
6. **테스트 없이 완료라고 하지 않는다.** 컨트랙트 변경에는 단위 테스트와 해당 불변식 테스트가 함께 있어야 한다.
7. **배포는 사람이 한다.** `--broadcast`는 사용자의 명시적 지시가 있을 때만 실행한다.

## 꼭 지킬 설계 포인트

- 동결 검사는 `_update`(from, to), `transferFrom`(spender), 4인자 `_approve`(owner, spender) 세 곳. 일시정지 중에도 `freeze`, `unfreeze`, `wipeFrozen`, 역할 변경은 동작한다.
- `wipeFrozen`만 `ERC20Upgradeable._update`를 직접 호출해 동결·일시정지를 우회한다. 다른 어떤 함수도 이 경로를 쓰지 않는다.
- 사건별 회계는 온체인: `reissuedByCase[caseId] <= wipedByCase[caseId]`.
- 봇 키는 FREEZER만 갖는다. FREEZER의 admin은 GUARDIAN(운영 Safe). MINTER의 admin은 MASTER_MINTER.
- 타임락 생성자 admin은 `address(0)`. 배포자 EOA는 배포 후 어떤 역할도 갖지 않으며 스크립트가 온체인에서 검증한다.
- `hot` 주소 자동 동결은 점수가 아니라 R1·R6 발동 기준. `protected`와 `whitelabel`은 봇이 동결하지 않는다.
- Responder는 `freeze`/`freezeBatch` 선택자 외에는 서명하지 않는다.

## 저장소 구조

```
docs/design.md        설계문서 (단일 기준)
docs/decisions.md     3장 질문의 답, 변경 결정, 잔여 위험
docs/runbooks/        회수, 오탐 해제, 봇 키 교체 절차
contracts/            Foundry 프로젝트 (src, script, test)
offchain/             pnpm 워크스페이스 (abi, detector, responder, ops-cli, notifier)
config/               rules.yaml, addresses.<chain>.yaml
infra/                docker-compose (PostgreSQL, Redis, Anvil)
```

## 툴체인 (docs/decisions.md 1절)

- **Foundry는 WSL Ubuntu에서 실행한다.** Windows Smart App Control이 `forge.exe`를 차단한다. 보안 설정을 바꾸지 않는다.
  ```
  wsl -d Ubuntu -- bash -lc 'export PATH=$HOME/.foundry/bin:$PATH; cd /mnt/c/Users/mustree/projects/stablecoin/contracts && forge build'
  ```
- solc 0.8.28, `evm_version = paris` 고정. OpenZeppelin v5.4.0 고정(v5.5.0+는 paris 빌드 불가). 버전을 올리면 `node script/check-push0.mjs`를 다시 돌린다.
- 오프체인(pnpm, Node)은 Windows에서 실행한다. `offchain/`에서 `pnpm typecheck`, `pnpm test`(단위), `pnpm test:e2e`(로컬 Anvil 시나리오 1~7. WSL Anvil을 띄우고 Deploy.s.sol로 배포한다).
- Sepolia Safe 생성: `script/CreateSafes.s.sol` (입력 `config/safes.sepolia.toml`, 출력 `deployments/safes-sepolia.json`). 테스트 `test/CreateSafes.t.sol`은 Sepolia 포크가 필요해 `SEPOLIA_RPC_URL`이 없으면 건너뛴다.
- 로컬 배포·권한 검증: (WSL) `contracts/script/anvil-deploy.sh`. 로컬 Anvil 전용이며 chainId가 31337이 아니면 거부한다.
- 컨트랙트 ABI를 바꾸면 (WSL) `forge build` → (Windows) `pnpm gen:abi`.
- 소스를 바꾼 뒤 테스트는 `forge clean && forge test`로 돌린다. openzeppelin-foundry-upgrades가 중복 build-info를 거부한다. `forge coverage`에서는 `Upgrade.t.sol`만 실패하는데 플러그인 아티팩트가 없어서이며 정상이다(`docs/decisions.md` 1절).

## 현재 단계

2~5단계 구현 완료. 6단계(Sepolia): Safe·토큰 배포, 시연 시나리오 1b·2·4 성공, 사용자가 자동 동결 전환(`docs/decisions.md` 4절 2026-11-09). 보류: 시나리오 3과 제출 경로 측정, 실트래픽 섀도 관찰. 7단계(자체 체인)는 `docs/decisions.md` 2절 답이 필요하다. 확인이 필요한 해석은 `docs/decisions.md` 4.1절에 있다.

Sepolia 시연: `packages/ops-cli/src/demo-main.ts` (`init`, `status`, `mint-plan`, `fund`, `run --scenario 1b|2|4`, `--round 0..2`). 시연 지갑은 `.env`의 `DEMO_MNEMONIC`에서 파생하고, 같은 코드를 `packages/e2e/test/demo.test.ts`가 Anvil에서 검증한다. 감시탑은 `WATCH_FROM=latest`로 띄운다.

Windows에서 `pnpm.exe`가 Smart App Control에 막히면 `node node_modules/vitest/vitest.mjs run --project unit|e2e`, `node node_modules/tsx/dist/cli.mjs packages/ops-cli/src/main.ts ...`로 실행한다.
