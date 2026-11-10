// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {StableToken} from "../src/StableToken.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {DeployConfig, Deployment, DeployConfigLib} from "./lib/DeployConfig.sol";
import {DeploymentChecks} from "./lib/DeploymentChecks.sol";

/// @notice 프록시·타임락·역할 배포와 권한 이전 (design.md 13장 2단계).
///
///         순서:
///         1. TimelockController(delay, [거버넌스 Safe], [address(0)], admin = address(0))
///         2. StableToken 구현체, TransparentUpgradeableProxy(initialOwner = 타임락 → ProxyAdmin 소유자)
///            초기 DEFAULT_ADMIN은 배포자. 역할을 나눈 뒤 바로 포기한다.
///         3. 역할 부여: 운영 Safe(GUARDIAN·FREEZER·UNFREEZER·PAUSER·RESCUER), 회수 Safe(WIPER),
///            금고 Safe(MASTER_MINTER), 봇(FREEZER). FREEZER의 admin은 GUARDIAN이고 MINTER의 admin은
///            MASTER_MINTER이므로, 배포자가 두 역할을 잠시 받아 부여한 뒤 같은 실행 안에서 포기한다.
///         4. 보호 주소 지정, minter 한도 설정
///         5. DEFAULT_ADMIN을 타임락에 넘기고 배포자는 포기
///         6. DeploymentChecks로 온체인 검증. 하나라도 틀리면 revert (브로드캐스트 전 시뮬레이션에서 멈춘다)
///
///         사용 (로컬 Anvil):
///           DEPLOY_CHAIN=anvil forge script script/Deploy.s.sol --rpc-url anvil \
///             --private-key <anvil key 0> --broadcast
///         실제 체인의 --broadcast는 사람이 한다 (design.md 0장 7항). 키는 --account(키스토어)나 --ledger로 넘긴다.
contract Deploy is Script {
    function run() external returns (Deployment memory d) {
        string memory chain = vm.envOr("DEPLOY_CHAIN", string("anvil"));
        string memory configPath = string.concat(vm.projectRoot(), "/../config/deploy.", chain, ".toml");
        DeployConfig memory c = DeployConfigLib.load(configPath);
        uint256 startBlock = block.number;

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        d = deploy(c, deployer);
        vm.stopBroadcast();

        DeploymentChecks.verify(c, d, true);
        _log(c, d);
        // 시뮬레이션에서는 컨트랙트가 아직 없으므로 기록 파일을 쓰지 않는다.
        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            _write(chain, c, d, startBlock);
        } else {
            console2.log("simulation only    : deployments/<chain>.json not written");
        }
    }

    /// @notice 배포 본체. 테스트는 vm.startPrank(deployer, deployer) 아래에서 이 함수를 직접 부른다.
    function deploy(DeployConfig memory c, address deployer) public returns (Deployment memory d) {
        DeployConfigLib.validate(c, deployer);
        d.deployer = deployer;

        // 1. 타임락. admin = address(0)이므로 배포자는 타임락 admin을 가진 적이 없다.
        address[] memory proposers = new address[](1);
        proposers[0] = c.governanceSafe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        TimelockController timelock = new TimelockController(c.timelockDelay, proposers, executors, address(0));
        d.timelock = address(timelock);

        // 2. 구현체와 프록시. ProxyAdmin은 프록시 생성자가 만들고 소유자는 타임락이다.
        StableToken impl = new StableToken();
        d.implementation = address(impl);
        bytes memory init = abi.encodeCall(StableToken.initialize, (c.name, c.symbol, deployer, c.minFreezeAge));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), d.timelock, init);
        d.token = address(proxy);
        d.proxyAdmin = address(uint160(uint256(vm.load(d.token, DeploymentChecks.ADMIN_SLOT))));
        StableToken t = StableToken(d.token);

        // 3. 역할 부여 (design.md 6장)
        t.grantRole(t.GUARDIAN_ROLE(), c.opsSafe);
        t.grantRole(t.UNFREEZER_ROLE(), c.opsSafe);
        t.grantRole(t.PAUSER_ROLE(), c.opsSafe);
        t.grantRole(t.RESCUER_ROLE(), c.opsSafe);
        t.grantRole(t.WIPER_ROLE(), c.recoverySafe);
        t.grantRole(t.MASTER_MINTER_ROLE(), c.treasurySafe);

        // FREEZER의 admin은 GUARDIAN. 배포자가 잠시 GUARDIAN을 받아 봇과 운영 Safe에 FREEZER를 준다.
        t.grantRole(t.GUARDIAN_ROLE(), deployer);
        t.grantRole(t.FREEZER_ROLE(), c.bot);
        t.grantRole(t.FREEZER_ROLE(), c.opsSafe);
        t.renounceRole(t.GUARDIAN_ROLE(), deployer);

        // 4. minter 한도 (MINTER의 admin은 MASTER_MINTER). 한도가 0이면 금고 Safe가 나중에 설정한다.
        if (c.minterAllowance > 0) {
            t.grantRole(t.MASTER_MINTER_ROLE(), deployer);
            t.configureMinter(c.minter, c.minterAllowance);
            t.renounceRole(t.MASTER_MINTER_ROLE(), deployer);
        }

        // 보호 주소: 봇이 동결할 수 없다 (GUARDIAN만 가능).
        address[] memory prot = DeploymentChecks.protectedSet(c, d);
        for (uint256 i = 0; i < prot.length; ++i) {
            t.setProtected(prot[i], true);
        }

        // 5. DEFAULT_ADMIN을 타임락에 넘기고 배포자는 포기한다.
        t.grantRole(t.DEFAULT_ADMIN_ROLE(), d.timelock);
        t.renounceRole(t.DEFAULT_ADMIN_ROLE(), deployer);
    }

    function _log(DeployConfig memory c, Deployment memory d) internal pure {
        console2.log("chainId check      :", c.expectedChainId);
        console2.log("StableToken (proxy):", d.token);
        console2.log("implementation     :", d.implementation);
        console2.log("ProxyAdmin         :", d.proxyAdmin);
        console2.log("TimelockController :", d.timelock);
        console2.log("deployer (no roles):", d.deployer);
        console2.log("verification       : OK");
    }

    function _write(string memory chain, DeployConfig memory c, Deployment memory d, uint256 startBlock) internal {
        string memory k = "deployment";
        vm.serializeString(k, "chain", chain);
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "startBlock", startBlock);
        vm.serializeAddress(k, "token", d.token);
        vm.serializeAddress(k, "implementation", d.implementation);
        vm.serializeAddress(k, "proxyAdmin", d.proxyAdmin);
        vm.serializeAddress(k, "timelock", d.timelock);
        vm.serializeAddress(k, "deployer", d.deployer);
        vm.serializeAddress(k, "governanceSafe", c.governanceSafe);
        vm.serializeAddress(k, "opsSafe", c.opsSafe);
        vm.serializeAddress(k, "recoverySafe", c.recoverySafe);
        vm.serializeAddress(k, "treasurySafe", c.treasurySafe);
        vm.serializeAddress(k, "minter", c.minter);
        vm.serializeAddress(k, "bot", c.bot);
        vm.serializeUint(k, "minFreezeAge", c.minFreezeAge);
        vm.serializeUint(k, "timelockDelay", c.timelockDelay);
        string memory json = vm.serializeAddress(k, "protected", DeploymentChecks.protectedSet(c, d));
        // DEPLOY_OUTPUT_NAME: 같은 설정으로 여러 번 배포할 때(E2E) 결과 파일 이름을 바꾼다.
        string memory name = vm.envOr("DEPLOY_OUTPUT_NAME", chain);
        string memory out = string.concat(vm.projectRoot(), "/../deployments/", name, ".json");
        vm.writeJson(json, out);
        console2.log("written            :", out);
    }
}
