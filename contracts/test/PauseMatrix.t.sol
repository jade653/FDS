// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";

/// @notice 일시정지 매트릭스 (design.md 12장).
///         일시정지 상태에서 freeze, unfreeze, wipeFrozen, 역할 변경은 성공하고
///         transfer, transferFrom, mint, mintForRecovery, burn은 실패한다.
contract PauseMatrixTest is BaseTest {
    function setUp() public override {
        super.setUp();
        _mint(alice, 100e6);
        _mint(minter, 100e6);
        _mint(attacker, 100e6);
        vm.prank(alice);
        token.approve(carol, type(uint256).max);

        // 회수 재발행용 사건 하나를 미리 만든다.
        _freeze(attacker);
        vm.warp(block.timestamp + MIN_FREEZE_AGE);
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);

        vm.prank(pauser);
        token.pause();
        assertTrue(token.paused());
    }

    // 실패해야 하는 것들 ------------------------------------------------

    function test_paused_transferFails() public {
        vm.expectRevert(_paused());
        vm.prank(alice);
        token.transfer(bob, 1);
    }

    function test_paused_transferFromFails() public {
        vm.expectRevert(_paused());
        vm.prank(carol);
        token.transferFrom(alice, bob, 1);
    }

    function test_paused_mintFails() public {
        vm.expectRevert(_paused());
        vm.prank(minter);
        token.mint(alice, 1);
    }

    function test_paused_mintForRecoveryFails() public {
        vm.expectRevert(_paused());
        vm.prank(minter);
        token.mintForRecovery(bob, 1, CASE_1);
    }

    function test_paused_burnFails() public {
        vm.expectRevert(_paused());
        vm.prank(minter);
        token.burn(1);
    }

    function test_paused_ownTokenRescueFails() public {
        _unpauseAndMintToContract();
        vm.expectRevert(_paused());
        vm.prank(rescuer);
        token.rescueERC20(address(token), alice, 1);
    }

    function _unpauseAndMintToContract() internal {
        vm.prank(pauser);
        token.unpause();
        _mint(address(token), 1);
        vm.prank(pauser);
        token.pause();
    }

    // 성공해야 하는 것들 ------------------------------------------------

    function test_paused_approveStillWorks() public {
        // approve는 잔고를 움직이지 않으므로 일시정지 대상이 아니다 (USDC도 동일).
        vm.prank(alice);
        token.approve(bob, 5);
        assertEq(token.allowance(alice, bob), 5);
    }

    function test_paused_freezeWorks() public {
        _freeze(alice);
        assertTrue(token.isFrozen(alice));
    }

    function test_paused_freezeBatchWorks() public {
        address[] memory list = new address[](2);
        list[0] = alice;
        list[1] = bob;
        vm.prank(bot);
        token.freezeBatch(list, REASON);
        assertTrue(token.isFrozen(alice) && token.isFrozen(bob));
    }

    function test_paused_unfreezeWorks() public {
        _freeze(alice);
        vm.prank(unfreezer);
        token.unfreeze(alice);
        assertFalse(token.isFrozen(alice));
    }

    function test_paused_wipeFrozenWorks() public {
        _freeze(alice);
        vm.warp(block.timestamp + MIN_FREEZE_AGE);
        vm.prank(wiper);
        token.wipeFrozen(alice, CASE_2);
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.wipedByCase(CASE_2), 100e6);
    }

    function test_paused_roleChangesWork() public {
        vm.prank(admin);
        token.grantRole(PAUSER_ROLE, bob);
        vm.prank(guardian);
        token.revokeRole(FREEZER_ROLE, bot);
        vm.prank(masterMinter);
        token.configureMinter(bob, 1);
        vm.prank(masterMinter);
        token.removeMinter(minter);
        assertTrue(token.hasRole(PAUSER_ROLE, bob));
        assertFalse(token.hasRole(FREEZER_ROLE, bot));
        assertTrue(token.hasRole(MINTER_ROLE, bob));
        assertFalse(token.hasRole(MINTER_ROLE, minter));
    }

    function test_paused_adminSettersWork() public {
        vm.startPrank(admin);
        token.setProtected(alice, true);
        token.setMinFreezeAge(1);
        vm.stopPrank();
        assertTrue(token.isProtected(alice));
        assertEq(token.minFreezeAge(), 1);
    }

    function test_paused_thenUnpauseRestoresEverything() public {
        vm.prank(pauser);
        token.unpause();
        vm.prank(alice);
        token.transfer(bob, 1);
        vm.prank(minter);
        token.mint(bob, 1);
        vm.prank(minter);
        token.mintForRecovery(bob, 1, CASE_1);
        vm.prank(minter);
        token.burn(1);
        assertEq(token.balanceOf(bob), 3);
    }
}
