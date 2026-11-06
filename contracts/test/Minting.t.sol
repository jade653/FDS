// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {StableToken} from "../src/StableToken.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice configureMinter / removeMinter / mint / burn 과 MINTER 역할 관리 제한.
contract MintingTest is BaseTest {
    address internal minter2 = makeAddr("minter2");

    // ------------------------------------------------------------------
    // configureMinter / removeMinter
    // ------------------------------------------------------------------

    function test_configureMinter_grantsRoleAndSetsAllowance() public {
        vm.expectEmit(true, true, true, true);
        emit StableToken.MinterConfigured(minter2, 500e6);
        vm.prank(masterMinter);
        token.configureMinter(minter2, 500e6);
        assertTrue(token.hasRole(MINTER_ROLE, minter2));
        assertEq(token.minterAllowance(minter2), 500e6);
    }

    function test_configureMinter_overwritesAllowance() public {
        _mint(alice, 10e6);
        assertEq(token.minterAllowance(minter), MINTER_ALLOWANCE - 10e6);
        vm.prank(masterMinter);
        token.configureMinter(minter, 7);
        assertEq(token.minterAllowance(minter), 7);
    }

    function test_configureMinter_zeroAllowanceAllowed() public {
        vm.prank(masterMinter);
        token.configureMinter(minter, 0);
        vm.expectRevert(abi.encodeWithSelector(StableToken.MinterAllowanceExceeded.selector, minter, 0, 1));
        vm.prank(minter);
        token.mint(alice, 1);
    }

    function test_configureMinter_unauthorized() public {
        vm.expectRevert(_unauthorized(admin, MASTER_MINTER_ROLE));
        vm.prank(admin);
        token.configureMinter(minter2, 1);
    }

    function test_configureMinter_zeroAddressReverts() public {
        vm.expectRevert(StableToken.ZeroAddress.selector);
        vm.prank(masterMinter);
        token.configureMinter(address(0), 1);
    }

    function test_configureMinter_worksWhilePaused() public {
        vm.prank(pauser);
        token.pause();
        vm.prank(masterMinter);
        token.configureMinter(minter2, 1);
        assertTrue(token.hasRole(MINTER_ROLE, minter2));
    }

    function test_removeMinter_revokesRoleAndZeroesAllowance() public {
        vm.expectEmit(true, true, true, true);
        emit StableToken.MinterRemoved(minter);
        vm.prank(masterMinter);
        token.removeMinter(minter);
        assertFalse(token.hasRole(MINTER_ROLE, minter));
        assertEq(token.minterAllowance(minter), 0);

        vm.expectRevert(_unauthorized(minter, MINTER_ROLE));
        vm.prank(minter);
        token.mint(alice, 1);
    }

    function test_removeMinter_notMinterReverts() public {
        vm.expectRevert(abi.encodeWithSelector(StableToken.NotMinter.selector, minter2));
        vm.prank(masterMinter);
        token.removeMinter(minter2);
    }

    function test_removeMinter_unauthorized() public {
        vm.expectRevert(_unauthorized(admin, MASTER_MINTER_ROLE));
        vm.prank(admin);
        token.removeMinter(minter);
    }

    function test_removeMinter_thenReconfigureStartsFresh() public {
        vm.startPrank(masterMinter);
        token.removeMinter(minter);
        token.configureMinter(minter, 5);
        vm.stopPrank();
        assertEq(token.minterAllowance(minter), 5);
    }

    // ------------------------------------------------------------------
    // MINTER 역할은 grantRole / revokeRole로 바꿀 수 없다
    // ------------------------------------------------------------------

    function test_grantRoleMinterRejected() public {
        vm.expectRevert(StableToken.UseMinterFunctions.selector);
        vm.prank(masterMinter);
        token.grantRole(MINTER_ROLE, minter2);
    }

    function test_revokeRoleMinterRejected() public {
        vm.expectRevert(StableToken.UseMinterFunctions.selector);
        vm.prank(masterMinter);
        token.revokeRole(MINTER_ROLE, minter);
    }

    function test_renounceMinterClearsAllowance() public {
        vm.expectEmit(true, true, true, true);
        emit StableToken.MinterRemoved(minter);
        vm.prank(minter);
        token.renounceRole(MINTER_ROLE, minter);
        assertFalse(token.hasRole(MINTER_ROLE, minter));
        assertEq(token.minterAllowance(minter), 0);
    }

    function test_renounceMinterByNonMinterIsSilentNoop() public {
        vm.recordLogs();
        vm.prank(alice);
        token.renounceRole(MINTER_ROLE, alice);
        assertEq(vm.getRecordedLogs().length, 0, "no MinterRemoved for a non-minter");
        assertEq(token.minterAllowance(minter), MINTER_ALLOWANCE);
    }

    function test_renounceOtherRoleKeepsAllowanceLogicUntouched() public {
        vm.prank(bot);
        token.renounceRole(FREEZER_ROLE, bot);
        assertFalse(token.hasRole(FREEZER_ROLE, bot));
        assertEq(token.minterAllowance(minter), MINTER_ALLOWANCE);
    }

    // ------------------------------------------------------------------
    // mint
    // ------------------------------------------------------------------

    function test_mint_withinAllowance() public {
        vm.expectEmit(true, true, true, true);
        emit IERC20.Transfer(address(0), alice, 100e6);
        vm.expectEmit(true, true, true, true);
        emit StableToken.Mint(minter, alice, 100e6);
        _mint(alice, 100e6);
        assertEq(token.balanceOf(alice), 100e6);
        assertEq(token.totalSupply(), 100e6);
        assertEq(token.minterAllowance(minter), MINTER_ALLOWANCE - 100e6);
    }

    function test_mint_exactAllowanceSucceeds() public {
        _mint(alice, MINTER_ALLOWANCE);
        assertEq(token.minterAllowance(minter), 0);
    }

    function test_mint_overAllowanceByOneReverts() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                StableToken.MinterAllowanceExceeded.selector, minter, MINTER_ALLOWANCE, MINTER_ALLOWANCE + 1
            )
        );
        vm.prank(minter);
        token.mint(alice, MINTER_ALLOWANCE + 1);
    }

    function test_mint_cumulativeAllowance() public {
        _mint(alice, MINTER_ALLOWANCE - 1);
        _mint(alice, 1);
        vm.expectRevert(abi.encodeWithSelector(StableToken.MinterAllowanceExceeded.selector, minter, 0, 1));
        vm.prank(minter);
        token.mint(alice, 1);
    }

    function test_mint_zeroAmountReverts() public {
        vm.expectRevert(StableToken.ZeroAmount.selector);
        vm.prank(minter);
        token.mint(alice, 0);
    }

    function test_mint_toZeroAddressReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InvalidReceiver.selector, address(0)));
        vm.prank(minter);
        token.mint(address(0), 1);
    }

    function test_mint_unauthorized() public {
        vm.expectRevert(_unauthorized(masterMinter, MINTER_ROLE));
        vm.prank(masterMinter);
        token.mint(alice, 1);
    }

    // ------------------------------------------------------------------
    // burn
    // ------------------------------------------------------------------

    function test_burn_ownBalance() public {
        _mint(minter, 100e6);
        vm.expectEmit(true, true, true, true);
        emit IERC20.Transfer(minter, address(0), 40e6);
        vm.expectEmit(true, true, true, true);
        emit StableToken.Burn(minter, 40e6);
        vm.prank(minter);
        token.burn(40e6);
        assertEq(token.balanceOf(minter), 60e6);
        assertEq(token.totalSupply(), 60e6);
        // 소각은 한도를 돌려주지 않는다.
        assertEq(token.minterAllowance(minter), MINTER_ALLOWANCE - 100e6);
    }

    function test_burn_moreThanBalanceReverts() public {
        _mint(minter, 10);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, minter, 10, 11));
        vm.prank(minter);
        token.burn(11);
    }

    function test_burn_zeroAmountReverts() public {
        vm.expectRevert(StableToken.ZeroAmount.selector);
        vm.prank(minter);
        token.burn(0);
    }

    function test_burn_unauthorized() public {
        _mint(alice, 10);
        vm.expectRevert(_unauthorized(alice, MINTER_ROLE));
        vm.prank(alice);
        token.burn(10);
    }

    function test_burn_cannotBurnOthersBalance() public {
        // burn은 자기 잔고만. 다른 주소의 잔고를 줄이는 경로는 wipeFrozen뿐이다.
        _mint(alice, 10);
        vm.expectRevert(abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, minter, 0, 10));
        vm.prank(minter);
        token.burn(10);
        assertEq(token.balanceOf(alice), 10);
    }
}
