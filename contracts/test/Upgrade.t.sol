// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Upgrades} from "@openzeppelin/foundry-upgrades/Upgrades.sol";
import {StableToken} from "../src/StableToken.sol";
import {StableTokenV2} from "./mocks/StableTokenV2.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ITransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice 업그레이드 테스트 (design.md 12장).
///         V1 배포(업그레이드 안전성 검사 포함) → 상태 생성 → V2로 업그레이드(저장소 레이아웃 검사 포함)
///         → 잔고·동결·역할·사건 회계·nonce가 보존되는지 확인한다.
contract UpgradeTest is Test {
    StableToken internal token;
    address internal proxy;

    address internal proxyOwner = makeAddr("timelock.proxyOwner");
    address internal admin = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal bot = makeAddr("bot");
    address internal unfreezer = makeAddr("unfreezer");
    address internal pauser = makeAddr("pauser");
    address internal wiper = makeAddr("wiper");
    address internal masterMinter = makeAddr("masterMinter");
    address internal minter = makeAddr("minter");
    address internal alice = makeAddr("alice");
    address internal attacker = makeAddr("attacker");
    address internal protectedVault = makeAddr("vault");

    bytes32 internal constant CASE = keccak256("case-upgrade");

    function setUp() public {
        vm.warp(1_700_000_000);
        // deployTransparentProxy는 배포 전에 StableToken의 업그레이드 안전성을 검증한다.
        proxy = Upgrades.deployTransparentProxy(
            "StableToken.sol", proxyOwner, abi.encodeCall(StableToken.initialize, ("Stable Token", "STB", admin, 600))
        );
        token = StableToken(proxy);

        vm.startPrank(admin);
        token.grantRole(token.GUARDIAN_ROLE(), guardian);
        token.grantRole(token.UNFREEZER_ROLE(), unfreezer);
        token.grantRole(token.PAUSER_ROLE(), pauser);
        token.grantRole(token.WIPER_ROLE(), wiper);
        token.grantRole(token.MASTER_MINTER_ROLE(), masterMinter);
        token.setProtected(protectedVault, true);
        vm.stopPrank();
        vm.startPrank(guardian);
        token.grantRole(token.FREEZER_ROLE(), bot);
        vm.stopPrank();
        vm.prank(masterMinter);
        token.configureMinter(minter, 1_000e6);
    }

    function _createState() internal {
        vm.startPrank(minter);
        token.mint(alice, 300e6);
        token.mint(attacker, 200e6);
        vm.stopPrank();
        vm.prank(alice);
        token.approve(minter, 77);

        vm.prank(bot);
        token.freeze(attacker, keccak256("R1"));
        vm.warp(block.timestamp + 600);
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE);
        vm.prank(minter);
        token.mintForRecovery(alice, 50e6, CASE);
    }

    function _upgradeToV2() internal {
        // upgradeProxy는 @custom:oz-upgrades-from StableToken 주석으로 V1과 저장소 레이아웃을 비교한다.
        Upgrades.upgradeProxy(proxy, "StableTokenV2.sol", abi.encodeCall(StableTokenV2.initializeV2, (42)), proxyOwner);
    }

    function test_upgradePreservesState() public {
        _createState();
        uint64 attackerFrozenAt = token.frozenAt(attacker);
        address implBefore = Upgrades.getImplementationAddress(proxy);

        _upgradeToV2();
        StableTokenV2 v2 = StableTokenV2(proxy);

        assertTrue(Upgrades.getImplementationAddress(proxy) != implBefore, "implementation must change");
        assertEq(v2.version(), 2);
        assertEq(v2.upgradeMarker(), 42);

        // 메타데이터
        assertEq(v2.name(), "Stable Token");
        assertEq(v2.symbol(), "STB");
        assertEq(v2.decimals(), 6);

        // 잔고·공급
        assertEq(v2.balanceOf(alice), 350e6);
        assertEq(v2.balanceOf(attacker), 0);
        assertEq(v2.totalSupply(), 350e6);
        assertEq(v2.allowance(alice, minter), 77);

        // 동결·보호·대기 시간
        assertTrue(v2.isFrozen(attacker));
        assertEq(v2.frozenAt(attacker), attackerFrozenAt);
        assertFalse(v2.isFrozen(alice));
        assertTrue(v2.isProtected(protectedVault));
        assertEq(v2.minFreezeAge(), 600);

        // 사건 회계·minter 한도
        assertEq(v2.wipedByCase(CASE), 200e6);
        assertEq(v2.reissuedByCase(CASE), 50e6);
        assertEq(v2.minterAllowance(minter), 1_000e6 - 300e6 - 200e6 - 50e6);

        // 역할과 역할 admin
        assertTrue(v2.hasRole(v2.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(v2.hasRole(v2.GUARDIAN_ROLE(), guardian));
        assertTrue(v2.hasRole(v2.FREEZER_ROLE(), bot));
        assertTrue(v2.hasRole(v2.UNFREEZER_ROLE(), unfreezer));
        assertTrue(v2.hasRole(v2.PAUSER_ROLE(), pauser));
        assertTrue(v2.hasRole(v2.WIPER_ROLE(), wiper));
        assertTrue(v2.hasRole(v2.MASTER_MINTER_ROLE(), masterMinter));
        assertTrue(v2.hasRole(v2.MINTER_ROLE(), minter));
        assertEq(v2.getRoleAdmin(v2.FREEZER_ROLE()), v2.GUARDIAN_ROLE());
        assertEq(v2.getRoleAdmin(v2.MINTER_ROLE()), v2.MASTER_MINTER_ROLE());
    }

    function test_upgradeKeepsBehaviour() public {
        _createState();
        _upgradeToV2();
        StableTokenV2 v2 = StableTokenV2(proxy);

        // 동결은 여전히 전송을 막고, 회수 상한도 유지된다.
        vm.expectRevert(abi.encodeWithSelector(StableToken.AccountFrozen.selector, attacker));
        vm.prank(minter);
        v2.mint(attacker, 1);

        vm.expectRevert(
            abi.encodeWithSelector(StableToken.RecoveryExceedsWiped.selector, CASE, 200e6, 50e6, 150e6 + 1)
        );
        vm.prank(minter);
        v2.mintForRecovery(alice, 150e6 + 1, CASE);

        vm.prank(minter);
        v2.mintForRecovery(alice, 150e6, CASE);
        assertEq(v2.reissuedByCase(CASE), 200e6);
    }

    function test_upgradePreservesPermitNoncesAndDomain() public {
        bytes32 domainBefore = token.DOMAIN_SEPARATOR();
        _upgradeToV2();
        assertEq(StableTokenV2(proxy).DOMAIN_SEPARATOR(), domainBefore);
        assertEq(StableTokenV2(proxy).nonces(alice), 0);
    }

    function test_upgradeWhilePausedKeepsPaused() public {
        vm.prank(pauser);
        token.pause();
        _upgradeToV2();
        assertTrue(StableTokenV2(proxy).paused());
    }

    function test_v2CannotBeReinitializedTwice() public {
        _upgradeToV2();
        vm.expectRevert();
        StableTokenV2(proxy).initializeV2(1);
    }

    function test_onlyProxyOwnerCanUpgrade() public {
        ProxyAdmin proxyAdmin = ProxyAdmin(Upgrades.getAdminAddress(proxy));
        assertEq(proxyAdmin.owner(), proxyOwner);
        StableTokenV2 impl = new StableTokenV2();

        // 타임락(DEFAULT_ADMIN)도, 봇도 ProxyAdmin의 owner가 아니면 업그레이드할 수 없다.
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
        vm.prank(admin);
        proxyAdmin.upgradeAndCall(ITransparentUpgradeableProxy(proxy), address(impl), "");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, bot));
        vm.prank(bot);
        proxyAdmin.upgradeAndCall(ITransparentUpgradeableProxy(proxy), address(impl), "");
    }

    function test_v2ImplementationCannotBeInitialized() public {
        StableTokenV2 impl = new StableTokenV2();
        vm.expectRevert();
        impl.initialize("x", "x", admin, 0);
        vm.expectRevert();
        impl.initializeV2(1);
    }
}
