// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {StableToken} from "../src/StableToken.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {TransparentUpgradeableProxy} from
    "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

/// @notice 초기화, 메타데이터, 역할 admin 구성, ERC-7201 슬롯.
contract InitializeTest is BaseTest {
    function test_metadata() public view {
        assertEq(token.name(), NAME);
        assertEq(token.symbol(), SYMBOL);
        assertEq(token.decimals(), 6);
        assertEq(token.totalSupply(), 0);
        assertEq(token.minFreezeAge(), MIN_FREEZE_AGE);
        assertFalse(token.paused());
    }

    function test_adminHasOnlyDefaultAdmin() public view {
        assertTrue(token.hasRole(DEFAULT_ADMIN_ROLE, admin));
        assertFalse(token.hasRole(FREEZER_ROLE, admin));
        assertFalse(token.hasRole(MINTER_ROLE, admin));
        assertFalse(token.hasRole(GUARDIAN_ROLE, admin));
    }

    function test_roleAdmins() public view {
        bytes32 defaultAdmin = token.DEFAULT_ADMIN_ROLE();
        assertEq(token.getRoleAdmin(FREEZER_ROLE), GUARDIAN_ROLE);
        assertEq(token.getRoleAdmin(MINTER_ROLE), MASTER_MINTER_ROLE);
        assertEq(token.getRoleAdmin(GUARDIAN_ROLE), defaultAdmin);
        assertEq(token.getRoleAdmin(UNFREEZER_ROLE), defaultAdmin);
        assertEq(token.getRoleAdmin(PAUSER_ROLE), defaultAdmin);
        assertEq(token.getRoleAdmin(WIPER_ROLE), defaultAdmin);
        assertEq(token.getRoleAdmin(MASTER_MINTER_ROLE), defaultAdmin);
        assertEq(token.getRoleAdmin(RESCUER_ROLE), defaultAdmin);
        assertEq(token.getRoleAdmin(defaultAdmin), defaultAdmin);
    }

    function test_initializeEmitsMinFreezeAge() public {
        StableToken impl = new StableToken();
        vm.expectEmit(true, true, true, true);
        emit StableToken.MinFreezeAgeSet(123);
        new TransparentUpgradeableProxy(
            address(impl), proxyOwner, abi.encodeCall(StableToken.initialize, (NAME, SYMBOL, admin, 123))
        );
    }

    function test_cannotInitializeTwice() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        token.initialize(NAME, SYMBOL, attacker, 0);
    }

    function test_implementationCannotBeInitialized() public {
        StableToken impl = new StableToken();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(NAME, SYMBOL, admin, 0);
    }

    function test_initializeRejectsZeroAdmin() public {
        StableToken impl = new StableToken();
        vm.expectRevert(StableToken.ZeroAddress.selector);
        new TransparentUpgradeableProxy(
            address(impl), proxyOwner, abi.encodeCall(StableToken.initialize, (NAME, SYMBOL, address(0), 0))
        );
    }

    /// @dev 컨트랙트에 박힌 슬롯 상수가 ERC-7201 공식과 일치하는지 저장소를 직접 읽어 확인한다.
    function test_erc7201SlotMatchesFormula() public {
        bytes32 base = keccak256(abi.encode(uint256(keccak256("stabletoken.storage.StableToken")) - 1))
            & ~bytes32(uint256(0xff));
        // 구조체의 4번째 멤버(minFreezeAge)는 base + 3 슬롯에 있다.
        bytes32 raw = vm.load(address(token), bytes32(uint256(base) + 3));
        assertEq(uint64(uint256(raw)), MIN_FREEZE_AGE);

        // frozenAt 매핑은 base + 0 슬롯. 동결 후 값이 들어가는지 확인.
        _freeze(alice);
        bytes32 frozenSlot = keccak256(abi.encode(alice, uint256(base)));
        assertEq(uint64(uint256(vm.load(address(token), frozenSlot))), uint64(block.timestamp));
    }

    function test_freezeBatchMaxIsFifty() public view {
        assertEq(token.FREEZE_BATCH_MAX(), 50);
    }

    function test_supportsAccessControlInterface() public view {
        assertTrue(token.supportsInterface(0x7965db0b)); // IAccessControl
        assertTrue(token.supportsInterface(0x01ffc9a7)); // IERC165
    }
}
