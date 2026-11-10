# 오탐 해제 런북 (design.md 8.3)

목표: 잘못 동결된 주소를 **1시간 안에** 해제한다. 해제는 운영 Safe(UNFREEZER)만 할 수 있다. 봇은 해제 트랜잭션을 만들지 않는다.

## 1. 확인

- 알림의 사건 번호와 근거(룰, 트랜잭션, 점수)를 본다. Case Store의 `actions`에 자동 동결 요청과 근거가 남아 있다.
- 거래소·브리지 등 화이트 라벨 주소였다면 `config/addresses.<chain>.yaml`의 `whitelabel`에 빠져 있었던 것이다.

## 2. 해제 (운영 Safe)

```bash
pnpm ops unfreeze --chain sepolia --account <주소> [--account ...] --why "오탐: <사유>" --out unfreeze.json
```

운영 Safe 앱 → Transaction Builder → `unfreeze.json` → 정족수 서명 → 실행. R7은 운영 Safe가 보낸 `Unfrozen`을 승인된 변경으로 본다.

## 3. 기록과 재발 방지

- 사건을 오탐(`false_positive`)으로 닫는다.
- 근거가 된 룰의 임계값을 `config/rules.yaml`에서 조정하거나 주소를 `addresses.<chain>.yaml`에 분류한다. **Git 커밋으로만** 바꾼다. 감시탑은 재시작 없이 다시 읽고, 읽기에 실패하면 이전 설정을 유지하며 알림을 보낸다.

## 오탐이 폭주할 때

- 시간당 자동 동결이 상한(20개)을 넘으면 Responder가 스스로 사람 승인 모드로 바뀐다(`responder.rate_limited` 알림).
- 즉시 멈추려면 킬 스위치: `config/rules.yaml`의 `responder.kill_switch: true`를 커밋하거나 `RESPONDER_MODE=off`로 재시작한다. 이 상태에서는 아무것도 서명하지 않고 알림만 보낸다.
- 원인을 고친 뒤 사람 승인 모드를 풀고 다시 자동으로 돌린다.
