#!/usr/bin/env bash
# 로컬 Anvil에 배포하고 온체인 권한 검증을 돌린다 (design.md 13장 2단계 완료 기준).
# 로컬 전용이다. RPC가 127.0.0.1이 아니면 거부한다. Sepolia·자체 체인 브로드캐스트는 사람이 한다.
#
#   ./script/anvil-deploy.sh            # Anvil이 떠 있지 않으면 띄운다 (끝나도 계속 실행)
#   ANVIL_PORT=8546 ./script/anvil-deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${ANVIL_PORT:-8545}"
RPC="http://127.0.0.1:${PORT}"
# Anvil 기본 계정 0 (니모닉 "test ... junk"). 공개된 테스트 키이며 로컬에서만 쓴다.
ANVIL_KEY0="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "starting anvil on ${PORT}"
  nohup anvil --port "$PORT" --host "${ANVIL_HOST:-127.0.0.1}" >/tmp/anvil-"$PORT".log 2>&1 &
  for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
fi

CHAIN_ID="$(cast chain-id --rpc-url "$RPC")"
if [ "$CHAIN_ID" != "31337" ]; then
  echo "refusing: chain id ${CHAIN_ID} is not local anvil (31337)" >&2
  exit 1
fi

forge clean >/dev/null
DEPLOY_CHAIN=anvil forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$ANVIL_KEY0" --broadcast
DEPLOY_CHAIN=anvil VERIFY_FRESH=true forge script script/VerifyDeployment.s.sol --rpc-url "$RPC"
node script/check-push0.mjs out/StableToken.sol/StableToken.json out/TimelockController.sol/TimelockController.json \
  out/TransparentUpgradeableProxy.sol/TransparentUpgradeableProxy.json out/ProxyAdmin.sol/ProxyAdmin.json
echo "deployments/anvil.json:"
cat ../deployments/anvil.json
