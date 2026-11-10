# 봇 키 교체·회수 런북 (design.md 6장, 12장 시나리오 5)

봇 키는 FREEZER만 갖는다. 탈취돼도 최대 피해는 잘못된 동결이며 자금은 움직이지 않는다. FREEZER의 admin은 GUARDIAN(운영 Safe)이므로 **타임락 없이** 즉시 회수할 수 있다.

## 탈취·오작동 의심 (긴급)

신호: `bot.freeze_rate` 최고 등급 알림(봇 동결이 시간당 상한 초과), 알 수 없는 `Frozen` 이벤트, 봇 주소에서 나가는 예상 밖 트랜잭션.

1. 감시탑을 멈추거나 킬 스위치를 켠다(`responder.kill_switch: true` 또는 `RESPONDER_MODE=off`).
2. FREEZER 회수 (운영 Safe):
   ```bash
   pnpm ops bot-revoke --chain sepolia --bot <봇 주소> --out revoke.json
   ```
   운영 Safe 앱에서 서명·실행한다. R7은 운영 Safe가 보낸 `RoleRevoked`를 승인된 변경으로 본다.
3. 봇이 잘못 동결한 주소를 찾아 해제한다: [오탐 해제](false-positive.md).
4. 봇 주소에 남은 가스 ETH를 회수할 수 있으면 회수한다(KMS 키면 KMS에서 키를 비활성화).

## 정기 교체

1. 새 키를 KMS(또는 Sepolia는 암호화 키스토어)에서 만든다. 키는 내보낼 수 없어야 한다.
2. 새 주소에 가스 ETH를 최소한(동결 50건 분량)만 넣는다.
3. 교체 배치 (운영 Safe): 새 키에 FREEZER 부여 → 옛 키 회수. 새 키에는 FREEZER 외 아무 권한도 주지 않는다.
   ```bash
   pnpm ops bot-rotate --chain sepolia --old <옛 봇> --new <새 봇> --out rotate.json
   ```
4. 감시탑 설정을 새 키로 바꾼다(`BOT_KEYSTORE_PATH` 또는 `BOT_KMS_KEY_ID`). 감시탑은 서명자 주소가 설정의 봇 주소와 다르면 시작하지 않는다. `config/addresses.<chain>.yaml`에 `bot: "<새 봇>"`을 넣고, `config/deploy.<chain>.toml`의 `bot`도 고쳐 커밋한다(`VerifyDeployment.s.sol`이 이 값으로 검증한다). `deployments/<chain>.json`은 배포 당시 기록이므로 고치지 않는다.
5. 검증:
   ```bash
   pnpm ops verify-roles --chain sepolia --bot <새 봇>
   ```
   FREEZER 보유자가 운영 Safe와 새 봇뿐인지 확인한다.
