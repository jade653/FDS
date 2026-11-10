// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";

/// @notice 배포 입력값. `config/deploy.<chain>.toml`에서 읽는다 (design.md 6장·10장).
struct DeployConfig {
    uint256 expectedChainId;
    bool requireContractHolders;
    string name;
    string symbol;
    uint64 minFreezeAge;
    uint256 timelockDelay;
    address governanceSafe; // 타임락 proposer·canceller
    address opsSafe; // GUARDIAN, FREEZER, UNFREEZER, PAUSER, RESCUER
    address recoverySafe; // WIPER
    address treasurySafe; // MASTER_MINTER
    address minter; // MINTER
    address bot; // FREEZER만
    uint256 minterAllowance;
    address[] extraProtected;
}

/// @notice 배포 결과. `deployments/<chain>.json`에 기록한다.
struct Deployment {
    address token; // 프록시
    address implementation;
    address proxyAdmin;
    address timelock;
    address deployer;
}

library DeployConfigLib {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    error InvalidConfig(string reason);

    function load(string memory path) internal view returns (DeployConfig memory c) {
        string memory t = vm.readFile(path);
        c.expectedChainId = vm.parseTomlUint(t, ".checks.expected_chain_id");
        c.requireContractHolders = vm.parseTomlBool(t, ".checks.require_contract_holders");
        c.name = vm.parseTomlString(t, ".token.name");
        c.symbol = vm.parseTomlString(t, ".token.symbol");
        c.minFreezeAge = uint64(vm.parseTomlUint(t, ".token.min_freeze_age"));
        c.timelockDelay = vm.parseTomlUint(t, ".timelock.min_delay");
        c.governanceSafe = vm.parseTomlAddress(t, ".holders.governance_safe");
        c.opsSafe = vm.parseTomlAddress(t, ".holders.ops_safe");
        c.recoverySafe = vm.parseTomlAddress(t, ".holders.recovery_safe");
        c.treasurySafe = vm.parseTomlAddress(t, ".holders.treasury_safe");
        c.minter = vm.parseTomlAddress(t, ".holders.minter");
        c.bot = vm.parseTomlAddress(t, ".holders.bot");
        c.minterAllowance = vm.parseTomlUint(t, ".minter.allowance");
        // 빈 배열은 파서에 따라 타입을 추론하지 못하므로 문자열 배열로 읽어 변환한다.
        string[] memory extra = vm.parseTomlStringArray(t, ".protected.extra");
        c.extraProtected = new address[](extra.length);
        for (uint256 i = 0; i < extra.length; ++i) {
            c.extraProtected[i] = vm.parseAddress(extra[i]);
        }
    }

    /// @notice 배포 전에 입력값을 검사한다. 0 주소, 겹치는 보유자, 배포자가 보유자인 경우를 거부한다.
    function validate(DeployConfig memory c, address deployer) internal view {
        if (c.expectedChainId == 0) revert InvalidConfig("expected_chain_id is 0 (chain not configured)");
        if (block.chainid != c.expectedChainId) revert InvalidConfig("chain id mismatch");
        if (bytes(c.name).length == 0 || bytes(c.symbol).length == 0) revert InvalidConfig("empty name/symbol");
        if (c.timelockDelay == 0) revert InvalidConfig("timelock delay is 0");

        address[6] memory h = holders(c);
        string[6] memory names = ["governance_safe", "ops_safe", "recovery_safe", "treasury_safe", "minter", "bot"];
        for (uint256 i = 0; i < h.length; ++i) {
            if (h[i] == address(0)) revert InvalidConfig(string.concat(names[i], " is zero"));
            // 배포자 EOA는 배포 후 어떤 역할도 갖지 않는다 (design.md 6장).
            if (h[i] == deployer) revert InvalidConfig(string.concat(names[i], " equals deployer"));
            // 역할 분리: 서로 다른 주체여야 한다. 특히 회수 Safe와 금고 Safe가 같으면 소각·재발행을 한 집단이 한다.
            for (uint256 j = i + 1; j < h.length; ++j) {
                if (h[i] == h[j]) revert InvalidConfig(string.concat(names[i], " equals ", names[j]));
            }
        }
        if (c.requireContractHolders) {
            // 봇(index 5)을 뺀 모든 보유자는 Safe(컨트랙트)여야 한다. EOA는 관리 권한을 갖지 않는다.
            for (uint256 i = 0; i < 5; ++i) {
                if (h[i].code.length == 0) revert InvalidConfig(string.concat(names[i], " has no code (not a Safe)"));
            }
        }
        for (uint256 i = 0; i < c.extraProtected.length; ++i) {
            if (c.extraProtected[i] == address(0)) revert InvalidConfig("extra protected is zero");
            if (c.extraProtected[i] == c.bot) revert InvalidConfig("bot cannot be protected");
        }
    }

    function holders(DeployConfig memory c) internal pure returns (address[6] memory) {
        return [c.governanceSafe, c.opsSafe, c.recoverySafe, c.treasurySafe, c.minter, c.bot];
    }
}
