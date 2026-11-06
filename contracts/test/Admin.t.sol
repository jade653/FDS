// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {StableToken} from "../src/StableToken.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/// @notice pause/unpause, setProtected, setMinFreezeAge, rescueERC20, 역할 admin 구조.
contract AdminTest is BaseTest {
    // ------------------------------------------------------------------
    // pause / unpause
    // ------------------------------------------------------------------

    function test_pause_byPauser() public {
        vm.expectEmit(true, true, true, true);
        emit PausableUpgradeable.Paused(pauser);
        vm.prank(pauser);
        token.pause();
        assertTrue(token.paused());
    }

    function test_pause_unauthorized() public {
        vm.expectRevert(_unauthorized(bot, PAUSER_ROLE));
        vm.prank(bot);
        token.pause();
    }

    function test_pause_twiceReverts() public {
        vm.startPrank(pauser);
        token.pause();
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        token.pause();
        vm.stopPrank();
    }

    function test_unpause_byPauser() public {
        vm.prank(pauser);
        token.pause();
        vm.expectEmit(true, true, true, true);
        emit PausableUpgradeable.Unpaused(pauser);
        vm.prank(pauser);
        token.unpause();
        assertFalse(token.paused());
    }

    function test_unpause_unauthorized() public {
        vm.prank(pauser);
        token.pause();
        vm.expectRevert(_unauthorized(admin, PAUSER_ROLE));
        vm.prank(admin);
        token.unpause();
    }

    function test_unpause_whenNotPausedReverts() public {
        vm.expectRevert(PausableUpgradeable.ExpectedPause.selector);
        vm.prank(pauser);
        token.unpause();
    }

    function test_unpause_restoresTransfers() public {
        _mint(alice, 10);
        vm.startPrank(pauser);
        token.pause();
        token.unpause();
        vm.stopPrank();
        vm.prank(alice);
        token.transfer(bob, 10);
        assertEq(token.balanceOf(bob), 10);
    }

    // ------------------------------------------------------------------
    // setProtected
    // ------------------------------------------------------------------

    function test_setProtected_byAdmin() public {
        vm.expectEmit(true, true, true, true);
        emit StableToken.ProtectedSet(alice, true);
        vm.prank(admin);
        token.setProtected(alice, true);
        assertTrue(token.isProtected(alice));

        vm.prank(admin);
        token.setProtected(alice, false);
        assertFalse(token.isProtected(alice));
    }

    function test_setProtected_unauthorized() public {
        vm.expectRevert(_unauthorized(guardian, DEFAULT_ADMIN_ROLE));
        vm.prank(guardian);
        token.setProtected(alice, true);
    }

    function test_setProtected_zeroAddressReverts() public {
        vm.expectRevert(StableToken.ZeroAddress.selector);
        vm.prank(admin);
        token.setProtected(address(0), true);
    }

    function test_setProtected_doesNotUnfreeze() public {
        _freeze(alice);
        vm.prank(admin);
        token.setProtected(alice, true);
        assertTrue(token.isFrozen(alice));
    }

    // ------------------------------------------------------------------
    // setMinFreezeAge
    // ------------------------------------------------------------------

    function test_setMinFreezeAge_byAdmin() public {
        vm.expectEmit(true, true, true, true);
        emit StableToken.MinFreezeAgeSet(72 hours);
        vm.prank(admin);
        token.setMinFreezeAge(72 hours);
        assertEq(token.minFreezeAge(), 72 hours);
    }

    function test_setMinFreezeAge_unauthorized() public {
        vm.expectRevert(_unauthorized(wiper, DEFAULT_ADMIN_ROLE));
        vm.prank(wiper);
        token.setMinFreezeAge(0);
    }

    function test_setMinFreezeAge_maxValue() public {
        vm.prank(admin);
        token.setMinFreezeAge(type(uint64).max);
        assertEq(token.minFreezeAge(), type(uint64).max);
    }

    // ------------------------------------------------------------------
    // rescueERC20
    // ------------------------------------------------------------------

    function test_rescue_foreignToken() public {
        MockERC20 other = new MockERC20();
        other.mint(address(token), 1_000);

        vm.expectEmit(true, true, true, true);
        emit StableToken.Rescued(address(other), alice, 400);
        vm.prank(rescuer);
        token.rescueERC20(address(other), alice, 400);
        assertEq(other.balanceOf(alice), 400);
        assertEq(other.balanceOf(address(token)), 600);
    }

    function test_rescue_ownToken() public {
        // 이 토큰이 컨트랙트 주소로 잘못 전송된 경우도 돌려줄 수 있다.
        _mint(address(token), 50);
        vm.prank(rescuer);
        token.rescueERC20(address(token), alice, 50);
        assertEq(token.balanceOf(alice), 50);
        assertEq(token.balanceOf(address(token)), 0);
    }

    function test_rescue_ownTokenToFrozenReverts() public {
        _mint(address(token), 50);
        _freeze(alice);
        vm.expectRevert(_frozen(alice));
        vm.prank(rescuer);
        token.rescueERC20(address(token), alice, 50);
    }

    function test_rescue_ownTokenWhilePausedReverts() public {
        _mint(address(token), 50);
        vm.prank(pauser);
        token.pause();
        vm.expectRevert(_paused());
        vm.prank(rescuer);
        token.rescueERC20(address(token), alice, 50);
    }

    function test_rescue_foreignTokenWhilePausedWorks() public {
        MockERC20 other = new MockERC20();
        other.mint(address(token), 10);
        vm.prank(pauser);
        token.pause();
        vm.prank(rescuer);
        token.rescueERC20(address(other), alice, 10);
        assertEq(other.balanceOf(alice), 10);
    }

    function test_rescue_unauthorized() public {
        MockERC20 other = new MockERC20();
        other.mint(address(token), 10);
        vm.expectRevert(_unauthorized(admin, RESCUER_ROLE));
        vm.prank(admin);
        token.rescueERC20(address(other), alice, 10);
    }

    function test_rescue_zeroRecipientReverts() public {
        MockERC20 other = new MockERC20();
        vm.expectRevert(StableToken.ZeroAddress.selector);
        vm.prank(rescuer);
        token.rescueERC20(address(other), address(0), 1);
    }

    function test_rescue_moreThanHeldReverts() public {
        MockERC20 other = new MockERC20();
        other.mint(address(token), 10);
        vm.expectRevert();
        vm.prank(rescuer);
        token.rescueERC20(address(other), alice, 11);
    }

    // ------------------------------------------------------------------
    // 역할 admin 구조 (design.md 6장)
    // ------------------------------------------------------------------

    function test_guardianManagesFreezerWithoutTimelock() public {
        address bot2 = makeAddr("bot2");
        vm.startPrank(guardian);
        token.grantRole(FREEZER_ROLE, bot2);
        assertTrue(token.hasRole(FREEZER_ROLE, bot2));
        token.revokeRole(FREEZER_ROLE, bot);
        vm.stopPrank();
        assertFalse(token.hasRole(FREEZER_ROLE, bot));

        vm.expectRevert(_unauthorized(bot, FREEZER_ROLE));
        vm.prank(bot);
        token.freeze(alice, REASON);
    }

    function test_defaultAdminCannotGrantFreezerDirectly() public {
        // FREEZER의 admin은 GUARDIAN이므로 타임락도 직접 줄 수 없다.
        vm.expectRevert(_unauthorized(admin, GUARDIAN_ROLE));
        vm.prank(admin);
        token.grantRole(FREEZER_ROLE, attacker);
    }

    function test_guardianCannotGrantOtherRoles() public {
        vm.expectRevert(_unauthorized(guardian, DEFAULT_ADMIN_ROLE));
        vm.prank(guardian);
        token.grantRole(UNFREEZER_ROLE, attacker);
    }

    function test_defaultAdminManagesOtherRoles() public {
        vm.startPrank(admin);
        token.revokeRole(PAUSER_ROLE, pauser);
        token.grantRole(PAUSER_ROLE, bob);
        vm.stopPrank();
        assertFalse(token.hasRole(PAUSER_ROLE, pauser));
        assertTrue(token.hasRole(PAUSER_ROLE, bob));
    }

    function test_roleChangesWorkWhilePaused() public {
        vm.prank(pauser);
        token.pause();
        vm.prank(admin);
        token.grantRole(UNFREEZER_ROLE, bob);
        vm.prank(guardian);
        token.revokeRole(FREEZER_ROLE, bot);
        assertTrue(token.hasRole(UNFREEZER_ROLE, bob));
        assertFalse(token.hasRole(FREEZER_ROLE, bot));
    }

    function test_renounceRoleRequiresSelf() public {
        vm.expectRevert(IAccessControl.AccessControlBadConfirmation.selector);
        vm.prank(attacker);
        token.renounceRole(FREEZER_ROLE, bot);
    }

    function test_freezerOnlyKeyHasNoOtherPower() public {
        // 불변식 3의 단위 버전: 봇 키로 할 수 있는 건 동결뿐이다.
        _freeze(alice);
        vm.startPrank(bot);
        vm.expectRevert(_unauthorized(bot, UNFREEZER_ROLE));
        token.unfreeze(alice);
        vm.expectRevert(_unauthorized(bot, WIPER_ROLE));
        token.wipeFrozen(alice, CASE_1);
        vm.expectRevert(_unauthorized(bot, MINTER_ROLE));
        token.mint(bot, 1);
        vm.expectRevert(_unauthorized(bot, MINTER_ROLE));
        token.mintForRecovery(bot, 1, CASE_1);
        vm.expectRevert(_unauthorized(bot, MINTER_ROLE));
        token.burn(1);
        vm.expectRevert(_unauthorized(bot, PAUSER_ROLE));
        token.pause();
        vm.expectRevert(_unauthorized(bot, MASTER_MINTER_ROLE));
        token.configureMinter(bot, 1);
        vm.expectRevert(_unauthorized(bot, DEFAULT_ADMIN_ROLE));
        token.setProtected(bot, true);
        vm.expectRevert(_unauthorized(bot, DEFAULT_ADMIN_ROLE));
        token.setMinFreezeAge(0);
        vm.expectRevert(_unauthorized(bot, RESCUER_ROLE));
        token.rescueERC20(address(token), bot, 1);
        vm.expectRevert(_unauthorized(bot, GUARDIAN_ROLE));
        token.grantRole(FREEZER_ROLE, attacker);
        vm.expectRevert(_unauthorized(bot, DEFAULT_ADMIN_ROLE));
        token.grantRole(GUARDIAN_ROLE, bot);
        vm.stopPrank();
    }
}
