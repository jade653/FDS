// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {DeployConfig, Deployment, DeployConfigLib} from "./lib/DeployConfig.sol";
import {DeploymentChecks} from "./lib/DeploymentChecks.sol";

/// @notice 이미 배포된 시스템을 `config/deploy.<chain>.toml`과 `deployments/<chain>.json`에 대조한다.
///         브로드캐스트하지 않는다. 언제든 다시 돌려도 된다.
///
///           DEPLOY_CHAIN=anvil forge script script/VerifyDeployment.s.sol --rpc-url anvil
///         봇 키를 교체했다면 config의 bot도 같이 고친다. VERIFY_FRESH=true면 배포 직후 상태까지 본다.
contract VerifyDeployment is Script {
    function run() external view {
        string memory chain = vm.envOr("DEPLOY_CHAIN", string("anvil"));
        DeployConfig memory c =
            DeployConfigLib.load(string.concat(vm.projectRoot(), "/../config/deploy.", chain, ".toml"));
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/../deployments/", chain, ".json"));

        require(vm.parseJsonUint(j, ".chainId") == block.chainid, "deployment file is for another chain");
        Deployment memory d = Deployment({
            token: vm.parseJsonAddress(j, ".token"),
            implementation: vm.parseJsonAddress(j, ".implementation"),
            proxyAdmin: vm.parseJsonAddress(j, ".proxyAdmin"),
            timelock: vm.parseJsonAddress(j, ".timelock"),
            deployer: vm.parseJsonAddress(j, ".deployer")
        });
        // 배포 파일의 보유자가 설정과 같은지도 본다 (설정을 고친 뒤 재배포하지 않은 경우를 잡는다).
        require(vm.parseJsonAddress(j, ".opsSafe") == c.opsSafe, "ops_safe differs from deployment");

        DeploymentChecks.verify(c, d, vm.envOr("VERIFY_FRESH", false));
        console2.log("verification OK:", d.token);
    }
}
