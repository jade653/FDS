// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {StableToken} from "../src/StableToken.sol";

/// @notice 퍼즈 테스트 (design.md 12장): mint 한도, wipeFrozen 대기 시간, freezeBatch 길이,
///         임의 caseId·금액에서 mintForRecovery 상한.
contract FuzzTest is BaseTest {
    function _assumeUser(address a) internal view {
        vm.assume(a != address(0) && a != address(token) && a.code.length == 0);
        vm.assume(!token.hasRole(MINTER_ROLE, a));
    }

    // ------------------------------------------------------------------
    // mint 한도
    // ------------------------------------------------------------------

    function testFuzz_mint_withinAllowance(address to, uint256 allowance_, uint256 amount) public {
        _assumeUser(to);
        allowance_ = bound(allowance_, 1, type(uint128).max);
        amount = bound(amount, 1, allowance_);

        vm.prank(masterMinter);
        token.configureMinter(minter, allowance_);
        _mint(to, amount);

        assertEq(token.balanceOf(to), amount);
        assertEq(token.minterAllowance(minter), allowance_ - amount);
    }

    function testFuzz_mint_overAllowanceReverts(address to, uint256 allowance_, uint256 amount) public {
        _assumeUser(to);
        allowance_ = bound(allowance_, 0, type(uint128).max);
        amount = bound(amount, allowance_ + 1, type(uint256).max);

        vm.prank(masterMinter);
        token.configureMinter(minter, allowance_);
        vm.expectRevert(
            abi.encodeWithSelector(StableToken.MinterAllowanceExceeded.selector, minter, allowance_, amount)
        );
        vm.prank(minter);
        token.mint(to, amount);
    }

    function testFuzz_mint_cumulativeNeverExceedsAllowance(uint256 allowance_, uint256[8] memory amounts) public {
        allowance_ = bound(allowance_, 0, type(uint96).max);
        vm.prank(masterMinter);
        token.configureMinter(minter, allowance_);

        uint256 minted;
        for (uint256 i = 0; i < amounts.length; ++i) {
            uint256 amount = bound(amounts[i], 1, type(uint96).max);
            vm.prank(minter);
            if (minted + amount <= allowance_) {
                token.mint(alice, amount);
                minted += amount;
            } else {
                vm.expectRevert(
                    abi.encodeWithSelector(
                        StableToken.MinterAllowanceExceeded.selector, minter, allowance_ - minted, amount
                    )
                );
                token.mint(alice, amount);
            }
        }
        assertLe(minted, allowance_);
        assertEq(token.totalSupply(), minted);
    }

    // ------------------------------------------------------------------
    // wipeFrozen 대기 시간
    // ------------------------------------------------------------------

    function testFuzz_wipe_respectsMinFreezeAge(uint64 minAge, uint64 elapsed, uint256 amount) public {
        minAge = uint64(bound(minAge, 0, 365 days));
        elapsed = uint64(bound(elapsed, 0, 2 * 365 days));
        amount = bound(amount, 1, MINTER_ALLOWANCE);

        vm.prank(admin);
        token.setMinFreezeAge(minAge);
        _mint(attacker, amount);
        _freeze(attacker);
        uint64 frozenAt = token.frozenAt(attacker);
        vm.warp(uint256(frozenAt) + elapsed);

        vm.prank(wiper);
        if (elapsed >= minAge) {
            token.wipeFrozen(attacker, CASE_1);
            assertEq(token.balanceOf(attacker), 0);
            assertEq(token.wipedByCase(CASE_1), amount);
        } else {
            vm.expectRevert(
                abi.encodeWithSelector(StableToken.FreezeTooRecent.selector, attacker, frozenAt + minAge)
            );
            token.wipeFrozen(attacker, CASE_1);
            assertEq(token.balanceOf(attacker), amount);
        }
    }

    // ------------------------------------------------------------------
    // freezeBatch 길이
    // ------------------------------------------------------------------

    function testFuzz_freezeBatch_length(uint256 n) public {
        n = bound(n, 0, 120);
        address[] memory list = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            list[i] = address(uint160(0xA000 + i));
        }

        uint256 max = token.FREEZE_BATCH_MAX();
        if (n <= max) {
            vm.prank(bot);
            token.freezeBatch(list, REASON);
            for (uint256 i = 0; i < n; ++i) {
                assertTrue(token.isFrozen(list[i]));
            }
        } else {
            vm.expectRevert(abi.encodeWithSelector(StableToken.BatchTooLarge.selector, n, max));
            vm.prank(bot);
            token.freezeBatch(list, REASON);
        }
    }

    // ------------------------------------------------------------------
    // mintForRecovery 상한: 임의 caseId와 금액 조합
    // ------------------------------------------------------------------

    function testFuzz_reissue_neverExceedsWiped(bytes32 caseId, uint256 wipedAmount, uint256[6] memory requests)
        public
    {
        wipedAmount = bound(wipedAmount, 1, MINTER_ALLOWANCE / 2);
        _mint(attacker, wipedAmount);
        _freeze(attacker);
        vm.warp(block.timestamp + MIN_FREEZE_AGE);
        vm.prank(wiper);
        token.wipeFrozen(attacker, caseId);
        assertEq(token.wipedByCase(caseId), wipedAmount);

        uint256 reissued;
        for (uint256 i = 0; i < requests.length; ++i) {
            uint256 amount = bound(requests[i], 1, wipedAmount);
            vm.prank(minter);
            if (reissued + amount <= wipedAmount) {
                token.mintForRecovery(alice, amount, caseId);
                reissued += amount;
            } else {
                vm.expectRevert(
                    abi.encodeWithSelector(
                        StableToken.RecoveryExceedsWiped.selector, caseId, wipedAmount, reissued, amount
                    )
                );
                token.mintForRecovery(alice, amount, caseId);
            }
            assertLe(token.reissuedByCase(caseId), token.wipedByCase(caseId));
        }
        assertEq(token.reissuedByCase(caseId), reissued);
        assertEq(token.balanceOf(alice), reissued);
    }

    function testFuzz_reissue_differentCaseIdAlwaysReverts(bytes32 wipedCase, bytes32 otherCase, uint256 amount)
        public
    {
        vm.assume(wipedCase != otherCase);
        amount = bound(amount, 1, MINTER_ALLOWANCE / 2);
        _mint(attacker, amount);
        _freeze(attacker);
        vm.warp(block.timestamp + MIN_FREEZE_AGE);
        vm.prank(wiper);
        token.wipeFrozen(attacker, wipedCase);

        vm.expectRevert(abi.encodeWithSelector(StableToken.RecoveryExceedsWiped.selector, otherCase, 0, 0, amount));
        vm.prank(minter);
        token.mintForRecovery(alice, amount, otherCase);
    }

    function testFuzz_reissue_unknownCaseAlwaysReverts(bytes32 caseId, uint256 amount) public {
        amount = bound(amount, 1, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(StableToken.RecoveryExceedsWiped.selector, caseId, 0, 0, amount));
        vm.prank(minter);
        token.mintForRecovery(alice, amount, caseId);
    }

    // ------------------------------------------------------------------
    // 동결은 어떤 주소에 대해서도 전송을 막는다
    // ------------------------------------------------------------------

    function testFuzz_frozenAccountCannotSendOrReceive(address user, uint256 amount) public {
        _assumeUser(user);
        vm.assume(user != alice);
        amount = bound(amount, 1, MINTER_ALLOWANCE / 2);
        _mint(user, amount);
        _mint(alice, amount);
        _freeze(user);

        vm.expectRevert(_frozen(user));
        vm.prank(user);
        token.transfer(alice, amount);

        vm.expectRevert(_frozen(user));
        vm.prank(alice);
        token.transfer(user, amount);

        assertEq(token.balanceOf(user), amount);
    }
}
