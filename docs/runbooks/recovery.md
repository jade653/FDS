# 회수 런북 (design.md 9장)

사건 번호(`caseId`) 하나로 동결부터 종결까지 추적한다. 소각은 회수 Safe, 재발행은 발행 Safe(minter)가 하고, 둘 다 같은 `caseId`를 온체인 이벤트에 남긴다. ops-cli는 Safe Transaction Builder JSON만 만든다. **서명과 제출은 사람이 Safe 앱에서 한다.**

명령은 `offchain/`에서 실행한다. `--chain`은 `sepolia` 또는 자체 체인 이름이며 RPC는 `.env`의 `<CHAIN>_RPC_URL`에서 읽는다.

## 0. 사건 번호

자동 동결은 Detector가 연 사건의 `caseKey`를 `Frozen` 이벤트의 `reason`에 넣는다. 사람이 연 사건이면 사건 문자열로 만든다.

```bash
pnpm ops case-id "incident-2026-11-06-01"
```

이후 `--case`에는 사건 문자열이나 0x로 시작하는 64자리 해시를 그대로 넘긴다.

## 1. 동결

봇이 자동으로 했거나, 운영 Safe가 `freeze(account, caseKey)`를 실행한다. 보호 주소는 운영 Safe(GUARDIAN + FREEZER)만 동결할 수 있다.

## 2. 확산 추적

- 알림의 "연관 주소"(R3 분산 송금 수신처)와 R10(동결 주소 관련 시도) 신호를 본다.
- 추가로 묶을 주소는 알림의 원클릭 승인 링크로 동결하거나 운영 Safe가 `freezeBatch`를 실행한다.

## 3. 조사와 판정

탈취가 맞는지, 피해자가 누구인지, 회수 금액이 얼마인지 사람이 판정한다. 오탐이면 [오탐 해제](false-positive.md)로 간다.

```bash
pnpm ops case --chain sepolia --case <caseId> --account <동결 주소> [--account ...]
```

## 4. 대기

동결 후 `minFreezeAge`(테스트넷 10분, 운영 72시간)가 지나야 소각할 수 있다. 컨트랙트가 강제하고, ops-cli도 미리 거부한다. `case` 출력의 `wipe available at`을 본다.

## 5. 소각 (회수 Safe)

```bash
pnpm ops wipe --chain sepolia --case <caseId> --account <동결 주소> --out wipe.json
```

- 동결 여부, 대기 시간, 잔고를 확인한 뒤 `wipeFrozen(account, caseId)` 배치를 만든다. 합계는 stderr에 나온다.
- 회수 Safe 앱 → Transaction Builder → `wipe.json` 불러오기 → 정족수 서명 → 실행.
- 소각 후에도 동결은 유지된다.

## 6. 준비금 회계

소각된 금액만큼 준비금이 풀렸음을 장부에 남긴다. 테스트 발행 단계에서는 오프체인 장부(`ledger/<chain>.jsonl`)만 쓴다.

```bash
pnpm ops ledger --chain sepolia --case <caseId> --kind reserve_released --amount 900000 --actor <이름>
```

## 7. 재발행 (발행 Safe, 필요하면 금고 Safe 먼저)

```bash
pnpm ops reissue --chain sepolia --case <caseId> --to <피해자> --amount 900000 --out reissue.json
```

- 남은 재발행 가능액(`wipedByCase - reissuedByCase`)을 넘으면 거부한다. 컨트랙트도 거부한다.
- 피해자 주소가 동결이면 거부한다.
- minter 한도가 모자라면 금고 Safe용 `configureMinter` 배치를 먼저 출력한다(한도는 덮어쓰기). 금고 Safe가 먼저 실행하고, 그다음 발행 Safe가 `mintForRecovery`를 실행한다.
- 금고 Safe와 회수 Safe의 서명자는 겹치지 않아야 한다(운영 권장, design.md 6장).
- 실행 뒤 장부에 `--kind reissued`로 남긴다.

## 8. 종결

```bash
pnpm ops reconcile --chain sepolia --case <caseId>
```

- `FrozenFundsWiped`와 `RecoveryReissued` 이벤트 합계가 온체인 누적값과 같은지(`consistent`), 재발행 합계가 소각 합계와 같은지(`closable`)를 본다.
- 둘 다 true면 사건을 닫는다. 동결 해제 여부는 별도로 판단한다.

## 로컬 연습

로컬 Anvil에서는 Safe가 없으므로 Safe 자리의 Anvil 기본 계정으로 실행할 수 있다. `--execute-local`은 chainId 31337이 아니면 거부한다.

```bash
pnpm ops wipe --case <caseId> --account <주소> --execute-local
```

전체 흐름은 `offchain/packages/e2e/test/scenarios.test.ts`의 시나리오 6이 자동으로 실행한다.
