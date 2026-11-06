// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {StableToken} from "../src/StableToken.sol";

/// @notice freeze / freezeBatch / unfreeze 단위 테스트 (design.md 5.3).
contract FreezeTest is BaseTest {
    // ------------------------------------------------------------------
    // freeze
    // ------------------------------------------------------------------

    function test_freeze_byFreezer() public {
        vm.expectEmit(true, true, true, true);
        emit StableToken.Frozen(alice, bot, REASON);
        _freeze(alice);
        assertTrue(token.isFrozen(alice));
        assertEq(token.frozenAt(alice), uint64(block.timestamp));
    }

    function test_freeze_unauthorized() public {
        vm.expectRevert(_unauthorized(attacker, FREEZER_ROLE));
        vm.prank(attacker);
        token.freeze(alice, REASON);
    }

    function test_freeze_guardianWithoutFreezerCannotFreeze() public {
        // GUARDIAN은 FREEZER의 admin일 뿐 FREEZER 자체는 아니다.
        vm.expectRevert(_unauthorized(guardian, FREEZER_ROLE));
        vm.prank(guardian);
        token.freeze(alice, REASON);
    }

    function test_freeze_alreadyFrozenIsSilentNoop() public {
        _freeze(alice);
        uint64 first = token.frozenAt(alice);
        vm.warp(block.timestamp + 1 hours);

        vm.recordLogs();
        _freeze(alice);
        assertEq(vm.getRecordedLogs().length, 0, "no event on repeat freeze");
        assertEq(token.frozenAt(alice), first, "frozenAt must not be reset");
    }

    function test_freeze_zeroAddressReverts() public {
        vm.expectRevert(StableToken.ZeroAddress.selector);
        vm.prank(bot);
        token.freeze(address(0), REASON);
    }

    function test_freeze_protectedRequiresGuardian() public {
        vm.prank(admin);
        token.setProtected(alice, true);

        vm.expectRevert(abi.encodeWithSelector(StableToken.ProtectedAccount.selector, alice));
        vm.prank(bot);
        token.freeze(alice, REASON);
        assertFalse(token.isFrozen(alice));
    }

    function test_freeze_protectedByGuardianWithFreezer() public {
        vm.prank(admin);
        token.setProtected(alice, true);
        // 운영 Safe는 GUARDIAN과 FREEZER를 둘 다 가진다.
        vm.prank(guardian);
        token.grantRole(FREEZER_ROLE, guardian);

        vm.prank(guardian);
        token.freeze(alice, REASON);
        assertTrue(token.isFrozen(alice));
    }

    function test_freeze_protectionLiftedAllowsBot() public {
        vm.startPrank(admin);
        token.setProtected(alice, true);
        token.setProtected(alice, false);
        vm.stopPrank();
        _freeze(alice);
        assertTrue(token.isFrozen(alice));
    }

    function test_freeze_worksWhilePaused() public {
        vm.prank(pauser);
        token.pause();
        _freeze(alice);
        assertTrue(token.isFrozen(alice));
    }

    // ------------------------------------------------------------------
    // freezeBatch
    // ------------------------------------------------------------------

    function _accounts(uint256 n) internal pure returns (address[] memory list) {
        list = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            list[i] = address(uint160(0x1000 + i));
        }
    }

    function test_freezeBatch_freezesAllAndEmitsEach() public {
        address[] memory list = _accounts(3);
        for (uint256 i = 0; i < list.length; ++i) {
            vm.expectEmit(true, true, true, true);
            emit StableToken.Frozen(list[i], bot, REASON);
        }
        vm.prank(bot);
        token.freezeBatch(list, REASON);
        for (uint256 i = 0; i < list.length; ++i) {
            assertTrue(token.isFrozen(list[i]));
        }
    }

    function test_freezeBatch_maxLengthAccepted() public {
        vm.prank(bot);
        token.freezeBatch(_accounts(50), REASON);
        assertTrue(token.isFrozen(address(uint160(0x1000 + 49))));
    }

    function test_freezeBatch_overMaxReverts() public {
        vm.expectRevert(abi.encodeWithSelector(StableToken.BatchTooLarge.selector, 51, 50));
        vm.prank(bot);
        token.freezeBatch(_accounts(51), REASON);
    }

    function test_freezeBatch_emptyIsNoop() public {
        vm.prank(bot);
        token.freezeBatch(new address[](0), REASON);
    }

    function test_freezeBatch_unauthorized() public {
        vm.expectRevert(_unauthorized(attacker, FREEZER_ROLE));
        vm.prank(attacker);
        token.freezeBatch(_accounts(1), REASON);
    }

    function test_freezeBatch_skipsAlreadyFrozen() public {
        address[] memory list = _accounts(2);
        _freeze(list[0]);
        uint64 first = token.frozenAt(list[0]);
        vm.warp(block.timestamp + 1);

        vm.prank(bot);
        token.freezeBatch(list, REASON);
        assertEq(token.frozenAt(list[0]), first);
        assertEq(token.frozenAt(list[1]), uint64(block.timestamp));
    }

    function test_freezeBatch_protectedInBatchRevertsWhole() public {
        address[] memory list = _accounts(3);
        vm.prank(admin);
        token.setProtected(list[1], true);

        vm.expectRevert(abi.encodeWithSelector(StableToken.ProtectedAccount.selector, list[1]));
        vm.prank(bot);
        token.freezeBatch(list, REASON);
        assertFalse(token.isFrozen(list[0]), "batch must be atomic");
    }

    function test_freezeBatch_zeroAddressInBatchReverts() public {
        address[] memory list = _accounts(2);
        list[1] = address(0);
        vm.expectRevert(StableToken.ZeroAddress.selector);
        vm.prank(bot);
        token.freezeBatch(list, REASON);
    }

    // ------------------------------------------------------------------
    // unfreeze
    // ------------------------------------------------------------------

    function test_unfreeze_byUnfreezer() public {
        _freeze(alice);
        vm.expectEmit(true, true, true, true);
        emit StableToken.Unfrozen(alice, unfreezer);
        vm.prank(unfreezer);
        token.unfreeze(alice);
        assertFalse(token.isFrozen(alice));
        assertEq(token.frozenAt(alice), 0);
    }

    function test_unfreeze_unauthorized() public {
        _freeze(alice);
        vm.expectRevert(_unauthorized(bot, UNFREEZER_ROLE));
        vm.prank(bot);
        token.unfreeze(alice);
    }

    function test_unfreeze_notFrozenReverts() public {
        vm.expectRevert(abi.encodeWithSelector(StableToken.AccountNotFrozen.selector, alice));
        vm.prank(unfreezer);
        token.unfreeze(alice);
    }

    function test_unfreeze_worksWhilePaused() public {
        _freeze(alice);
        vm.prank(pauser);
        token.pause();
        vm.prank(unfreezer);
        token.unfreeze(alice);
        assertFalse(token.isFrozen(alice));
    }

    function test_unfreeze_thenRefreezeRecordsNewTime() public {
        _freeze(alice);
        vm.prank(unfreezer);
        token.unfreeze(alice);
        vm.warp(block.timestamp + 1 days);
        _freeze(alice);
        assertEq(token.frozenAt(alice), uint64(block.timestamp));
    }

    function test_unfreeze_restoresTransfers() public {
        _mint(alice, 100e6);
        _freeze(alice);
        vm.prank(unfreezer);
        token.unfreeze(alice);
        vm.prank(alice);
        token.transfer(bob, 40e6);
        assertEq(token.balanceOf(bob), 40e6);
    }
}
