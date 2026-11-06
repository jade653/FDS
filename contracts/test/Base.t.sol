// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StableToken} from "../src/StableToken.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/// @notice 모든 단위·매트릭스·퍼즈 테스트의 공통 기반. design.md 6장 역할 표대로 역할을 나눠 배포한다.
///         프록시는 TransparentUpgradeableProxy를 직접 배포한다(업그레이드 안전성 검사는 Upgrade.t.sol에서만 돌린다).
abstract contract BaseTest is Test {
    StableToken internal token;
    address internal proxyOwner = makeAddr("proxyOwner");

    // 역할 보유자 (6장 표)
    address internal admin = makeAddr("timelock"); // DEFAULT_ADMIN
    address internal guardian = makeAddr("opsSafe.guardian"); // GUARDIAN
    address internal bot = makeAddr("bot"); // FREEZER만 가진 키
    address internal unfreezer = makeAddr("opsSafe.unfreezer"); // UNFREEZER
    address internal pauser = makeAddr("opsSafe.pauser"); // PAUSER
    address internal wiper = makeAddr("recoverySafe"); // WIPER
    address internal masterMinter = makeAddr("treasurySafe"); // MASTER_MINTER
    address internal minter = makeAddr("minter"); // MINTER
    address internal rescuer = makeAddr("opsSafe.rescuer"); // RESCUER

    // 일반 사용자
    address internal alice;
    uint256 internal aliceKey;
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal attacker = makeAddr("attacker");

    // 역할 상수 캐시. vm.prank 뒤에 X_ROLE 뷰 호출을 넣으면 prank가 그 호출에 소모되므로 미리 읽어 둔다.
    bytes32 internal DEFAULT_ADMIN_ROLE;
    bytes32 internal GUARDIAN_ROLE;
    bytes32 internal FREEZER_ROLE;
    bytes32 internal UNFREEZER_ROLE;
    bytes32 internal PAUSER_ROLE;
    bytes32 internal WIPER_ROLE;
    bytes32 internal MASTER_MINTER_ROLE;
    bytes32 internal MINTER_ROLE;
    bytes32 internal RESCUER_ROLE;

    string internal constant NAME = "Stable Token";
    string internal constant SYMBOL = "STB";
    uint64 internal constant MIN_FREEZE_AGE = 10 minutes; // design.md 10장 테스트넷 값
    uint256 internal constant MINTER_ALLOWANCE = 1_000_000e6; // 10장 테스트넷 값
    bytes32 internal constant REASON = keccak256("R1");
    bytes32 internal constant CASE_1 = keccak256("case-1");
    bytes32 internal constant CASE_2 = keccak256("case-2");

    function setUp() public virtual {
        (alice, aliceKey) = makeAddrAndKey("alice");
        vm.warp(1_700_000_000);

        StableToken impl = new StableToken();
        bytes memory init = abi.encodeCall(StableToken.initialize, (NAME, SYMBOL, admin, MIN_FREEZE_AGE));
        token = StableToken(address(new TransparentUpgradeableProxy(address(impl), proxyOwner, init)));

        DEFAULT_ADMIN_ROLE = token.DEFAULT_ADMIN_ROLE();
        GUARDIAN_ROLE = token.GUARDIAN_ROLE();
        FREEZER_ROLE = token.FREEZER_ROLE();
        UNFREEZER_ROLE = token.UNFREEZER_ROLE();
        PAUSER_ROLE = token.PAUSER_ROLE();
        WIPER_ROLE = token.WIPER_ROLE();
        MASTER_MINTER_ROLE = token.MASTER_MINTER_ROLE();
        MINTER_ROLE = token.MINTER_ROLE();
        RESCUER_ROLE = token.RESCUER_ROLE();

        vm.startPrank(admin);
        token.grantRole(GUARDIAN_ROLE, guardian);
        token.grantRole(UNFREEZER_ROLE, unfreezer);
        token.grantRole(PAUSER_ROLE, pauser);
        token.grantRole(WIPER_ROLE, wiper);
        token.grantRole(MASTER_MINTER_ROLE, masterMinter);
        token.grantRole(RESCUER_ROLE, rescuer);
        vm.stopPrank();

        // FREEZER의 admin은 GUARDIAN이다. 타임락이 아니라 운영 Safe가 봇 키를 준다.
        vm.prank(guardian);
        token.grantRole(FREEZER_ROLE, bot);

        vm.prank(masterMinter);
        token.configureMinter(minter, MINTER_ALLOWANCE);
    }

    // ------------------------------------------------------------------
    // 헬퍼
    // ------------------------------------------------------------------

    function _mint(address to, uint256 amount) internal {
        vm.prank(minter);
        token.mint(to, amount);
    }

    function _freeze(address account) internal {
        vm.prank(bot);
        token.freeze(account, REASON);
    }

    function _unauthorized(address account, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, account, role);
    }

    function _frozen(address account) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(StableToken.AccountFrozen.selector, account);
    }

    function _paused() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(PausableUpgradeable.EnforcedPause.selector);
    }

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function _signPermit(uint256 key, address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, token.nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        return vm.sign(key, digest);
    }
}
