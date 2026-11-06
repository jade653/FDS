// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StableToken} from "../../src/StableToken.sol";
import {Handler} from "./Handler.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {ProxyAdmin} from "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

/// @notice design.md 5.5의 불변식 7개를 핸들러 기반 invariant 테스트로 강제한다.
contract StableTokenInvariantTest is Test {
    StableToken internal token;
    ProxyAdmin internal proxyAdmin;
    Handler internal handler;

    address internal proxyOwner = makeAddr("proxyOwner");
    address internal admin = makeAddr("timelock");
    address internal guardian = makeAddr("guardian");
    address internal bot = makeAddr("bot");
    address internal unfreezer = makeAddr("unfreezer");
    address internal pauser = makeAddr("pauser");
    address internal wiper = makeAddr("wiper");
    address internal masterMinter = makeAddr("masterMinter");

    function setUp() public {
        vm.warp(1_700_000_000);
        StableToken impl = new StableToken();
        bytes memory init = abi.encodeCall(StableToken.initialize, ("Stable Token", "STB", admin, 10 minutes));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(address(impl), proxyOwner, init);
        token = StableToken(address(proxy));
        proxyAdmin = ProxyAdmin(address(uint160(uint256(vm.load(address(proxy), ERC1967Utils.ADMIN_SLOT)))));

        vm.startPrank(admin);
        token.grantRole(token.GUARDIAN_ROLE(), guardian);
        token.grantRole(token.UNFREEZER_ROLE(), unfreezer);
        token.grantRole(token.PAUSER_ROLE(), pauser);
        token.grantRole(token.WIPER_ROLE(), wiper);
        token.grantRole(token.MASTER_MINTER_ROLE(), masterMinter);
        vm.stopPrank();
        vm.startPrank(guardian);
        token.grantRole(token.FREEZER_ROLE(), bot);
        token.grantRole(token.FREEZER_ROLE(), guardian); // 운영 Safe는 FREEZER + GUARDIAN
        vm.stopPrank();

        address[] memory minters = new address[](2);
        minters[0] = makeAddr("minter0");
        minters[1] = makeAddr("minter1");
        address[] memory plainUsers = new address[](6);
        for (uint256 i = 0; i < plainUsers.length; ++i) {
            plainUsers[i] = makeAddr(string(abi.encodePacked("user", vm.toString(i))));
        }

        handler = new Handler(
            token, proxyAdmin, admin, guardian, bot, unfreezer, pauser, wiper, masterMinter, minters, plainUsers
        );

        targetContract(address(handler));
    }

    // 1. totalSupply == 모든 잔고의 합
    function invariant_totalSupplyEqualsSumOfBalances() public view {
        uint256 sum;
        uint256 n = handler.usersLength();
        for (uint256 i = 0; i < n; ++i) {
            sum += token.balanceOf(handler.users(i));
        }
        assertEq(token.totalSupply(), sum, "totalSupply != sum(balances)");
    }

    // 2. 동결된 주소의 잔고는 wipeFrozen 외에는 변하지 않는다
    function invariant_frozenBalancesOnlyChangeByWipe() public view {
        uint256 n = handler.usersLength();
        for (uint256 i = 0; i < n; ++i) {
            address a = handler.users(i);
            if (token.isFrozen(a)) {
                assertEq(token.balanceOf(a), handler.frozenBalance(a), "frozen balance changed");
            }
        }
    }

    // 3. FREEZER만 가진 주소는 해제, 소각, 발행, 정지, 역할 변경, 업그레이드를 할 수 없다
    function invariant_freezerOnlyKeyCannotDoAnythingElse() public view {
        assertFalse(handler.freezerDidForbiddenAction(), "freezer-only key did a forbidden action");
        // 역할 자체도 늘어나지 않았는지 확인한다.
        assertFalse(token.hasRole(token.DEFAULT_ADMIN_ROLE(), bot));
        assertFalse(token.hasRole(token.UNFREEZER_ROLE(), bot));
        assertFalse(token.hasRole(token.WIPER_ROLE(), bot));
        assertFalse(token.hasRole(token.MINTER_ROLE(), bot));
        assertFalse(token.hasRole(token.MASTER_MINTER_ROLE(), bot));
        assertFalse(token.hasRole(token.PAUSER_ROLE(), bot));
        assertFalse(token.hasRole(token.GUARDIAN_ROLE(), bot));
        assertFalse(token.hasRole(token.RESCUER_ROLE(), bot));
        assertEq(proxyAdmin.owner(), proxyOwner);
    }

    // 4. minter의 누적 발행량은 그동안 설정된 한도의 합을 넘지 않는다
    function invariant_mintedNeverExceedsConfiguredAllowance() public view {
        uint256 n = handler.mintersLength();
        for (uint256 i = 0; i < n; ++i) {
            address m = handler.minters(i);
            assertLe(handler.totalMinted(m), handler.totalAllowanceConfigured(m), "minted > configured");
            // 남은 한도 + 발행량 <= 설정 합계 (한도 덮어쓰기는 합계를 줄이지 않는다)
            assertLe(
                token.minterAllowance(m) + handler.totalMinted(m),
                handler.totalAllowanceConfigured(m),
                "allowance accounting broken"
            );
        }
    }

    // 5. 보호 주소는 GUARDIAN 없이 동결되지 않는다
    function invariant_protectedNeverFrozenWithoutGuardian() public view {
        assertFalse(handler.protectedFrozenWithoutGuardian(), "bot froze a protected account");
    }

    // 6. 일시정지 상태에서도 freeze는 성공한다
    function invariant_freezeSucceedsWhilePaused() public view {
        assertFalse(handler.freezeFailedWhilePaused(), "freeze failed while paused");
    }

    // 7. 모든 caseId에 대해 reissuedByCase <= wipedByCase
    function invariant_reissuedNeverExceedsWiped() public view {
        uint256 n = handler.caseIdsLength();
        for (uint256 i = 0; i < n; ++i) {
            bytes32 c = handler.caseIds(i);
            assertLe(token.reissuedByCase(c), token.wipedByCase(c), "reissued > wiped");
        }
    }

    // 보조: 역할 admin 구조가 바뀌지 않는다
    function invariant_roleAdminsUnchanged() public view {
        assertEq(token.getRoleAdmin(token.FREEZER_ROLE()), token.GUARDIAN_ROLE());
        assertEq(token.getRoleAdmin(token.MINTER_ROLE()), token.MASTER_MINTER_ROLE());
    }
}
