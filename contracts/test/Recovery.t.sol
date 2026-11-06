// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {StableToken} from "../src/StableToken.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice 회수 경로: wipeFrozen → mintForRecovery 와 사건별 회계 (design.md 5.4).
contract RecoveryTest is BaseTest {
    address internal victim = makeAddr("victim");

    function _frozenWithBalance(address account, uint256 amount) internal {
        _mint(account, amount);
        _freeze(account);
    }

    function _wipeAfterAge(address account, bytes32 caseId) internal {
        vm.warp(token.frozenAt(account) + MIN_FREEZE_AGE);
        vm.prank(wiper);
        token.wipeFrozen(account, caseId);
    }

    // ------------------------------------------------------------------
    // wipeFrozen
    // ------------------------------------------------------------------

    function test_wipe_burnsAllAndRecordsCase() public {
        _frozenWithBalance(attacker, 500e6);
        vm.warp(block.timestamp + MIN_FREEZE_AGE);

        vm.expectEmit(true, true, true, true);
        emit IERC20.Transfer(attacker, address(0), 500e6);
        vm.expectEmit(true, true, true, true);
        emit StableToken.FrozenFundsWiped(CASE_1, attacker, 500e6);
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);

        assertEq(token.balanceOf(attacker), 0);
        assertEq(token.totalSupply(), 0);
        assertEq(token.wipedByCase(CASE_1), 500e6);
        assertTrue(token.isFrozen(attacker), "freeze must persist after wipe");
    }

    function test_wipe_unauthorized() public {
        _frozenWithBalance(attacker, 1);
        vm.warp(block.timestamp + MIN_FREEZE_AGE);
        vm.expectRevert(_unauthorized(bot, WIPER_ROLE));
        vm.prank(bot);
        token.wipeFrozen(attacker, CASE_1);
    }

    function test_wipe_notFrozenReverts() public {
        _mint(attacker, 1);
        vm.expectRevert(abi.encodeWithSelector(StableToken.AccountNotFrozen.selector, attacker));
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);
    }

    function test_wipe_exactlyAtMinAgeSucceeds() public {
        _frozenWithBalance(attacker, 1);
        vm.warp(token.frozenAt(attacker) + MIN_FREEZE_AGE);
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);
        assertEq(token.balanceOf(attacker), 0);
    }

    function test_wipe_oneSecondEarlyReverts() public {
        _frozenWithBalance(attacker, 1);
        uint64 availableAt = token.frozenAt(attacker) + MIN_FREEZE_AGE;
        vm.warp(availableAt - 1);
        vm.expectRevert(abi.encodeWithSelector(StableToken.FreezeTooRecent.selector, attacker, availableAt));
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);
    }

    function test_wipe_immediatelyAfterFreezeReverts() public {
        _frozenWithBalance(attacker, 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                StableToken.FreezeTooRecent.selector, attacker, token.frozenAt(attacker) + MIN_FREEZE_AGE
            )
        );
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);
    }

    function test_wipe_zeroMinAgeAllowsImmediateWipe() public {
        vm.prank(admin);
        token.setMinFreezeAge(0);
        _frozenWithBalance(attacker, 1);
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);
        assertEq(token.wipedByCase(CASE_1), 1);
    }

    function test_wipe_minAgeChangeAppliesToExistingFreezes() public {
        _frozenWithBalance(attacker, 1);
        vm.warp(block.timestamp + MIN_FREEZE_AGE);
        vm.prank(admin);
        token.setMinFreezeAge(1 days);
        vm.expectRevert(
            abi.encodeWithSelector(StableToken.FreezeTooRecent.selector, attacker, token.frozenAt(attacker) + 1 days)
        );
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);
    }

    function test_wipe_zeroBalanceReverts() public {
        _freeze(attacker);
        vm.warp(block.timestamp + MIN_FREEZE_AGE);
        vm.expectRevert(abi.encodeWithSelector(StableToken.NothingToWipe.selector, attacker));
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);
    }

    function test_wipe_secondWipeOfSameAccountReverts() public {
        _frozenWithBalance(attacker, 1);
        _wipeAfterAge(attacker, CASE_1);
        vm.expectRevert(abi.encodeWithSelector(StableToken.NothingToWipe.selector, attacker));
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);
    }

    function test_wipe_worksWhilePaused() public {
        _frozenWithBalance(attacker, 9e6);
        vm.warp(block.timestamp + MIN_FREEZE_AGE);
        vm.prank(pauser);
        token.pause();
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);
        assertEq(token.balanceOf(attacker), 0);
        assertEq(token.wipedByCase(CASE_1), 9e6);
    }

    function test_wipe_accumulatesAcrossAccountsInOneCase() public {
        address a2 = makeAddr("attacker2");
        _frozenWithBalance(attacker, 3e6);
        _frozenWithBalance(a2, 4e6);
        _wipeAfterAge(attacker, CASE_1);
        _wipeAfterAge(a2, CASE_1);
        assertEq(token.wipedByCase(CASE_1), 7e6);
        assertEq(token.wipedByCase(CASE_2), 0);
    }

    function test_wipe_doesNotTouchMinterAllowance() public {
        _frozenWithBalance(attacker, 3e6);
        uint256 before = token.minterAllowance(minter);
        _wipeAfterAge(attacker, CASE_1);
        assertEq(token.minterAllowance(minter), before);
    }

    function test_wipe_unfreezeAfterWipeAllowsUse() public {
        // 소각 후 동결은 유지되고, 해제는 별도 절차(UNFREEZER)다.
        _frozenWithBalance(attacker, 1);
        _wipeAfterAge(attacker, CASE_1);
        vm.prank(unfreezer);
        token.unfreeze(attacker);
        _mint(attacker, 5);
        assertEq(token.balanceOf(attacker), 5);
    }

    // ------------------------------------------------------------------
    // mintForRecovery
    // ------------------------------------------------------------------

    function test_reissue_upToWiped() public {
        _frozenWithBalance(attacker, 100e6);
        _wipeAfterAge(attacker, CASE_1);
        uint256 allowanceBefore = token.minterAllowance(minter);

        vm.expectEmit(true, true, true, true);
        emit IERC20.Transfer(address(0), victim, 100e6);
        vm.expectEmit(true, true, true, true);
        emit StableToken.RecoveryReissued(CASE_1, victim, 100e6);
        vm.prank(minter);
        token.mintForRecovery(victim, 100e6, CASE_1);

        assertEq(token.balanceOf(victim), 100e6);
        assertEq(token.reissuedByCase(CASE_1), 100e6);
        assertEq(token.minterAllowance(minter), allowanceBefore - 100e6, "recovery uses minter allowance");
    }

    function test_reissue_partialThenRemainder() public {
        _frozenWithBalance(attacker, 100e6);
        _wipeAfterAge(attacker, CASE_1);
        vm.startPrank(minter);
        token.mintForRecovery(victim, 60e6, CASE_1);
        token.mintForRecovery(bob, 40e6, CASE_1);
        vm.stopPrank();
        assertEq(token.reissuedByCase(CASE_1), 100e6);
    }

    function test_reissue_overWipedByOneReverts() public {
        _frozenWithBalance(attacker, 100e6);
        _wipeAfterAge(attacker, CASE_1);
        vm.prank(minter);
        token.mintForRecovery(victim, 60e6, CASE_1);

        vm.expectRevert(
            abi.encodeWithSelector(StableToken.RecoveryExceedsWiped.selector, CASE_1, 100e6, 60e6, 40e6 + 1)
        );
        vm.prank(minter);
        token.mintForRecovery(victim, 40e6 + 1, CASE_1);
    }

    function test_reissue_unknownCaseReverts() public {
        vm.expectRevert(abi.encodeWithSelector(StableToken.RecoveryExceedsWiped.selector, CASE_2, 0, 0, 1));
        vm.prank(minter);
        token.mintForRecovery(victim, 1, CASE_2);
    }

    function test_reissue_wrongCaseReverts() public {
        _frozenWithBalance(attacker, 100e6);
        _wipeAfterAge(attacker, CASE_1);
        vm.expectRevert(abi.encodeWithSelector(StableToken.RecoveryExceedsWiped.selector, CASE_2, 0, 0, 1));
        vm.prank(minter);
        token.mintForRecovery(victim, 1, CASE_2);
    }

    function test_reissue_zeroAmountReverts() public {
        _frozenWithBalance(attacker, 1);
        _wipeAfterAge(attacker, CASE_1);
        vm.expectRevert(StableToken.ZeroAmount.selector);
        vm.prank(minter);
        token.mintForRecovery(victim, 0, CASE_1);
    }

    function test_reissue_respectsMinterAllowance() public {
        _frozenWithBalance(attacker, 100e6);
        _wipeAfterAge(attacker, CASE_1);
        vm.prank(masterMinter);
        token.configureMinter(minter, 50e6);

        vm.expectRevert(abi.encodeWithSelector(StableToken.MinterAllowanceExceeded.selector, minter, 50e6, 100e6));
        vm.prank(minter);
        token.mintForRecovery(victim, 100e6, CASE_1);
        assertEq(token.reissuedByCase(CASE_1), 0, "failed reissue must not count");
    }

    function test_reissue_unauthorized() public {
        _frozenWithBalance(attacker, 1);
        _wipeAfterAge(attacker, CASE_1);
        vm.expectRevert(_unauthorized(wiper, MINTER_ROLE));
        vm.prank(wiper);
        token.mintForRecovery(victim, 1, CASE_1);
    }

    function test_reissue_toFrozenVictimReverts() public {
        _frozenWithBalance(attacker, 1);
        _wipeAfterAge(attacker, CASE_1);
        _freeze(victim);
        vm.expectRevert(_frozen(victim));
        vm.prank(minter);
        token.mintForRecovery(victim, 1, CASE_1);
    }

    function test_reissue_whilePausedReverts() public {
        _frozenWithBalance(attacker, 1);
        _wipeAfterAge(attacker, CASE_1);
        vm.prank(pauser);
        token.pause();
        vm.expectRevert(_paused());
        vm.prank(minter);
        token.mintForRecovery(victim, 1, CASE_1);
        assertEq(token.reissuedByCase(CASE_1), 0);
    }

    function test_fullRunbook_wipeTwoAccountsReissueToVictims() public {
        // 시나리오 6: 사건 하나에서 두 주소를 소각하고 두 피해자에게 재발행. 합계가 일치해야 한다.
        address a2 = makeAddr("attacker2");
        address v2 = makeAddr("victim2");
        _frozenWithBalance(attacker, 30e6);
        _frozenWithBalance(a2, 20e6);
        _wipeAfterAge(attacker, CASE_1);
        _wipeAfterAge(a2, CASE_1);

        vm.startPrank(minter);
        token.mintForRecovery(victim, 30e6, CASE_1);
        token.mintForRecovery(v2, 20e6, CASE_1);
        vm.stopPrank();

        assertEq(token.wipedByCase(CASE_1), token.reissuedByCase(CASE_1));
        assertEq(token.totalSupply(), 50e6);
    }
}
