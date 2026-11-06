// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";

/// @notice 동결 검사 매트릭스 (design.md 12장).
///         transfer, transferFrom, approve, permit, mint, burn 각각에 대해 spender / from / to 를 하나씩 동결한
///         모든 조합이 실패하는지, 그리고 아무도 동결되지 않았을 때는 성공하는지 확인한다.
contract FreezeMatrixTest is BaseTest {
    uint256 internal constant AMOUNT = 10e6;

    function setUp() public override {
        super.setUp();
        _mint(alice, 100e6);
        _mint(bob, 100e6);
        _mint(minter, 100e6);
        // transferFrom용 유한 allowance와 무한 allowance를 모두 준비한다.
        vm.prank(alice);
        token.approve(carol, 50e6);
        vm.prank(bob);
        token.approve(carol, type(uint256).max);
    }

    // ------------------------------------------------------------------
    // transfer(from = msg.sender, to)
    // ------------------------------------------------------------------

    function test_transfer_noneFrozen() public {
        vm.prank(alice);
        assertTrue(token.transfer(bob, AMOUNT));
    }

    function test_transfer_fromFrozen() public {
        _freeze(alice);
        vm.expectRevert(_frozen(alice));
        vm.prank(alice);
        token.transfer(bob, AMOUNT);
    }

    function test_transfer_toFrozen() public {
        _freeze(bob);
        vm.expectRevert(_frozen(bob));
        vm.prank(alice);
        token.transfer(bob, AMOUNT);
    }

    function test_transfer_frozenToSelf() public {
        _freeze(alice);
        vm.expectRevert(_frozen(alice));
        vm.prank(alice);
        token.transfer(alice, AMOUNT);
    }

    // ------------------------------------------------------------------
    // transferFrom(spender = msg.sender, from, to) — 유한 allowance
    // ------------------------------------------------------------------

    function test_transferFrom_noneFrozen() public {
        vm.prank(carol);
        assertTrue(token.transferFrom(alice, bob, AMOUNT));
        assertEq(token.allowance(alice, carol), 50e6 - AMOUNT);
    }

    function test_transferFrom_spenderFrozen() public {
        _freeze(carol);
        vm.expectRevert(_frozen(carol));
        vm.prank(carol);
        token.transferFrom(alice, bob, AMOUNT);
    }

    function test_transferFrom_fromFrozen() public {
        _freeze(alice);
        vm.expectRevert(_frozen(alice));
        vm.prank(carol);
        token.transferFrom(alice, bob, AMOUNT);
    }

    function test_transferFrom_toFrozen() public {
        _freeze(bob);
        vm.expectRevert(_frozen(bob));
        vm.prank(carol);
        token.transferFrom(alice, bob, AMOUNT);
    }

    // ------------------------------------------------------------------
    // transferFrom — 무한 allowance (_approve를 거치지 않으므로 _update/transferFrom override가 최종 방어선)
    // ------------------------------------------------------------------

    function test_transferFromInfinite_noneFrozen() public {
        vm.prank(carol);
        assertTrue(token.transferFrom(bob, alice, AMOUNT));
        assertEq(token.allowance(bob, carol), type(uint256).max);
    }

    function test_transferFromInfinite_spenderFrozen() public {
        _freeze(carol);
        vm.expectRevert(_frozen(carol));
        vm.prank(carol);
        token.transferFrom(bob, alice, AMOUNT);
    }

    function test_transferFromInfinite_fromFrozen() public {
        _freeze(bob);
        vm.expectRevert(_frozen(bob));
        vm.prank(carol);
        token.transferFrom(bob, alice, AMOUNT);
    }

    function test_transferFromInfinite_toFrozen() public {
        _freeze(alice);
        vm.expectRevert(_frozen(alice));
        vm.prank(carol);
        token.transferFrom(bob, alice, AMOUNT);
    }

    // ------------------------------------------------------------------
    // approve(owner = msg.sender, spender)
    // ------------------------------------------------------------------

    function test_approve_noneFrozen() public {
        vm.prank(alice);
        assertTrue(token.approve(bob, AMOUNT));
        assertEq(token.allowance(alice, bob), AMOUNT);
    }

    function test_approve_ownerFrozen() public {
        _freeze(alice);
        vm.expectRevert(_frozen(alice));
        vm.prank(alice);
        token.approve(bob, AMOUNT);
    }

    function test_approve_spenderFrozen() public {
        _freeze(bob);
        vm.expectRevert(_frozen(bob));
        vm.prank(alice);
        token.approve(bob, AMOUNT);
    }

    function test_approve_zeroValueStillBlockedWhenFrozen() public {
        // 동결된 owner는 allowance를 0으로 되돌리는 것조차 못 한다 (USDC v2.2보다 엄격).
        _freeze(alice);
        vm.expectRevert(_frozen(alice));
        vm.prank(alice);
        token.approve(carol, 0);
    }

    // ------------------------------------------------------------------
    // permit(owner, spender) — 서명자 alice, 제출자는 누구나
    // ------------------------------------------------------------------

    /// @dev 서명을 먼저 만들고(뷰 호출 포함) 나서 expectRevert를 걸어야 permit 호출에 정확히 걸린다.
    function _permit(address spender, bytes memory expectedRevert) internal {
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(aliceKey, alice, spender, AMOUNT, deadline);
        if (expectedRevert.length != 0) vm.expectRevert(expectedRevert);
        vm.prank(attacker); // relayer는 아무나
        token.permit(alice, spender, AMOUNT, deadline, v, r, s);
    }

    function test_permit_noneFrozen() public {
        _permit(bob, "");
        assertEq(token.allowance(alice, bob), AMOUNT);
        assertEq(token.nonces(alice), 1);
    }

    function test_permit_ownerFrozen() public {
        _freeze(alice);
        _permit(bob, _frozen(alice));
        assertEq(token.allowance(alice, bob), 0);
        assertEq(token.nonces(alice), 0, "nonce must not be consumed");
    }

    function test_permit_spenderFrozen() public {
        _freeze(bob);
        _permit(bob, _frozen(bob));
        assertEq(token.allowance(alice, bob), 0);
    }

    function test_permit_relayerFrozenDoesNotMatter() public {
        // permit의 msg.sender는 잔고와 무관하므로 동결 검사 대상이 아니다.
        _freeze(attacker);
        _permit(bob, "");
        assertEq(token.allowance(alice, bob), AMOUNT);
    }

    // ------------------------------------------------------------------
    // mint(spender = minter, to)
    // ------------------------------------------------------------------

    function test_mint_noneFrozen() public {
        _mint(alice, AMOUNT);
    }

    function test_mint_minterFrozen() public {
        _freeze(minter);
        vm.expectRevert(_frozen(minter));
        vm.prank(minter);
        token.mint(alice, AMOUNT);
    }

    function test_mint_toFrozen() public {
        _freeze(alice);
        vm.expectRevert(_frozen(alice));
        vm.prank(minter);
        token.mint(alice, AMOUNT);
    }

    function test_mintForRecovery_minterFrozen() public {
        _mint(attacker, AMOUNT);
        _freeze(attacker);
        vm.warp(block.timestamp + MIN_FREEZE_AGE);
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);

        _freeze(minter);
        vm.expectRevert(_frozen(minter));
        vm.prank(minter);
        token.mintForRecovery(alice, AMOUNT, CASE_1);
    }

    function test_mintForRecovery_toFrozen() public {
        _mint(attacker, AMOUNT);
        _freeze(attacker);
        vm.warp(block.timestamp + MIN_FREEZE_AGE);
        vm.prank(wiper);
        token.wipeFrozen(attacker, CASE_1);

        _freeze(alice);
        vm.expectRevert(_frozen(alice));
        vm.prank(minter);
        token.mintForRecovery(alice, AMOUNT, CASE_1);
    }

    // ------------------------------------------------------------------
    // burn(from = minter)
    // ------------------------------------------------------------------

    function test_burn_noneFrozen() public {
        vm.prank(minter);
        token.burn(AMOUNT);
    }

    function test_burn_minterFrozen() public {
        _freeze(minter);
        vm.expectRevert(_frozen(minter));
        vm.prank(minter);
        token.burn(AMOUNT);
    }

    // ------------------------------------------------------------------
    // 동결 후 잔고는 그대로 (불변식 2의 단위 버전)
    // ------------------------------------------------------------------

    function test_frozenBalanceCannotChangeExceptWipe() public {
        _freeze(alice);
        uint256 before = token.balanceOf(alice);

        vm.prank(alice);
        vm.expectRevert(_frozen(alice));
        token.transfer(bob, 1);

        vm.prank(bob);
        vm.expectRevert(_frozen(alice));
        token.transfer(alice, 1);

        vm.prank(carol);
        vm.expectRevert(_frozen(alice));
        token.transferFrom(alice, bob, 1);

        vm.prank(minter);
        vm.expectRevert(_frozen(alice));
        token.mint(alice, 1);

        assertEq(token.balanceOf(alice), before);

        vm.warp(block.timestamp + MIN_FREEZE_AGE);
        vm.prank(wiper);
        token.wipeFrozen(alice, CASE_1);
        assertEq(token.balanceOf(alice), 0);
    }
}
