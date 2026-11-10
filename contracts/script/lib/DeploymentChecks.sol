// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {StableToken} from "../../src/StableToken.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {DeployConfig, Deployment} from "./DeployConfig.sol";

/// @notice 배포 결과를 design.md 6장 권한 표와 대조하는 온체인 검증.
///         Deploy.s.sol이 배포 직후, VerifyDeployment.s.sol이 언제든 다시 실행한다.
///         실패하면 어떤 항목이 틀렸는지 문자열과 함께 revert한다.
///
///         AccessControl은 보유자를 열거할 수 없으므로 "알려진 주체 × 모든 역할" 행렬을 검사한다.
///         알려진 주체 밖의 보유자까지 찾는 전수 검사는 이벤트를 훑는 `ops-cli verify-roles`가 한다.
library DeploymentChecks {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // ERC-1967
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 internal constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Initializable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant INITIALIZABLE_SLOT = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00;

    uint256 internal constant N_ROLES = 9;
    uint256 internal constant N_PRINCIPALS = 10;

    error CheckFailed(string what);

    function _check(bool ok, string memory what) private pure {
        if (!ok) revert CheckFailed(what);
    }

    function roles(StableToken t) internal view returns (bytes32[N_ROLES] memory r, string[N_ROLES] memory n) {
        r = [
            t.DEFAULT_ADMIN_ROLE(),
            t.GUARDIAN_ROLE(),
            t.FREEZER_ROLE(),
            t.UNFREEZER_ROLE(),
            t.PAUSER_ROLE(),
            t.WIPER_ROLE(),
            t.MASTER_MINTER_ROLE(),
            t.MINTER_ROLE(),
            t.RESCUER_ROLE()
        ];
        n = ["DEFAULT_ADMIN", "GUARDIAN", "FREEZER", "UNFREEZER", "PAUSER", "WIPER", "MASTER_MINTER", "MINTER", "RESCUER"];
    }

    /// @dev 주체별 기대 역할 (design.md 6장). 인덱스는 roles()와 같다.
    function expected(DeployConfig memory c, Deployment memory d)
        internal
        pure
        returns (address[N_PRINCIPALS] memory who, string[N_PRINCIPALS] memory label, bool[N_ROLES][N_PRINCIPALS] memory e)
    {
        who = [
            d.timelock,
            c.opsSafe,
            c.recoverySafe,
            c.treasurySafe,
            c.minter,
            c.bot,
            c.governanceSafe,
            d.deployer,
            d.token,
            d.proxyAdmin
        ];
        label = ["timelock", "ops_safe", "recovery_safe", "treasury_safe", "minter", "bot", "governance_safe", "deployer", "token", "proxy_admin"];
        //                 ADMIN  GUARD  FREEZ  UNFRZ  PAUSE  WIPER  MMINT  MINT   RESCU
        e[0] = [true, false, false, false, false, false, false, false, false]; // timelock
        e[1] = [false, true, true, true, true, false, false, false, true]; // ops safe
        e[2] = [false, false, false, false, false, true, false, false, false]; // recovery safe
        e[3] = [false, false, false, false, false, false, true, false, false]; // treasury safe
        e[4] = [false, false, false, false, false, false, false, c.minterAllowance > 0, false]; // minter
        e[5] = [false, false, true, false, false, false, false, false, false]; // bot: FREEZER만
        // governance safe, deployer, token, proxy admin: 토큰 역할 없음
    }

    /// @param fresh 배포 직후 상태(공급 0, 한도 그대로, 정지 아님)까지 볼지. 운영 중 재검증에서는 false.
    function verify(DeployConfig memory c, Deployment memory d, bool fresh) internal view {
        _verifyProxy(d);
        _verifyParams(c, d, fresh);
        _verifyRoles(c, d);
        _verifyRoleAdmins(StableToken(d.token));
        _verifyProtected(c, d);
        _verifyTimelock(c, d);
    }

    function _verifyProxy(Deployment memory d) private view {
        _check(d.token.code.length > 0, "token has no code");
        _check(address(uint160(uint256(vm.load(d.token, IMPLEMENTATION_SLOT)))) == d.implementation, "implementation slot");
        _check(address(uint160(uint256(vm.load(d.token, ADMIN_SLOT)))) == d.proxyAdmin, "proxy admin slot");
        // ProxyAdmin 소유자는 타임락이다. 배포자 EOA가 아니다.
        _check(ProxyAdmin(d.proxyAdmin).owner() == d.timelock, "ProxyAdmin owner is not the timelock");
        // 구현체는 직접 초기화할 수 없어야 한다 (_disableInitializers).
        _check(
            uint64(uint256(vm.load(d.implementation, INITIALIZABLE_SLOT))) == type(uint64).max,
            "implementation initializers not disabled"
        );
    }

    function _verifyParams(DeployConfig memory c, Deployment memory d, bool fresh) private view {
        StableToken t = StableToken(d.token);
        _check(keccak256(bytes(t.name())) == keccak256(bytes(c.name)), "token name");
        _check(keccak256(bytes(t.symbol())) == keccak256(bytes(c.symbol)), "token symbol");
        _check(t.decimals() == 6, "decimals");
        _check(t.minFreezeAge() == c.minFreezeAge, "minFreezeAge");
        if (fresh) {
            _check(!t.paused(), "token paused");
            _check(t.totalSupply() == 0, "unexpected supply");
            _check(t.minterAllowance(c.minter) == c.minterAllowance, "minter allowance");
        }
    }

    function _verifyRoles(DeployConfig memory c, Deployment memory d) private view {
        StableToken t = StableToken(d.token);
        (bytes32[N_ROLES] memory r, string[N_ROLES] memory rn) = roles(t);
        (address[N_PRINCIPALS] memory who, string[N_PRINCIPALS] memory label, bool[N_ROLES][N_PRINCIPALS] memory e) =
            expected(c, d);
        for (uint256 p = 0; p < N_PRINCIPALS; ++p) {
            for (uint256 i = 0; i < N_ROLES; ++i) {
                bool has = t.hasRole(r[i], who[p]);
                if (has != e[p][i]) {
                    revert CheckFailed(string.concat(label[p], has ? " unexpectedly has " : " is missing ", rn[i]));
                }
            }
        }
    }

    function _verifyRoleAdmins(StableToken t) private view {
        (bytes32[N_ROLES] memory r, string[N_ROLES] memory rn) = roles(t);
        _check(t.getRoleAdmin(t.FREEZER_ROLE()) == t.GUARDIAN_ROLE(), "FREEZER admin is not GUARDIAN");
        _check(t.getRoleAdmin(t.MINTER_ROLE()) == t.MASTER_MINTER_ROLE(), "MINTER admin is not MASTER_MINTER");
        for (uint256 i = 0; i < N_ROLES; ++i) {
            if (r[i] == t.FREEZER_ROLE() || r[i] == t.MINTER_ROLE()) continue;
            _check(t.getRoleAdmin(r[i]) == t.DEFAULT_ADMIN_ROLE(), string.concat(rn[i], " admin is not DEFAULT_ADMIN"));
        }
    }

    function _verifyProtected(DeployConfig memory c, Deployment memory d) private view {
        StableToken t = StableToken(d.token);
        address[] memory prot = protectedSet(c, d);
        for (uint256 i = 0; i < prot.length; ++i) {
            _check(t.isProtected(prot[i]), string.concat("not protected: ", vm.toString(prot[i])));
        }
        _check(!t.isProtected(c.bot), "bot must not be protected");
        _check(!t.isFrozen(c.bot), "bot is frozen");
    }

    function _verifyTimelock(DeployConfig memory c, Deployment memory d) private view {
        TimelockController tl = TimelockController(payable(d.timelock));
        _check(tl.getMinDelay() == c.timelockDelay, "timelock delay");
        // 타임락 admin은 타임락 자신뿐이다 (생성자 admin = address(0)).
        _check(tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), d.timelock), "timelock is not its own admin");
        _check(tl.hasRole(tl.PROPOSER_ROLE(), c.governanceSafe), "governance safe is not proposer");
        _check(tl.hasRole(tl.CANCELLER_ROLE(), c.governanceSafe), "governance safe is not canceller");
        // 실행자는 개방 (docs/decisions.md 3절).
        _check(tl.hasRole(tl.EXECUTOR_ROLE(), address(0)), "executor is not open");

        (address[N_PRINCIPALS] memory who, string[N_PRINCIPALS] memory label,) = expected(c, d);
        for (uint256 p = 0; p < N_PRINCIPALS; ++p) {
            address a = who[p];
            if (a == d.timelock) continue;
            _check(!tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), a), string.concat(label[p], " has timelock admin"));
            if (a == c.governanceSafe) continue;
            _check(!tl.hasRole(tl.PROPOSER_ROLE(), a), string.concat(label[p], " is timelock proposer"));
            _check(!tl.hasRole(tl.CANCELLER_ROLE(), a), string.concat(label[p], " is timelock canceller"));
        }
    }

    /// @notice 보호 주소 집합: 타임락, 토큰, 각 Safe, minter, 추가 주소.
    function protectedSet(DeployConfig memory c, Deployment memory d) internal pure returns (address[] memory s) {
        s = new address[](7 + c.extraProtected.length);
        s[0] = d.timelock;
        s[1] = d.token;
        s[2] = c.governanceSafe;
        s[3] = c.opsSafe;
        s[4] = c.recoverySafe;
        s[5] = c.treasurySafe;
        s[6] = c.minter;
        for (uint256 i = 0; i < c.extraProtected.length; ++i) {
            s[7 + i] = c.extraProtected[i];
        }
    }
}
